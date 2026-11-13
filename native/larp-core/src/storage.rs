use std::{collections::BTreeMap, fs, path::{Path, PathBuf}, sync::atomic::{AtomicUsize, Ordering}};

use rusqlite::{backup::Progress, params, Connection, OptionalExtension, TransactionBehavior, MAIN_DB};
use serde_json::{json, Value};

use crate::{
    contracts::{GroupMember, GroupRole, GroupSummary, StorageCommand, UserProfile},
    error::CoreError,
    identity,
};

const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
const MAX_ENVELOPE_BYTES: usize = 65_536;

fn sql_sequence(sequence: u64) -> Result<i64, CoreError> {
    if sequence > MAX_SEQUENCE { return Err(CoreError::InvalidSequence); }
    i64::try_from(sequence).map_err(|_| CoreError::InvalidSequence)
}

fn sequence_from_sql(sequence: i64) -> Result<u64, CoreError> {
    u64::try_from(sequence).map_err(|_| CoreError::Storage)
}

static MIGRATION_BACKUP_ID: AtomicUsize = AtomicUsize::new(0);

pub struct LocalDatabase {
    connection: Connection,
}

impl LocalDatabase {
    pub fn open(path: &str) -> Result<Self, CoreError> {
        let database_path = Path::new(path);
        let connection = Connection::open(database_path).map_err(|_| CoreError::Storage)?;
        connection.pragma_update(None, "foreign_keys", "ON").map_err(|_| CoreError::Storage)?;
        migrate(&connection, database_path)?;
        connection.pragma_update(None, "journal_mode", "WAL").map_err(|_| CoreError::Storage)?;
        Ok(Self { connection })
    }

    pub fn handle(&mut self, command: StorageCommand) -> Result<Value, CoreError> {
        match command {
            StorageCommand::ReplaceCloudCache(r) => { self.replace_cloud_cache(r.groups, r.members_by_group)?; Ok(Value::Null) }
            StorageCommand::CacheCloudMembers(r) => { self.cache_cloud_members(&r.group_id, r.members)?; Ok(Value::Null) }
            StorageCommand::GetCachedCloudGroups(_) => self.cached_groups(),
            StorageCommand::GetCachedCloudMembers(r) => self.cached_members(&r.group_id),
            StorageCommand::GetCachedMessages(r) => self.cached_messages(&r.group_id, r.per_author_limit),
            StorageCommand::PersistOutgoing(r) => {
                let chat = checked_chat(&r.envelope_json, &r.header)?;
                if chat.sender_id != r.local_user_id { return Err(CoreError::InvalidIdentity); }
                match self.store_chat(&chat)? {
                    StoreResult::Conflict => Err(CoreError::Conflict),
                    StoreResult::Inserted | StoreResult::Duplicate => Ok(Value::Null),
                }
            }
            StorageCommand::PersistVerifiedIncoming(r) => {
                let chat = checked_chat(&r.envelope_json, &r.header)?;
                Ok(json!(match self.store_chat(&chat)? {
                    StoreResult::Inserted => "inserted", StoreResult::Duplicate => "duplicate", StoreResult::Conflict => "conflict",
                }))
            }
            StorageCommand::ReadMissing(r) => self.read_missing(&r.group_id, &r.author_id, r.after_sequence, r.through_sequence, r.limit),
            StorageCommand::PersistAck(r) => { self.persist_ack(&r.local_user_id, &checked_ack(&r.envelope_json, &r.header)?)?; Ok(Value::Null) }
            StorageCommand::GetHighestContiguous(r) => Ok(json!(self.highest_contiguous(&r.group_id, &r.author_id)?)),
        }
    }

    fn replace_cloud_cache(&mut self, groups: Vec<GroupSummary>, members: BTreeMap<String, Vec<GroupMember>>) -> Result<(), CoreError> {
        let tx = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| CoreError::Storage)?;
        tx.execute("DELETE FROM cached_cloud_groups", []).map_err(|_| CoreError::Storage)?;
        for group in &groups {
            validate_group(group)?;
            let list = members.get(&group.id).ok_or(CoreError::InvalidCache)?;
            validate_members(list)?;
            if list.len() != group.member_count as usize { return Err(CoreError::InvalidCache); }
            tx.execute("INSERT INTO cached_cloud_groups(id,name,created_at,member_count,role) VALUES (?1,?2,?3,?4,?5)",
                params![group.id, group.name, group.created_at, group.member_count, role(group.role)]).map_err(|_| CoreError::InvalidCache)?;
            insert_members(&tx, &group.id, list)?;
        }
        tx.commit().map_err(|_| CoreError::Storage)
    }

    fn cache_cloud_members(&mut self, group: &str, members: Vec<GroupMember>) -> Result<(), CoreError> {
        if !valid_id(group, 80) { return Err(CoreError::InvalidCache); }
        validate_members(&members)?;
        let tx = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| CoreError::Storage)?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM cached_cloud_groups WHERE id=?1)", [group], |r| r.get(0)).map_err(|_| CoreError::Storage)?;
        if exists {
            tx.execute("DELETE FROM cached_cloud_members WHERE group_id=?1", [group]).map_err(|_| CoreError::Storage)?;
            insert_members(&tx, group, &members)?;
            tx.execute("UPDATE cached_cloud_groups SET member_count=?1 WHERE id=?2", params![i64::try_from(members.len()).map_err(|_| CoreError::Storage)?, group]).map_err(|_| CoreError::Storage)?;
        }
        tx.commit().map_err(|_| CoreError::Storage)
    }

    fn cached_groups(&self) -> Result<Value, CoreError> {
        let mut s = self.connection.prepare("SELECT id,name,created_at,member_count,role FROM cached_cloud_groups ORDER BY created_at,id").map_err(|_| CoreError::Storage)?;
        let rows = s.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"createdAt":r.get::<_,String>(2)?,"memberCount":r.get::<_,u32>(3)?,"role":r.get::<_,String>(4)?}))).map_err(|_| CoreError::Storage)?;
        Ok(json!(rows.collect::<Result<Vec<_>,_>>().map_err(|_| CoreError::Storage)?))
    }

    fn cached_members(&self, group: &str) -> Result<Value, CoreError> {
        let mut s = self.connection.prepare("SELECT user_id,public_key,joined_at,role,display_name,avatar_data FROM cached_cloud_members WHERE group_id=?1 ORDER BY joined_at,user_id").map_err(|_| CoreError::Storage)?;
        let rows = s.query_map([group], |r| {
            let user: String = r.get(0)?; let display: Option<String> = r.get(4)?; let avatar: Option<String> = r.get(5)?;
            Ok(json!({"userId":user,"publicKey":r.get::<_,String>(1)?,"joinedAt":r.get::<_,String>(2)?,"role":r.get::<_,String>(3)?,
                "profile":if display.is_none() && avatar.is_none(){Value::Null}else{json!({"userId":user,"displayName":display,"avatarData":avatar})}}))
        }).map_err(|_| CoreError::Storage)?;
        Ok(json!(rows.collect::<Result<Vec<_>,_>>().map_err(|_| CoreError::Storage)?))
    }

    fn cached_messages(&self, group: &str, limit: u32) -> Result<Value, CoreError> {
        if !valid_id(group, 80) || !(1..=100).contains(&limit) { return Err(CoreError::InvalidRange); }
        let members = self.cached_members(group)?;
        let mut output = Vec::new();
        for member in members.as_array().ok_or(CoreError::Storage)? {
            let author = member["userId"].as_str().ok_or(CoreError::Storage)?;
            let end = self.highest_contiguous(group, author)?;
            let mut after = end.saturating_sub(limit as u64);
            while after < end {
                let batch = self.read_missing(group, author, after, end, limit.min(20))?;
                let rows = batch.as_array().ok_or(CoreError::Storage)?;
                if rows.is_empty() { break; }
                after = rows.last().and_then(|v| v["sequence"].as_u64()).ok_or(CoreError::Storage)?;
                output.extend(rows.iter().cloned());
            }
        }
        Ok(json!(output))
    }

    fn store_chat(&mut self, chat: &Chat) -> Result<StoreResult, CoreError> {
        let chat_sequence = sql_sequence(chat.sequence)?;
        let tx = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| CoreError::Storage)?;
        let by_id: Option<(String,String,i64,String)> = tx.query_row("SELECT group_id,author_id,sequence,envelope_json FROM peer_messages WHERE message_id=?1", [&chat.message_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|_| CoreError::Storage)?;
        let by_seq: Option<String> = tx.query_row("SELECT message_id FROM peer_messages WHERE group_id=?1 AND author_id=?2 AND sequence=?3", params![chat.group_id,chat.sender_id,chat_sequence], |r| r.get(0)).optional().map_err(|_| CoreError::Storage)?;
        let result = if by_id.as_ref().is_some_and(|(g,a,s,j)| g==&chat.group_id && a==&chat.sender_id && *s==chat_sequence && j==&chat.canonical) { StoreResult::Duplicate }
            else if by_id.is_some() || by_seq.is_some() { StoreResult::Conflict }
            else {
                tx.execute("INSERT INTO peer_messages(message_id,group_id,author_id,sequence,envelope_json) VALUES (?1,?2,?3,?4,?5)", params![chat.message_id,chat.group_id,chat.sender_id,chat_sequence,chat.canonical]).map_err(|_|CoreError::Storage)?;
                StoreResult::Inserted
            };
        tx.commit().map_err(|_| CoreError::Storage)?;
        Ok(result)
    }

    fn read_missing(&self, group: &str, author: &str, after: u64, through: u64, limit: u32) -> Result<Value, CoreError> {
        if after > MAX_SEQUENCE || through > MAX_SEQUENCE { return Err(CoreError::InvalidRange); }
        if !(1..=10_000).contains(&limit) { return Err(CoreError::InvalidRange); }
        if group.is_empty() || author.is_empty() || through <= after { return Ok(json!([])); }
        let mut s = self.connection.prepare("SELECT envelope_json,message_id,group_id,author_id,sequence FROM peer_messages WHERE group_id=?1 AND author_id=?2 AND sequence>?3 AND sequence<=?4 ORDER BY sequence LIMIT ?5").map_err(|_| CoreError::Storage)?;
        let rows = s.query_map(params![group,author,sql_sequence(after)?,sql_sequence(through)?,limit], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?))).map_err(|_| CoreError::Storage)?;
        let mut out = Vec::new(); let mut expected = after + 1;
        for row in rows {
            let (text, message_id, row_group, row_author, sequence_sql) = row.map_err(|_| CoreError::Storage)?;
            let sequence = sequence_from_sql(sequence_sql)?;
            if sequence != expected { break; }
            let header = raw_envelope_header(&text, "chat")?;
            if header.group_id != row_group || header.sender_id != row_author || header.message_id.as_deref() != Some(message_id.as_str()) ||
                header.sequence != sequence || row_group != group || row_author != author {
                return Err(CoreError::InvalidEnvelope);
            }
            out.push(json!({"envelopeJson":text,"messageId":message_id,"groupId":row_group,"authorId":row_author,"sequence":sequence}));
            expected += 1;
        }
        Ok(json!(out))
    }

    fn highest_contiguous(&self, group: &str, author: &str) -> Result<u64, CoreError> {
        let mut s = self.connection.prepare("SELECT sequence FROM peer_messages WHERE group_id=?1 AND author_id=?2 ORDER BY sequence").map_err(|_| CoreError::Storage)?;
        let rows = s.query_map(params![group,author], |r| r.get::<_,i64>(0)).map_err(|_| CoreError::Storage)?;
        let mut expected = 1;
        for seq in rows {
            let seq = sequence_from_sql(seq.map_err(|_| CoreError::Storage)?)?;
            if seq != expected { break; }
            expected += 1;
        }
        Ok(expected - 1)
    }

    fn persist_ack(&mut self, local: &str, ack: &Ack) -> Result<(), CoreError> {
        let ack_sequence = sql_sequence(ack.sequence)?;
        let tx = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| CoreError::Storage)?;
        let owns: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM peer_messages WHERE group_id=?1 AND message_id=?2 AND sequence=?3 AND author_id=?4)", params![ack.group_id,ack.message_id,ack_sequence,local], |r| r.get(0)).map_err(|_| CoreError::Storage)?;
        if !owns { return Err(CoreError::Conflict); }
        let existing: Option<(String,String,i64,String,String)> = tx.query_row(
            "SELECT group_id,message_id,sequence,author_id,envelope_json FROM peer_message_acks WHERE group_id=?1 AND message_id=?2 AND sequence=?3 AND recipient_id=?4",
            params![ack.group_id,ack.message_id,ack_sequence,ack.sender_id],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
        ).optional().map_err(|_| CoreError::Storage)?;
        if let Some((group,message,sequence,author,envelope)) = existing {
            let stored = raw_envelope_header(&envelope, "ack")?;
            if group != ack.group_id || message != ack.message_id || sequence != ack_sequence || author != local ||
                envelope != ack.canonical || stored.group_id != group || stored.sender_id != ack.sender_id ||
                stored.message_id.as_deref() != Some(message.as_str()) || stored.sequence != ack.sequence {
                return Err(CoreError::InvalidEnvelope);
            }
        } else {
            tx.execute("INSERT INTO peer_message_acks(group_id,message_id,sequence,author_id,recipient_id,envelope_json) VALUES (?1,?2,?3,?4,?5,?6)", params![ack.group_id,ack.message_id,ack_sequence,local,ack.sender_id,ack.canonical]).map_err(|_|CoreError::Storage)?;
        }
        tx.commit().map_err(|_| CoreError::Storage)
    }
}



#[derive(Debug)]
struct Chat { group_id:String, sender_id:String, message_id:String, sequence:u64, canonical:String }
#[derive(Debug)]
struct Ack { group_id:String, sender_id:String, message_id:String, sequence:u64, canonical:String }
#[derive(Clone,Copy,PartialEq,Eq)]
enum StoreResult { Inserted, Duplicate, Conflict }

struct EnvelopeHeader {
    group_id: String,
    sender_id: String,
    message_id: Option<String>,
    created_at: Option<String>,
    sequence: u64,
}
fn raw_envelope_header(text: &str, kind: &str) -> Result<EnvelopeHeader, CoreError> {
    use serde_json::value::RawValue;
    let fields: BTreeMap<String, Box<RawValue>> = serde_json::from_str(text).map_err(|_| CoreError::InvalidEnvelope)?;
    let string = |key: &str| -> Result<String, CoreError> {
        let raw = fields.get(key).ok_or(CoreError::InvalidEnvelope)?;
        serde_json::from_str::<String>(raw.get()).map_err(|_| CoreError::InvalidEnvelope)
    };
    let version: u64 = raw_field(&fields, "version")?;
    if version != 1 || string("kind")? != kind { return Err(CoreError::InvalidEnvelope); }
    let sequence: u64 = raw_field(&fields, "sequence").map_err(|_| CoreError::InvalidSequence)?;
    if sequence == 0 || sequence > MAX_SEQUENCE { return Err(CoreError::InvalidSequence); }
    let message_id = fields.get("messageId")
        .map(|raw| serde_json::from_str::<String>(raw.get()).map_err(|_| CoreError::InvalidEnvelope))
        .transpose()?;
    let created_at = if kind == "chat" { Some(string("createdAt")?) } else { None };
    Ok(EnvelopeHeader { group_id: string("groupId")?, sender_id: string("senderId")?, message_id, created_at, sequence })
}
fn raw_field<T: serde::de::DeserializeOwned>(
    fields: &BTreeMap<String, Box<serde_json::value::RawValue>>,
    key: &str,
) -> Result<T, CoreError> {
    let raw = fields.get(key).ok_or(CoreError::InvalidEnvelope)?;
    serde_json::from_str(raw.get()).map_err(|_| CoreError::InvalidEnvelope)
}
fn projection_string(header:&Value,key:&str)->Result<String,CoreError>{
    header.get(key).and_then(Value::as_str).filter(|value|!value.is_empty()&&value.len()<=4096)
        .map(str::to_owned).ok_or(CoreError::InvalidEnvelope)
}
fn projection_sequence(header:&Value)->Result<u64,CoreError>{
    header.get("sequence").and_then(Value::as_u64).filter(|value|*value<=MAX_SEQUENCE).ok_or(CoreError::InvalidSequence)
}
fn checked_chat(text:&str,header:&Value)->Result<Chat,CoreError>{
    if text.is_empty()||text.len()>MAX_ENVELOPE_BYTES{return Err(CoreError::InputTooLarge)}
    if header.get("kind").and_then(Value::as_str)!=Some("chat"){return Err(CoreError::InvalidEnvelope)}
    let group_id = projection_string(header,"groupId")?;
    let sender_id = projection_string(header,"senderId")?;
    let message_id = projection_string(header,"messageId")?;
    let sequence = projection_sequence(header)?;
    let created_at = projection_string(header,"createdAt")?;
    let stored = raw_envelope_header(text, "chat")?;
    if stored.group_id != group_id || stored.sender_id != sender_id ||
        stored.message_id.as_deref() != Some(message_id.as_str()) || stored.sequence != sequence ||
        stored.created_at.as_deref() != Some(created_at.as_str()) {
        return Err(CoreError::InvalidEnvelope);
    }
    Ok(Chat{group_id,sender_id,message_id,sequence,canonical:text.to_owned()})
}
fn checked_ack(text:&str,header:&Value)->Result<Ack,CoreError>{
    if text.is_empty()||text.len()>MAX_ENVELOPE_BYTES{return Err(CoreError::InputTooLarge)}
    if header.get("kind").and_then(Value::as_str)!=Some("ack"){return Err(CoreError::InvalidEnvelope)}
    let group_id = projection_string(header,"groupId")?;
    let sender_id = projection_string(header,"senderId")?;
    let message_id = projection_string(header,"messageId")?;
    let sequence = projection_sequence(header)?;
    let stored = raw_envelope_header(text, "ack")?;
    if stored.group_id != group_id || stored.sender_id != sender_id || stored.message_id.as_deref() != Some(message_id.as_str()) || stored.sequence != sequence {
        return Err(CoreError::InvalidEnvelope);
    }
    Ok(Ack{group_id,sender_id,message_id,sequence,canonical:text.to_owned()})
}

fn validate_v5_schema(connection: &Connection) -> Result<(), CoreError> {
    let required: [(&str, &[&str]); 4] = [
        ("peer_messages", &["message_id", "group_id", "author_id", "sequence", "envelope_json"]),
        ("peer_message_acks", &["group_id", "message_id", "sequence", "author_id", "recipient_id", "envelope_json"]),
        ("cached_cloud_groups", &["id", "name", "created_at", "member_count", "role"]),
        ("cached_cloud_members", &["group_id", "user_id", "public_key", "joined_at", "role", "display_name", "avatar_data"]),
    ];
    for (table, columns) in required {
        let mut statement = connection.prepare(&format!("PRAGMA table_info({table})")).map_err(|_| CoreError::InvalidCache)?;
        let found = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|_| CoreError::InvalidCache)?
            .collect::<Result<std::collections::HashSet<_>, _>>().map_err(|_| CoreError::InvalidCache)?;
        if columns.iter().any(|column| !found.contains(*column)) { return Err(CoreError::InvalidCache); }
    }
    Ok(())
}

fn create_migration_backup(connection: &Connection, database_path: &Path, version: i64) -> Result<PathBuf, CoreError> {
    let parent = database_path.parent().unwrap_or_else(|| Path::new("."));
    let name = database_path.file_name().and_then(|name| name.to_str()).ok_or(CoreError::Storage)?;
    let suffix = MIGRATION_BACKUP_ID.fetch_add(1, Ordering::Relaxed);
    let stem = format!("{name}.pre-v5-v{version}-{}-{suffix}", std::process::id());
    let temporary = parent.join(format!("{stem}.tmp"));
    let backup_path = parent.join(format!("{stem}.sqlite"));
    if temporary.exists() || backup_path.exists() { return Err(CoreError::Storage); }
    let reservation = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| CoreError::Storage)?;
    drop(reservation);
    let backup_result = connection.backup(MAIN_DB, &temporary, None::<fn(Progress)>).map_err(|_| CoreError::Storage);
    if let Err(error) = backup_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let validation = (|| {
        let snapshot = Connection::open(&temporary).map_err(|_| CoreError::Storage)?;
        let integrity: String = snapshot.pragma_query_value(None, "integrity_check", |row| row.get(0)).map_err(|_| CoreError::Storage)?;
        let snapshot_version: i64 = snapshot.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(|_| CoreError::Storage)?;
        if integrity != "ok" || snapshot_version != version { return Err(CoreError::Storage); }
        Ok(())
    })();
    if let Err(error) = validation {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    fs::rename(&temporary, &backup_path).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        CoreError::Storage
    })?;
    Ok(backup_path)
}

fn migrate(connection:&Connection, database_path: &Path)->Result<(),CoreError>{
    let version:i64=connection.pragma_query_value(None,"user_version",|r|r.get(0)).map_err(|_|CoreError::Storage)?;
    if version>5{return Err(CoreError::UnsupportedVersion)}
    if version==5{return validate_v5_schema(connection)}
    if (2..=4).contains(&version) { create_migration_backup(connection, database_path, version)?; }
    let member_columns:Vec<String>=if version>=3{
        let mut st=connection.prepare("PRAGMA table_info(cached_cloud_members)").map_err(|_|CoreError::Storage)?;
        st.query_map([],|r|r.get(1)).map_err(|_|CoreError::Storage)?.collect::<Result<_,_>>().map_err(|_|CoreError::Storage)?
    }else{Vec::new()};
    let tx=connection.unchecked_transaction().map_err(|_|CoreError::Storage)?;
    if version<=1{
        tx.execute_batch("CREATE TABLE peer_messages (message_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, author_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991), envelope_json TEXT NOT NULL CHECK(length(CAST(envelope_json AS BLOB)) BETWEEN 1 AND 65536), UNIQUE(group_id,author_id,sequence), UNIQUE(group_id,message_id,sequence,author_id)); CREATE INDEX peer_messages_author_sequence ON peer_messages(group_id,author_id,sequence); CREATE TABLE peer_message_acks(group_id TEXT NOT NULL,message_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),author_id TEXT NOT NULL,recipient_id TEXT NOT NULL,envelope_json TEXT NOT NULL CHECK(length(CAST(envelope_json AS BLOB)) BETWEEN 1 AND 65536),PRIMARY KEY(group_id,message_id,sequence,recipient_id),FOREIGN KEY(group_id,message_id,sequence,author_id) REFERENCES peer_messages(group_id,message_id,sequence,author_id) ON DELETE CASCADE); CREATE TABLE cached_cloud_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),created_at TEXT NOT NULL,member_count INTEGER NOT NULL CHECK(member_count BETWEEN 1 AND 6),role TEXT NOT NULL CHECK(role IN ('owner','member'))); CREATE TABLE cached_cloud_members(group_id TEXT NOT NULL REFERENCES cached_cloud_groups(id) ON DELETE CASCADE,user_id TEXT NOT NULL,public_key TEXT NOT NULL CHECK(length(public_key) BETWEEN 1 AND 4096),joined_at TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','member')),PRIMARY KEY(group_id,user_id)); CREATE INDEX cached_cloud_members_by_user ON cached_cloud_members(user_id,group_id);").map_err(|_|CoreError::Storage)?;
    }else if version==2{
        tx.execute_batch("CREATE TABLE cached_cloud_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),created_at TEXT NOT NULL,member_count INTEGER NOT NULL CHECK(member_count BETWEEN 1 AND 6),role TEXT NOT NULL CHECK(role IN ('owner','member'))); CREATE TABLE cached_cloud_members(group_id TEXT NOT NULL REFERENCES cached_cloud_groups(id) ON DELETE CASCADE,user_id TEXT NOT NULL,public_key TEXT NOT NULL CHECK(length(public_key) BETWEEN 1 AND 4096),joined_at TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','member')),PRIMARY KEY(group_id,user_id)); CREATE INDEX cached_cloud_members_by_user ON cached_cloud_members(user_id,group_id);").map_err(|_|CoreError::Storage)?;
    }
    if !member_columns.iter().any(|c|c=="display_name"){tx.execute_batch("ALTER TABLE cached_cloud_members ADD COLUMN display_name TEXT CHECK(display_name IS NULL OR (display_name=trim(display_name) AND length(display_name) BETWEEN 1 AND 32));").map_err(|_|CoreError::Storage)?;}
    if !member_columns.iter().any(|c|c=="avatar_data"){tx.execute_batch("ALTER TABLE cached_cloud_members ADD COLUMN avatar_data TEXT CHECK(avatar_data IS NULL OR (length(avatar_data) BETWEEN 27 AND 66000 AND substr(avatar_data,1,23)='data:image/webp;base64,'));").map_err(|_|CoreError::Storage)?;}
    if version == 3 {
        tx.execute_batch("DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS participants; DROP TABLE IF EXISTS groups;")
            .map_err(|_| CoreError::Storage)?;
    }
    tx.pragma_update(None,"user_version",5).map_err(|_|CoreError::Storage)?;
    tx.commit().map_err(|_|CoreError::Storage)
}

fn valid_id(value:&str,max:usize)->bool{!value.is_empty()&&value.len()<=max}
fn valid_date(value:&str)->bool{time::OffsetDateTime::parse(value,&time::format_description::well_known::Rfc3339).is_ok()}
fn validate_group(g:&GroupSummary)->Result<(),CoreError>{if !valid_id(&g.id,80)||js_trim(&g.name).is_empty()||g.name.encode_utf16().count()>80||!valid_date(&g.created_at)||!(1..=6).contains(&g.member_count){Err(CoreError::InvalidCache)}else{Ok(())}}
fn validate_members(ms:&[GroupMember])->Result<(),CoreError>{
    if !(1..=6).contains(&ms.len())||ms.iter().filter(|m|m.role==GroupRole::Owner).count()!=1{return Err(CoreError::InvalidCache)}
    let mut ids=std::collections::HashSet::new();
    for m in ms {if !valid_id(&m.user_id,80)||!ids.insert(&m.user_id)||!valid_id(&m.public_key,4096)||!valid_date(&m.joined_at){return Err(CoreError::InvalidCache)}
        identity::validate_public_pem(&m.public_key).map_err(|_| CoreError::InvalidCache)?;
        if let Some(p)=&m.profile {validate_profile(p,&m.user_id)?;}}
    Ok(())
}
pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| matches!(c,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
fn valid_webp(bytes: &[u8]) -> bool {
    if bytes.len() < 20 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP"
        || u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8 != bytes.len() { return false; }
    let mut offset = 12usize;
    let mut first = true;
    let mut has_image = false;
    while offset + 8 <= bytes.len() {
        let name = &bytes[offset..offset + 4];
        let length = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let Some(next) = offset.checked_add(8).and_then(|n| n.checked_add(length)).and_then(|n| n.checked_add(length & 1)) else { return false };
        if next > bytes.len() || (first && length == 0)
            || (name == b"VP8X" && length != 10)
            || (name == b"VP8 " && length < 10)
            || (name == b"VP8L" && length < 5)
            || (first && name != b"VP8 " && name != b"VP8L" && name != b"VP8X") { return false; }
        if name == b"VP8 " || name == b"VP8L" { has_image = true; }
        first = false;
        offset = next;
    }
    !first && has_image && offset == bytes.len()
}
pub fn normalize_profile_name(value:&str)->Result<Option<String>,CoreError>{
    if value.encode_utf16().count()>256{return Err(CoreError::InvalidProfile)}
    let name=js_trim(value);
    if name.chars().count()>32{return Err(CoreError::InvalidProfile)}
    Ok((!name.is_empty()).then(||name.to_owned()))
}
pub fn validate_profile(p:&UserProfile,id:&str)->Result<(),CoreError>{
    use base64::Engine;
    if p.user_id!=id{return Err(CoreError::InvalidCache)}
    if let Some(name)=&p.display_name {
        if name.encode_utf16().count()>256 || js_trim(name).chars().count()>32{return Err(CoreError::InvalidCache)}
    }
    if let Some(data)=&p.avatar_data {
        let prefix="data:image/webp;base64,";
        if data.encode_utf16().count()>66_000||!data.starts_with(prefix){return Err(CoreError::InvalidCache)}
        let payload=&data[prefix.len()..];
        if payload.is_empty(){return Err(CoreError::InvalidCache)}
        let bytes=base64::engine::general_purpose::STANDARD.decode(payload).map_err(|_|CoreError::InvalidCache)?;
        if bytes.len()>48*1024||base64::engine::general_purpose::STANDARD.encode(&bytes)!=payload||!valid_webp(&bytes){return Err(CoreError::InvalidCache)}
    }
    Ok(())
}
fn role(r:GroupRole)->&'static str{match r{GroupRole::Owner=>"owner",GroupRole::Member=>"member"}}
fn insert_members(tx:&rusqlite::Transaction<'_>,group:&str,ms:&[GroupMember])->Result<(),CoreError>{
    tx.execute("DELETE FROM cached_cloud_members WHERE group_id=?1",[group]).map_err(|_|CoreError::Storage)?;
    for m in ms {
        let name=m.profile.as_ref().and_then(|p|p.display_name.as_deref()).map(js_trim).filter(|s|!s.is_empty());
        let avatar=m.profile.as_ref().and_then(|p|p.avatar_data.as_deref());
        tx.execute("INSERT INTO cached_cloud_members(group_id,user_id,public_key,joined_at,role,display_name,avatar_data) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![group,m.user_id,m.public_key,m.joined_at,role(m.role),name,avatar]).map_err(|_|CoreError::InvalidCache)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{EmptyPayload, StorageGetCachedCloudMembers, StoragePersistOutgoing, StoragePersistVerifiedIncoming, StorageGetHighestContiguous, StorageReadMissing, StoragePersistAck, StorageReplaceCloudCache};
    use serde_json::json;

    fn db_path(label:&str)->String {
        std::env::temp_dir().join(format!("larp-storage-{label}-{}-{}.sqlite",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())).to_string_lossy().into_owned()
    }
    fn chat(author:&str,id:&str,seq:u64)->String {
        json!({"version":1,"kind":"chat","groupId":"room","senderId":author,"messageId":id,"sequence":seq,"content":"hi","createdAt":"2026-01-01T00:00:00.000Z","signature":{"algorithm":"Ed25519","signature":"AQ=="}}).to_string()
    }
    fn ack(author:&str,id:&str,seq:u64)->String {
        json!({"version":1,"kind":"ack","groupId":"room","senderId":author,"messageId":id,"sequence":seq,"signature":{"algorithm":"Ed25519","signature":"AQ=="}}).to_string()
    }
    fn outgoing(db:&mut LocalDatabase,text:String)->Result<Value,CoreError> {
        let header:Value=serde_json::from_str(&text).unwrap();
        db.handle(StorageCommand::PersistOutgoing(StoragePersistOutgoing{local_user_id:"local".into(),envelope_json:text,header}))
    }
    fn incoming(db:&mut LocalDatabase,text:String)->Result<Value,CoreError> {
        let header:Value=serde_json::from_str(&text).unwrap();
        db.handle(StorageCommand::PersistVerifiedIncoming(StoragePersistVerifiedIncoming{envelope_json:text,header}))
    }
    #[test]
    fn opens_v5_database_and_rejects_future_schema() {
        let path=db_path("new");
        let mut db=LocalDatabase::open(&path).unwrap();
        assert_eq!(db.handle(StorageCommand::GetCachedCloudGroups(EmptyPayload{})).unwrap(),json!([]));
        drop(db);
        let conn=Connection::open(&path).unwrap();
        let version:i64=conn.pragma_query_value(None,"user_version",|r|r.get(0)).unwrap();
        assert_eq!(version,5);
        let legacy_tables: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('groups','participants','messages')",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(legacy_tables, 0);
        conn.pragma_update(None,"user_version",6).unwrap();
        drop(conn);
        assert_eq!(LocalDatabase::open(&path).err(),Some(CoreError::UnsupportedVersion));
        let _=std::fs::remove_file(&path);
        let _=std::fs::remove_file(format!("{path}-wal"));
        let _=std::fs::remove_file(format!("{path}-shm"));
    }
    #[test]
    fn message_duplicate_conflict_prefix_and_ack_ownership() {
        let path=db_path("messages");let mut db=LocalDatabase::open(&path).unwrap();
        outgoing(&mut db,chat("local","m1",1)).unwrap();
        assert_eq!(incoming(&mut db,chat("local","m1",1)).unwrap(),json!("duplicate"));
        assert_eq!(incoming(&mut db,chat("local","different",1)).unwrap(),json!("conflict"));
        assert_eq!(incoming(&mut db,chat("other","m1",1)).unwrap(),json!("conflict"));
        incoming(&mut db,chat("other","m3",3)).unwrap();
        assert_eq!(db.handle(StorageCommand::GetHighestContiguous(StorageGetHighestContiguous{group_id:"room".into(),author_id:"other".into()})).unwrap(),json!(0));
        incoming(&mut db,chat("other","m2",2)).unwrap();
        incoming(&mut db,chat("other","other-m1",1)).unwrap();
        assert_eq!(db.handle(StorageCommand::GetHighestContiguous(StorageGetHighestContiguous{group_id:"room".into(),author_id:"other".into()})).unwrap(),json!(3));
        let range=db.handle(StorageCommand::ReadMissing(StorageReadMissing{group_id:"room".into(),author_id:"other".into(),after_sequence:0,through_sequence:3,limit:10})).unwrap();
        assert_eq!(range.as_array().unwrap().len(),3);
        assert_eq!(range[0]["envelopeJson"].as_str(),Some(chat("other","other-m1",1).as_str()));
        let acknowledgement=ack("recipient","m1",1);
        let header:Value=serde_json::from_str(&acknowledgement).unwrap();
        db.handle(StorageCommand::PersistAck(StoragePersistAck{local_user_id:"other".into(),envelope_json:acknowledgement.clone(),header:header.clone()})).unwrap_err();
        db.handle(StorageCommand::PersistAck(StoragePersistAck{local_user_id:"local".into(),envelope_json:acknowledgement.clone(),header:header.clone()})).unwrap();
        let corrupted_ack = acknowledgement.replace("AQ==", "Ag==");
        db.connection.execute("UPDATE peer_message_acks SET envelope_json=?1 WHERE group_id='room' AND message_id='m1'", [&corrupted_ack]).unwrap();
        assert_eq!(
            db.handle(StorageCommand::PersistAck(StoragePersistAck{local_user_id:"local".into(),envelope_json:acknowledgement.clone(),header:header.clone()})),
            Err(CoreError::InvalidEnvelope),
        );
        assert_eq!(db.handle(StorageCommand::ReadMissing(StorageReadMissing{group_id:"room".into(),author_id:"other".into(),after_sequence:0,through_sequence:3,limit:10_001})).err(),Some(CoreError::InvalidRange));
        drop(db);let _=std::fs::remove_file(&path);
    }
    #[test]
    fn legacy_schema_migrations_keep_data_and_verified_snapshots() {
        for version in 2_i64..=4 {
            let path = db_path(&format!("migration-v{version}"));
            drop(LocalDatabase::open(&path).unwrap());
            let connection = Connection::open(&path).unwrap();
            let message = chat("author", "m1", 1);
            let acknowledgement = ack("recipient", "m1", 1);
            connection.execute(
                "INSERT INTO peer_messages(message_id,group_id,author_id,sequence,envelope_json) VALUES ('m1','room','author',1,?1)",
                [&message],
            ).unwrap();
            connection.execute(
                "INSERT INTO peer_message_acks(group_id,message_id,sequence,author_id,recipient_id,envelope_json) VALUES ('room','m1',1,'author','recipient',?1)",
                [&acknowledgement],
            ).unwrap();
            connection.execute_batch("DROP TABLE cached_cloud_members; DROP TABLE cached_cloud_groups;").unwrap();
            if version >= 3 {
                connection.execute_batch("CREATE TABLE cached_cloud_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,member_count INTEGER NOT NULL,role TEXT NOT NULL); CREATE TABLE cached_cloud_members(group_id TEXT NOT NULL REFERENCES cached_cloud_groups(id),user_id TEXT NOT NULL,public_key TEXT NOT NULL,joined_at TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(group_id,user_id));").unwrap();
                connection.execute("INSERT INTO cached_cloud_groups(id,name,created_at,member_count,role) VALUES ('room','Room','2026-01-01T00:00:00.000Z',1,'owner')", []).unwrap();
                connection.execute("INSERT INTO cached_cloud_members(group_id,user_id,public_key,joined_at,role) VALUES ('room','author','public','2026-01-01T00:00:00.000Z','owner')", []).unwrap();
                if version == 4 {
                    connection.execute_batch("ALTER TABLE cached_cloud_members ADD COLUMN display_name TEXT; ALTER TABLE cached_cloud_members ADD COLUMN avatar_data TEXT; UPDATE cached_cloud_members SET display_name='Saved profile', avatar_data='data:image/webp;base64,QUJD';").unwrap();
                }
            }
            if version == 3 {
                connection.execute_batch("CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE participants(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id)); CREATE TABLE messages(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id),content TEXT NOT NULL); INSERT INTO groups VALUES ('legacy-group','Legacy'); INSERT INTO participants VALUES ('legacy-member','legacy-group'); INSERT INTO messages VALUES ('legacy-message','legacy-group','legacy content');").unwrap();
            }
            connection.pragma_update(None, "user_version", version).unwrap();
            drop(connection);

            drop(LocalDatabase::open(&path).unwrap());
            let migrated = Connection::open(&path).unwrap();
            let migrated_version: i64 = migrated.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
            assert_eq!(migrated_version, 5);
            let messages: i64 = migrated.query_row("SELECT COUNT(*) FROM peer_messages", [], |row| row.get(0)).unwrap();
            let acks: i64 = migrated.query_row("SELECT COUNT(*) FROM peer_message_acks", [], |row| row.get(0)).unwrap();
            assert_eq!((messages, acks), (1, 1));
            if version == 3 {
                let legacy_tables: i64 = migrated.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('groups','participants','messages')",
                    [],
                    |row| row.get(0),
                ).unwrap();
                assert_eq!(legacy_tables, 0);
                let stored_ack: String = migrated.query_row(
                    "SELECT envelope_json FROM peer_message_acks WHERE message_id='m1'",
                    [],
                    |row| row.get(0),
                ).unwrap();
                assert_eq!(serde_json::from_str::<Value>(&stored_ack).unwrap(), serde_json::from_str::<Value>(&acknowledgement).unwrap());
            }
            if version >= 3 {
                let member: (String, Option<String>, Option<String>) = migrated.query_row(
                    "SELECT public_key,display_name,avatar_data FROM cached_cloud_members WHERE group_id='room' AND user_id='author'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                ).unwrap();
                let expected = if version == 4 {
                    ("public".to_owned(), Some("Saved profile".to_owned()), Some("data:image/webp;base64,QUJD".to_owned()))
                } else {
                    ("public".to_owned(), None, None)
                };
                assert_eq!(member, expected);
            }
            drop(migrated);

            let prefix = format!("{}.pre-v5-v{version}-", Path::new(&path).file_name().unwrap().to_string_lossy());
            let backup = fs::read_dir(Path::new(&path).parent().unwrap()).unwrap()
                .filter_map(Result::ok)
                .find(|entry| entry.file_name().to_string_lossy().starts_with(&prefix) &&
                    entry.file_name().to_string_lossy().ends_with(".sqlite"))
                .map(|entry| entry.path()).expect("migration snapshot exists");
            let snapshot = Connection::open(&backup).unwrap();
            let backup_version: i64 = snapshot.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
            let backup_messages: i64 = snapshot.query_row("SELECT COUNT(*) FROM peer_messages", [], |row| row.get(0)).unwrap();
            let backup_acks: i64 = snapshot.query_row("SELECT COUNT(*) FROM peer_message_acks", [], |row| row.get(0)).unwrap();
            assert_eq!((backup_version, backup_messages, backup_acks), (version, 1, 1));
            if version == 2 {
                let cache_tables: i64 = snapshot.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'cached_cloud_%'", [], |row| row.get(0)).unwrap();
                assert_eq!(cache_tables, 0);
            } else {
                let members: i64 = snapshot.query_row("SELECT COUNT(*) FROM cached_cloud_members", [], |row| row.get(0)).unwrap();
                assert_eq!(members, 1);
            }
            drop(snapshot);
            let _ = fs::remove_file(&backup);
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(format!("{path}-wal"));
            let _ = fs::remove_file(format!("{path}-shm"));
        }
    }

    #[test]
    fn migration_backup_failure_aborts_before_schema_changes() {
        let path = db_path("migration-backup-failure");
        drop(LocalDatabase::open(&path).unwrap());
        let connection = Connection::open(&path).unwrap();
        connection.pragma_update(None, "user_version", 4).unwrap();
        let missing_parent = Path::new(&path).with_extension("missing-parent");
        let impossible_path = missing_parent.join("legacy.sqlite");
        assert_eq!(migrate(&connection, &impossible_path), Err(CoreError::Storage));
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
        assert_eq!(version, 4);
        let columns: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('cached_cloud_members') WHERE name IN ('display_name','avatar_data')",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(columns, 2);
        drop(connection);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(format!("{path}-wal"));
        let _ = fs::remove_file(format!("{path}-shm"));
    }

    #[test]
    fn raw_chat_metadata_is_bound_without_decoding_opaque_json_strings() {
        let envelope = r#"{"version":1,"kind":"chat","groupId":"room","senderId":"author","messageId":"m1","sequence":1,"content":"\ud800","createdAt":"2026-01-01T00:00:00.000Z","signature":{"algorithm":"Ed25519","signature":"AQ=="}}"#;
        let header = json!({"kind":"chat","groupId":"room","senderId":"author","messageId":"m1","sequence":1,"createdAt":"2026-01-01T00:00:00.000Z"});
        assert!(checked_chat(envelope, &header).is_ok());
        assert_eq!(checked_chat(envelope, &json!({"kind":"chat","groupId":"wrong","senderId":"author","messageId":"m1","sequence":1,"createdAt":"2026-01-01T00:00:00.000Z"})).err(), Some(CoreError::InvalidEnvelope));
    }
    #[test]
    fn cloud_cache_round_trip_and_replace_is_atomic() {
        let path=db_path("cache");let mut db=LocalDatabase::open(&path).unwrap();
        let group=GroupSummary{id:"room".into(),name:"Room".into(),created_at:"2026-01-01T00:00:00.000Z".into(),member_count:1,role:GroupRole::Owner};
        let member=GroupMember{user_id:"local".into(),public_key:"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----\n".into(),joined_at:"2026-01-01T00:00:00.000Z".into(),role:GroupRole::Owner,profile:None};
        db.handle(StorageCommand::ReplaceCloudCache(StorageReplaceCloudCache{groups:vec![group.clone()],members_by_group:[("room".into(),vec![member.clone()])].into()})).unwrap();
        assert_eq!(db.handle(StorageCommand::GetCachedCloudGroups(EmptyPayload{})).unwrap(),json!([group]));
        assert_eq!(db.handle(StorageCommand::GetCachedCloudMembers(StorageGetCachedCloudMembers{group_id:"room".into()})).unwrap(),json!([member]));
        drop(db);let _=std::fs::remove_file(&path);
    }
    #[test]
    fn profile_fields_match_typescript_name_and_webp_validation() {
        use base64::Engine;
        let profile=|name:Option<String>,avatar:Option<String>|UserProfile{user_id:"user".into(),display_name:name,avatar_data:avatar};
        assert!(validate_profile(&profile(Some("  ".into()),None),"user").is_ok());
        assert!(validate_profile(&profile(Some("😀".repeat(32)),None),"user").is_ok());
        assert_eq!(validate_profile(&profile(Some("😀".repeat(33)),None),"user").err(),Some(CoreError::InvalidCache));
        assert_eq!(validate_profile(&profile(Some("😀".repeat(129)),None),"user").err(),Some(CoreError::InvalidCache));

        let webp = |size: usize| {
            let mut bytes = vec![0u8; size];
            bytes[0..4].copy_from_slice(b"RIFF");
            bytes[4..8].copy_from_slice(&((size - 8) as u32).to_le_bytes());
            bytes[8..12].copy_from_slice(b"WEBP");
            bytes[12..16].copy_from_slice(b"VP8 ");
            bytes[16..20].copy_from_slice(&((size - 20) as u32).to_le_bytes());
            bytes
        };
        let max_avatar = webp(48 * 1024);
        let uri = format!("data:image/webp;base64,{}", base64::engine::general_purpose::STANDARD.encode(&max_avatar));
        assert!(validate_profile(&profile(None, Some(uri.clone())), "user").is_ok());
        assert_eq!(validate_profile(&profile(None, Some(format!("{uri}="))), "user").err(), Some(CoreError::InvalidCache));
        let oversize_avatar = webp(48 * 1024 + 2);
        let oversize_uri = format!("data:image/webp;base64,{}", base64::engine::general_purpose::STANDARD.encode(&oversize_avatar));
        assert_eq!(validate_profile(&profile(None, Some(oversize_uri)), "user").err(), Some(CoreError::InvalidCache));
        let mut invalid_webp = max_avatar;
        invalid_webp[8] = b'X';
        let invalid = format!("data:image/webp;base64,{}", base64::engine::general_purpose::STANDARD.encode(&invalid_webp));
        assert_eq!(validate_profile(&profile(None, Some(invalid)), "user").err(), Some(CoreError::InvalidCache));
        assert_eq!(validate_profile(&profile(None, None), "other").err(), Some(CoreError::InvalidCache));
    }
    #[test]
    fn group_name_limit_matches_javascript_utf16_length_and_trim() {
        let group = |name: String| GroupSummary {
            id: "room".into(), name, created_at: "2026-01-01T00:00:00.000Z".into(),
            member_count: 1, role: GroupRole::Owner,
        };
        assert!(validate_group(&group("😀".repeat(40))).is_ok());
        assert_eq!(validate_group(&group("😀".repeat(41))).err(), Some(CoreError::InvalidCache));
        assert_eq!(validate_group(&group("\u{feff}".into())).err(), Some(CoreError::InvalidCache));
    }
}
