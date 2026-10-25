/// Where the window may go, and what leaves it for the system browser.
///
/// The window holds two things: the bundled page (`fallback/`, the app's own
/// origin) and the app's server at `http://localhost:<port>`. Everything else a
/// page tries to open there goes to the system browser instead: links with
/// `target=_blank`, `window.open`, a page sending itself elsewhere. The ChatGPT
/// sign-in is the case that forced it: Google refuses to sign in inside an app's
/// webview ("this browser or app may not be secure"), so auth.openai.com must
/// open in the real browser, whose callback reaches the server on 127.0.0.1.
///
/// Frames: the server's CSP lets the pages frame only themselves, `blob:` and
/// `data:` (main.ts `frame-src`, pageSandbox.ts), and macOS asks about frame
/// navigations too, so `blob:`, `data:` and `about:` stay in the window.
use tauri::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Retry,
    ShowLog,
    ShowFolder,
    /// "Forgot your password?" on our server's sign-in page: ask for a reset (reset.rs).
    Reset,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Load it in the window.
    Stay,
    /// Open it in the system browser (or mail app) and stay where we are.
    Browser,
    /// Refuse it.
    Refuse,
    /// A button on the bundled page (`action/<name>`): done by the shell, not loaded.
    Do(Action),
}

/// Whether a URL is the bundled page's own origin (`tauri://localhost` on the Mac,
/// `http(s)://tauri.localhost` on Windows).
pub fn is_app_origin(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// The rule for one navigation in the main window. `server_port` is the port of
/// the server the window was sent to, None before it answered.
pub fn route(url: &Url, server_port: Option<u16>) -> Route {
    if is_app_origin(url) {
        return match url.path() {
            "/action/retry" => Route::Do(Action::Retry),
            "/action/log" => Route::Do(Action::ShowLog),
            "/action/folder" => Route::Do(Action::ShowFolder),
            p if p.starts_with("/action/") => Route::Refuse,
            _ => Route::Stay,
        };
    }
    let ours = url.scheme() == "http" && url.host_str() == Some("localhost") && server_port.is_some() && url.port() == server_port;
    if ours && url.path() == crate::reset::RESET_PATH {
        return Route::Do(Action::Reset);
    }
    match url.scheme() {
        "http" if ours => Route::Stay,
        "blob" | "data" | "about" => Route::Stay,
        "http" | "https" | "mailto" | "tel" => Route::Browser,
        _ => Route::Refuse,
    }
}

/// A new window asked for (`target=_blank`, `window.open`): never one of ours.
pub fn route_new_window(url: &Url) -> Route {
    match url.scheme() {
        "http" | "https" | "mailto" | "tel" if !is_app_origin(url) => Route::Browser,
        _ => Route::Refuse,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(u: &str, port: Option<u16>) -> Route {
        route(&u.parse().unwrap(), port)
    }

    #[test]
    fn the_bundled_page_and_our_server_stay() {
        assert_eq!(r("tauri://localhost/index.html", None), Route::Stay);
        assert_eq!(r("http://tauri.localhost/failed.html", None), Route::Stay);
        assert_eq!(r("http://localhost:50123/", Some(50123)), Route::Stay);
        assert_eq!(r("http://localhost:50123/notes/Ideas?x=1", Some(50123)), Route::Stay);
        assert_eq!(r("blob:http://localhost:50123/0b6e", Some(50123)), Route::Stay);
        assert_eq!(r("about:blank", Some(50123)), Route::Stay);
        assert_eq!(r("about:srcdoc", Some(50123)), Route::Stay);
    }

    #[test]
    fn everything_else_opens_in_the_browser() {
        // Settings' "Source code", ChatGPT's sign-in and "Manage usage", a mail link.
        assert_eq!(r("https://github.com/JewelsArt/Basalt-backup", Some(50123)), Route::Browser);
        assert_eq!(r("https://auth.openai.com/oauth/authorize?client_id=x", Some(50123)), Route::Browser);
        assert_eq!(r("mailto:sam@example.com", Some(50123)), Route::Browser);
        // Another Orrama, another port, or ours before it answered.
        assert_eq!(r("http://localhost:4623/", Some(50123)), Route::Browser);
        assert_eq!(r("http://localhost:50123/", None), Route::Browser);
        // 127.0.0.1 is another origin (other cookies): the callback belongs in the browser.
        assert_eq!(r("http://127.0.0.1:50123/callback?code=x", Some(50123)), Route::Browser);
    }

    #[test]
    fn odd_schemes_are_refused() {
        assert_eq!(r("file:///etc/passwd", Some(50123)), Route::Refuse);
        assert_eq!(r("javascript:alert(1)", Some(50123)), Route::Refuse);
        assert_eq!(r("ftp://example.com/", Some(50123)), Route::Refuse);
    }

    #[test]
    fn the_bundled_pages_buttons_are_actions() {
        assert_eq!(r("tauri://localhost/action/retry", None), Route::Do(Action::Retry));
        assert_eq!(r("http://tauri.localhost/action/log", None), Route::Do(Action::ShowLog));
        assert_eq!(r("tauri://localhost/action/folder", None), Route::Do(Action::ShowFolder));
        assert_eq!(r("tauri://localhost/action/rm-rf", None), Route::Refuse);
        // Only on the app's own origin: the same path on the server is a page.
        assert_eq!(r("http://localhost:50123/action/retry", Some(50123)), Route::Stay);
    }

    #[test]
    fn forgot_your_password_on_our_server_is_the_shells() {
        assert_eq!(r("http://localhost:50123/_shell/reset", Some(50123)), Route::Do(Action::Reset));
        // Not on another server, nor before ours answered, nor any other path.
        assert_eq!(r("http://localhost:4623/_shell/reset", Some(50123)), Route::Browser);
        assert_eq!(r("http://localhost:50123/_shell/reset", None), Route::Browser);
        assert_eq!(r("http://127.0.0.1:50123/_shell/reset", Some(50123)), Route::Browser);
        assert_eq!(r("http://localhost:50123/reset", Some(50123)), Route::Stay);
        assert_eq!(r("http://localhost:50123/_shell/other", Some(50123)), Route::Stay);
    }

    #[test]
    fn new_windows_go_to_the_browser() {
        let n = |u: &str| route_new_window(&u.parse().unwrap());
        assert_eq!(n("https://chatgpt.com/codex/settings/usage"), Route::Browser);
        assert_eq!(n("http://localhost:50123/notes"), Route::Browser);
        assert_eq!(n("mailto:x@example.com"), Route::Browser);
        assert_eq!(n("tauri://localhost/index.html"), Route::Refuse);
        assert_eq!(n("blob:http://localhost:50123/0b6e"), Route::Refuse);
        assert_eq!(n("file:///tmp/x"), Route::Refuse);
    }
}
