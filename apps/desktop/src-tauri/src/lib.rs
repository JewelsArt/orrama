/// The window, and nothing else.
///
/// The shell shows the running server (http://localhost:4623, which serves the
/// app and the API same-origin), so it needs no commands of its own. It used to
/// register `read_vault_file` / `write_vault_file`, which took the vault root
/// FROM THE CALLER — anything able to invoke them could read or write any file
/// on the Mac — and nothing in the app ever called them. Removed with the
/// never-initialised fs/dialog plugins and the `notify` watcher; the server's
/// watcher is the one that feeds outside edits into the CRDT.
///
/// The window opens on the bundled page in `fallback/` ("Basalt isn't running")
/// and moves to the server only once `/api/health` answers the way Basalt does.
/// It used to load :4623 directly, so whatever held that port — with the agent
/// down — was shown inside "Basalt" and got the password typed into it
/// (audit OPS-010).
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use tauri::Manager;

const SERVER: &str = "http://localhost:4623";
const HEALTH: ([u8; 4], u16) = ([127, 0, 0, 1], 4623);

/// Whether an HTTP response is Basalt's `/api/health`: a 200 whose JSON body
/// says `"ok":true` and carries the `build` and `notes` fields.
pub fn is_basalt(response: &str) -> bool {
    let Some((head, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let status = head.lines().next().unwrap_or("");
    let ok_status = status.starts_with("HTTP/1.1 200") || status.starts_with("HTTP/1.0 200");
    let json = head.to_ascii_lowercase().contains("content-type: application/json");
    ok_status && json && body.contains("\"ok\":true") && body.contains("\"build\":") && body.contains("\"notes\":")
}

fn basalt_answers() -> bool {
    let addr = SocketAddr::from(HEALTH);
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(1)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = "GET /api/health HTTP/1.1\r\nHost: localhost:4623\r\nConnection: close\r\n\r\n";
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.take(64 * 1024).read_to_string(&mut response);
    is_basalt(&response)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").expect("the main window");
            let server: tauri::Url = SERVER.parse().expect("the server URL");
            std::thread::spawn(move || loop {
                if basalt_answers() {
                    let _ = window.navigate(server);
                    break;
                }
                std::thread::sleep(Duration::from_secs(2));
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running basalt");
}

#[cfg(test)]
mod tests {
    use super::is_basalt;

    const HEAD: &str = "HTTP/1.1 200 OK\r\ncontent-type: application/json; charset=utf-8\r\n\r\n";

    #[test]
    fn knows_basalt_health() {
        assert!(is_basalt(&format!("{HEAD}{{\"ok\":true,\"notes\":3,\"build\":\"ca300d99b0ef\"}}")));
        assert!(is_basalt(&format!("{HEAD}{{\"ok\":true,\"notes\":0,\"build\":null}}")));
    }

    #[test]
    fn refuses_anything_else() {
        assert!(!is_basalt(&format!("{HEAD}{{\"ok\":true}}"))); // some other app's health
        assert!(!is_basalt("HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n\r\n<html>\"ok\":true \"build\": \"notes\":</html>"));
        assert!(!is_basalt("HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"notes\":1,\"build\":null}"));
        assert!(!is_basalt(""));
    }
}
