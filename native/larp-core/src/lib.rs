mod cloud_http;
mod contracts;
mod error;
mod identity;
mod storage;

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, atomic::{AtomicBool, AtomicUsize, Ordering}, mpsc::{self, SyncSender}},
    thread::{self, JoinHandle},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use napi::{
    bindgen_prelude::Promise,
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
    Error, Result as NapiResult, Status,
};
use napi_derive::napi;
use serde_json::{json, Value};
use zeroize::Zeroizing;
use crate::{contracts::{StorageCommand, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES}, error::CoreError};

const TSFN_QUEUE_SIZE: usize = 128;


const MAX_PENDING_REQUESTS: usize = 64;
const MAX_PENDING_BYTES: usize = 8 * 1024 * 1024;
const MAX_PENDING_EVENTS: usize = 128;
const MAX_EVENT_BYTES: usize = 8 * 1024 * 1024;
type HostCall = ThreadsafeFunction<String, Promise<String>, String, Status, true, false, TSFN_QUEUE_SIZE>;
type CoreEvent = ThreadsafeFunction<String, (), String, Status, true, false, TSFN_QUEUE_SIZE>;
enum WorkerMessage {
    Run(String, tokio::sync::oneshot::Sender<Result<Value, CoreError>>),
    Stop,
}

struct SubscriptionState { generation: usize, epoch: u64, group_id: String, kind: &'static str, member_ids: HashSet<String>, member_public_keys: HashMap<String, String>, presence_ready: bool, invalidated: bool, canceled: bool }
struct SubscriptionRegistry {
    states: HashMap<String, SubscriptionState>,
    canceled: HashSet<(String, u64)>,
}
struct CoreInner {
    host_call: Mutex<Option<Arc<HostCall>>>,
    on_event: Mutex<Option<Arc<CoreEvent>>>,
    storage_tx: SyncSender<WorkerMessage>,
    user_data_dir: PathBuf,
    cloud_http: Option<cloud_http::CloudHttp>,
    cloud_url: Option<String>,
    session_map: Mutex<Option<BTreeMap<String, String>>>,
    session_lock: tokio::sync::Mutex<()>,
    identity_lock: tokio::sync::Mutex<()>,
    cloud_status: Mutex<Value>,
    subscriptions: Mutex<SubscriptionRegistry>,
    pending_errors: Arc<Mutex<HashMap<String, (u64, String)>>>,
    event_stop: Arc<AtomicBool>,
    event_worker: Mutex<Option<JoinHandle<()>>>,
    event_calls: AtomicUsize,
    admission_count: AtomicUsize,
    admission_bytes: AtomicUsize,
    event_count: AtomicUsize,
    event_bytes: AtomicUsize,
    drain_notify: Arc<tokio::sync::Notify>,
    closed: AtomicBool,
    close_complete: AtomicBool,
    subscription_generation: AtomicUsize,
    worker: Mutex<Option<JoinHandle<()>>>,
    close_lock: tokio::sync::Mutex<()>,
}
#[napi]
pub struct NativeLarpCore { inner: Arc<CoreInner> }
#[napi(object)]
pub struct CloudConfiguration {
    pub url: String,
    #[napi(js_name = "anonKey")]
    pub anon_key: String,
}

#[napi]
pub async fn open_core(
    user_data_path: String,
    cloud_config: Option<CloudConfiguration>,
    host_call: HostCall,
    on_event: CoreEvent,
) -> NapiResult<NativeLarpCore> {
    if user_data_path.is_empty() || user_data_path.len() > 32_768 { return Err(napi_error(CoreError::InvalidRequest)); }
    let (cloud_http, cloud_url) = match cloud_config.as_ref() {
        Some(configuration) => {
            validate_cloud_url(&configuration.url).map_err(napi_error)?;
            let http = cloud_http::CloudHttp::new(&configuration.url, &configuration.anon_key).map_err(napi_error)?;
            (Some(http), Some(configuration.url.clone()))
        }
        None => (None, None),
    };
    let user_data_dir = PathBuf::from(user_data_path);
    fs::create_dir_all(&user_data_dir).map_err(|_| napi_error(CoreError::Storage))?;
    let path = user_data_dir.join("larp.sqlite").to_string_lossy().into_owned();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (storage_tx, storage_rx) = mpsc::sync_channel::<WorkerMessage>(64);
    let worker = thread::Builder::new().name("larp-sqlite".into()).spawn(move || {
        let mut database = match storage::LocalDatabase::open(&path) {
            Ok(database) => { if ready_tx.send(Ok(())).is_err() { return; } database }
            Err(error) => { let _ = ready_tx.send(Err(error)); return; }
        };
        while let Ok(message) = storage_rx.recv() {
            match message {
                WorkerMessage::Run(raw, reply) => {
                    let result = serde_json::from_str::<StorageCommand>(&raw)
                        .map_err(|_| CoreError::InvalidRequest)
                        .and_then(|command| database.handle(command));
                    let _ = reply.send(result);
                }
                WorkerMessage::Stop => break,
            }
        }
    }).map_err(|_| napi_error(CoreError::Storage))?;
    match ready_rx.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => { let _ = worker.join(); return Err(napi_error(error)); }
        Err(_) => { let _ = worker.join(); return Err(napi_error(CoreError::Storage)); }
    }

    let pending_errors = Arc::new(Mutex::new(HashMap::<String, (u64, String)>::new()));
    let event_stop = Arc::new(AtomicBool::new(false));
    let on_event = Arc::new(on_event);
    let event_events = Arc::clone(&on_event);
    let event_pending = Arc::clone(&pending_errors);
    let event_stop_thread = Arc::clone(&event_stop);
    let drain_notify = Arc::new(tokio::sync::Notify::new());
    let event_drain = Arc::clone(&drain_notify);
    let event_worker = match thread::Builder::new().name("larp-events".into()).spawn(move || loop {
        let next = event_pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter().next().map(|(id, (epoch, message))| (id.clone(), *epoch, message.clone()));
        if let Some((id, epoch, message)) = next {
            let event_json = json!({"subscriptionId":id,"epoch":epoch,"kind":"error","payload":{"message":message}}).to_string();
            if event_events.call(Ok(event_json), ThreadsafeFunctionCallMode::NonBlocking) == Status::Ok {
                let mut pending = event_pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if pending.get(&id).is_some_and(|(pending_epoch, _)| *pending_epoch == epoch) {
                    pending.remove(&id);
                    event_drain.notify_waiters();
                }
            } else if event_stop_thread.load(Ordering::Acquire) {
                break;
            } else {
                thread::sleep(std::time::Duration::from_millis(5));
            }
        } else if event_stop_thread.load(Ordering::Acquire) {
            break;
        } else {
            thread::sleep(std::time::Duration::from_millis(10));
        }
    }) {
        Ok(worker) => worker,
        Err(_) => {
            let _ = storage_tx.send(WorkerMessage::Stop);
            let _ = worker.join();
            return Err(napi_error(CoreError::Internal));
        }
    };
    Ok(NativeLarpCore { inner: Arc::new(CoreInner {
        host_call: Mutex::new(Some(Arc::new(host_call))), on_event: Mutex::new(Some(on_event)), storage_tx, user_data_dir, cloud_http, cloud_url,
        session_map: Mutex::new(None), session_lock: tokio::sync::Mutex::new(()),
        identity_lock: tokio::sync::Mutex::new(()),
        cloud_status: Mutex::new(json!({"state":"connecting","detail":"Starting cloud services","groups":[]})),
        subscriptions: Mutex::new(SubscriptionRegistry { states: HashMap::new(), canceled: HashSet::new() }),
        pending_errors, event_stop, event_worker: Mutex::new(Some(event_worker)),
        event_calls: AtomicUsize::new(0),
        admission_count: AtomicUsize::new(0), admission_bytes: AtomicUsize::new(0),
        event_count: AtomicUsize::new(0), event_bytes: AtomicUsize::new(0),
        drain_notify, closed: AtomicBool::new(false), close_complete: AtomicBool::new(false),
        subscription_generation: AtomicUsize::new(0), worker: Mutex::new(Some(worker)), close_lock: tokio::sync::Mutex::new(()),
    }) })
}

#[napi]
impl NativeLarpCore {
    #[napi]
    pub async fn request(&self, request_json: String) -> NapiResult<String> {
        let bytes = request_json.len();
        if bytes > MAX_REQUEST_BYTES { return Ok(failure(CoreError::InputTooLarge)); }
        let permit = match RequestPermit::acquire(&self.inner, bytes) {
            Ok(permit) => permit,
            Err(error) => return Ok(failure(error)),
        };
        let request = match parse_request(&request_json) { Ok(request) => request, Err(error) => return Ok(failure(error)) };
        if matches!(request.op.as_str(), "getCachedMessages" | "getRecentMessages" | "readMissingEnvelopes") {
            let result = self.read_stored_messages(&request).await;
            drop(permit);
            return match result {
                Ok(envelopes) => raw_envelope_response(&envelopes),
                Err(error) => Ok(failure(error)),
            };
        }
        let result = self.dispatch(request).await;
        drop(permit);
        match result { Ok(value) => response(value), Err(error) => Ok(failure(error)) }
    }

    #[napi]
    pub async fn ingest_cloud_event(&self, subscription_id: String, epoch: f64, event_json: String) -> NapiResult<()> {
        let _call_permit = EventCallPermit::acquire(&self.inner).map_err(napi_error)?;
        let epoch = safe_js_epoch(epoch).ok_or_else(|| napi_error(CoreError::InvalidRequest))?;
        let bytes = event_json.len();
        if !valid_subscription_id(&subscription_id) || bytes > MAX_EVENT_BYTES { return Err(napi_error(CoreError::InvalidRequest)); }
        let fields = raw_object_fields(&event_json).map_err(napi_error)?;
        let kind: String = raw_field(&fields, "kind").map_err(napi_error)?;
        if kind == "cancel" {
            if fields.len() != 1 { return Err(napi_error(CoreError::InvalidRequest)); }
            let permit = EventPermit::acquire_cancel(&self.inner).map_err(napi_error)?;
            let result = self.cancel_subscription(&subscription_id, epoch).await;
            drop(permit);
            return result;
        }
        if fields.keys().any(|key| !matches!(key.as_str(), "kind" | "payload" | "subscriptionId" | "epoch")) {
            return Err(napi_error(CoreError::InvalidRequest));
        }
        let (generation, group_id, subscription_kind, member_ids, member_public_keys) = {
            let registry = self.inner.subscriptions.lock().map_err(|_| napi_error(CoreError::Internal))?;
            match registry.states.get(&subscription_id) {
                Some(state) if state.epoch == epoch && !state.invalidated =>
                    (state.generation, state.group_id.clone(), state.kind, state.member_ids.clone(), state.member_public_keys.clone()),
                _ => return Err(napi_error(CoreError::Closed)),
            }
        };
        let permit = match EventPermit::acquire(&self.inner, bytes) {
            Ok(permit) => permit,
            Err(CoreError::Backpressure) => return self.defer_event_error(&subscription_id, generation, epoch, &group_id).await,
            Err(error) => return Err(napi_error(error)),
        };
        if let Some(raw) = fields.get("subscriptionId") {
            let value: String = serde_json::from_str(raw.get()).map_err(|_| napi_error(CoreError::InvalidRequest))?;
            if value != subscription_id { return Err(napi_error(CoreError::Closed)); }
        }
        if let Some(raw) = fields.get("epoch") {
            let value: f64 = serde_json::from_str(raw.get()).map_err(|_| napi_error(CoreError::InvalidRequest))?;
            if safe_js_epoch(value) != Some(epoch) { return Err(napi_error(CoreError::Closed)); }
        }
        let incoming = match fields.get("payload") {
            Some(raw) if kind != "signal" => serde_json::from_str::<Value>(raw.get()).map_err(|_| napi_error(CoreError::InvalidRequest))?,
            _ => Value::Null,
        };
        let mut signal_payload_json = None;
        let payload = match kind.as_str() {
            "members" if subscription_kind == "members" => self.refresh_subscription_members(&subscription_id, generation, epoch, &group_id).await.map_err(napi_error)?,
            "presence" if subscription_kind == "presence" => {
                let normalized = validate_presence_payload(incoming, &member_ids).map_err(napi_error)?;
                let ready = normalized["ready"].as_bool().ok_or_else(|| napi_error(CoreError::InvalidCloudData))?;
                if self.update_presence_ready(&subscription_id, generation, epoch, ready).map_err(napi_error)? {
                    let user_id = self.session_user_id().await.map_err(napi_error)?;
                    let result = self.call_host("track-presence", json!({"subscriptionId":subscription_id,"epoch":epoch,"groupId":group_id,"userId":user_id,"status":"online"}))
                        .await.map_err(napi_error)?;
                    if result.as_str() != Some("ok") { return Err(napi_error(CoreError::CloudTransport)); }
                }
                normalized
            }
            "signal" if subscription_kind == "signal" => {
                let envelope_json = raw_signal_envelope(&fields).map_err(napi_error)?;
                let projection = self.call_host_kind("codec", "project-envelope", json!({"envelopeJson":envelope_json})).await.map_err(napi_error)?;
                let header = projection.get("header").ok_or_else(|| napi_error(CoreError::InvalidEnvelope))?;
                let signature = projection.get("signature").ok_or_else(|| napi_error(CoreError::InvalidEnvelope))?;
                let signing_bytes = projection.get("signingBytesBase64").and_then(Value::as_str).ok_or_else(|| napi_error(CoreError::InvalidEnvelope))?;
                let user_id = self.session_user_id().await.map_err(napi_error)?;
                verify_received_signal(header, &group_id, &user_id, &member_public_keys, signing_bytes, signature).map_err(napi_error)?;
                signal_payload_json = Some(envelope_json);
                Value::Null
            }
            "error" => {
                let message = incoming.as_str().or_else(|| incoming.get("message").and_then(Value::as_str))
                    .unwrap_or("Realtime subscription failed.");
                json!({"message":message})
            }
            _ => return Err(napi_error(CoreError::InvalidRequest)),
        };
        if !self.inner.subscriptions.lock().map_err(|_| napi_error(CoreError::Internal))?
            .states.get(&subscription_id).is_some_and(|state| state.generation == generation && state.epoch == epoch && !state.invalidated) {
            return Err(napi_error(CoreError::Closed));
        }
        let event_json = match signal_payload_json {
            Some(raw) => raw_core_event(&subscription_id, epoch, &kind, &raw).map_err(napi_error)?,
            None => serde_json::to_string(&json!({"subscriptionId":subscription_id,"epoch":epoch,"kind":kind,"payload":payload}))
                .map_err(|_| napi_error(CoreError::Internal))?,
        };
        let on_event = self.inner.on_event.lock().map_err(|_| napi_error(CoreError::Internal))?
            .as_ref().cloned().ok_or_else(|| napi_error(CoreError::Closed))?;
        let delivery = on_event.call_async(Ok(event_json)).await;
        drop(on_event);
        drop(permit);
        if delivery.is_err() { return self.defer_event_error(&subscription_id, generation, epoch, &group_id).await; }
        Ok(())
    }

    async fn cancel_subscription(&self, id: &str, epoch: u64) -> NapiResult<()> {
        let action = {
            let mut registry = self.inner.subscriptions.lock().map_err(|_| napi_error(CoreError::Internal))?;
            let existing = registry.states.get(id).map(|state| (state.epoch, state.generation, state.group_id.clone(), state.canceled));
            match existing {
                Some((state_epoch, _, _, _)) if state_epoch != epoch => return Err(napi_error(CoreError::Closed)),
                Some((_, generation, group_id, canceled)) => {
                    if !registry.canceled.contains(&(id.to_owned(), epoch)) {
                        insert_cancel_tombstone(&mut registry, id, epoch).map_err(napi_error)?;
                    }
                    let state = registry.states.get_mut(id).ok_or_else(|| napi_error(CoreError::Internal))?;
                    state.invalidated = true;
                    state.canceled = true;
                    Some((generation, group_id, canceled))
                }
                None => {
                    if !registry.canceled.contains(&(id.to_owned(), epoch)) {
                        insert_cancel_tombstone(&mut registry, id, epoch).map_err(napi_error)?;
                    }
                    return Ok(());
                }
            }
        };
        if let Some((generation, group_id, _already_canceled)) = action {
            let result = self.call_host("close-channel", json!({"subscriptionId":id,"epoch":epoch,"groupId":group_id})).await;
            if result.is_ok() {
                if let Ok(mut registry) = self.inner.subscriptions.lock() {
                    if registry.states.get(id).is_some_and(|state| state.generation == generation && state.epoch == epoch && state.canceled) {
                        registry.states.remove(id);
                    }
                }
            }
            result.map_err(napi_error)?;
        }
        Ok(())
    }

    async fn defer_event_error(&self, id: &str, generation: usize, epoch: u64, group_id: &str) -> NapiResult<()> {
        let invalidated = {
            let mut registry = self.inner.subscriptions.lock().map_err(|_| napi_error(CoreError::Internal))?;
            match registry.states.get_mut(id) {
                Some(state) if state.generation == generation && state.epoch == epoch && !state.invalidated => {
                    state.invalidated = true;
                    true
                }
                _ => false,
            }
        };
        if !invalidated { return Err(napi_error(CoreError::Closed)); }
        queue_pending_event_error(&self.inner.pending_errors, id, epoch, "Realtime event delivery queue is full.");
        let _ = self.call_host("close-channel", json!({"subscriptionId":id,"epoch":epoch,"groupId":group_id})).await;
        Err(napi_error(CoreError::Backpressure))
    }
    #[napi]
    pub async fn close(&self) -> NapiResult<()> {
        let _guard = self.inner.close_lock.lock().await;
        if self.inner.close_complete.load(Ordering::Acquire) { return Ok(()); }
        self.inner.closed.store(true, Ordering::Release);
        loop {
            let mut notified = std::pin::pin!(self.inner.drain_notify.notified());
            notified.as_mut().enable();
            let no_deferred_errors = self.inner.pending_errors.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner).is_empty();
            if self.inner.admission_count.load(Ordering::Acquire) == 0 &&
                self.inner.event_calls.load(Ordering::Acquire) == 0 &&
                self.inner.event_count.load(Ordering::Acquire) == 0 && no_deferred_errors { break; }
            notified.await;
        }
        let mut close_error = self.inner.subscriptions.is_poisoned().then_some(CoreError::Internal);
        let channels = {
            let mut registry = self.inner.subscriptions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            registry.states.iter_mut().map(|(id, state)| {
                state.invalidated = true;
                (id.clone(), state.epoch, state.group_id.clone())
            }).collect::<Vec<_>>()
        };
        for (id, epoch, group_id) in channels {
            if let Err(error) = self.call_host("close-channel", json!({"subscriptionId":id,"epoch":epoch,"groupId":group_id})).await {
                close_error.get_or_insert(error);
            }
        }
        if let Err(error) = self.call_host("dispose", json!({})).await { close_error.get_or_insert(error); }
        self.inner.event_stop.store(true, Ordering::Release);
        let _ = self.inner.storage_tx.send(WorkerMessage::Stop);
        let storage_worker = match self.inner.worker.lock() {
            Ok(mut worker) => worker.take(),
            Err(poisoned) => {
                close_error.get_or_insert(CoreError::Internal);
                poisoned.into_inner().take()
            }
        };
        let event_worker = match self.inner.event_worker.lock() {
            Ok(mut worker) => worker.take(),
            Err(poisoned) => {
                close_error.get_or_insert(CoreError::Internal);
                poisoned.into_inner().take()
            }
        };
        if storage_worker.is_some_and(|worker| worker.join().is_err()) { close_error.get_or_insert(CoreError::Storage); }
        if event_worker.is_some_and(|worker| worker.join().is_err()) { close_error.get_or_insert(CoreError::Internal); }
        let mut registry = self.inner.subscriptions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        registry.states.clear();
        registry.canceled.clear();
        drop(registry);
        if self.inner.host_call.is_poisoned() { close_error.get_or_insert(CoreError::Internal); }
        let host_call = self.inner.host_call.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        drop(host_call);
        if self.inner.on_event.is_poisoned() { close_error.get_or_insert(CoreError::Internal); }
        let on_event = self.inner.on_event.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        drop(on_event);
        self.inner.close_complete.store(true, Ordering::Release);
        if let Some(error) = close_error { return Err(napi_error(error)); }
        Ok(())
    }
}

impl NativeLarpCore {
    async fn dispatch(&self, request: Request) -> Result<Value, CoreError> {
        match request.op.as_str() {
            "getPublicIdentity" => return self.get_public_identity().await,
            "signIdentityPayload" => return self.sign_identity(&request.payload).await,
            "verifyIdentityPayload" => return self.verify_identity(&request.payload),
            "getCloudStatus" => return Ok(self.inner.cloud_status.lock().map_err(|_| CoreError::Internal)?.clone()),
            "getTurnServers" => return self.get_turn_servers(&request.payload).await,
            "acquireScreenShare" => {
                let group_id = request.payload.get("groupId").cloned().ok_or(CoreError::InvalidRequest)?;
                return self.rpc("acquire_group_share_lease", json!({"p_group_id":group_id})).await?
                    .as_bool().map(Value::Bool).ok_or(CoreError::InvalidCloudData);
            }
            "releaseScreenShare" => {
                let group_id = request.payload.get("groupId").cloned().ok_or(CoreError::InvalidRequest)?;
                self.rpc("release_group_share_lease", json!({"p_group_id":group_id})).await?;
                return Ok(Value::Null);
            }
            "refreshCloud" => return self.refresh_cloud().await,
            _ => {}
        }
        if matches!(request.op.as_str(), "persistOutgoingEnvelope" | "persistVerifiedEnvelope" | "persistMessageAcknowledgement") {
            return self.persist_envelope(&request.op, &request.payload_json).await;
        }
        if matches!(request.op.as_str(), "createCloudGroup" | "acceptCloudInvite" | "removeCloudMember" | "leaveCloudGroup") {
            return self.group_mutation(&request.op, request.payload).await;
        }
        if request.op == "listCloudInvites" {
            return self.list_cloud_invites(&request.payload).await;
        }
        if request.op == "getMyProfile" {
            return self.get_my_profile().await;
        }
        if request.op == "saveMyProfile" {
            return self.save_my_profile(request.payload).await;
        }
        if request.op == "getCloudMembers" {
            return self.get_cloud_members(&request.payload).await;
        }
        if request.op == "createCloudInvite" {
            return self.create_invite(request.payload).await;
        }
        if request.op == "revokeCloudInvite" {
            let group_id = request.payload.get("groupId").cloned().ok_or(CoreError::InvalidRequest)?;
            let invite_id = request.payload.get("inviteId").cloned().ok_or(CoreError::InvalidRequest)?;
            self.rpc("revoke_group_invite", json!({"p_group_id":group_id,"p_invite_id":invite_id})).await?;
            return Ok(Value::Null);
        }
        if let Some(command) = map_storage_request(&request.op, &request.payload)? {
            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
            self.inner.storage_tx.try_send(WorkerMessage::Run(command, reply_tx)).map_err(|_| CoreError::Backpressure)?;
            return reply_rx.await.map_err(|_| CoreError::Storage)?;
        }
        if request.op == "sendSignal" { return self.send_signal(&request.payload, &request.payload_json).await; }
        let subscription = matches!(request.op.as_str(), "subscribeCloudMembers" | "subscribeCloudPresence" | "subscribeSignals");
        if !subscription { return Err(CoreError::InvalidRequest); }
        let session = self.cloud_session().await?;
        let user_id = session["user"]["id"].as_str().ok_or(CoreError::CloudAuthentication)?.to_owned();
        let access_token = session["access_token"].as_str().ok_or(CoreError::CloudAuthentication)?;
        let (op, payload) = map_cloud_operation(&request.op, request.payload, &user_id, access_token)?;
        if subscription {
            let id = payload.get("subscriptionId").and_then(Value::as_str).ok_or(CoreError::InvalidRequest)?.to_owned();
            let epoch = payload.get("epoch").and_then(Value::as_u64).filter(|v| *v <= 9_007_199_254_740_991).ok_or(CoreError::InvalidRequest)?;
            let group_id = payload.get("groupId").and_then(Value::as_str).ok_or(CoreError::InvalidRequest)?.to_owned();
            if !valid_subscription_id(&id) { return Err(CoreError::InvalidRequest); }
            let kind = match request.op.as_str() {
                "subscribeCloudMembers" => "members",
                "subscribeCloudPresence" => "presence",
                _ => "signal",
            };
            let generation = self.inner.subscription_generation.fetch_add(1, Ordering::Relaxed);
            {
                let mut registry = self.inner.subscriptions.lock().map_err(|_| CoreError::Internal)?;
                prepare_subscription_registration(&mut registry, &id, epoch)?;
                registry.states.insert(id.clone(), SubscriptionState { generation, epoch, group_id: group_id.clone(), kind,
                    member_ids: HashSet::new(), member_public_keys: HashMap::new(), presence_ready: false, invalidated: false, canceled: false });
            }
            if !self.subscription_is_current(&id, generation, epoch)? { return Err(CoreError::Closed); }
            let members = match self.get_cloud_members(&json!({"groupId":group_id})).await {
                Ok(members) => members,
                Err(error) => {
                    self.invalidate_subscription(&id, generation);
                    let _ = self.call_host("close-channel", json!({"subscriptionId":id,"epoch":epoch,"groupId":group_id})).await;
                    return Err(error);
                }
            };
            if !members.as_array().is_some_and(|rows| rows.iter().any(|row| row["userId"].as_str() == Some(user_id.as_str()))) {
                self.invalidate_subscription(&id, generation);
                let _ = self.call_host("close-channel", json!({"subscriptionId":id,"epoch":epoch,"groupId":group_id})).await;
                return Err(CoreError::InvalidIdentity);
            }
            let rows = members.as_array().ok_or(CoreError::InvalidCloudData)?;
            let member_ids = rows.iter().filter_map(|member| member.get("userId").and_then(Value::as_str).map(str::to_owned)).collect::<HashSet<_>>();
            let member_public_keys = rows.iter().filter_map(|member| Some((
                member.get("userId")?.as_str()?.to_owned(),
                member.get("publicKey")?.as_str()?.to_owned(),
            ))).collect::<HashMap<_,_>>();
            {
                let mut registry = self.inner.subscriptions.lock().map_err(|_| CoreError::Internal)?;
                match registry.states.get_mut(&id) {
                    Some(state) if state.generation == generation && state.epoch == epoch && !state.invalidated => {
                        state.member_ids = member_ids;
                        state.member_public_keys = member_public_keys;
                    }
                    _ => return Err(CoreError::Closed),
                }
            }
            let result = match self.call_host(op, payload).await {
                Ok(value) => value,
                Err(error) => {
                    self.invalidate_subscription(&id, generation);
                    let _ = self.call_host("close-channel", json!({"subscriptionId":id,"epoch":epoch,"groupId":group_id})).await;
                    return Err(error);
                }
            };
            if !self.subscription_is_current(&id, generation, epoch)? {
                let _ = self.call_host("close-channel", json!({"subscriptionId":id,"epoch":epoch,"groupId":group_id})).await;
                return Err(CoreError::Closed);
            }
            if kind == "presence" {
                let tracked = self.call_host("track-presence", json!({"subscriptionId":id,"epoch":epoch,"groupId":group_id,"userId":user_id,"status":"online"})).await;
                if tracked.as_ref().ok().and_then(Value::as_str) != Some("ok") {
                    self.invalidate_subscription(&id, generation);
                    let error = tracked.err().unwrap_or(CoreError::CloudTransport);
                    let _ = self.call_host("close-channel", json!({"subscriptionId":id,"epoch":epoch,"groupId":group_id})).await;
                    return Err(error);
                }
                if let Some(state) = self.inner.subscriptions.lock().map_err(|_| CoreError::Internal)?.states.get_mut(&id) {
                    if state.generation == generation && state.epoch == epoch && !state.invalidated { state.presence_ready = true; }
                }
            }
            if !self.subscription_is_current(&id, generation, epoch)? {
                let _ = self.call_host("close-channel", json!({"subscriptionId":id,"epoch":epoch,"groupId":group_id})).await;
                return Err(CoreError::Closed);
            }
            return Ok(result);
        }
        self.call_host(op, payload).await
    }

    fn invalidate_subscription(&self, id: &str, generation: usize) {
        if let Ok(mut registry) = self.inner.subscriptions.lock() {
            if let Some(state) = registry.states.get_mut(id).filter(|state| state.generation == generation) {
                state.invalidated = true;
            }
        }
    }
    fn subscription_is_current(&self, id: &str, generation: usize, epoch: u64) -> Result<bool, CoreError> {
        let registry = self.inner.subscriptions.lock().map_err(|_| CoreError::Internal)?;
        Ok(registry.states.get(id).is_some_and(|state| state.generation == generation && state.epoch == epoch && !state.invalidated))
    }
    async fn identity_private(&self) -> Result<(Zeroizing<String>, String), CoreError> {
        let _guard = self.inner.identity_lock.lock().await;
        if self.call_host_kind("secrets", "available", json!({})).await?.as_bool() != Some(true) {
            return Err(CoreError::InvalidIdentity);
        }
        let path = self.inner.user_data_dir.join("identity.json");
        let (ciphertext, public) = match fs::read(&path) {
            Ok(bytes) => {
                if bytes.len() > 16 * 1024 { return Err(CoreError::InvalidIdentity); }
                let value: Value = serde_json::from_slice(&bytes).map_err(|_| CoreError::InvalidIdentity)?;
                let object = value.as_object().ok_or(CoreError::InvalidIdentity)?;
                if object.len() != 3 || object.get("version").and_then(Value::as_u64) != Some(1) { return Err(CoreError::InvalidIdentity); }
                let encrypted = object.get("encryptedPrivateKey").and_then(Value::as_str).ok_or(CoreError::InvalidIdentity)?;
                let public = object.get("publicKey").and_then(Value::as_str).ok_or(CoreError::InvalidIdentity)?;
                let decoded = STANDARD.decode(encrypted).map_err(|_| CoreError::InvalidIdentity)?;
                if STANDARD.encode(decoded) != encrypted { return Err(CoreError::InvalidIdentity); }
                (encrypted.to_owned(), public.to_owned())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let (private, public) = identity::generate_keypair()?;
                let private = Zeroizing::new(private);
                let plaintext = STANDARD.encode(private.as_bytes());
                let result = self.call_host_kind("secrets", "encrypt", json!({"plaintextBase64":plaintext})).await?;
                let encrypted = result.get("ciphertextBase64").and_then(Value::as_str).ok_or(CoreError::InvalidIdentity)?.to_owned();
                let decoded = STANDARD.decode(&encrypted).map_err(|_| CoreError::InvalidIdentity)?;
                if STANDARD.encode(decoded) != encrypted { return Err(CoreError::InvalidIdentity); }
                atomic_write(&path, json!({"version":1,"encryptedPrivateKey":encrypted,"publicKey":public}).to_string().as_bytes())?;
                (encrypted, public)
            }
            Err(_) => return Err(CoreError::Storage),
        };
        let result = self.call_host_kind("secrets", "decrypt", json!({"ciphertextBase64":ciphertext})).await?;
        let encoded = Zeroizing::new(result.get("plaintextBase64").and_then(Value::as_str).ok_or(CoreError::InvalidIdentity)?.to_owned());
        let mut bytes = Zeroizing::new(STANDARD.decode(encoded.as_str()).map_err(|_| CoreError::InvalidIdentity)?);
        if STANDARD.encode(bytes.as_slice()) != encoded.as_str() { return Err(CoreError::InvalidIdentity); }
        let private = Zeroizing::new(String::from_utf8(std::mem::take(&mut *bytes)).map_err(|_| CoreError::InvalidIdentity)?);
        if identity::derive_public_key(private.as_str())? != public { return Err(CoreError::InvalidIdentity); }
        Ok((private, public))
    }
    async fn get_public_identity(&self) -> Result<Value, CoreError> {
        let (_, public_key) = self.identity_private().await?;
        Ok(json!({"algorithm":"Ed25519","publicKey":public_key}))
    }
    async fn sign_identity(&self, payload: &Value) -> Result<Value, CoreError> {
        let message = decode_identity_payload(payload)?;
        let (private, _) = self.identity_private().await?;
        Ok(json!({"algorithm":"Ed25519","signature":identity::sign_pem(private.as_str(), &message)?}))
    }
    fn verify_identity(&self, payload: &Value) -> Result<Value, CoreError> {
        let message = decode_identity_payload(payload)?;
        let public = payload.get("publicKey").and_then(Value::as_str).ok_or(CoreError::InvalidRequest)?;
        let signature = payload.get("signature").and_then(Value::as_object).ok_or(CoreError::InvalidRequest)?;
        if signature.get("algorithm").and_then(Value::as_str) != Some("Ed25519") { return Ok(Value::Bool(false)); }
        let signature = signature.get("signature").and_then(Value::as_str).ok_or(CoreError::InvalidRequest)?;
        Ok(Value::Bool(identity::verify_strict_pem(public, &message, signature)?))
    }
    fn cloud_http(&self) -> Result<&cloud_http::CloudHttp, CoreError> {
        self.inner.cloud_http.as_ref().ok_or(CoreError::CloudConfiguration)
    }
    async fn cloud_session(&self) -> Result<Value, CoreError> {
        use reqwest::Method;
        let _guard = self.inner.session_lock.lock().await;
        let base_url = self.inner.cloud_url.as_deref().ok_or(CoreError::CloudConfiguration)?;
        let parsed_url = url::Url::parse(base_url).map_err(|_| CoreError::CloudConfiguration)?;
        let hostname = parsed_url.host().ok_or(CoreError::CloudConfiguration)?.to_string();
        let hostname = hostname.split('.').next().ok_or(CoreError::CloudConfiguration)?;
        let auth_key = format!("sb-{hostname}-auth-token");
        let mut values = self.load_session_map().await?;
        let (session, changed) = if let Some(raw) = values.get(&auth_key) {
            let stored: Value = serde_json::from_str(raw).map_err(|_| CoreError::CloudAuthentication)?;
            validate_auth_session(&stored)?;
            let expires_at = stored.get("expires_at").and_then(Value::as_i64).ok_or(CoreError::CloudAuthentication)?;
            if expires_at > time::OffsetDateTime::now_utc().unix_timestamp() + 60 {
                (stored, false)
            } else {
                let refresh_token = stored.get("refresh_token").and_then(Value::as_str).filter(|s| !s.is_empty())
                    .ok_or(CoreError::CloudAuthentication)?;
                let refreshed = self.cloud_http()?.request(Method::POST, "/auth/v1/token?grant_type=refresh_token", None,
                    Some(&json!({"refresh_token":refresh_token}))).await.map_err(|_| CoreError::CloudAuthentication)?;
                let refreshed = normalize_auth_session(refreshed).map_err(|_| CoreError::CloudAuthentication)?;
                validate_auth_session(&refreshed).map_err(|_| CoreError::CloudAuthentication)?;
                if refreshed["user"]["id"] != stored["user"]["id"] { return Err(CoreError::CloudAuthentication); }
                (refreshed, true)
            }
        } else {
            (normalize_auth_session(self.cloud_http()?.request(Method::POST, "/auth/v1/signup", None,
                Some(&json!({"data":{}}))).await?)?, true)
        };
        validate_auth_session(&session)?;
        if changed {
            values.insert(auth_key, serde_json::to_string(&session).map_err(|_| CoreError::CloudAuthentication)?);
            self.persist_session_map(&values).await?;
            *self.inner.session_map.lock().map_err(|_| CoreError::Internal)? = Some(values);
        }
        let access_token = session["access_token"].as_str().ok_or(CoreError::CloudAuthentication)?;
        self.call_host("set-auth", json!({"accessToken":access_token})).await?;
        Ok(session)
    }
    async fn cloud_request(&self, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value, CoreError> {
        let session = self.cloud_session().await?;
        let access_token = session["access_token"].as_str().ok_or(CoreError::CloudAuthentication)?;
        self.cloud_http()?.request(method, path, Some(access_token), body).await
    }
    async fn rpc(&self, name: &str, args: Value) -> Result<Value, CoreError> {
        let allowed = matches!(name,
            "register_identity" | "create_group" | "list_my_groups" | "create_group_invite" |
            "list_group_invites" | "accept_group_invite" | "revoke_group_invite" |
            "remove_group_member" | "leave_group" | "acquire_group_share_lease" |
            "release_group_share_lease" | "list_group_members");
        if !allowed { return Err(CoreError::InvalidRequest); }
        self.cloud_request(reqwest::Method::POST, &format!("/rest/v1/rpc/{name}"), Some(&args)).await
    }
    async fn load_session_map(&self) -> Result<BTreeMap<String, String>, CoreError> {
        if let Some(values) = self.inner.session_map.lock().map_err(|_| CoreError::Internal)?.clone() { return Ok(values); }
        let path = self.inner.user_data_dir.join("supabase-session.json");
        let ciphertext = match fs::read(path) {
            Ok(bytes) if !bytes.is_empty() && bytes.len() <= 2 * 1024 * 1024 => STANDARD.encode(bytes),
            Ok(_) => return Err(CoreError::CloudAuthentication),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                *self.inner.session_map.lock().map_err(|_| CoreError::Internal)? = Some(BTreeMap::new());
                return Ok(BTreeMap::new());
            }
            Err(_) => return Err(CoreError::Storage),
        };
        let result = self.call_host_kind("secrets", "decrypt", json!({"ciphertextBase64":ciphertext})).await
            .map_err(|_| CoreError::CloudAuthentication)?;
        let encoded = Zeroizing::new(result.get("plaintextBase64").and_then(Value::as_str)
            .ok_or(CoreError::CloudAuthentication)?.to_owned());
        let mut bytes = Zeroizing::new(STANDARD.decode(encoded.as_str()).map_err(|_| CoreError::CloudAuthentication)?);
        if STANDARD.encode(bytes.as_slice()) != encoded.as_str() { return Err(CoreError::CloudAuthentication); }
        let plaintext = Zeroizing::new(String::from_utf8(std::mem::take(&mut *bytes)).map_err(|_| CoreError::CloudAuthentication)?);
        let decoded: Value = serde_json::from_str(plaintext.as_str()).map_err(|_| CoreError::CloudAuthentication)?;
        if decoded.as_object().is_none_or(|object| object.len() != 2 || object.get("version").and_then(Value::as_u64) != Some(1)) {
            return Err(CoreError::CloudAuthentication);
        }
        let raw = decoded.get("values").and_then(Value::as_object).ok_or(CoreError::CloudAuthentication)?;
        let mut values = BTreeMap::new();
        for (key, value) in raw {
            values.insert(key.clone(), value.as_str().ok_or(CoreError::CloudAuthentication)?.to_owned());
        }
        *self.inner.session_map.lock().map_err(|_| CoreError::Internal)? = Some(values.clone());
        Ok(values)
    }
    async fn persist_session_map(&self, values: &BTreeMap<String, String>) -> Result<(), CoreError> {
        let plaintext = Zeroizing::new(json!({"version":1,"values":values}).to_string());
        let encoded = STANDARD.encode(plaintext.as_bytes());
        let result = self.call_host_kind("secrets", "encrypt", json!({"plaintextBase64":encoded})).await?;
        let ciphertext = result.get("ciphertextBase64").and_then(Value::as_str).ok_or(CoreError::CloudAuthentication)?;
        let bytes = STANDARD.decode(ciphertext).map_err(|_| CoreError::CloudAuthentication)?;
        if STANDARD.encode(&bytes) != ciphertext { return Err(CoreError::CloudAuthentication); }
        atomic_write(&self.inner.user_data_dir.join("supabase-session.json"), &bytes)
    }
    async fn persist_envelope(&self, op: &str, payload_json: &str) -> Result<Value, CoreError> {
        let is_ack = op == "persistMessageAcknowledgement";
        let envelope_json = raw_object_field(payload_json, if is_ack { "acknowledgement" } else { "message" })?;
        let projection = self.call_host_kind("codec", "project-envelope", json!({"envelopeJson":envelope_json})).await?;
        if projection.get("ok").and_then(Value::as_bool) != Some(true) { return Err(CoreError::InvalidEnvelope); }
        let header = projection.get("header").cloned().ok_or(CoreError::InvalidEnvelope)?;
        let storage_json = projection.get("storageJson").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?;
        let signing_bytes = projection.get("signingBytesBase64").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?;
        let signature = projection.get("signature").ok_or(CoreError::InvalidEnvelope)?;
        let user_id = if op == "persistOutgoingEnvelope" || is_ack {
            let session = self.cloud_session().await?;
            session.get("user").and_then(|user| user.get("id")).and_then(Value::as_str)
                .ok_or(CoreError::CloudAuthentication)?.to_owned()
        } else { String::new() };
        let (storage_op, body) = match op {
            "persistOutgoingEnvelope" | "persistMessageAcknowledgement" => {
                let (_, public) = self.identity_private().await?;
                verify_projection(&header, signature, signing_bytes, &public)?;
                if header.get("senderId").and_then(Value::as_str) != Some(user_id.as_str()) { return Err(CoreError::InvalidIdentity); }
                let storage_op = if is_ack { "persist-ack" } else { "persist-outgoing" };
                (storage_op, json!({"localUserId":user_id,"envelopeJson":storage_json,"header":header}))
            }
            "persistVerifiedEnvelope" => {
                let group_id = header.get("groupId").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?;
                let cached = self.run_storage(json!({"op":"get-cached-cloud-members","payload":{"groupId":group_id}}).to_string()).await?;
                let keys = cached.as_array().ok_or(CoreError::InvalidCache)?.iter().filter_map(|row|
                    Some((row.get("userId")?.as_str()?.to_owned(), row.get("publicKey")?.as_str()?.to_owned()))
                ).collect::<HashMap<_,_>>();
                let sender = header.get("senderId").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?;
                let public = keys.get(sender).ok_or(CoreError::InvalidIdentity)?;
                verify_projection(&header, signature, signing_bytes, public)?;
                ("persist-verified-incoming", json!({"envelopeJson":storage_json,"header":header}))
            }
            _ => return Err(CoreError::InvalidRequest),
        };
        self.run_storage(json!({"op":storage_op,"payload":body}).to_string()).await
    }
    async fn run_storage(&self, raw: String) -> Result<Value, CoreError> {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        self.inner.storage_tx.try_send(WorkerMessage::Run(raw, reply_tx)).map_err(|_| CoreError::Backpressure)?;
        reply_rx.await.map_err(|_| CoreError::Storage)?
    }
    async fn read_stored_messages(&self, request: &Request) -> Result<Vec<String>, CoreError> {
        let group_id = request.payload.get("groupId").and_then(Value::as_str).ok_or(CoreError::InvalidRequest)?;
        let storage_request = map_storage_request(&request.op, &request.payload)?.ok_or(CoreError::InvalidRequest)?;
        let stored_rows = self.run_storage(storage_request).await?;
        let rows = stored_rows.as_array().ok_or(CoreError::Storage)?;
        let members = self.run_storage(json!({"op":"get-cached-cloud-members","payload":{"groupId":group_id}}).to_string()).await?;
        let keys = members.as_array().ok_or(CoreError::InvalidCache)?.iter().filter_map(|row|
            Some((row.get("userId")?.as_str()?.to_owned(), row.get("publicKey")?.as_str()?.to_owned()))
        ).collect::<HashMap<_,_>>();
        let expected_author = request.payload.get("authorId").and_then(Value::as_str);
        let mut envelopes = Vec::with_capacity(rows.len());
        for row in rows {
            let envelope_json = row.get("envelopeJson").and_then(Value::as_str).filter(|text| text.len() <= 65_536)
                .ok_or(CoreError::InvalidEnvelope)?;
            let projection = self.call_host_kind("codec", "project-envelope", json!({"envelopeJson":envelope_json})).await?;
            if projection.get("ok").and_then(Value::as_bool) != Some(true) { return Err(CoreError::InvalidEnvelope); }
            let header = projection.get("header").ok_or(CoreError::InvalidEnvelope)?;
            let sender = bind_stored_message_row(row, group_id, expected_author, header)?;
            let public = keys.get(sender).ok_or(CoreError::InvalidIdentity)?;
            let signature = projection.get("signature").ok_or(CoreError::InvalidEnvelope)?;
            let signing_bytes = projection.get("signingBytesBase64").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?;
            verify_projection(header, signature, signing_bytes, public)?;
            let created_at = header.get("createdAt").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?.to_owned();
            envelopes.push((created_at, envelope_json.to_owned()));
        }
        if matches!(request.op.as_str(), "getCachedMessages" | "getRecentMessages") {
            envelopes.sort_by(|left, right| left.0.cmp(&right.0));
        }
        Ok(envelopes.into_iter().map(|(_, envelope)| envelope).collect())
    }
    async fn group_mutation(&self, op: &str, payload: Value) -> Result<Value, CoreError> {
        let group = || payload.get("groupId").cloned().ok_or(CoreError::InvalidRequest);
        let result = match op {
            "createCloudGroup" => {
                let name = payload.get("name").and_then(Value::as_str).ok_or(CoreError::InvalidRequest)?;
                if storage::js_trim(name).is_empty() || name.encode_utf16().count() > 80 { return Err(CoreError::InvalidRequest); }
                self.rpc("create_group", json!({"p_name":name})).await?
            }
            "acceptCloudInvite" => {
                use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
                let code = payload.get("code").and_then(Value::as_str).filter(|code| code.len() == 43).ok_or(CoreError::InvalidRequest)?;
                let decoded = URL_SAFE_NO_PAD.decode(code).map_err(|_| CoreError::InvalidRequest)?;
                if decoded.len() != 32 || URL_SAFE_NO_PAD.encode(&decoded) != code { return Err(CoreError::InvalidRequest); }
                self.rpc("accept_group_invite", json!({"p_token_hash":digest_code(code)})).await?
            }
            "removeCloudMember" => self.rpc("remove_group_member", json!({
                "p_group_id":group()?,
                "p_member_user_id":payload.get("memberUserId").cloned().ok_or(CoreError::InvalidRequest)?
            })).await?,
            "leaveCloudGroup" => self.rpc("leave_group", json!({"p_group_id":group()?})).await?,
            _ => return Err(CoreError::InvalidRequest),
        };
        match op {
            "removeCloudMember" => {
                self.refresh_cloud().await?;
                Ok(Value::Null)
            }
            "leaveCloudGroup" => {
                let row = exactly_one_row(&result)?;
                let deleted = row.get("deleted").and_then(Value::as_bool).ok_or(CoreError::InvalidCloudData)?;
                let group = if deleted { Value::Null } else { group_to_dto(row)? };
                self.refresh_cloud().await?;
                Ok(json!({"deleted":deleted,"group":group}))
            }
            _ => {
                let group = group_to_dto(exactly_one_row(&result)?)?;
                self.refresh_cloud().await?;
                Ok(group)
            }
        }
    }
    async fn list_cloud_invites(&self, payload: &Value) -> Result<Value, CoreError> {
        let group_id = payload.get("groupId").cloned().ok_or(CoreError::InvalidRequest)?;
        let rows = self.rpc("list_group_invites", json!({"p_group_id":group_id})).await?;
        rows.as_array().ok_or(CoreError::InvalidCloudData)?.iter().map(|row| {
            Ok(json!({
                "id":row.get("id").cloned().ok_or(CoreError::InvalidCloudData)?,
                "createdAt":row.get("created_at").cloned().ok_or(CoreError::InvalidCloudData)?,
                "expiresAt":row.get("expires_at").cloned().ok_or(CoreError::InvalidCloudData)?
            }))
        }).collect::<Result<Vec<_>, CoreError>>().map(Value::Array)
    }
    async fn refresh_cloud(&self) -> Result<Value, CoreError> {
        match self.refresh_cloud_inner().await {
            Ok(status) => Ok(status),
            Err(error) => {
                let state = if error == CoreError::CloudConfiguration { "not-configured" } else { "unavailable" };
                let status = json!({"state":state,"detail":error.message(),"groups":[],"userId":Value::Null});
                *self.inner.cloud_status.lock().map_err(|_| CoreError::Internal)? = status;
                Err(error)
            }
        }
    }
    async fn refresh_cloud_inner(&self) -> Result<Value, CoreError> {
        let session = self.cloud_session().await?;
        let user_id = session["user"]["id"].as_str().filter(|id| !id.is_empty()).ok_or(CoreError::CloudAuthentication)?.to_owned();
        let identity = self.get_public_identity().await?;
        let public_key = identity.get("publicKey").and_then(Value::as_str).ok_or(CoreError::InvalidIdentity)?;
        self.rpc("register_identity", json!({"p_public_key":public_key})).await?;
        let rows = self.rpc("list_my_groups", json!({})).await?;
        let rows = rows.as_array().ok_or(CoreError::InvalidCloudData)?;
        let mut groups = Vec::with_capacity(rows.len());
        let mut members_by_group = BTreeMap::<String, Value>::new();
        for row in rows {
            let group = group_to_dto(row)?;
            let id = group["id"].as_str().ok_or(CoreError::InvalidCloudData)?.to_owned();
            members_by_group.insert(id, self.get_cloud_members(&json!({"groupId":group["id"]})).await?);
            groups.push(group);
        }
        let cache = json!({"op":"replace-cloud-cache","payload":{"groups":groups,"membersByGroup":members_by_group}});
        self.run_storage(cache.to_string()).await?;
        let status = json!({"state":"ready","detail":"Connected","groups":groups,"userId":user_id});
        *self.inner.cloud_status.lock().map_err(|_| CoreError::Internal)? = status.clone();
        Ok(status)
    }
    async fn get_turn_servers(&self, payload: &Value) -> Result<Value, CoreError> {
        let group_id = payload.get("groupId").and_then(Value::as_str).ok_or(CoreError::InvalidRequest)?;
        let data = self.cloud_request(reqwest::Method::POST, "/functions/v1/turn-credentials", Some(&json!({"groupId":group_id}))).await?;
        let servers = data.get("servers").and_then(Value::as_array).filter(|servers| servers.len() <= 4)
            .ok_or(CoreError::InvalidTurnCredentials)?;
        let mut output = Vec::with_capacity(servers.len());
        for server in servers {
            let urls = match server.get("urls") {
                Some(Value::String(url)) => vec![url.clone()],
                Some(Value::Array(urls)) => urls.iter().map(|url| url.as_str().map(str::to_owned).ok_or(CoreError::InvalidTurnCredentials)).collect::<Result<Vec<_>,_>>()?,
                _ => return Err(CoreError::InvalidTurnCredentials),
            };
            if urls.is_empty() || urls.len() > 4 || urls.iter().any(|url| url.len() > 256 || !(url.starts_with("turn:") || url.starts_with("turns:"))) {
                return Err(CoreError::InvalidTurnCredentials);
            }
            let username = server.get("username").and_then(Value::as_str).filter(|value| !value.is_empty() && value.len() <= 256)
                .ok_or(CoreError::InvalidTurnCredentials)?;
            let credential = server.get("credential").and_then(Value::as_str).filter(|value| !value.is_empty() && value.len() <= 1024)
                .ok_or(CoreError::InvalidTurnCredentials)?;
            output.push(json!({"urls":urls,"username":username,"credential":credential}));
        }
        Ok(Value::Array(output))
    }
    async fn session_user_id(&self) -> Result<String, CoreError> {
        self.cloud_session().await?.get("user").and_then(|user| user.get("id"))
            .and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned)
            .ok_or(CoreError::CloudAuthentication)
    }
    async fn send_signal(&self, payload: &Value, payload_json: &str) -> Result<Value, CoreError> {
        let group_id = payload.get("groupId").and_then(Value::as_str).ok_or(CoreError::InvalidRequest)?;
        let envelope_json = raw_object_field(payload_json, "envelope")?;
        if envelope_json.len() > 65_536 { return Err(CoreError::InputTooLarge); }
        let projection = self.call_host_kind("codec", "project-envelope", json!({"envelopeJson":envelope_json})).await?;
        if projection.get("ok").and_then(Value::as_bool) != Some(true) { return Err(CoreError::InvalidEnvelope); }
        let header = projection.get("header").ok_or(CoreError::InvalidEnvelope)?;
        let signature = projection.get("signature").ok_or(CoreError::InvalidEnvelope)?;
        let signing_bytes = projection.get("signingBytesBase64").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?;
        let user_id = self.session_user_id().await?;
        let (_, public) = self.identity_private().await?;
        verify_projection(header, signature, signing_bytes, &public)?;
        let members = self.get_cloud_members(&json!({"groupId":group_id})).await?;
        let recipient = validate_signal_header(header, group_id, &user_id, members.as_array().ok_or(CoreError::InvalidCloudData)?)?;
        if recipient == user_id { return Err(CoreError::InvalidEnvelope); }
        let active = {
            let registry = self.inner.subscriptions.lock().map_err(|_| CoreError::Internal)?;
            registry.states.iter().find(|(_, state)| state.kind == "signal" && state.group_id == group_id && !state.invalidated)
                .map(|(id, state)| (id.clone(), state.epoch)).ok_or(CoreError::Closed)?
        };
        let id = serde_json::to_string(&active.0).map_err(|_| CoreError::Internal)?;
        let group = serde_json::to_string(group_id).map_err(|_| CoreError::Internal)?;
        let host_payload = format!("{{\"subscriptionId\":{id},\"epoch\":{},\"groupId\":{group},\"envelope\":{envelope_json}}}", active.1);
        let result = self.call_host_raw("cloud", "send-signal", &host_payload).await?;
        if result.as_str() != Some("ok") { return Err(CoreError::CloudTransport); }
        Ok(Value::Null)
    }
    async fn get_my_profile(&self) -> Result<Value, CoreError> {
        let user_id = self.session_user_id().await?;
        let path = format!("/rest/v1/larp_user_profiles?select=user_id,display_name,avatar_data&user_id=eq.{user_id}");
        let rows = self.cloud_request(reqwest::Method::GET, &path, None).await?;
        let rows = rows.as_array().ok_or(CoreError::InvalidCloudData)?;
        if rows.len() > 1 { return Err(CoreError::InvalidCloudData); }
        profile_to_dto(rows.first().cloned().unwrap_or(Value::Null), &user_id)
    }
    async fn save_my_profile(&self, payload: Value) -> Result<Value, CoreError> {
        let user_id = self.session_user_id().await?;
        let display_name = match payload.get("displayName").ok_or(CoreError::InvalidProfile)? {
            Value::Null => None,
            Value::String(value) => storage::normalize_profile_name(value)?,
            _ => return Err(CoreError::InvalidProfile),
        };
        let avatar_data = match payload.get("avatarData").ok_or(CoreError::InvalidProfile)? {
            Value::Null => None,
            Value::String(value) => Some(value.clone()),
            _ => return Err(CoreError::InvalidProfile),
        };
        let profile = crate::contracts::UserProfile { user_id: user_id.clone(), display_name: display_name.clone(), avatar_data: avatar_data.clone() };
        storage::validate_profile(&profile, &user_id).map_err(|_| CoreError::InvalidProfile)?;
        let fields = json!({"display_name":display_name,"avatar_data":avatar_data});
        let path = format!("/rest/v1/larp_user_profiles?select=user_id,display_name,avatar_data&user_id=eq.{user_id}");
        let result = match self.cloud_request(reqwest::Method::POST, "/rest/v1/larp_user_profiles?select=user_id,display_name,avatar_data",
            Some(&json!({"user_id":user_id,"display_name":display_name,"avatar_data":avatar_data}))).await {
            Err(CoreError::Conflict) => self.cloud_request(reqwest::Method::PATCH, &path, Some(&fields)).await?,
            other => other?,
        };
        let row = exactly_one_row(&result)?.clone();
        let profile = profile_to_dto(row, &user_id)?;
        self.update_cached_profile(&user_id, &profile).await?;
        Ok(profile)
    }
    async fn update_cached_profile(&self, user_id: &str, profile: &Value) -> Result<(), CoreError> {
        let groups = self.run_storage(json!({"op":"get-cached-cloud-groups","payload":{}}).to_string()).await?;
        for group in groups.as_array().ok_or(CoreError::InvalidCache)? {
            let group_id = group.get("id").and_then(Value::as_str).ok_or(CoreError::InvalidCache)?;
            let mut members = self.run_storage(json!({"op":"get-cached-cloud-members","payload":{"groupId":group_id}}).to_string()).await?;
            let rows = members.as_array_mut().ok_or(CoreError::InvalidCache)?;
            let mut changed = false;
            for member in rows {
                if member.get("userId").and_then(Value::as_str) == Some(user_id) {
                    member["profile"] = profile.clone();
                    changed = true;
                }
            }
            if changed {
                self.run_storage(json!({"op":"cache-cloud-members","payload":{"groupId":group_id,"members":members}}).to_string()).await?;
            }
        }
        Ok(())
    }
    async fn get_cloud_members(&self, payload: &Value) -> Result<Value, CoreError> {
        let group_id = payload.get("groupId").cloned().ok_or(CoreError::InvalidRequest)?;
        let members = self.rpc("list_group_members", json!({"p_group_id":group_id})).await?;
        let rows = members.as_array().ok_or(CoreError::InvalidCloudData)?;
        let user_ids: Vec<String> = rows.iter().map(|row| {
            let id = row.get("user_id").and_then(Value::as_str).ok_or(CoreError::InvalidCloudData)?;
            if !is_uuid(id) { return Err(CoreError::InvalidCloudData); }
            Ok(id.to_owned())
        }).collect::<Result<_, CoreError>>()?;
        let profiles = if user_ids.is_empty() { Vec::new() } else {
            let path = format!("/rest/v1/larp_user_profiles?select=user_id,display_name,avatar_data&user_id=in.({})", user_ids.join(","));
            self.cloud_request(reqwest::Method::GET, &path, None).await?
                .as_array().cloned().ok_or(CoreError::InvalidCloudData)?
        };
        let mut profile_by_user = HashMap::new();
        for profile in profiles {
            let user_id = profile.get("user_id").and_then(Value::as_str).ok_or(CoreError::InvalidCloudData)?.to_owned();
            let profile = profile_to_dto(profile, &user_id)?;
            profile_by_user.insert(user_id, profile);
        }
        let members = rows.iter().map(|row| {
            let id = row.get("user_id").and_then(Value::as_str).ok_or(CoreError::InvalidCloudData)?;
            let public_key = row.get("public_key").cloned().ok_or(CoreError::InvalidCloudData)?;
            let joined_at = row.get("joined_at").cloned().ok_or(CoreError::InvalidCloudData)?;
            let role = row.get("role").cloned().ok_or(CoreError::InvalidCloudData)?;
            Ok(json!({"userId":id,"publicKey":public_key,"joinedAt":joined_at,"role":role,"profile":profile_by_user.remove(id)}))
        }).collect::<Result<Vec<_>, CoreError>>()?;
        let group_id = group_id.as_str().ok_or(CoreError::InvalidRequest)?;
        self.run_storage(json!({"op":"cache-cloud-members","payload":{"groupId":group_id,"members":members}}).to_string()).await?;
        Ok(Value::Array(members))
    }
    async fn refresh_subscription_members(&self, id: &str, generation: usize, epoch: u64, group_id: &str) -> Result<Value, CoreError> {
        let members = self.get_cloud_members(&json!({"groupId":group_id})).await?;
        let rows = members.as_array().ok_or(CoreError::InvalidCloudData)?;
        let member_ids = rows.iter().filter_map(|member| member.get("userId").and_then(Value::as_str).map(str::to_owned)).collect::<HashSet<_>>();
        let member_public_keys = rows.iter().filter_map(|member| Some((
            member.get("userId")?.as_str()?.to_owned(),
            member.get("publicKey")?.as_str()?.to_owned(),
        ))).collect::<HashMap<_,_>>();
        let mut registry = self.inner.subscriptions.lock().map_err(|_| CoreError::Internal)?;
        match registry.states.get_mut(id) {
            Some(state) if state.generation == generation && state.epoch == epoch && !state.invalidated => {
                state.member_ids = member_ids;
                state.member_public_keys = member_public_keys;
            }
            _ => return Err(CoreError::Closed),
        }
        Ok(members)
    }
    fn update_presence_ready(&self, id: &str, generation: usize, epoch: u64, ready: bool) -> Result<bool, CoreError> {
        let mut registry = self.inner.subscriptions.lock().map_err(|_| CoreError::Internal)?;
        Self::update_presence_ready_state(&mut registry, id, generation, epoch, ready)
    }
    fn update_presence_ready_state(
        registry: &mut SubscriptionRegistry,
        id: &str,
        generation: usize,
        epoch: u64,
        ready: bool,
    ) -> Result<bool, CoreError> {
        let state = registry.states.get_mut(id)
            .filter(|state| state.generation == generation && state.epoch == epoch && !state.invalidated)
            .ok_or(CoreError::Closed)?;
        let should_retrack = ready && !state.presence_ready;
        state.presence_ready = ready;
        Ok(should_retrack)
    }
    async fn create_invite(&self, payload: Value) -> Result<Value, CoreError> {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let group_id = payload.get("groupId").and_then(Value::as_str).ok_or(CoreError::InvalidRequest)?;
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|_| CoreError::Internal)?;
        let code = URL_SAFE_NO_PAD.encode(secret);
        secret.fill(0);
        let result = self.rpc("create_group_invite", json!({"p_group_id":group_id,"p_token_hash":digest_code(&code)})).await?;
        let row = if let Some(rows) = result.as_array() {
            if rows.len() != 1 { return Err(CoreError::InvalidCloudData); }
            &rows[0]
        } else { &result };
        let id = row.get("id").and_then(Value::as_str).ok_or(CoreError::InvalidCloudData)?;
        let expires = row.get("expires_at").and_then(Value::as_str).ok_or(CoreError::InvalidCloudData)?;
        Ok(json!({"id":id,"code":code,"expiresAt":expires}))
    }
    async fn call_host(&self, op: &str, payload: Value) -> Result<Value, CoreError> {
        self.call_host_kind("cloud", op, payload).await
    }
    async fn call_host_kind(&self, kind: &str, op: &str, payload: Value) -> Result<Value, CoreError> {
        let input = json!({"version":1,"kind":kind,"op":op,"payload":payload}).to_string();
        self.call_host_input(input).await
    }
    async fn call_host_raw(&self, kind: &str, op: &str, payload: &str) -> Result<Value, CoreError> {
        let kind = serde_json::to_string(kind).map_err(|_| CoreError::Internal)?;
        let op = serde_json::to_string(op).map_err(|_| CoreError::Internal)?;
        let input = format!("{{\"version\":1,\"kind\":{kind},\"op\":{op},\"payload\":{payload}}}");
        self.call_host_input(input).await
    }
    async fn call_host_input(&self, input: String) -> Result<Value, CoreError> {
        let host_call = self.inner.host_call.lock().map_err(|_| CoreError::Internal)?
            .as_ref().cloned().ok_or(CoreError::Closed)?;
        let promise = host_call.call_async(Ok(input)).await.map_err(|_| CoreError::CloudTransport)?;
        let output = promise.await.map_err(|_| CoreError::CloudTransport)?;
        parse_host_response(&output)
    }
}
static TEMP_FILE_ID: AtomicUsize = AtomicUsize::new(0);
fn atomic_write(path: &std::path::Path, contents: &[u8]) -> Result<(), CoreError> {
    use std::io::Write;
    let suffix = TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_extension(format!("tmp.{}.{}", std::process::id(), suffix));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut temp_created = false;
    let result = (|| {
        let mut file = options.open(&temp).map_err(|_| CoreError::Storage)?;
        temp_created = true;
        file.write_all(contents).map_err(|_| CoreError::Storage)?;
        file.sync_all().map_err(|_| CoreError::Storage)?;
        match fs::rename(&temp, path) {
            Ok(()) => Ok(()),
            Err(_) => {
                #[cfg(windows)]
                { replace_existing_file_windows(&temp, path) }
                #[cfg(not(windows))]
                { Err(CoreError::Storage) }
            }
        }
    })();
    if result.is_err() && temp_created { let _ = fs::remove_file(&temp); }
    result
}
#[cfg(windows)]
fn replace_existing_file_windows(temp: &std::path::Path, path: &std::path::Path) -> Result<(), CoreError> {
    if !path.is_file() { return Err(CoreError::Storage); }
    let suffix = TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
    let backup = path.with_extension(format!("replace-backup.{}.{}", std::process::id(), suffix));
    let mut backup_file = fs::OpenOptions::new().write(true).create_new(true).open(&backup).map_err(|_| CoreError::Storage)?;
    let backup_result = (|| {
        let mut source = fs::File::open(path).map_err(|_| CoreError::Storage)?;
        std::io::copy(&mut source, &mut backup_file).map_err(|_| CoreError::Storage)?;
        backup_file.sync_all().map_err(|_| CoreError::Storage)
    })();
    if let Err(error) = backup_result {
        drop(backup_file);
        let _ = fs::remove_file(&backup);
        return Err(error);
    }
    drop(backup_file);
    if fs::remove_file(path).is_err() {
        let _ = fs::remove_file(&backup);
        return Err(CoreError::Storage);
    }
    if fs::rename(temp, path).is_ok() {
        let _ = fs::remove_file(backup);
        return Ok(());
    }
    if fs::rename(&backup, path).is_err() &&
        fs::hard_link(&backup, path).is_err() &&
        fs::copy(&backup, path).is_err() {
        return Err(CoreError::Storage);
    }
    Err(CoreError::Storage)
}
fn verify_projection(header: &Value, signature: &Value, signing_bytes_base64: &str, public_key: &str) -> Result<(), CoreError> {
    if signature.get("algorithm").and_then(Value::as_str) != Some("Ed25519") { return Err(CoreError::InvalidEnvelope); }
    let signature = signature.get("signature").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?;
    let encoded = STANDARD.decode(signing_bytes_base64).map_err(|_| CoreError::InvalidEnvelope)?;
    if STANDARD.encode(&encoded) != signing_bytes_base64 || encoded.len() > 65_536 { return Err(CoreError::InvalidEnvelope); }
    let sender = header.get("senderId").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?;
    if sender.is_empty() || sender.len() > 128 { return Err(CoreError::InvalidEnvelope); }
    if !identity::verify_strict_pem(public_key, &encoded, signature)? { return Err(CoreError::InvalidIdentity); }
    Ok(())
}
fn decode_identity_payload(payload: &Value) -> Result<Vec<u8>, CoreError> {
    let encoded = payload.get("payloadBase64").and_then(Value::as_str).filter(|s| s.len() <= 1_398_104).ok_or(CoreError::InvalidRequest)?;
    let bytes = STANDARD.decode(encoded).map_err(|_| CoreError::InvalidRequest)?;
    if bytes.len() > 1_048_576 || STANDARD.encode(&bytes) != encoded { return Err(CoreError::InvalidRequest); }
    Ok(bytes)
}
fn verify_received_signal(
    header: &Value,
    group_id: &str,
    local_user_id: &str,
    member_public_keys: &HashMap<String, String>,
    signing_bytes_base64: &str,
    signature: &Value,
) -> Result<(), CoreError> {
    if header.get("groupId").and_then(Value::as_str) != Some(group_id)
        || header.get("recipientId").and_then(Value::as_str) != Some(local_user_id)
        || header.get("senderId").and_then(Value::as_str) == Some(local_user_id)
        || !matches!(header.get("kind").and_then(Value::as_str), Some("description" | "ice-batch" | "connect-request" | "media-state" | "protocol-error")) {
        return Err(CoreError::InvalidEnvelope);
    }
    let sender = header.get("senderId").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?;
    let public_key = member_public_keys.get(sender).ok_or(CoreError::InvalidIdentity)?;
    if signature.get("algorithm").and_then(Value::as_str) != Some("Ed25519") { return Err(CoreError::InvalidEnvelope); }
    let signature = signature.get("signature").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?;
    let signing_bytes = STANDARD.decode(signing_bytes_base64).map_err(|_| CoreError::InvalidEnvelope)?;
    if STANDARD.encode(&signing_bytes) != signing_bytes_base64 { return Err(CoreError::InvalidEnvelope); }
    if !identity::verify_strict_pem(public_key, &signing_bytes, signature)? { return Err(CoreError::InvalidIdentity); }
    Ok(())
}
fn validate_signal_header<'a>(header: &'a Value, group_id: &str, user_id: &str, members: &[Value]) -> Result<&'a str, CoreError> {
    if header.get("groupId").and_then(Value::as_str) != Some(group_id)
        || header.get("senderId").and_then(Value::as_str) != Some(user_id)
        || !matches!(header.get("kind").and_then(Value::as_str), Some("description" | "ice-batch" | "connect-request" | "media-state" | "protocol-error")) {
        return Err(CoreError::InvalidEnvelope);
    }
    let recipient = header.get("recipientId").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?;
    if !members.iter().any(|member| member.get("userId").and_then(Value::as_str) == Some(recipient)) {
        return Err(CoreError::InvalidIdentity);
    }
    Ok(recipient)
}
fn validate_presence_payload(value: Value, members: &HashSet<String>) -> Result<Value, CoreError> {
    let object = value.as_object().ok_or(CoreError::InvalidCloudData)?;
    if object.len() != 2 { return Err(CoreError::InvalidCloudData); }
    let ready = object.get("ready").and_then(Value::as_bool).ok_or(CoreError::InvalidCloudData)?;
    let presence = object.get("presence").and_then(Value::as_object).ok_or(CoreError::InvalidCloudData)?;
    let mut statuses = serde_json::Map::new();
    for (user_id, sessions) in presence {
        if user_id.is_empty() || user_id.len() > 128 { return Err(CoreError::InvalidCloudData); }
        if !members.contains(user_id) { continue; }
        let sessions = sessions.as_array().ok_or(CoreError::InvalidCloudData)?;
        let mut status = None;
        for session in sessions {
            let session = session.as_object().ok_or(CoreError::InvalidCloudData)?;
            if session.get("userId").and_then(Value::as_str) != Some(user_id.as_str()) { continue; }
            match session.get("status").and_then(Value::as_str) {
                Some("online") => status = Some("online"),
                Some("away") if status.is_none() => status = Some("away"),
                Some("offline") | None => {}
                _ => return Err(CoreError::InvalidCloudData),
            }
        }
        if let Some(status) = status { statuses.insert(user_id.clone(), Value::String(status.to_owned())); }
    }
    Ok(json!({"presence":statuses,"ready":ready}))
}
fn exactly_one_row(value: &Value) -> Result<&Value, CoreError> {
    value.as_array().filter(|rows| rows.len() == 1).and_then(|rows| rows.first()).ok_or(CoreError::InvalidCloudData)
}
fn group_to_dto(row: &Value) -> Result<Value, CoreError> {
    let id = row.get("id").and_then(Value::as_str).ok_or(CoreError::InvalidCloudData)?;
    let name = row.get("name").and_then(Value::as_str).ok_or(CoreError::InvalidCloudData)?;
    let created_at = row.get("created_at").and_then(Value::as_str).ok_or(CoreError::InvalidCloudData)?;
    let count = row.get("member_count").and_then(Value::as_u64).filter(|count| (1..=6).contains(count)).ok_or(CoreError::InvalidCloudData)?;
    let role = row.get("role").and_then(Value::as_str).filter(|role| matches!(*role, "owner" | "member")).ok_or(CoreError::InvalidCloudData)?;
    if !is_uuid(id) || storage::js_trim(name).is_empty() || name.encode_utf16().count() > 80 ||
        time::OffsetDateTime::parse(created_at, &time::format_description::well_known::Rfc3339).is_err() {
        return Err(CoreError::InvalidCloudData);
    }
    Ok(json!({"id":id,"name":name,"createdAt":created_at,"memberCount":count,"role":role}))
}
fn is_uuid(value: &str) -> bool {
    let parts: Vec<_> = value.split('-').collect();
    parts.len() == 5 && [8,4,4,4,12].iter().zip(parts).all(|(length, part)| part.len() == *length && part.bytes().all(|byte| byte.is_ascii_hexdigit()))
}
fn normalize_auth_session(mut session: Value) -> Result<Value, CoreError> {
    let object = session.as_object_mut().ok_or(CoreError::CloudAuthentication)?;
    if !object.contains_key("expires_at") {
        let expires_in = object.get("expires_in").and_then(Value::as_i64)
            .filter(|seconds| *seconds > 0).ok_or(CoreError::CloudAuthentication)?;
        let expires_at = time::OffsetDateTime::now_utc().unix_timestamp()
            .checked_add(expires_in).ok_or(CoreError::CloudAuthentication)?;
        object.insert("expires_at".to_owned(), Value::from(expires_at));
    }
    Ok(session)
}
fn validate_auth_session(session: &Value) -> Result<(), CoreError> {
    let access_token = session.get("access_token").and_then(Value::as_str)
        .filter(|token| !token.is_empty() && token.len() <= 16 * 1024).ok_or(CoreError::CloudAuthentication)?;
    let refresh_token = session.get("refresh_token").and_then(Value::as_str)
        .filter(|token| !token.is_empty() && token.len() <= 16 * 1024).ok_or(CoreError::CloudAuthentication)?;
    let user_id = session.get("user").and_then(|user| user.get("id")).and_then(Value::as_str)
        .filter(|id| is_uuid(id)).ok_or(CoreError::CloudAuthentication)?;
    let expires_at = session.get("expires_at").and_then(Value::as_i64).ok_or(CoreError::CloudAuthentication)?;
    if access_token == refresh_token || user_id.is_empty() || expires_at <= 0 { return Err(CoreError::CloudAuthentication); }
    Ok(())
}
fn profile_to_dto(row: Value, expected_user_id: &str) -> Result<Value, CoreError> {
    if row.is_null() { return Ok(Value::Null); }
    let user_id = row.get("user_id").and_then(Value::as_str).ok_or(CoreError::InvalidCloudData)?;
    let display_name = match row.get("display_name").ok_or(CoreError::InvalidCloudData)? {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        _ => return Err(CoreError::InvalidProfile),
    };
    let avatar_data = match row.get("avatar_data").ok_or(CoreError::InvalidCloudData)? {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        _ => return Err(CoreError::InvalidProfile),
    };
    let profile = crate::contracts::UserProfile { user_id: user_id.to_owned(), display_name: display_name.clone(), avatar_data: avatar_data.clone() };
    storage::validate_profile(&profile, expected_user_id).map_err(|_| CoreError::InvalidProfile)?;
    Ok(json!({"userId":user_id,"displayName":display_name,"avatarData":avatar_data}))
}
fn map_storage_request(op: &str, payload: &Value) -> Result<Option<String>, CoreError> {
    let (operation, body) = match op {
        "getCachedCloudGroups" => ("get-cached-cloud-groups", json!({})),
        "getCachedCloudMembers" => ("get-cached-cloud-members", json!({"groupId": payload.get("groupId").cloned().ok_or(CoreError::InvalidRequest)?})),
        "getRecentMessages" | "getCachedMessages" => ("get-cached-messages", json!({"groupId": payload.get("groupId").cloned().ok_or(CoreError::InvalidRequest)?,"perAuthorLimit":payload.get("perAuthorLimit").cloned().unwrap_or(json!(50))})),
        "readMissingEnvelopes" => ("read-missing", json!({"groupId":payload.get("groupId").cloned().ok_or(CoreError::InvalidRequest)?,"authorId":payload.get("authorId").cloned().ok_or(CoreError::InvalidRequest)?,"afterSequence":payload.get("afterSequence").cloned().ok_or(CoreError::InvalidRequest)?,"throughSequence":payload.get("throughSequence").cloned().ok_or(CoreError::InvalidRequest)?,"limit":payload.get("limit").cloned().ok_or(CoreError::InvalidRequest)?})),
        "getHighestContiguousSequence" => ("get-highest-contiguous", json!({"groupId":payload.get("groupId").cloned().ok_or(CoreError::InvalidRequest)?,"authorId":payload.get("authorId").cloned().ok_or(CoreError::InvalidRequest)?})),
        _ => return Ok(None),
    };
    serde_json::to_string(&json!({"op":operation,"payload":body})).map(Some).map_err(|_| CoreError::Internal)
}

struct RequestPermit { inner: Arc<CoreInner>, bytes: usize }
impl RequestPermit {
    fn acquire(inner: &Arc<CoreInner>, bytes: usize) -> Result<Self, CoreError> {
        if inner.closed.load(Ordering::Acquire) { return Err(CoreError::Closed); }
        let count = inner.admission_count.fetch_add(1, Ordering::AcqRel);
        let total = inner.admission_bytes.fetch_add(bytes, Ordering::AcqRel);
        if count >= MAX_PENDING_REQUESTS || total.saturating_add(bytes) > MAX_PENDING_BYTES {
            inner.admission_count.fetch_sub(1, Ordering::AcqRel);
            inner.admission_bytes.fetch_sub(bytes, Ordering::AcqRel);
            inner.drain_notify.notify_waiters();
            return Err(CoreError::Backpressure);
        }
        if inner.closed.load(Ordering::Acquire) {
            inner.admission_count.fetch_sub(1, Ordering::AcqRel);
            inner.admission_bytes.fetch_sub(bytes, Ordering::AcqRel);
            inner.drain_notify.notify_waiters();
            return Err(CoreError::Closed);
        }
        Ok(Self { inner: Arc::clone(inner), bytes })
    }
}
impl Drop for RequestPermit {
    fn drop(&mut self) {
        self.inner.admission_count.fetch_sub(1, Ordering::AcqRel);
        self.inner.admission_bytes.fetch_sub(self.bytes, Ordering::AcqRel);
        self.inner.drain_notify.notify_waiters();
    }
}
struct EventCallPermit { inner: Arc<CoreInner> }
impl EventCallPermit {
    fn acquire(inner: &Arc<CoreInner>) -> Result<Self, CoreError> {
        if inner.closed.load(Ordering::Acquire) { return Err(CoreError::Closed); }
        inner.event_calls.fetch_add(1, Ordering::AcqRel);
        if inner.closed.load(Ordering::Acquire) {
            inner.event_calls.fetch_sub(1, Ordering::AcqRel);
            inner.drain_notify.notify_waiters();
            return Err(CoreError::Closed);
        }
        Ok(Self { inner: Arc::clone(inner) })
    }
}
impl Drop for EventCallPermit {
    fn drop(&mut self) {
        self.inner.event_calls.fetch_sub(1, Ordering::AcqRel);
        self.inner.drain_notify.notify_waiters();
    }
}
struct EventPermit { inner: Arc<CoreInner>, bytes: usize }
impl EventPermit {
    fn acquire(inner: &Arc<CoreInner>, bytes: usize) -> Result<Self, CoreError> {
        if inner.closed.load(Ordering::Acquire) { return Err(CoreError::Closed); }
        let count = inner.event_count.fetch_add(1, Ordering::AcqRel);
        let total = inner.event_bytes.fetch_add(bytes, Ordering::AcqRel);
        if count >= MAX_PENDING_EVENTS || total.saturating_add(bytes) > MAX_EVENT_BYTES {
            inner.event_count.fetch_sub(1, Ordering::AcqRel);
            inner.event_bytes.fetch_sub(bytes, Ordering::AcqRel);
            inner.drain_notify.notify_waiters();
            return Err(CoreError::Backpressure);
        }
        if inner.closed.load(Ordering::Acquire) {
            inner.event_count.fetch_sub(1, Ordering::AcqRel);
            inner.event_bytes.fetch_sub(bytes, Ordering::AcqRel);
            inner.drain_notify.notify_waiters();
            return Err(CoreError::Closed);
        }
        Ok(Self { inner: Arc::clone(inner), bytes })
    }
    fn acquire_cancel(inner: &Arc<CoreInner>) -> Result<Self, CoreError> {
        if inner.closed.load(Ordering::Acquire) { return Err(CoreError::Closed); }
        inner.event_count.fetch_add(1, Ordering::AcqRel);
        if inner.closed.load(Ordering::Acquire) {
            inner.event_count.fetch_sub(1, Ordering::AcqRel);
            inner.drain_notify.notify_waiters();
            return Err(CoreError::Closed);
        }
        Ok(Self { inner: Arc::clone(inner), bytes: 0 })
    }
}
impl Drop for EventPermit {
    fn drop(&mut self) {
        self.inner.event_count.fetch_sub(1, Ordering::AcqRel);
        self.inner.event_bytes.fetch_sub(self.bytes, Ordering::AcqRel);
        self.inner.drain_notify.notify_waiters();
    }
}

fn validate_payload_contract(op: &str, payload: &Value) -> Result<(), CoreError> {
    let fields: &[&str] = match op {
        "getCloudStatus" | "refreshCloud" | "getPublicIdentity" | "getMyProfile" | "getCachedCloudGroups" => &[],
        "signIdentityPayload" => &["payloadBase64"],
        "verifyIdentityPayload" => &["payloadBase64", "publicKey", "signature"],
        "createCloudGroup" => &["name"],
        "createCloudInvite" | "listCloudInvites" | "leaveCloudGroup" | "getCloudMembers" | "getTurnServers" |
        "getCachedCloudMembers" | "acquireScreenShare" | "releaseScreenShare" => &["groupId"],
        "acceptCloudInvite" => &["code"],
        "revokeCloudInvite" => &["groupId", "inviteId"],
        "removeCloudMember" => &["groupId", "memberUserId"],
        "saveMyProfile" => &["displayName", "avatarData"],
        "subscribeCloudMembers" | "subscribeCloudPresence" | "subscribeSignals" => &["groupId", "subscriptionId", "epoch"],
        "getCachedMessages" | "getRecentMessages" => &["groupId", "perAuthorLimit"],
        "persistOutgoingEnvelope" | "persistVerifiedEnvelope" => &["message"],
        "persistMessageAcknowledgement" => &["acknowledgement"],
        "readMissingEnvelopes" => &["groupId", "authorId", "afterSequence", "throughSequence", "limit"],
        "getHighestContiguousSequence" => &["groupId", "authorId"],
        "sendSignal" => &["groupId", "envelope"],
        _ => return Err(CoreError::InvalidRequest),
    };
    let object = payload.as_object().ok_or(CoreError::InvalidRequest)?;
    if object.keys().any(|key| !fields.contains(&key.as_str())) { return Err(CoreError::InvalidRequest); }
    for field in fields {
        let optional = matches!((op, *field), ("getCachedMessages" | "getRecentMessages", "perAuthorLimit"));
        if !optional && !object.contains_key(*field) { return Err(CoreError::InvalidRequest); }
    }
    Ok(())
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCoreRequest<'a> {
    version: u64,
    op: String,
    #[serde(borrow)]
    payload: &'a serde_json::value::RawValue,
}
struct Request { op: String, payload: Value, payload_json: String }
fn parse_request(raw: &str) -> Result<Request, CoreError> {
    let request: RawCoreRequest<'_> = serde_json::from_str(raw).map_err(|_| CoreError::InvalidRequest)?;
    if request.version != 1 { return Err(CoreError::UnsupportedVersion); }
    if !is_core_operation(&request.op) { return Err(CoreError::InvalidRequest); }
    let payload_json = request.payload.get().to_owned();
    let payload = match request.op.as_str() {
        "persistOutgoingEnvelope" | "persistVerifiedEnvelope" => {
            let fields = raw_object_fields(&payload_json)?;
            if fields.len() != 1 || !fields.contains_key("message") { return Err(CoreError::InvalidRequest); }
            Value::Object(serde_json::Map::new())
        }
        "persistMessageAcknowledgement" => {
            let fields = raw_object_fields(&payload_json)?;
            if fields.len() != 1 || !fields.contains_key("acknowledgement") { return Err(CoreError::InvalidRequest); }
            Value::Object(serde_json::Map::new())
        }
        "sendSignal" => {
            let fields = raw_object_fields(&payload_json)?;
            if fields.len() != 2 || !fields.contains_key("groupId") || !fields.contains_key("envelope") {
                return Err(CoreError::InvalidRequest);
            }
            let group_id: String = raw_field(&fields, "groupId")?;
            json!({"groupId":group_id})
        }
        _ => {
            let payload: Value = serde_json::from_str(&payload_json).map_err(|_| CoreError::InvalidRequest)?;
            if !payload.is_object() { return Err(CoreError::InvalidRequest); }
            validate_payload_contract(&request.op, &payload)?;
            payload
        }
    };
    Ok(Request { op: request.op, payload, payload_json })
}
fn raw_object_fields(raw: &str) -> Result<BTreeMap<String, Box<serde_json::value::RawValue>>, CoreError> {
    serde_json::from_str(raw).map_err(|_| CoreError::InvalidRequest)
}
fn raw_field<T: serde::de::DeserializeOwned>(
    fields: &BTreeMap<String, Box<serde_json::value::RawValue>>,
    key: &str,
) -> Result<T, CoreError> {
    let raw = fields.get(key).ok_or(CoreError::InvalidRequest)?;
    serde_json::from_str(raw.get()).map_err(|_| CoreError::InvalidRequest)
}
fn raw_object_field(raw: &str, key: &str) -> Result<String, CoreError> {
    let fields = raw_object_fields(raw)?;
    fields.get(key).map(|value| value.get().to_owned()).ok_or(CoreError::InvalidRequest)
}
fn raw_signal_envelope(fields: &BTreeMap<String, Box<serde_json::value::RawValue>>) -> Result<String, CoreError> {
    let payload = fields.get("payload").ok_or(CoreError::InvalidEnvelope)?;
    if let Ok(payload_fields) = serde_json::from_str::<BTreeMap<String, Box<serde_json::value::RawValue>>>(payload.get()) {
        if let Some(envelope) = payload_fields.get("envelope") {
            return Ok(envelope.get().to_owned());
        }
    }
    Ok(payload.get().to_owned())
}
fn raw_core_event(id: &str, epoch: u64, kind: &str, raw_payload: &str) -> Result<String, CoreError> {
    let id = serde_json::to_string(id).map_err(|_| CoreError::Internal)?;
    let kind = serde_json::to_string(kind).map_err(|_| CoreError::Internal)?;
    Ok(format!("{{\"subscriptionId\":{id},\"epoch\":{epoch},\"kind\":{kind},\"payload\":{raw_payload}}}"))
}
fn raw_envelope_response(envelopes: &[String]) -> NapiResult<String> {
    let mut capacity = "{\"version\":1,\"ok\":true,\"value\":[]}".len();
    for (index, envelope) in envelopes.iter().enumerate() {
        capacity = match capacity.checked_add(envelope.len()).and_then(|size| size.checked_add(usize::from(index > 0))) {
            Some(size) if size <= MAX_RESPONSE_BYTES => size,
            _ => return Ok(failure(CoreError::InputTooLarge)),
        };
    }
    if capacity > MAX_RESPONSE_BYTES { return Ok(failure(CoreError::InputTooLarge)); }
    let mut output = String::with_capacity(capacity);
    output.push_str("{\"version\":1,\"ok\":true,\"value\":[");
    for (index, envelope) in envelopes.iter().enumerate() {
        if index > 0 { output.push(','); }
        output.push_str(envelope);
    }
    output.push_str("]}");
    Ok(output)
}
fn bind_stored_message_row<'a>(
    row: &'a Value,
    expected_group: &str,
    expected_author: Option<&str>,
    header: &Value,
) -> Result<&'a str, CoreError> {
    if header.get("kind").and_then(Value::as_str) != Some("chat") { return Err(CoreError::InvalidEnvelope); }
    let group = row.get("groupId").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?;
    let author = row.get("authorId").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?;
    let message_id = row.get("messageId").and_then(Value::as_str).ok_or(CoreError::InvalidEnvelope)?;
    let sequence = row.get("sequence").and_then(Value::as_u64).filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or(CoreError::InvalidSequence)?;
    if group != expected_group || expected_author.is_some_and(|expected| expected != author) ||
        header.get("groupId").and_then(Value::as_str) != Some(group) ||
        header.get("senderId").and_then(Value::as_str) != Some(author) ||
        header.get("messageId").and_then(Value::as_str) != Some(message_id) ||
        header.get("sequence").and_then(Value::as_u64) != Some(sequence) {
        return Err(CoreError::InvalidEnvelope);
    }
    Ok(author)
}
fn safe_js_epoch(value: f64) -> Option<u64> {
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > 9_007_199_254_740_991.0 {
        return None;
    }
    Some(value as u64)
}
fn validate_cloud_url(url: &str) -> Result<(), CoreError> {
    let invalid = || Err(CoreError::CloudConfiguration);
    if url.is_empty() || url.len() > 2048 || url.trim() != url || url.contains('\\') {
        return invalid();
    }
    let Some((scheme, remainder)) = url.split_once("://") else { return invalid(); };
    let is_http = scheme.eq_ignore_ascii_case("http");
    if !is_http && !scheme.eq_ignore_ascii_case("https") { return invalid(); }
    let authority = remainder.split(|character| matches!(character, '/' | '?' | '#')).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') || authority.chars().any(char::is_whitespace) {
        return invalid();
    }
    let (host, port) = if let Some(bracketed) = authority.strip_prefix('[') {
        let Some(end) = bracketed.find(']') else { return invalid(); };
        let host = &bracketed[..end];
        if host.parse::<std::net::Ipv6Addr>().is_err() { return invalid(); }
        let suffix = &bracketed[end + 1..];
        let port = if suffix.is_empty() {
            None
        } else if let Some(port) = suffix.strip_prefix(':') {
            Some(port)
        } else {
            return invalid();
        };
        (host, port)
    } else {
        if authority.matches(':').count() > 1 { return invalid(); }
        let (host, port) = authority.split_once(':').map_or((authority, None), |(host, port)| (host, Some(port)));
        if host.is_empty() || host.chars().any(|character| {
            !(character.is_alphanumeric() || character == '.' || character == '-')
        }) {
            return invalid();
        }
        (host, port)
    };
    if let Some(port) = port {
        if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) || port.parse::<u16>().is_err() {
            return invalid();
        }
    }
    let loopback = host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1";
    if is_http && !loopback { return invalid(); }
    Ok(())
}
fn queue_pending_event_error(pending: &Mutex<HashMap<String, (u64, String)>>, id: &str, epoch: u64, message: &str) {
    let mut pending = pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    pending.insert(id.to_owned(), (epoch, message.to_owned()));
}
fn insert_cancel_tombstone(registry: &mut SubscriptionRegistry, id: &str, epoch: u64) -> Result<bool, CoreError> {
    if registry.canceled.contains(&(id.to_owned(), epoch)) { return Ok(false); }
    if registry.canceled.len() >= MAX_PENDING_EVENTS { return Err(CoreError::Backpressure); }
    registry.canceled.insert((id.to_owned(), epoch));
    Ok(true)
}
fn subscription_canceled_for_registration(registry: &mut SubscriptionRegistry, id: &str, epoch: u64) -> bool {
    registry.canceled.retain(|(pending_id, pending_epoch)| pending_id != id || *pending_epoch == epoch);
    registry.canceled.contains(&(id.to_owned(), epoch))
}
fn prepare_subscription_registration(
    registry: &mut SubscriptionRegistry,
    id: &str,
    epoch: u64,
) -> Result<(), CoreError> {
    if subscription_canceled_for_registration(registry, id, epoch) {
        return Err(CoreError::Closed);
    }
    match registry.states.get(id).map(|state| (state.epoch, state.canceled, state.invalidated)) {
        Some((state_epoch, true, _)) if state_epoch == epoch => return Err(CoreError::Closed),
        Some((_, true, _)) | Some((_, false, true)) => { registry.states.remove(id); }
        Some(_) => return Err(CoreError::Conflict),
        None => {}
    }
    registry.states.retain(|_, state| !state.invalidated || state.canceled);
    if registry.states.contains_key(id) { return Err(CoreError::Conflict); }
    if registry.states.len() >= MAX_PENDING_EVENTS { return Err(CoreError::Backpressure); }
    Ok(())
}
fn is_core_operation(op: &str) -> bool {
    matches!(op,
        "getCloudStatus" | "refreshCloud" | "getPublicIdentity" | "signIdentityPayload" | "verifyIdentityPayload" |
        "createCloudGroup" | "createCloudInvite" | "listCloudInvites" | "acceptCloudInvite" | "revokeCloudInvite" |
        "removeCloudMember" | "leaveCloudGroup" | "getCloudMembers" | "getMyProfile" | "saveMyProfile" |
        "subscribeCloudMembers" | "subscribeCloudPresence" | "getTurnServers" | "getCachedCloudGroups" |
        "getCachedCloudMembers" | "getCachedMessages" | "acquireScreenShare" | "releaseScreenShare" |
        "persistOutgoingEnvelope" | "persistVerifiedEnvelope" | "readMissingEnvelopes" |
        "persistMessageAcknowledgement" | "getHighestContiguousSequence" | "getRecentMessages" |
        "sendSignal" | "subscribeSignals")
}

fn map_cloud_operation(op: &str, payload: Value, user_id: &str, access_token: &str) -> Result<(&'static str, Value), CoreError> {
    let group = || payload.get("groupId").cloned().ok_or(CoreError::InvalidRequest);
    Ok(match op {
        "subscribeCloudMembers" | "subscribeCloudPresence" | "subscribeSignals" => {
            ("open-channel", json!({
                "subscriptionId":payload.get("subscriptionId").cloned().ok_or(CoreError::InvalidRequest)?,
                "epoch":payload.get("epoch").cloned().ok_or(CoreError::InvalidRequest)?,
                "groupId":group()?,
                "userId":user_id,
                "accessToken":access_token
            }))
        }
        _ => return Err(CoreError::InvalidRequest),
    })
}

fn parse_host_response(raw: &str) -> Result<Value, CoreError> {
    if raw.len() > MAX_RESPONSE_BYTES { return Err(CoreError::InputTooLarge); }
    let envelope: Value = serde_json::from_str(raw).map_err(|_| CoreError::CloudResponse)?;
    if envelope.get("version").and_then(Value::as_u64) != Some(1) { return Err(CoreError::CloudResponse); }
    if envelope.get("ok").and_then(Value::as_bool) == Some(true) {
        let value = envelope.get("value").cloned().ok_or(CoreError::CloudResponse)?;
        if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
            return match error.get("code").and_then(Value::as_str) {
                Some("23505") => Err(CoreError::Conflict),
                Some("CLOUD_NOT_CONFIGURED") | Some("cloud-configuration") => Err(CoreError::CloudConfiguration),
                Some("401") | Some("403") | Some("cloud-authentication") => Err(CoreError::CloudAuthentication),
                _ => Err(CoreError::CloudResponse),
            };
        }
        return Ok(value.get("data").cloned().unwrap_or(value));
    }
    let error = envelope.get("error").ok_or(CoreError::CloudResponse)?;
    match error.get("code").and_then(Value::as_str) {
        Some("CLOUD_NOT_CONFIGURED") | Some("cloud-configuration") => Err(CoreError::CloudConfiguration),
        Some("cloud-authentication") | Some("unauthorized") => Err(CoreError::CloudAuthentication),
        _ => Err(CoreError::CloudTransport),
    }
}
fn response(value: Value) -> NapiResult<String> {
    let output = json!({"version":1,"ok":true,"value":value}).to_string();
    if output.len() > MAX_RESPONSE_BYTES { Ok(failure(CoreError::InputTooLarge)) } else { Ok(output) }
}
fn failure(error: CoreError) -> String { json!({"version":1,"ok":false,"error":{"code":error.code(),"message":error.message()}}).to_string() }
fn valid_subscription_id(value: &str) -> bool { !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') }
fn napi_error(error: CoreError) -> Error { Error::new(Status::GenericFailure, format!("larp-core:{}", error.code())) }
fn digest_code(code: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(code.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auth_session_normalization_preserves_fields_and_requires_credentials() {
        let session = normalize_auth_session(json!({
            "access_token":"access",
            "refresh_token":"refresh",
            "expires_in":3600,
            "user":{"id":"00000000-0000-0000-0000-000000000001"},
            "unknown_session_field":{"preserved":true}
        })).unwrap();
        validate_auth_session(&session).unwrap();
        assert!(session["expires_at"].as_i64().is_some());
        assert_eq!(session["unknown_session_field"]["preserved"], true);
        assert_eq!(
            validate_auth_session(&json!({
                "access_token":"access",
                "user":{"id":"00000000-0000-0000-0000-000000000001"},
                "expires_at":1
            })),
            Err(CoreError::CloudAuthentication)
        );
    }
    #[test]
    fn request_envelope_is_closed_and_versioned() {
        assert!(parse_request(r#"{"version":1,"op":"getMyProfile","payload":{}}"#).is_ok());
        assert!(parse_request(r#"{"version":2,"op":"getMyProfile","payload":{}}"#).is_err());
        assert!(parse_request(r#"{"version":1,"op":"getMyProfile","payload":{},"extra":1}"#).is_err());
        assert!(parse_request(r#"{"version":1,"op":"rpc","payload":{"name":"arbitrary"}}"#).is_err());
        assert!(parse_request(r#"{"version":1,"op":"getMyProfile","payload":{"extra":true}}"#).is_err());
        assert!(parse_request(r#"{"version":1,"op":"signIdentityPayload","payload":{"payload":"text"}}"#).is_err());
    }
    #[test]
    fn cloud_configuration_requires_https_except_for_loopback_hosts() {
        for url in [
            "https://project.example",
            "http://localhost:54321",
            "http://127.0.0.1:54321",
            "http://[::1]:54321",
        ] {
            assert_eq!(validate_cloud_url(url), Ok(()), "{url}");
        }
        for url in [
            "http://project.example",
            "http://localhost.example",
            "http://192.168.1.5",
            "http://user:password@localhost",
            "https://user:password@project.example",
            "ftp://localhost",
            "https://",
        ] {
            assert_eq!(validate_cloud_url(url), Err(CoreError::CloudConfiguration), "{url}");
        }
    }
    #[test]
    fn protocol_envelope_json_keeps_isolated_surrogate_escapes_raw() {
        let request = r#"{"version":1,"op":"persistOutgoingEnvelope","payload":{"message":{"version":1,"kind":"chat","groupId":"room","senderId":"author","messageId":"m1","sequence":1,"content":"\ud800","createdAt":"2026-01-01T00:00:00.000Z","signature":{"algorithm":"Ed25519","signature":"AQ=="}}}}"#;
        let parsed = parse_request(request).unwrap();
        assert_eq!(
            raw_object_field(&parsed.payload_json, "message").unwrap(),
            r#"{"version":1,"kind":"chat","groupId":"room","senderId":"author","messageId":"m1","sequence":1,"content":"\ud800","createdAt":"2026-01-01T00:00:00.000Z","signature":{"algorithm":"Ed25519","signature":"AQ=="}}"#,
        );
        let signal = r#"{"version":1,"op":"sendSignal","payload":{"groupId":"room","envelope":{"version":1,"kind":"description","sdp":"\ud800"}}}"#;
        let parsed = parse_request(signal).unwrap();
        let envelope = raw_object_field(&parsed.payload_json, "envelope").unwrap();
        assert!(envelope.contains(r#""sdp":"\ud800""#));
        let event: BTreeMap<String, Box<serde_json::value::RawValue>> =
            serde_json::from_str(r#"{"kind":"signal","payload":{"envelope":{"kind":"description","sdp":"\ud800"}}}"#).unwrap();
        assert_eq!(raw_signal_envelope(&event).unwrap(), r#"{"kind":"description","sdp":"\ud800"}"#);
        assert_eq!(
            raw_envelope_response(&[envelope.clone()]).unwrap(),
            format!(r#"{{"version":1,"ok":true,"value":[{envelope}]}}"#),
        );
    }
    #[test]
    fn safe_epoch_accepts_javascript_number_boundary_only() {
        assert_eq!(safe_js_epoch(0.0), Some(0));
        assert_eq!(safe_js_epoch(9_007_199_254_740_991.0), Some(9_007_199_254_740_991));
        assert_eq!(safe_js_epoch(9_007_199_254_740_992.0), None);
        assert_eq!(safe_js_epoch(1.5), None);
        assert_eq!(safe_js_epoch(-1.0), None);
        assert_eq!(safe_js_epoch(f64::NAN), None);
    }
    #[test]
    fn deferred_event_error_tracks_latest_subscription_epoch() {
        let pending = Mutex::new(HashMap::new());
        queue_pending_event_error(&pending, "subscription", 7, "old");
        queue_pending_event_error(&pending, "subscription", 8, "new");
        assert_eq!(
            pending.lock().unwrap().get("subscription").cloned(),
            Some((8, "new".to_owned())),
        );
    }
    #[test]
    fn early_subscription_cancel_blocks_same_epoch_and_cleans_stale_registration() {
        let mut registry = SubscriptionRegistry { states: HashMap::new(), canceled: HashSet::new() };
        assert_eq!(insert_cancel_tombstone(&mut registry, "subscription", 7), Ok(true));
        assert_eq!(prepare_subscription_registration(&mut registry, "subscription", 7), Err(CoreError::Closed));
        assert!(subscription_canceled_for_registration(&mut registry, "subscription", 7));
        registry.states.insert("subscription".into(), SubscriptionState {
            generation: 1, epoch: 7, group_id: "room".into(), kind: "signal", member_ids: HashSet::new(),
            member_public_keys: HashMap::new(), presence_ready: false, invalidated: true, canceled: true,
        });
        assert_eq!(prepare_subscription_registration(&mut registry, "subscription", 8), Ok(()));
        assert!(!registry.states.contains_key("subscription"));
        assert!(registry.canceled.is_empty());
    }
    #[test]
    fn stored_message_row_must_match_projected_envelope_header() {
        let row = json!({"groupId":"room","authorId":"author","messageId":"m1","sequence":1});
        let header = json!({"kind":"chat","groupId":"room","senderId":"author","messageId":"m1","sequence":1});
        assert_eq!(bind_stored_message_row(&row, "room", Some("author"), &header), Ok("author"));
        assert_eq!(bind_stored_message_row(&row, "other", Some("author"), &header), Err(CoreError::InvalidEnvelope));
        assert_eq!(bind_stored_message_row(&row, "room", Some("other"), &header), Err(CoreError::InvalidEnvelope));
        assert_eq!(bind_stored_message_row(&row, "room", None, &json!({"kind":"chat","groupId":"room","senderId":"author","messageId":"m2","sequence":1})), Err(CoreError::InvalidEnvelope));
        assert_eq!(bind_stored_message_row(&row, "room", None, &json!({"kind":"chat","groupId":"room","senderId":"author","messageId":"m1","sequence":2})), Err(CoreError::InvalidEnvelope));
    }
    #[cfg(windows)]
    #[test]
    fn atomic_write_replaces_an_existing_encrypted_file_on_windows() {
        let path = std::env::temp_dir().join(format!("larp-atomic-write-{}.json", std::process::id()));
        fs::write(&path, b"old-ciphertext").unwrap();
        assert_eq!(atomic_write(&path, b"new-ciphertext"), Ok(()));
        assert_eq!(fs::read(&path).unwrap(), b"new-ciphertext");
        let _ = fs::remove_file(path);
    }
    #[cfg(windows)]
    #[test]
    fn windows_replacement_fallback_keeps_new_file_and_removes_old() {
        let path = std::env::temp_dir().join(format!("larp-atomic-fallback-{}.json", std::process::id()));
        let temp = path.with_extension("pending");
        fs::write(&path, b"old-ciphertext").unwrap();
        fs::write(&temp, b"new-ciphertext").unwrap();
        assert_eq!(replace_existing_file_windows(&temp, &path), Ok(()));
        assert_eq!(fs::read(&path).unwrap(), b"new-ciphertext");
        assert!(!temp.exists());
        let _ = fs::remove_file(path);
    }
    #[cfg(windows)]
    #[test]
    fn windows_replacement_failure_keeps_existing_encrypted_file() {
        let path = std::env::temp_dir().join(format!("larp-atomic-locked-{}.json", std::process::id()));
        let temp = path.with_extension("pending");
        fs::write(&path, b"old-ciphertext").unwrap();
        fs::write(&temp, b"new-ciphertext").unwrap();
        use std::os::windows::fs::OpenOptionsExt;
        let lock = fs::OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
        assert_eq!(replace_existing_file_windows(&temp, &path), Err(CoreError::Storage));
        drop(lock);
        assert_eq!(fs::read(&path).unwrap(), b"old-ciphertext");
        let _ = fs::remove_file(temp);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn realtime_channel_credentials_are_bound_to_native_session() {
        let (op, payload) = map_cloud_operation(
            "subscribeCloudMembers",
            json!({"subscriptionId":"sub","epoch":1,"groupId":"group"}),
            "user-id",
            "access-token",
        ).unwrap();
        assert_eq!(op, "open-channel");
        assert_eq!(payload["userId"], "user-id");
        assert_eq!(payload["accessToken"], "access-token");
        assert!(map_cloud_operation("rpc", json!({"name":"drop_table"}), "user-id", "access-token").is_err());
    }
    #[test]
    fn host_response_requires_envelope_and_value() {
        assert_eq!(parse_host_response(r#"{"version":1,"ok":true,"value":false}"#).unwrap(), Value::Bool(false));
        assert!(parse_host_response(r#"{"version":1,"ok":true}"#).is_err());
    }
    #[test]
    fn cloud_not_configured_keeps_its_distinct_error() {
        assert_eq!(
            parse_host_response(r#"{"version":1,"ok":false,"error":{"code":"CLOUD_NOT_CONFIGURED"}}"#),
            Err(CoreError::CloudConfiguration)
        );
    }

    #[test]
    fn identity_message_base64_is_canonical_bounded_and_byte_preserving() {
        assert_eq!(decode_identity_payload(&json!({"payloadBase64":"8J+YgA=="})).unwrap(), [0xf0, 0x9f, 0x98, 0x80]);
        assert_eq!(decode_identity_payload(&json!({"payload":"hello"})), Err(CoreError::InvalidRequest));
        assert_eq!(decode_identity_payload(&json!({"payloadBase64":"YQ"})), Err(CoreError::InvalidRequest));
    }

    #[test]
    fn presence_subscription_retracks_only_on_a_new_ready_transition() {
        let mut states = HashMap::new();
        states.insert("sub".into(), SubscriptionState {
            generation: 3,
            epoch: 7,
            group_id: "room".into(),
            kind: "presence",
            member_ids: HashSet::new(),
            member_public_keys: HashMap::new(),
            presence_ready: false,
            invalidated: false,
            canceled: false,
        });
        let mut registry = SubscriptionRegistry { states, canceled: HashSet::new() };

        assert_eq!(NativeLarpCore::update_presence_ready_state(&mut registry, "sub", 3, 7, false), Ok(false));
        assert_eq!(NativeLarpCore::update_presence_ready_state(&mut registry, "sub", 3, 7, true), Ok(true));
        assert_eq!(NativeLarpCore::update_presence_ready_state(&mut registry, "sub", 3, 7, true), Ok(false));
        assert_eq!(NativeLarpCore::update_presence_ready_state(&mut registry, "sub", 3, 7, false), Ok(false));
        assert_eq!(NativeLarpCore::update_presence_ready_state(&mut registry, "sub", 3, 7, true), Ok(true));
        assert_eq!(NativeLarpCore::update_presence_ready_state(&mut registry, "sub", 3, 8, true), Err(CoreError::Closed));

        registry.states.get_mut("sub").unwrap().invalidated = true;
        assert_eq!(NativeLarpCore::update_presence_ready_state(&mut registry, "sub", 3, 7, true), Err(CoreError::Closed));
    }

    #[test]
    fn presence_projection_aggregates_trusted_member_sessions() {
        let members = ["user-1".to_owned()].into_iter().collect::<HashSet<_>>();
        assert_eq!(
            validate_presence_payload(json!({"presence":{
                "user-1":[{"userId":"user-1","status":"away"},{"userId":"user-1","status":"online"}],
                "outsider":[{"userId":"outsider","status":"online"}],
                "user-2":[{"userId":"someone-else","status":"online"}]
            },"ready":true}), &members).unwrap(),
            json!({"presence":{"user-1":"online"},"ready":true})
        );
        assert_eq!(
            validate_presence_payload(json!({"presence":{"user-1":[{"userId":"user-1","status":"away"}]},"ready":false}), &members).unwrap(),
            json!({"presence":{"user-1":"away"},"ready":false})
        );
        assert!(validate_presence_payload(json!({"presence":{"user-1":"online"},"ready":true}), &members).is_err());
        assert!(validate_presence_payload(json!({"presence":{},"ready":"true"}), &members).is_err());
    }

    #[test]
    fn targeted_signal_requires_authenticated_member_and_keeps_media_state() {
        let header = json!({"kind":"media-state","groupId":"room","senderId":"local","recipientId":"peer"});
        let members = vec![json!({"userId":"local"}),json!({"userId":"peer"})];
        assert_eq!(validate_signal_header(&header,"room","local",&members).unwrap(),"peer");
        assert_eq!(validate_signal_header(&header,"room","outsider",&members),Err(CoreError::InvalidEnvelope));
        let outsiders = vec![json!({"userId":"local"})];
        assert_eq!(validate_signal_header(&header,"room","local",&outsiders),Err(CoreError::InvalidIdentity));
    }

    #[test]
    fn incoming_targeted_signal_must_verify_and_target_local_member() {
        let public = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----\n";
        let signature = json!({"algorithm":"Ed25519","signature":"5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc+bRr0lv18FlbviRlUUFDjnoQCw=="});
        let header = json!({"kind":"media-state","groupId":"room","senderId":"peer","recipientId":"local"});
        let keys = [("peer".to_owned(),public.to_owned())].into_iter().collect::<HashMap<_,_>>();
        assert!(verify_received_signal(&header,"room","local",&keys,"",&signature).is_ok());
        assert_eq!(verify_received_signal(&header,"room","other",&keys,"",&signature),Err(CoreError::InvalidEnvelope));
        assert_eq!(verify_received_signal(&header,"room","local",&HashMap::new(),"",&signature),Err(CoreError::InvalidIdentity));
    }
    #[test]
    fn signed_projection_verification_requires_valid_ed25519_signature() {
        let public = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----\n";
        let header = json!({"senderId":"user"});
        let signature = json!({"algorithm":"Ed25519","signature":"5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc+bRr0lv18FlbviRlUUFDjnoQCw=="});
        assert!(verify_projection(&header, &signature, "", public).is_ok());
        assert_eq!(verify_projection(&header, &signature, "YQ==", public), Err(CoreError::InvalidIdentity));
    }
}
