// A lock held through a `match` on what it guards is how the reset hung the window (2C).
#![warn(clippy::significant_drop_in_scrutinee)]

/// The window around Orrama's own server.
///
/// The app starts its server, keeps its two secrets, and shows the server's page
/// once it answers; it stops the server when it quits (server.rs). The window
/// opens on the bundled page in `fallback/` ("Starting Orrama…") and moves to
/// `http://localhost:<port>` only once `/api/health` answers as Orrama with this
/// launch's id (health.rs). It used to load :4623 directly, so whatever held that
/// port was shown inside "Orrama" and got the password typed into it (audit
/// OPS-010); then it showed any Orrama there.
///
/// No commands of its own. The server's pages get one plugin command, the dialog's
/// `open` (the system's folder chooser, 2C): a capability granted at run time for
/// exactly `http://localhost:<port>` once the server answers (capability.rs), and
/// nothing else; the bundled page needs none (its buttons are links the shell
/// catches, window.rs). Every page the window loads gets a mark,
/// `window.__ORRAMA_DESKTOP__`, so the web app knows it is inside the app
/// (desktop.ts) without reading the user agent. "Forgot your password?" is a link
/// the shell catches too (reset.rs). Single instance and the dialog are the plugins
/// registered; the opener is called from Rust, never registered.
/// It used to register `read_vault_file` / `write_vault_file`, which took the vault
/// root FROM THE CALLER — anything able to invoke them could read or write any file
/// on the Mac. Removed with the never-initialised fs/dialog plugins and the `notify`
/// watcher; the server's watcher is the one that feeds outside edits into the CRDT.
mod capability;
mod health;
mod port;
mod reset;
mod secrets;
mod server;
#[cfg(test)]
mod testutil;
mod window;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub use health::is_orrama;
use server::{Launch, Status, Supervisor};
use window::{Action, Route};

/// What the window's handlers and the supervisor share.
struct Shell {
    app: AppHandle,
    data_dir: PathBuf,
    log_file: PathBuf,
    supervisor: OnceLock<Supervisor>,
    /// The port of the server the window shows, once it answered.
    port: Mutex<Option<u16>>,
    /// Where the window was when the server went away, to go back once it is up.
    resume: Mutex<Option<Url>>,
    /// The ports whose pages were granted the folder chooser (capability.rs).
    granted: Mutex<Vec<u16>>,
    /// This launch's shell token, also in the server's environment (reset.rs).
    shell_token: String,
}

/// Set on every page the window loads: the web app's sign that it is in the app (desktop.ts).
const DESKTOP_MARK: &str = "Object.defineProperty(window, '__ORRAMA_DESKTOP__', { value: Object.freeze({ shell: 1 }) });";

/// The data folder: `ORRAMA_DATA_DIR` from the shell's own environment (tests, and
/// every run on Jules's Mac, where the app's default folder must stay untouched),
/// else the app's local data folder. True when it came from the environment.
fn data_dir(app: &tauri::App) -> Result<(PathBuf, bool), String> {
    if let Some(dir) = std::env::var_os("ORRAMA_DATA_DIR").filter(|d| !d.is_empty()) {
        let dir = PathBuf::from(dir);
        let dir = if dir.is_absolute() { dir } else { std::env::current_dir().map_err(|e| e.to_string())?.join(dir) };
        return Ok((dir, true));
    }
    app.path().app_local_data_dir().map(|d| (d, false)).map_err(|e| e.to_string())
}

/// The packaged server: the Node binary Tauri put beside the app's executable
/// (`externalBin`, its target triple dropped) and `server/` in the resources.
fn packaged(node: PathBuf, server_dir: PathBuf, data_dir: &Path) -> Launch {
    Launch { program: node, args: vec![server_dir.join("server.mjs").into()], cwd: data_dir.to_path_buf(), web_dist: server_dir.join("web") }
}

#[cfg(not(debug_assertions))]
fn launch(app: &tauri::App, data_dir: &Path) -> Result<Launch, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let node = exe.parent().ok_or("no folder around the app")?.join(format!("node{}", std::env::consts::EXE_SUFFIX));
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(packaged(node, resources.join("server"), data_dir))
}

/// Debug builds (`tauri dev`): `ORRAMA_DEV_SERVER_DIR` (an `apps/server` folder,
/// run with the system Node and tsx); else 2A's bundle when it was prepared in
/// `src-tauri/binaries` and `src-tauri/resources/server`; else this checkout's
/// `apps/server` with tsx. Release builds only ever run the packaged server.
#[cfg(debug_assertions)]
fn launch(_app: &tauri::App, data_dir: &Path) -> Result<Launch, String> {
    let tsx = |dir: PathBuf| Launch {
        program: "node".into(),
        args: vec!["--import".into(), "tsx".into(), "src/main.ts".into()],
        web_dist: dir.join("..").join("web").join("dist"),
        cwd: dir,
    };
    if let Some(dir) = std::env::var_os("ORRAMA_DEV_SERVER_DIR").filter(|d| !d.is_empty()) {
        return Ok(tsx(PathBuf::from(dir)));
    }
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let node = here.join("binaries").join(format!("node-{}{}", env!("ORRAMA_TARGET_TRIPLE"), std::env::consts::EXE_SUFFIX));
    let server_dir = here.join("resources").join("server");
    if node.exists() && server_dir.join("server.mjs").exists() {
        return Ok(packaged(node, server_dir, data_dir));
    }
    Ok(tsx(here.join("..").join("..").join("server")))
}

/// A page of the bundled `fallback/` folder, on the app's own origin.
fn app_page(name: &str) -> Url {
    let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    Url::parse(base).and_then(|b| b.join(name)).expect("a bundled page's URL")
}

fn show(shell: &Shell, window: &WebviewWindow, url: Url) {
    server::shell_log(&shell.log_file, &format!("the window shows {}", url.as_str().split('?').next().unwrap_or("")));
    if let Err(e) = window.navigate(url) {
        eprintln!("orrama: the window can't move: {e}");
    }
}

/// The supervisor says what the window shows.
fn on_status(app: &tauri::AppHandle, shell: &Shell, status: Status) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match status {
        Status::Starting => {
            let current = window.url().ok();
            let port = *shell.port.lock().unwrap();
            if let Some(url) = current.filter(|u| u.host_str() == Some("localhost") && u.port().is_some() && u.port() == port) {
                *shell.resume.lock().unwrap() = Some(url);
            }
            show(shell, &window, app_page("index.html"));
        }
        Status::Ready { port } => {
            *shell.port.lock().unwrap() = Some(port);
            grant_folder_chooser(app, shell, port);
            let back = shell.resume.lock().unwrap().take().filter(|u| u.port() == Some(port));
            let home = Url::parse(&format!("http://localhost:{port}/")).expect("the server's URL");
            show(shell, &window, back.unwrap_or(home));
        }
        Status::Failed => show(shell, &window, app_page("failed.html")),
        Status::KeyMissing(secrets::StoreKind::File) => show(shell, &window, app_page("key.html")),
        Status::KeyMissing(secrets::StoreKind::Keyring) => show(shell, &window, app_page("key-keyring.html")),
    }
}

/// The server's pages at this port may open the folder chooser, and nothing else.
fn grant_folder_chooser(app: &AppHandle, shell: &Shell, port: u16) {
    let mut granted = shell.granted.lock().unwrap();
    if granted.contains(&port) {
        return;
    }
    match app.add_capability(capability::server_page(port)) {
        Ok(()) => granted.push(port),
        Err(e) => server::shell_log(&shell.log_file, &format!("the folder chooser couldn't be given to the page: {e}")),
    }
}

/// Opens a link outside the window. The log names the scheme and host only.
fn open_in_browser(shell: &Shell, url: &Url) {
    server::shell_log(&shell.log_file, &format!("opened outside the window: {}:{}", url.scheme(), url.host_str().unwrap_or("")));
    let url = url.to_string();
    std::thread::spawn(move || {
        if let Err(e) = tauri_plugin_opener::open_url(&url, None::<&str>) {
            eprintln!("orrama: can't open a link in the browser: {e}");
        }
    });
}

fn act(shell: &Arc<Shell>, action: Action) {
    match action {
        Action::Reset => {
            let Some(port) = *shell.port.lock().unwrap() else {
                return;
            };
            let shell = shell.clone();
            std::thread::spawn(move || {
                let ticket = reset::fetch_ticket(port, &shell.shell_token);
                server::shell_log(&shell.log_file, if ticket.is_some() { "a password reset was asked for on this computer" } else { "a password reset couldn't be started" });
                if let Some(window) = shell.app.get_webview_window("main") {
                    show(&shell, &window, reset::form_url(port, ticket.as_deref()));
                }
            });
        }
        Action::Retry => {
            if let Some(s) = shell.supervisor.get() {
                s.retry();
            }
        }
        Action::ShowLog | Action::ShowFolder => {
            let target = match action {
                Action::ShowLog if shell.log_file.exists() => shell.log_file.clone(),
                Action::ShowLog => shell.log_file.parent().unwrap_or(&shell.data_dir).to_path_buf(),
                _ => shell.data_dir.clone(),
            };
            std::thread::spawn(move || {
                if let Err(e) = tauri_plugin_opener::reveal_item_in_dir(&target) {
                    eprintln!("orrama: can't show {}: {e}", target.display());
                }
            });
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First: a second launch hands over to the first and exits before it starts anything.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(shell) = app.try_state::<Arc<Shell>>() {
                server::shell_log(&shell.log_file, "another launch: bringing this window forward");
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let (data_dir, overridden) = data_dir(app)?;
            let launch = launch(app, &data_dir)?;
            let shell_token = secrets::random_hex(32)?;
            let config = server::Config {
                data_dir: data_dir.clone(),
                data_dir_overridden: overridden,
                default_notes_dir: std::env::var_os("ORRAMA_DEFAULT_NOTES_DIR").filter(|d: &OsString| !d.is_empty()),
                launch,
                shell_token: shell_token.clone(),
            };
            let shell = Arc::new(Shell {
                app: app.handle().clone(),
                log_file: config.log_file(),
                data_dir,
                supervisor: OnceLock::new(),
                port: Mutex::new(None),
                resume: Mutex::new(None),
                granted: Mutex::new(Vec::new()),
                shell_token,
            });
            app.manage(shell.clone());

            let (nav, popup, saves) = (shell.clone(), shell.clone(), shell.clone());
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Orrama")
                .initialization_script(DESKTOP_MARK)
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .on_navigation(move |url| {
                    // The port is read and its lock let go before anything is done: an action
                    // (the reset) reads it again, and a lock held across the match hung the
                    // window's main thread (clippy's significant_drop_in_scrutinee, above).
                    let port = *nav.port.lock().unwrap();
                    match window::route(url, port) {
                    Route::Stay => true,
                    Route::Browser => {
                        open_in_browser(&nav, url);
                        false
                    }
                    Route::Do(action) => {
                        act(&nav, action);
                        false
                    }
                    Route::Refuse => false,
                    }
                })
                .on_new_window(move |url, _features| {
                    if window::route_new_window(&url) == Route::Browser {
                        open_in_browser(&popup, &url);
                    }
                    NewWindowResponse::Deny
                })
                .on_download(move |webview, event| {
                    // Downloads the page offers (a project's file, a statement) go to the
                    // Downloads folder under their own name; wry numbers a name in use.
                    match event {
                        DownloadEvent::Requested { destination, .. } => {
                            if !destination.is_absolute() {
                                if let Ok(dir) = webview.app_handle().path().download_dir() {
                                    *destination = dir.join(destination.file_name().unwrap_or_default());
                                }
                            }
                            server::shell_log(&saves.log_file, &format!("saving a download to {}", destination.display()));
                        }
                        DownloadEvent::Finished { success, .. } => {
                            server::shell_log(&saves.log_file, if success { "the download is saved" } else { "the download failed" });
                        }
                        _ => {}
                    }
                    true
                })
                .build()?;

            let handle = app.handle().clone();
            let status_shell = shell.clone();
            let supervisor = Supervisor::start(config, move |status| on_status(&handle, &status_shell, status));
            let _ = shell.supervisor.set(supervisor);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building orrama")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(s) = app.try_state::<Arc<Shell>>().and_then(|s| s.supervisor.get().map(|_| s.inner().clone())) {
                    s.supervisor.get().expect("checked").stop();
                }
            }
        });
}
