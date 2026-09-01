use tauri::{WebviewUrl, WebviewWindowBuilder};
use url::Url;

fn client_url() -> Url {
    if cfg!(debug_assertions) {
        Url::parse("http://127.0.0.1:3000/app/?desktop=1").expect("valid desktop development URL")
    } else {
        Url::parse("https://geo.example.com/app/?desktop=1").expect("valid GEO production URL")
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(client_url()))
                .title("ZZ Geo")
                .user_agent("ZZGeoDesktop/0.2.0")
                .inner_size(1280.0, 820.0)
                .min_inner_size(980.0, 680.0)
                .center()
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run ZZ Geo desktop client");
}
