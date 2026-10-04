//! The cloud is an authentication/storage control plane. Business requests NEVER fall back to it.
use crate::CloudClient;
use serde_json::{json, Value};
use std::{
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::{oneshot, Mutex},
};
use url::Url;

type Writer = Arc<Mutex<ChildStdin>>;
#[derive(Clone)]
pub struct EngineHandle {
    pub origin: Url,
    pub token: String,
    pub client: reqwest::Client,
    alive: Arc<AtomicBool>,
    writer: Writer,
}
#[derive(Clone, Default)]
pub struct LocalEngine(Arc<Mutex<Option<EngineHandle>>>);

pub fn is_control_path(path: &str) -> bool {
    path.starts_with("/api/auth/")
        || path == "/api/organizations"
        || path.starts_with("/api/organizations/")
        || path == "/api/users"
        || path.starts_with("/api/users/")
        || (path.starts_with("/api/rbac/") && path != "/api/rbac/navigation")
        || path == "/help"
        || path.starts_with("/help/")
}
fn broker_allowed(path: &str, method: &str) -> bool {
    (method == "GET"
        && matches!(
            path,
            "/api/auth/me" | "/api/desktop-storage/bootstrap" | "/api/desktop-storage/head"
        ))
        || (method == "POST" && path == "/api/desktop-storage/commit")
        || (matches!(method, "GET" | "PUT")
            && path
                .strip_prefix("/api/desktop-storage/objects/")
                .is_some_and(|s| {
                    s.len() == 64
                        && s.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                }))
}
pub fn assert_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    let trusted = (url.scheme() == "geo" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("geo.localhost")
            && url.port().is_none())
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(3000));
    if window.label() != "main" || !trusted {
        return Err("Untrusted workspace".into());
    }
    Ok(())
}
async fn write(writer: &Writer, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let mut input = writer.lock().await;
    input.write_all(&bytes).await.map_err(|e| e.to_string())?;
    input.flush().await.map_err(|e| e.to_string())
}
async fn cloud_request(cloud: CloudClient, message: Value, writer: Writer) {
    let id = message["id"].clone();
    let result = async {
        let path = message["path"].as_str().ok_or("Missing cloud path")?;
        let method = message["method"].as_str().ok_or("Missing cloud method")?;
        if !broker_allowed(path, method) {
            return Err("Cloud broker only permits authentication and opaque storage".to_string());
        }
        let url = cloud.origin.join(path).map_err(|e| e.to_string())?;
        let mut request = cloud
            .client
            .request(
                reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?,
                url,
            )
            .header("content-type", "application/json")
            .header("x-geo-client", "desktop")
            .timeout(std::time::Duration::from_secs(60));
        if !message["body"].is_null() {
            request = request.body(message["body"].to_string());
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| "云端鉴权或存储服务不可用".to_string())?;
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > 6_000_000 {
                return Err("云端响应超过安全上限".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "云端未提供兼容的桌面存储接口".to_string())?;
        Ok(json!({"kind":"response","id":id,"status":status,"body":body}))
    }
    .await;
    let reply = result.unwrap_or_else(|error| json!({"kind":"response","id":id,"error":error}));
    let _ = write(&writer, &reply).await;
}

impl LocalEngine {
    pub async fn ensure(
        &self,
        app: &AppHandle,
        cloud: &CloudClient,
    ) -> Result<EngineHandle, String> {
        let mut registry = self.0.lock().await;
        if let Some(handle) = registry.as_ref().filter(|h| h.alive.load(Ordering::SeqCst)) {
            return Ok(handle.clone());
        }
        let resource = if cfg!(debug_assertions) {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        } else {
            app.path().resource_dir().map_err(|e| e.to_string())?
        };
        let executable = if cfg!(debug_assertions) {
            let target = include_str!(concat!(env!("OUT_DIR"), "/runtime-target.txt")).trim();
            resource.join("binaries").join(format!(
                "geo-node-{target}{}",
                if cfg!(windows) { ".exe" } else { "" }
            ))
        } else {
            std::env::current_exe()
                .map_err(|e| e.to_string())?
                .parent()
                .ok_or("客户端目录不可用")?
                .join(if cfg!(windows) {
                    "geo-node.exe"
                } else {
                    "geo-node"
                })
        };
        let data = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("workspaces");
        let mut command = Command::new(executable);
        command
            .arg(resource.join("runtime/engine.mjs"))
            .env_clear()
            .env("LANGCHAIN_TRACING_V2", "false")
            .env("LANGSMITH_TRACING", "false")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for key in [
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "HOME",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动本地业务引擎：{e}"))?;
        let writer = Arc::new(Mutex::new(child.stdin.take().ok_or("本地输入通道不可用")?));
        let stdout = child.stdout.take().ok_or("本地输出通道不可用")?;
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        write(&writer,&json!({"kind":"init","dataRoot":data,"token":token,"browserPath":resource.join("runtime/browsers")})).await?;
        let alive = Arc::new(AtomicBool::new(true));
        let task_alive = alive.clone();
        let (ready, wait) = oneshot::channel::<Result<u16, String>>();
        let task_writer = writer.clone();
        let cloud = cloud.clone();
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut ready = Some(ready);
            let mut reader = BufReader::new(stdout);
            let mut requests = tokio::task::JoinSet::new();
            let result: Result<(), String> = async {
                loop {
                    let mut bytes = Vec::new();
                    let mut limited = tokio::io::AsyncReadExt::take(&mut reader, 6_000_001);
                    let count = limited
                        .read_until(b'\n', &mut bytes)
                        .await
                        .map_err(|e| e.to_string())?;
                    if count == 0 {
                        return Err("本地引擎已退出，已写入 SQLite 的数据保留".into());
                    }
                    if bytes.len() > 6_000_000 {
                        return Err("本地通信超过安全上限".into());
                    }
                    let message: Value =
                        serde_json::from_slice(&bytes).map_err(|_| "本地通信格式无效")?;
                    match message["kind"].as_str() {
                        Some("ready") => {
                            let port = message["port"]
                                .as_u64()
                                .filter(|p| *p > 0 && *p <= 65535)
                                .ok_or("Invalid engine port")?
                                as u16;
                            if let Some(sender) = ready.take() {
                                let _ = sender.send(Ok(port));
                            }
                        }
                        Some("cloud") => {
                            if requests.len() >= 32 {
                                return Err("本地云端请求超过并发上限".into());
                            }
                            requests.spawn(cloud_request(
                                cloud.clone(),
                                message,
                                task_writer.clone(),
                            ));
                            while requests.try_join_next().is_some() {}
                        }
                        Some("fatal") => {
                            return Err(message["error"]
                                .as_str()
                                .unwrap_or("本地引擎启动失败")
                                .to_string())
                        }
                        Some("stopped") => return Ok(()),
                        _ => return Err("未知本地消息类型".into()),
                    }
                }
            }
            .await;
            if let Err(error) = result {
                if let Some(sender) = ready.take() {
                    let _ = sender.send(Err(error.clone()));
                }
                let _ = app_handle.emit("geo-engine-error", error);
            }
            requests.abort_all();
            let _ = child.kill().await;
            task_alive.store(false, Ordering::SeqCst);
        });
        let port = match tokio::time::timeout(std::time::Duration::from_secs(180), wait).await {
            Ok(Ok(Ok(port))) => port,
            other => {
                let _ = write(&writer, &json!({"kind":"shutdown"})).await;
                return Err(match other {
                    Ok(Ok(Err(error))) => error,
                    _ => "本地工作区启动超时，请重试".into(),
                });
            }
        };
        let handle = EngineHandle {
            origin: Url::parse(&format!("http://127.0.0.1:{port}")).map_err(|e| e.to_string())?,
            token,
            client: reqwest::Client::builder()
                .no_proxy()
                .build()
                .map_err(|e| e.to_string())?,
            alive,
            writer,
        };
        *registry = Some(handle.clone());
        Ok(handle)
    }
    pub async fn stop(&self) -> Result<(), String> {
        let mut registry = self.0.lock().await;
        if let Some(handle) = registry.as_ref() {
            if handle.alive.load(Ordering::SeqCst) {
                write(&handle.writer, &json!({"kind":"shutdown"})).await?;
                let wait = async {
                    while handle.alive.load(Ordering::SeqCst) {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                };
                tokio::time::timeout(std::time::Duration::from_secs(120), wait)
                    .await
                    .map_err(|_| "仍在等待本地任务安全停止，请稍后重试")?;
            }
        }
        *registry = None;
        Ok(())
    }
}

#[tauri::command]
pub async fn desktop_api_request(
    app: AppHandle,
    window: tauri::WebviewWindow,
    cloud: State<'_, CloudClient>,
    engine: State<'_, LocalEngine>,
    path: String,
    method: String,
    body: Option<String>,
) -> Result<Value, String> {
    assert_main(&window)?;
    if !path.starts_with("/api/")
        || path.contains(['\\', '#'])
        || path.contains("..")
        || path.len() > 16_000
        || !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE")
        || body.as_ref().is_some_and(|b| b.len() > 4_000_000)
    {
        return Err("Invalid business API request".into());
    }
    let parsed = Url::parse(&format!("http://local{path}")).map_err(|e| e.to_string())?;
    let control = is_control_path(parsed.path());
    if method != "GET"
        && (parsed.path().starts_with("/api/auth/") || parsed.path() == "/api/organizations/select")
    {
        engine.stop().await?;
    }
    let local = if control {
        None
    } else {
        Some(engine.ensure(&app, &cloud).await?)
    };
    let (client, origin) = local
        .as_ref()
        .map(|h| (&h.client, &h.origin))
        .unwrap_or((&cloud.client, &cloud.origin));
    let url = origin.join(&path).map_err(|e| e.to_string())?;
    if url.origin() != origin.origin() {
        return Err("Cross-origin request blocked".into());
    }
    let mut request = client
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?,
            url,
        )
        .header("content-type", "application/json")
        .header("x-geo-client", "desktop")
        .timeout(std::time::Duration::from_secs(180))
        .body(body.unwrap_or_default());
    if let Some(local) = local.as_ref() {
        request = request.header("x-geo-local-token", &local.token);
    }
    let response = request.send().await.map_err(|e| {
        format!(
            "{}请求失败：{e}",
            if control {
                "云端鉴权"
            } else {
                "本地业务引擎"
            }
        )
    })?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.map_err(|_| "服务返回无效数据")?;
    Ok(json!({"status":status,"body":body}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn business_never_routes_to_cloud() {
        for p in [
            "/api/projects",
            "/api/settings",
            "/api/workbench/sessions/x/desktop/tools",
            "/api/hrouter/models",
            "/api/rbac/navigation",
            "/artifacts/report.pdf",
        ] {
            assert!(!is_control_path(p));
        }
    }
    #[test]
    fn child_cannot_request_cloud_execution() {
        assert!(broker_allowed("/api/auth/me", "GET"));
        assert!(broker_allowed("/api/desktop-storage/commit", "POST"));
        for p in [
            "/api/projects",
            "/api/workbench/sessions/x/desktop/responses",
            "https://example.com",
            "/api/desktop-storage/objects/../head",
        ] {
            assert!(!broker_allowed(p, "POST"));
        }
    }
}
