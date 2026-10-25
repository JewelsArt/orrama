/// Which port the app's server listens on, and `desktop.json`, where it is kept.
///
/// The port must stay the same for an install: Sign in with ChatGPT registers
/// `http://127.0.0.1:<port>/callback` once (chatgpt.ts), and the session cookie
/// is named after the port (`orrama_session_<port>`). So the port used last time
/// comes first; a first launch takes 4623, Orrama's usual port, when it is free;
/// anything else gets a free port from the system, which is then kept.
use std::fs;
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const USUAL_PORT: u16 = 4623;

/// `<data dir>/desktop.json`: what the shell keeps between launches. Unknown
/// fields are kept on write, so a later shell's settings survive an older one.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// `"file"` or `"keyring"` (secrets.rs); absent means the platform's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_store: Option<String>,
    #[serde(flatten)]
    pub other: serde_json::Map<String, serde_json::Value>,
}

pub fn desktop_file(data_dir: &Path) -> PathBuf {
    data_dir.join("desktop.json")
}

/// The file as stored; a missing or unreadable one reads as empty (it holds no
/// secret: losing it costs a port change at worst, and the file is rewritten).
pub fn read_desktop(data_dir: &Path) -> DesktopFile {
    fs::read_to_string(desktop_file(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Written whole through a temp file and a rename, so a crash never leaves half a file.
pub fn write_desktop(data_dir: &Path, file: &DesktopFile) -> io::Result<()> {
    let path = desktop_file(data_dir);
    let tmp = data_dir.join(".desktop.json.tmp");
    let text = serde_json::to_string_pretty(file).map_err(io::Error::other)?;
    fs::write(&tmp, text + "\n")?;
    fs::rename(&tmp, &path)
}

/// The port rule: the stored port if it is free, else 4623 if free, else what
/// `os_port` gives (a port the system picked as free). None only when the system
/// gives none.
pub fn choose_port(stored: Option<u16>, is_free: impl Fn(u16) -> bool, os_port: impl FnOnce() -> Option<u16>) -> Option<u16> {
    if let Some(p) = stored.filter(|p| *p != 0 && is_free(*p)) {
        return Some(p);
    }
    if is_free(USUAL_PORT) {
        return Some(USUAL_PORT);
    }
    os_port()
}

/// Whether nothing listens on the port on this computer's own addresses. The
/// window opens `http://localhost:<port>`, which may reach IPv6 first, so
/// `[::1]` must be free too (a machine without IPv6 counts as free there).
pub fn is_free(port: u16) -> bool {
    let v4 = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).is_ok();
    v4 && match TcpListener::bind(SocketAddr::from((Ipv6Addr::LOCALHOST, port))) {
        Ok(_) => true,
        Err(e) => e.kind() != io::ErrorKind::AddrInUse,
    }
}

/// A port the system says is free on 127.0.0.1 (and on [::1]).
pub fn os_port() -> Option<u16> {
    for _ in 0..10 {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).ok()?;
        let port = listener.local_addr().ok()?.port();
        drop(listener);
        if is_free(port) {
            return Some(port);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tempdir;
    use std::cell::Cell;

    #[test]
    fn keeps_the_stored_port() {
        assert_eq!(choose_port(Some(51234), |_| true, || Some(1)), Some(51234));
    }

    #[test]
    fn takes_4623_the_first_time() {
        assert_eq!(choose_port(None, |_| true, || Some(1)), Some(USUAL_PORT));
    }

    #[test]
    fn stored_port_taken_falls_back_to_4623_then_the_system() {
        assert_eq!(choose_port(Some(51234), |p| p != 51234, || Some(1)), Some(USUAL_PORT));
        assert_eq!(choose_port(Some(51234), |_| false, || Some(50999)), Some(50999));
    }

    #[test]
    fn with_4623_taken_asks_the_system_once() {
        // Jules's own Orrama holds 4623 on this Mac.
        let asked = Cell::new(0);
        let port = choose_port(None, |p| p != USUAL_PORT, || {
            asked.set(asked.get() + 1);
            Some(50123)
        });
        assert_eq!((port, asked.get()), (Some(50123), 1));
        // ...and next time the stored one wins, even if 4623 is free again.
        assert_eq!(choose_port(port, |_| true, || Some(1)), Some(50123));
    }

    #[test]
    fn a_stored_zero_is_no_port() {
        assert_eq!(choose_port(Some(0), |_| true, || Some(1)), Some(USUAL_PORT));
    }

    #[test]
    fn sees_a_port_in_use() {
        let held = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(!is_free(port));
        drop(held);
        assert!(is_free(port));
        let p = os_port().unwrap();
        assert!(p > 0 && is_free(p));
    }

    #[test]
    fn desktop_file_round_trip_keeps_unknown_fields() {
        let dir = tempdir();
        assert_eq!(read_desktop(&dir), DesktopFile::default());
        fs::write(desktop_file(&dir), "{\"port\":50123,\"later\":true}").unwrap();
        let mut f = read_desktop(&dir);
        assert_eq!(f.port, Some(50123));
        f.port = Some(50124);
        write_desktop(&dir, &f).unwrap();
        let text = fs::read_to_string(desktop_file(&dir)).unwrap();
        assert!(text.contains("\"later\": true") && text.contains("50124"), "{text}");
        fs::write(desktop_file(&dir), "not json").unwrap();
        assert_eq!(read_desktop(&dir), DesktopFile::default());
        let _ = fs::remove_dir_all(&dir);
    }
}
