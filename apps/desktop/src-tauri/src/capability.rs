/// What the server's pages may ask of the app (2C, Jules 25 Oct 2026: D5).
///
/// The pages the window shows come from the app's own server at
/// `http://localhost:<port>`. They get one Tauri command and nothing else: the dialog
/// plugin's `open`, the system's folder chooser for "Use notes I already have" and
/// Settings → Notes → Change…. It answers the folder the person picked; it can read
/// or write nothing itself (no fs plugin is registered). Granted at run time, once
/// the port is known, for exactly that origin and the main window: not the bundled
/// pages (`local: false`), not another port or host, which the window doesn't load
/// anyway (window.rs).
pub const PERMISSION: &str = "dialog:allow-open";

/// The capability, as Tauri reads a capability file.
pub fn server_page(port: u16) -> String {
    serde_json::json!({
        "identifier": format!("server-page-{port}"),
        "description": "Orrama's own pages may open the system's folder chooser, and nothing else.",
        "local": false,
        "windows": ["main"],
        "remote": { "urls": [format!("http://localhost:{port}")] },
        "permissions": [PERMISSION],
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::utils::acl::capability::{CapabilityFile, PermissionEntry};
    use tauri::Url;

    fn parsed(port: u16) -> tauri::utils::acl::capability::Capability {
        match server_page(port).parse::<CapabilityFile>().expect("a capability file Tauri reads") {
            CapabilityFile::Capability(c) => c,
            _ => panic!("one capability, not a list"),
        }
    }

    #[test]
    fn the_page_gets_the_folder_chooser_and_nothing_else() {
        let c = parsed(50123);
        let ids: Vec<String> = c
            .permissions
            .iter()
            .map(|p| match p {
                PermissionEntry::PermissionRef(id) => id.get().to_string(),
                PermissionEntry::ExtendedPermission { identifier, .. } => identifier.get().to_string(),
            })
            .collect();
        assert_eq!(ids, ["dialog:allow-open"]);
        assert!(!c.local, "not the bundled pages");
        assert_eq!(c.windows, ["main"]);
        assert!(c.webviews.is_empty());
    }

    #[test]
    fn only_for_our_own_server_at_its_port() {
        let c = parsed(50123);
        let remote = c.remote.expect("a remote origin");
        assert_eq!(remote.urls.len(), 1);
        let pattern: tauri::utils::acl::RemoteUrlPattern = remote.urls[0].parse().expect("a URL pattern");
        let ok = |u: &str| pattern.test(&Url::parse(u).unwrap());
        assert!(ok("http://localhost:50123/"));
        assert!(ok("http://localhost:50123/settings/notes"));
        assert!(ok("http://localhost:50123/today?x=1#y"));
        assert!(!ok("http://localhost:4623/"), "another Orrama on this Mac");
        assert!(!ok("http://127.0.0.1:50123/"), "the browser's address for the callback");
        assert!(!ok("https://localhost:50123/"));
        assert!(!ok("http://localhost.evil.example:50123/"));
        assert!(!ok("https://auth.openai.com/"));
    }
}
