use base64::Engine as _;
use std::time::Duration;

use reqwest::{Client, Method, Url, header};
use serde_json::Value;

use crate::error::CoreError;

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// A bounded, redirect-free transport for Supabase Auth, REST, and Functions APIs.
pub(crate) struct CloudHttp {
    base_url: Url,
    anon_key: String,
    client: Client,
}

impl CloudHttp {
    pub(crate) fn new(base_url: &str, anon_key: &str) -> Result<Self, CoreError> {
        Self::with_timeout(base_url, anon_key, REQUEST_TIMEOUT)
    }

    fn with_timeout(base_url: &str, anon_key: &str, timeout: Duration) -> Result<Self, CoreError> {
        let base_url = validate_base_url(base_url)?;
        validate_anon_key(anon_key)?;

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .build()
            .map_err(|_| CoreError::CloudConfiguration)?;

        Ok(Self { base_url, anon_key: anon_key.to_owned(), client })
    }

    /// Sends a request to a fixed Supabase API path and parses a bounded JSON response.
    /// `access_token` is a user session token; the configured public key is never replaced.
    pub(crate) async fn request(
        &self,
        method: Method,
        fixed_path: &str,
        access_token: Option<&str>,
        body: Option<&Value>,
    ) -> Result<Value, CoreError> {
        let (fixed_path, query) = validate_fixed_path(fixed_path)?;
        if query == Some("select=user_id,display_name,avatar_data") && method != Method::POST {
            return Err(CoreError::CloudConfiguration);
        }
        let wants_representation = method == Method::POST || method == Method::PATCH;
        let mut url = self.base_url.clone();
        let base_path = url.path().trim_end_matches('/');
        url.set_path(&format!("{base_path}{fixed_path}"));
        url.set_query(query);

        let mut request = self
            .client
            .request(method, url)
            .header(header::ACCEPT, "application/json")
            .header("apikey", &self.anon_key)
            .bearer_auth(access_token.unwrap_or(&self.anon_key));
        if wants_representation {
            request = request.header("Prefer", "return=representation");
        }
        if let Some(body) = body {
            request = request.json(body);
        }

        let mut response = request
            .send()
            .await
            .map_err(|_| CoreError::CloudTransport)?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(CoreError::CloudAuthentication);
        }
        if status.is_redirection() {
            return Err(CoreError::CloudResponse);
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(CoreError::CloudResponse);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| CoreError::CloudTransport)?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(CoreError::CloudResponse);
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() && status.is_success() {
            return Ok(Value::Null);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| CoreError::CloudResponse)?;
        if !status.is_success() {
            if value.get("code").and_then(Value::as_str) == Some("23505") {
                return Err(CoreError::Conflict);
            }
            return Err(CoreError::CloudResponse);
        }
        Ok(value)
    }
}

fn validate_base_url(base_url: &str) -> Result<Url, CoreError> {
    let authority = base_url
        .split_once("://")
        .and_then(|(_, remainder)| remainder.split(|character| matches!(character, '/' | '?' | '#')).next())
        .ok_or(CoreError::CloudConfiguration)?;
    if authority.is_empty() || authority.contains('@') {
        return Err(CoreError::CloudConfiguration);
    }
    let url = Url::parse(base_url).map_err(|_| CoreError::CloudConfiguration)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CoreError::CloudConfiguration);
    }
    let host = url.host_str().ok_or(CoreError::CloudConfiguration)?;
    let is_loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1");
    if url.scheme() != "https" && !(url.scheme() == "http" && is_loopback) {
        return Err(CoreError::CloudConfiguration);
    }
    Ok(url)
}

fn validate_anon_key(key: &str) -> Result<(), CoreError> {
    if key.is_empty() || key.trim() != key || key.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(CoreError::CloudConfiguration);
    }
    let role = jwt_role(key);
    if key.starts_with("sb_secret_") || role.as_deref() == Some("service_role") {
        return Err(CoreError::CloudConfiguration);
    }
    let is_publishable = key
        .strip_prefix("sb_publishable_")
        .is_some_and(|suffix| !suffix.is_empty());
    let is_legacy_anon = role.as_deref() == Some("anon");
    if !is_publishable && !is_legacy_anon {
        return Err(CoreError::CloudConfiguration);
    }
    Ok(())
}

fn jwt_role(key: &str) -> Option<String> {
    let mut segments = key.split('.');
    let _header = segments.next()?;
    let payload = segments.next()?;
    if segments.next().is_none() {
        return None;
    }
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .ok()?;
    let payload: Value = serde_json::from_slice(&payload).ok()?;
    payload.get("role")?.as_str().map(str::to_owned)
}

fn validate_fixed_path(path: &str) -> Result<(&str, Option<&str>), CoreError> {
    let (route, query) = path
        .split_once('?')
        .map_or((path, None), |(route, query)| (route, Some(query)));
    if !route.starts_with('/')
        || route.starts_with("//")
        || route.chars().any(|character| matches!(character, '?' | '#' | '\\'))
        || route.split('/').any(|segment| segment == "." || segment == "..")
    {
        return Err(CoreError::CloudConfiguration);
    }

    match (route, query) {
        ("/auth/v1/token", Some("grant_type=refresh_token")) => {}
        ("/rest/v1/larp_user_profiles", Some(query)) if valid_profile_query(query) => {}
        ("/auth/v1/signup", None) | ("/functions/v1/turn-credentials", None) => {}
        (_, None)
            if route
                .strip_prefix("/rest/v1/rpc/")
                .is_some_and(valid_rpc_name) => {}
        _ => return Err(CoreError::CloudConfiguration),
    }
    if query.is_some_and(|query| query.chars().any(|character| matches!(character, '?' | '#' | '\\'))) {
        return Err(CoreError::CloudConfiguration);
    }
    Ok((route, query))
}

fn valid_profile_query(query: &str) -> bool {
    const SELECT: &str = "select=user_id,display_name,avatar_data";
    if query == SELECT {
        return true;
    }
    let mut has_select = false;
    let mut has_filter = false;
    for parameter in query.split('&') {
        if parameter == SELECT && !has_select {
            has_select = true;
            continue;
        }
        if let Some(filter) = parameter.strip_prefix("user_id=") {
            if !has_filter && valid_uuid_filter(filter) {
                has_filter = true;
                continue;
            }
        }
        return false;
    }
    has_select && has_filter
}

fn valid_rpc_name(name: &str) -> bool {
    matches!(
        name,
        "register_identity"
            | "create_group"
            | "list_my_groups"
            | "create_group_invite"
            | "list_group_invites"
            | "accept_group_invite"
            | "revoke_group_invite"
            | "remove_group_member"
            | "leave_group"
            | "acquire_group_share_lease"
            | "release_group_share_lease"
            | "list_group_members"
    )

}
fn valid_uuid_filter(filter: &str) -> bool {
    if let Some(uuid) = filter.strip_prefix("eq.") {
        return is_uuid(uuid);
    }
    let Some(list) = filter
        .strip_prefix("in.(")
        .and_then(|list| list.strip_suffix(')'))
    else {
        return false;
    };
    let mut count = 0;
    for uuid in list.split(',') {
        if !is_uuid(uuid) {
            return false;
        }
        count += 1;
    }
    (1..=100).contains(&count)
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
        time::Duration,
    };

    use base64::Engine as _;
    use reqwest::Method;
    use serde_json::json;

    use super::{CloudHttp, validate_anon_key, validate_base_url, validate_fixed_path};
    use crate::error::CoreError;

    fn local_server(response: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local fixture");
        let address = listener.local_addr().expect("fixture address");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept local request");
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(&response);
        });
        format!("http://{address}")
    }
    fn local_server_capturing_request(response: Vec<u8>) -> (String, thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local fixture");
        let address = listener.local_addr().expect("fixture address");
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept local request");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            loop {
                let count = stream.read(&mut buffer).expect("read local request");
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                }).unwrap_or(0);
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }
            let _ = stream.write_all(&response);
            request
        });
        (format!("http://{address}"), worker)
    }

    fn delayed_local_server(response: Vec<u8>, delay: Duration) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local fixture");
        let address = listener.local_addr().expect("fixture address");
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept local request");
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            thread::sleep(delay);
            let _ = stream.write_all(&response);
        });
        (format!("http://{address}"), worker)
    }

    fn http_response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    fn anon_jwt(role: &str) -> String {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(format!(r#"{{"role":"{role}"}}"#));
        format!("e30.{payload}.signature")
    }

    #[tokio::test]
    async fn applies_the_session_token_without_replacing_the_public_api_key() {
        let (base_url, worker) = local_server_capturing_request(http_response("200 OK", "", br#"{"id":"user"}"#));
        let client = CloudHttp::new(&base_url, "sb_publishable_fixture").expect("client");
        let body = json!({"data":{}});
        assert_eq!(
            client.request(Method::POST, "/auth/v1/signup", Some("user-session-token"), Some(&body)).await,
            Ok(json!({"id":"user"})),
        );
        let request = String::from_utf8(worker.join().expect("fixture worker")).expect("HTTP request");
        let (headers, body) = request.split_once("\r\n\r\n").expect("request headers");
        let headers = headers.to_ascii_lowercase();
        assert!(headers.contains("apikey: sb_publishable_fixture"));
        assert!(headers.contains("authorization: bearer user-session-token"));
        assert!(headers.contains("accept: application/json"));
        assert!(headers.contains("prefer: return=representation"));
        assert!(headers.contains("content-type: application/json"));
        assert_eq!(body, r#"{"data":{}}"#);
    }

    #[tokio::test]
    async fn maps_timeout_and_malformed_success_body_to_transport_errors() {
        let (base_url, worker) = delayed_local_server(
            http_response("200 OK", "", b"{}"),
            Duration::from_millis(150),
        );
        let client = CloudHttp::with_timeout(&base_url, "sb_publishable_fixture", Duration::from_millis(20))
            .expect("client");
        assert_eq!(
            client.request(Method::GET, "/rest/v1/rpc/list_my_groups", None, None).await,
            Err(CoreError::CloudTransport),
        );
        worker.join().expect("fixture worker");

        let base_url = local_server(http_response("200 OK", "", b"not-json"));
        let client = CloudHttp::new(&base_url, "sb_publishable_fixture").expect("client");
        assert_eq!(
            client.request(Method::GET, "/rest/v1/rpc/list_my_groups", None, None).await,
            Err(CoreError::CloudResponse),
        );
    }

    #[tokio::test]
    async fn enforces_response_cap() {
        let body = vec![b'a'; 8 * 1024 * 1024 + 1];
        let mut response = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        response.extend_from_slice(&body);
        let base_url = local_server(response);
        let client = CloudHttp::new(&base_url, "sb_publishable_fixture").expect("client");
        assert_eq!(
            client
                .request(Method::POST, "/auth/v1/signup", None, None)
                .await,
            Err(CoreError::CloudResponse)
        );
    }

    #[tokio::test]
    async fn maps_error_status_and_rejects_redirect() {
        for (status, headers, body, expected) in [
            ("401 Unauthorized", "", b"{}".as_slice(), CoreError::CloudAuthentication),
            ("403 Forbidden", "", b"{}".as_slice(), CoreError::CloudAuthentication),
            (
                "302 Found",
                "Location: http://127.0.0.1/elsewhere\r\n",
                b"{}",
                CoreError::CloudResponse,
            ),
            (
                "409 Conflict",
                "",
                br#"{"code":"23505"}"#,
                CoreError::Conflict,
            ),
        ] {
            let base_url = local_server(http_response(status, headers, body));
            let client = CloudHttp::new(&base_url, "sb_publishable_fixture").expect("client");
            assert_eq!(
                client
                    .request(Method::GET, "/rest/v1/rpc/list_my_groups", None, None)
                    .await,
                Err(expected)
            );
        }
    }

    #[test]
    fn validates_urls_and_public_keys() {
        for address in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://@example.com",
            "https://example.com/?token=x",
            "https://example.com/#fragment",
        ] {
            assert_eq!(
                validate_base_url(address),
                Err(CoreError::CloudConfiguration)
            );
        }
        for address in [
            "http://localhost:54321",
            "http://127.0.0.1:54321",
            "http://[::1]:54321",
        ] {
            assert!(validate_base_url(address).is_ok());
        }
        assert!(validate_anon_key("sb_publishable_fixture").is_ok());
        assert!(validate_anon_key(&anon_jwt("anon")).is_ok());
        assert_eq!(
            validate_anon_key(&anon_jwt("service_role")),
            Err(CoreError::CloudConfiguration)
        );
        assert_eq!(
            validate_anon_key("sb_secret_fixture"),
            Err(CoreError::CloudConfiguration)
        );
    }

    #[tokio::test]
    async fn profile_select_only_query_is_post_only() {
        let client =
            CloudHttp::new("http://127.0.0.1:1", "sb_publishable_fixture").expect("client");
        assert_eq!(
            client
                .request(
                    Method::GET,
                    "/rest/v1/larp_user_profiles?select=user_id,display_name,avatar_data",
                    None,
                    None
                )
                .await,
            Err(CoreError::CloudConfiguration)
        );
    }
    #[test]
    fn only_accepts_fixed_relative_api_paths_and_queries() {
        for path in [
            "//attacker.test/path",
            "https://attacker.test",
            "/a/../b",
            "/auth?x=1",
            "/auth#x",
            "/\\attacker",
            "/auth/v1/user",
            "/rest/v1/rpc/not_approved",
            "/rest/v1/larp_user_profiles",
            "/auth/v1/token?grant_type=other",
            "/auth/v1/token?grant_type=refresh_token&next=evil",
            "/rest/v1/larp_user_profiles?select=*&user_id=eq.00000000-0000-0000-0000-000000000000",
            "/rest/v1/larp_user_profiles?select=user_id,display_name,avatar_data&user_id=eq.not-a-uuid",
            "/rest/v1/larp_user_profiles?select=user_id,display_name,avatar_data&user_id=eq.00000000-0000-0000-0000-000000000000&admin=true",
        ] {
            assert_eq!(
                validate_fixed_path(path),
                Err(CoreError::CloudConfiguration)
            );
        }
        assert_eq!(
            validate_fixed_path("/auth/v1/signup"),
            Ok(("/auth/v1/signup", None))
        );
        assert_eq!(
            validate_fixed_path("/functions/v1/turn-credentials"),
            Ok(("/functions/v1/turn-credentials", None))
        );
        assert_eq!(
            validate_fixed_path("/rest/v1/rpc/register_identity"),
            Ok(("/rest/v1/rpc/register_identity", None))
        );
        assert_eq!(
            validate_fixed_path("/auth/v1/token?grant_type=refresh_token"),
            Ok(("/auth/v1/token", Some("grant_type=refresh_token")))
        );
        assert!(validate_fixed_path("/rest/v1/larp_user_profiles?select=user_id,display_name,avatar_data").is_ok());
        assert!(validate_fixed_path("/rest/v1/larp_user_profiles?select=user_id,display_name,avatar_data&user_id=eq.00000000-0000-0000-0000-000000000000").is_ok());
        assert!(validate_fixed_path("/rest/v1/larp_user_profiles?user_id=in.(00000000-0000-0000-0000-000000000000,11111111-1111-1111-1111-111111111111)&select=user_id,display_name,avatar_data").is_ok());
    }
}
