use std::collections::BTreeMap;
use serde_json::Value;

use serde::{Deserialize, Deserializer, Serialize};


pub const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;


#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GroupRole {
    Owner,
    Member,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GroupSummary {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub member_count: u32,
    pub role: GroupRole,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UserProfile {
    pub user_id: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub display_name: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub avatar_data: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GroupMember {
    pub user_id: String,
    pub public_key: String,
    pub joined_at: String,
    pub role: GroupRole,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub profile: Option<UserProfile>,
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmptyPayload {}


#[derive(Deserialize)]
#[serde(tag = "op", content = "payload", rename_all = "kebab-case", deny_unknown_fields)]
pub enum StorageCommand {
    ReplaceCloudCache(StorageReplaceCloudCache),
    CacheCloudMembers(StorageCacheCloudMembers),
    GetCachedCloudGroups(EmptyPayload),
    GetCachedCloudMembers(StorageGetCachedCloudMembers),
    GetCachedMessages(StorageGetCachedMessages),
    PersistOutgoing(StoragePersistOutgoing),
    PersistVerifiedIncoming(StoragePersistVerifiedIncoming),
    ReadMissing(StorageReadMissing),
    PersistAck(StoragePersistAck),
    GetHighestContiguous(StorageGetHighestContiguous),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageReplaceCloudCache {
    pub groups: Vec<GroupSummary>,
    pub members_by_group: BTreeMap<String, Vec<GroupMember>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageCacheCloudMembers {
    pub group_id: String,
    pub members: Vec<GroupMember>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageGetCachedCloudMembers {
    pub group_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageGetCachedMessages {
    pub group_id: String,
    pub per_author_limit: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StoragePersistOutgoing {
    pub local_user_id: String,
    pub envelope_json: String,
    pub header: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StoragePersistVerifiedIncoming {
    pub envelope_json: String,
    pub header: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageReadMissing {
    pub group_id: String,
    pub author_id: String,
    pub after_sequence: u64,
    pub through_sequence: u64,
    pub limit: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StoragePersistAck {
    pub local_user_id: String,
    pub envelope_json: String,
    pub header: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageGetHighestContiguous {
    pub group_id: String,
    pub author_id: String,
}

