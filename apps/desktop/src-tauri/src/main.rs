use reqwest::header::{
    HeaderMap as ReqwestHeaderMap, HeaderName as ReqwestHeaderName,
    HeaderValue as ReqwestHeaderValue,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{
    http::{header, Request, Response, StatusCode},
    ipc::Channel,
    webview::NewWindowResponse,
    State, WebviewUrl, WebviewWindowBuilder,
};
use url::Url;

const DEFAULT_SERVER_ORIGIN: &str = "https://www.honesttai.com";
const DESKTOP_USER_AGENT: &str = "ZZGeoDesktop/0.2.0";
static CHILD_WINDOW_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct CloudClient {
    client: reqwest::Client,
    origin: Url,
    requests: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum AgentStreamEvent {
    Head {
        status: u16,
        content_type: String,
        request_id: Option<String>,
    },
    Chunk {
        data: Vec<u8>,
    },
    End,
    Error {
        message: String,
    },
}

fn server_origin() -> Url {
    let configured = std::env::var("GEO_DESKTOP_SERVER_ORIGIN")
        .unwrap_or_else(|_| DEFAULT_SERVER_ORIGIN.to_string());
    let origin =
        Url::parse(configured.trim()).expect("GEO_DESKTOP_SERVER_ORIGIN must be a valid URL");
    let local_http = origin.scheme() == "http"
        && matches!(origin.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
    assert!(
        origin.scheme() == "https" || (cfg!(debug_assertions) && local_http),
        "GEO_DESKTOP_SERVER_ORIGIN must use HTTPS"
    );
    assert!(
        origin.username().is_empty()
            && origin.password().is_none()
            && origin.query().is_none()
            && origin.fragment().is_none()
            && (origin.path().is_empty() || origin.path() == "/"),
        "GEO_DESKTOP_SERVER_ORIGIN must be an origin without credentials, path, query, or fragment"
    );
    origin
}

fn development_url() -> Url {
    Url::parse("http://127.0.0.1:3000/app/?desktop=1").expect("valid desktop development URL")
}

fn embedded_url() -> Url {
    Url::parse("geo://localhost/app/?desktop=1").expect("valid embedded desktop URL")
}

fn asset_path(path: &str) -> Option<String> {
    match path {
        "/" | "/app" | "/app/" | "/app/index.html" => Some("index.html".to_string()),
        _ => path
            .strip_prefix("/app/")
            .filter(|path| !path.is_empty())
            .map(ToOwned::to_owned),
    }
}

fn is_cloud_path(path: &str) -> bool {
    ["/api", "/artifacts", "/share", "/help"]
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}

fn is_embedded_origin(url: &Url) -> bool {
    matches!(url.host_str(), Some("geo.localhost" | "localhost"))
        && matches!(url.scheme(), "http" | "https" | "geo")
}

fn external_url(origin: &Url, requested: &Url) -> Option<Url> {
    if is_embedded_origin(requested) {
        if requested.path() == "/help" || requested.path().starts_with("/help/") {
            let mut target = origin.clone();
            target.set_path(requested.path());
            target.set_query(requested.query());
            return Some(target);
        }
        return None;
    }
    matches!(requested.scheme(), "http" | "https").then(|| requested.clone())
}

fn embedded_artifact_url(requested: &Url) -> Option<Url> {
    if !is_embedded_origin(requested) || !requested.path().starts_with("/artifacts/") {
        return None;
    }
    let mut target = format!("geo://localhost{}", requested.path());
    if let Some(query) = requested.query() {
        target.push('?');
        target.push_str(query);
    }
    Url::parse(&target).ok()
}

fn cloud_url(origin: &Url, request: &Request<Vec<u8>>) -> Result<Url, url::ParseError> {
    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    Url::parse(&format!(
        "{}{}",
        origin.as_str().trim_end_matches('/'),
        path_and_query
    ))
}

fn should_forward_request_header(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "accept-encoding"
            | "connection"
            | "content-length"
            | "cookie"
            | "host"
            | "origin"
            | "referer"
            | "transfer-encoding"
    )
}

fn should_forward_response_header(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "connection" | "content-length" | "set-cookie" | "transfer-encoding"
    )
}

fn asset_response<R: tauri::Runtime>(
    resolver: &tauri::AssetResolver<R>,
    path: &str,
) -> Response<Vec<u8>> {
    let Some(asset) = resolver.get_for_scheme(path.to_string(), false) else {
        return text_response(StatusCode::NOT_FOUND, "Desktop asset not found");
    };
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, asset.mime_type())
        .header(
            header::CACHE_CONTROL,
            if path == "index.html" {
                "no-cache"
            } else {
                "public, max-age=31536000, immutable"
            },
        );
    if let Some(csp) = asset.csp_header() {
        builder = builder.header(header::CONTENT_SECURITY_POLICY, csp);
    }
    builder
        .body(asset.bytes().to_vec())
        .expect("valid embedded asset response")
}

fn text_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(message.as_bytes().to_vec())
        .expect("valid desktop error response")
}

fn proxy_error_response() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::BAD_GATEWAY)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(r#"{"error":"无法连接云端服务，请检查网络后重试"}"#.as_bytes().to_vec())
        .expect("valid desktop proxy error response")
}

async fn proxy_request(
    client: reqwest::Client,
    origin: Url,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let target = match cloud_url(&origin, &request) {
        Ok(target) => target,
        Err(_) => return proxy_error_response(),
    };
    let method = match reqwest::Method::from_bytes(request.method().as_str().as_bytes()) {
        Ok(method) => method,
        Err(_) => {
            return text_response(StatusCode::METHOD_NOT_ALLOWED, "Unsupported request method")
        }
    };
    let mut headers = ReqwestHeaderMap::new();
    for (name, value) in request.headers() {
        if !should_forward_request_header(name.as_str()) {
            continue;
        }
        let Ok(name) = ReqwestHeaderName::from_bytes(name.as_str().as_bytes()) else {
            continue;
        };
        let Ok(value) = ReqwestHeaderValue::from_bytes(value.as_bytes()) else {
            continue;
        };
        headers.append(name, value);
    }
    headers.insert(
        reqwest::header::USER_AGENT,
        ReqwestHeaderValue::from_static(DESKTOP_USER_AGENT),
    );

    let upstream = match client
        .request(method, target)
        .headers(headers)
        .body(request.into_body())
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return proxy_error_response(),
    };
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let response_headers = upstream.headers().clone();
    let body = match upstream.bytes().await {
        Ok(body) => body.to_vec(),
        Err(_) => return proxy_error_response(),
    };
    let mut response = Response::builder()
        .status(status)
        .body(body)
        .expect("valid cloud response");
    for (name, value) in &response_headers {
        if !should_forward_response_header(name.as_str()) {
            continue;
        }
        let Ok(name) = header::HeaderName::from_bytes(name.as_str().as_bytes()) else {
            continue;
        };
        let Ok(value) = header::HeaderValue::from_bytes(value.as_bytes()) else {
            continue;
        };
        response.headers_mut().append(name, value);
    }
    response
}

fn is_safe_runtime_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn remove_agent_request(state: &CloudClient, request_id: &str) {
    if let Ok(mut requests) = state.requests.lock() {
        requests.remove(request_id);
    }
}

#[tauri::command]
async fn stream_agent_response(
    state: State<'_, CloudClient>,
    session_id: String,
    run_id: String,
    client_id: String,
    request_id: String,
    body: String,
    on_event: Channel<AgentStreamEvent>,
) -> Result<(), String> {
    if !is_safe_runtime_id(&session_id)
        || !is_safe_runtime_id(&run_id)
        || !is_safe_runtime_id(&client_id)
        || !is_safe_runtime_id(&request_id)
    {
        return Err("Invalid desktop Agent identifier".to_string());
    }
    if body.len() > 2_000_000 {
        return Err("Desktop Agent request is too large".to_string());
    }
    let request: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| "Desktop Agent request is not valid JSON".to_string())?;
    let mut target = state.origin.clone();
    target.set_path(&format!(
        "/api/workbench/sessions/{session_id}/desktop/responses"
    ));
    target.set_query(None);
    let request = state
        .client
        .post(target)
        .header("content-type", "application/json")
        .header("x-geo-client", "desktop")
        .json(&serde_json::json!({
            "runId": run_id,
            "clientId": client_id,
            "request": request,
        }));
    let (cancel, mut cancelled) = tokio::sync::oneshot::channel();
    if let Ok(mut requests) = state.requests.lock() {
        if let Some(previous) = requests.insert(request_id.clone(), cancel) {
            let _ = previous.send(());
        }
    } else {
        return Err("Desktop Agent request registry is unavailable".to_string());
    }
    let upstream = match tokio::select! {
        _ = &mut cancelled => {
            let _ = on_event.send(AgentStreamEvent::End);
            return Ok(());
        }
        response = request.send() => response
    } {
        Ok(response) => response,
        Err(error) => {
            remove_agent_request(&state, &request_id);
            let message = format!("无法连接 Agent 请求代理：{error}");
            let _ = on_event.send(AgentStreamEvent::Error {
                message: message.clone(),
            });
            return Err(message);
        }
    };
    let status = upstream.status().as_u16();
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("text/event-stream; charset=utf-8")
        .to_string();
    let upstream_request_id = upstream
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    if let Err(error) = on_event.send(AgentStreamEvent::Head {
        status,
        content_type,
        request_id: upstream_request_id,
    }) {
        remove_agent_request(&state, &request_id);
        return Err(error.to_string());
    }
    let mut upstream = upstream;
    loop {
        let chunk = tokio::select! {
            _ = &mut cancelled => {
                let _ = on_event.send(AgentStreamEvent::End);
                remove_agent_request(&state, &request_id);
                return Ok(());
            }
            chunk = upstream.chunk() => chunk
        };
        match chunk {
            Ok(Some(chunk)) => {
                if let Err(error) = on_event.send(AgentStreamEvent::Chunk {
                    data: chunk.to_vec(),
                }) {
                    remove_agent_request(&state, &request_id);
                    return Err(error.to_string());
                }
            }
            Ok(None) => break,
            Err(error) => {
                remove_agent_request(&state, &request_id);
                let message = format!("Agent 响应流中断：{error}");
                let _ = on_event.send(AgentStreamEvent::Error {
                    message: message.clone(),
                });
                return Err(message);
            }
        }
    }
    remove_agent_request(&state, &request_id);
    on_event
        .send(AgentStreamEvent::End)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn cancel_agent_response(state: State<'_, CloudClient>, request_id: String) -> Result<(), String> {
    if !is_safe_runtime_id(&request_id) {
        return Err("Invalid desktop Agent request identifier".to_string());
    }
    let sender = state
        .requests
        .lock()
        .map_err(|_| "Desktop Agent request registry is unavailable".to_string())?
        .remove(&request_id);
    if let Some(sender) = sender {
        let _ = sender.send(());
    }
    Ok(())
}

fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let origin = server_origin();
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .user_agent(DESKTOP_USER_AGENT)
        .build()
        .expect("failed to initialize the desktop cloud client");
    let cloud = CloudClient {
        client,
        origin,
        requests: Arc::new(Mutex::new(HashMap::new())),
    };
    let protocol_cloud = cloud.clone();
    let setup_origin = cloud.origin.clone();

    tauri::Builder::default()
		.manage(cloud)
		.invoke_handler(tauri::generate_handler![stream_agent_response, cancel_agent_response])
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol("geo", move |context, request, responder| {
            let path = request.uri().path().to_string();
            if is_cloud_path(&path) {
                let client = protocol_cloud.client.clone();
                let origin = protocol_cloud.origin.clone();
                tauri::async_runtime::spawn(async move {
                    responder.respond(proxy_request(client, origin, request).await);
                });
                return;
            }

            let response = match asset_path(&path) {
                Some(path) => asset_response(&context.app_handle().asset_resolver(), &path),
                None => text_response(StatusCode::NOT_FOUND, "Desktop route not found"),
            };
            responder.respond(response);
        })
        .setup(move |app| {
            let start_url = if cfg!(debug_assertions) {
                WebviewUrl::External(development_url())
            } else {
                WebviewUrl::CustomProtocol(embedded_url())
            };
            let server_origin = serde_json::to_string(setup_origin.as_str())
                .expect("serializable server origin");
            let child_origin = setup_origin.clone();
            let child_app = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", start_url)
                .title("ZZ Geo")
                .user_agent(DESKTOP_USER_AGENT)
                .initialization_script(format!(
                    "Object.defineProperty(window, '__GEO_DESKTOP_SERVER_ORIGIN__', {{ value: {server_origin}, configurable: false, writable: false }});"
                ))
                .on_new_window(move |requested, features| {
                    if let Some(url) = embedded_artifact_url(&requested) {
                        let label = format!(
                            "artifact-{}",
                            CHILD_WINDOW_ID.fetch_add(1, Ordering::Relaxed)
                        );
                        return match WebviewWindowBuilder::new(
                            &child_app,
                            label,
                            WebviewUrl::CustomProtocol(url),
                        )
                        .window_features(features)
                        .title("ZZ Geo 文档")
                        .user_agent(DESKTOP_USER_AGENT)
                        .build()
                        {
                            Ok(window) => NewWindowResponse::Create { window },
                            Err(_) => NewWindowResponse::Deny,
                        };
                    }
                    if let Some(url) = external_url(&child_origin, &requested) {
                        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                    }
                    NewWindowResponse::Deny
                })
                .inner_size(1280.0, 820.0)
                .min_inner_size(980.0, 680.0)
                .center()
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run ZZ Geo desktop client");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_existing_app_base_to_embedded_assets() {
        assert_eq!(asset_path("/app/"), Some("index.html".to_string()));
        assert_eq!(
            asset_path("/app/assets/index.js"),
            Some("assets/index.js".to_string())
        );
    }

    #[test]
    fn keeps_cloud_routes_out_of_the_asset_bundle() {
        for path in [
            "/api/auth/me",
            "/artifacts/report.pdf",
            "/share/token",
            "/help/",
        ] {
            assert!(is_cloud_path(path));
        }
        assert!(!is_cloud_path("/app/assets/index.js"));
    }

    #[test]
    fn preserves_the_cloud_query_string() {
        let request = Request::builder()
            .uri("geo://localhost/api/projects?page=2&pageSize=20")
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            cloud_url(&Url::parse(DEFAULT_SERVER_ORIGIN).unwrap(), &request)
                .unwrap()
                .as_str(),
            "https://www.honesttai.com/api/projects?page=2&pageSize=20"
        );
    }

    #[test]
    fn preserves_encoded_cloud_paths() {
        let request = Request::builder()
            .uri("geo://localhost/artifacts/reports%2Ffinal.pdf")
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            cloud_url(&Url::parse(DEFAULT_SERVER_ORIGIN).unwrap(), &request)
                .unwrap()
                .as_str(),
            "https://www.honesttai.com/artifacts/reports%2Ffinal.pdf"
        );
    }

    #[test]
    fn does_not_forward_browser_or_hop_by_hop_headers() {
        for name in ["cookie", "origin", "host", "content-length", "connection"] {
            assert!(!should_forward_request_header(name));
        }
        assert!(should_forward_request_header("content-type"));
        assert!(!should_forward_response_header("set-cookie"));
        assert!(should_forward_response_header("content-disposition"));
    }

    #[test]
    fn opens_embedded_help_on_the_cloud_site() {
        let origin = Url::parse(DEFAULT_SERVER_ORIGIN).unwrap();
        let help = Url::parse("http://geo.localhost/help/").unwrap();
        assert_eq!(
            external_url(&origin, &help).unwrap().as_str(),
            "https://www.honesttai.com/help/"
        );
    }

    #[test]
    fn only_opens_safe_external_schemes() {
        let origin = Url::parse(DEFAULT_SERVER_ORIGIN).unwrap();
        assert!(
            external_url(&origin, &Url::parse("https://example.com/source").unwrap()).is_some()
        );
        assert!(external_url(&origin, &Url::parse("javascript:alert(1)").unwrap()).is_none());
    }

    #[test]
    fn keeps_authenticated_artifacts_inside_the_desktop_client() {
        let artifact = Url::parse("http://geo.localhost/artifacts/reports%2Ffinal.pdf").unwrap();
        assert_eq!(
            embedded_artifact_url(&artifact).unwrap().as_str(),
            "geo://localhost/artifacts/reports%2Ffinal.pdf"
        );
        assert!(
            embedded_artifact_url(&Url::parse("https://example.com/file.pdf").unwrap()).is_none()
        );
    }

    #[test]
    fn only_accepts_bounded_runtime_identifiers() {
        assert!(is_safe_runtime_id("session-1234"));
        assert!(is_safe_runtime_id("client:desktop_1"));
        assert!(!is_safe_runtime_id("short"));
        assert!(!is_safe_runtime_id("../../session"));
        assert!(!is_safe_runtime_id("session/other"));
    }
}
