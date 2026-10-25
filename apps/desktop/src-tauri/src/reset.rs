/// "Forgot your password?" in the app (2C, Jules 25 Oct 2026: reset it on this computer).
///
/// The server's sign-in page sends the window to `RESET_PATH`, which the window
/// catches (window.rs) instead of loading. The shell then asks its own server for a
/// one-time reset ticket with the launch's shell token (`ORRAMA_SHELL_TOKEN`, in the
/// server's environment only, never on a page: server.rs), and opens the reset form
/// at `/reset#ticket=…`. A page can't ask for a ticket itself: it never sees the
/// token, and a browser elsewhere has no shell at all. Whoever sits at this
/// unlocked computer can already read the notes, so this gives nothing new away.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use tauri::Url;

/// Where "Forgot your password?" sends the window (desktop.ts `RESET_PATH`).
pub const RESET_PATH: &str = "/_shell/reset";

/// The raw request for a ticket. The token goes in a header, never in the URL.
pub fn request(port: u16, token: &str) -> String {
    format!(
        "POST /api/auth/reset/ticket HTTP/1.1\r\nHost: localhost:{port}\r\nX-Orrama-Shell-Token: {token}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
    )
}

/// The ticket in the server's answer: a 200 whose JSON `ticket` is base64url (what
/// the server makes), or None. Anything else is refused, so nothing but a ticket
/// can end up in the address the window opens.
pub fn ticket_of(response: &str) -> Option<String> {
    let (head, body) = response.split_once("\r\n\r\n")?;
    let status = head.lines().next().unwrap_or("");
    if !(status.starts_with("HTTP/1.1 200") || status.starts_with("HTTP/1.0 200")) {
        return None;
    }
    // The object itself: a chunked answer wraps it in chunk sizes.
    let json = match (body.find('{'), body.rfind('}')) {
        (Some(a), Some(b)) if a < b => &body[a..=b],
        _ => return None,
    };
    let ticket = serde_json::from_str::<serde_json::Value>(json).ok()?.get("ticket")?.as_str()?.to_string();
    let base64url = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    (!ticket.is_empty() && ticket.len() <= 128 && ticket.chars().all(base64url)).then_some(ticket)
}

/// Asks the server on 127.0.0.1:<port> for a ticket. None when it can't be had.
pub fn fetch_ticket(port: u16, token: &str) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    stream.write_all(request(port, token).as_bytes()).ok()?;
    let mut response = String::new();
    let _ = stream.take(64 * 1024).read_to_string(&mut response);
    ticket_of(&response)
}

/// The reset form, with its ticket, or saying the shell couldn't get one.
pub fn form_url(port: u16, ticket: Option<&str>) -> Url {
    let fragment = match ticket {
        Some(t) => format!("ticket={t}"),
        None => "failed".into(),
    };
    Url::parse(&format!("http://localhost:{port}/reset#{fragment}")).expect("the reset form's URL")
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "HTTP/1.1 200 OK\r\ncontent-type: application/json; charset=utf-8\r\n\r\n";

    #[test]
    fn the_request_carries_the_token_in_a_header_only() {
        let r = request(50123, "ab12");
        assert!(r.starts_with("POST /api/auth/reset/ticket HTTP/1.1\r\n"));
        assert!(r.contains("\r\nHost: localhost:50123\r\n"));
        assert!(r.contains("\r\nX-Orrama-Shell-Token: ab12\r\n"));
        assert_eq!(r.lines().next().unwrap().matches("ab12").count(), 0, "never in the request line");
        assert!(r.ends_with("\r\n\r\n{}"));
    }

    #[test]
    fn takes_a_ticket_from_the_servers_answer() {
        assert_eq!(ticket_of(&format!("{HEAD}{{\"ticket\":\"Ab_9-xY\"}}")).as_deref(), Some("Ab_9-xY"));
        let chunked = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n12\r\n{\"ticket\":\"t-1_x\"}\r\n0\r\n\r\n";
        assert_eq!(ticket_of(chunked).as_deref(), Some("t-1_x"));
    }

    #[test]
    fn refuses_anything_that_is_not_a_ticket() {
        assert_eq!(ticket_of("HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\n\r\n{\"ticket\":\"x\"}"), None);
        assert_eq!(ticket_of("HTTP/1.1 404 Not Found\r\n\r\n{\"error\":\"Reset it on the computer Orrama runs on.\"}"), None);
        assert_eq!(ticket_of(&format!("{HEAD}{{\"error\":\"x\"}}")), None);
        assert_eq!(ticket_of(&format!("{HEAD}{{\"ticket\":\"\"}}")), None);
        // Nothing that could change the address the window opens.
        assert_eq!(ticket_of(&format!("{HEAD}{{\"ticket\":\"x#y\"}}")), None);
        assert_eq!(ticket_of(&format!("{HEAD}{{\"ticket\":\"x&next=https://evil\"}}")), None);
        assert_eq!(ticket_of(&format!("{HEAD}{{\"ticket\":\"{}\"}}", "a".repeat(129))), None);
        assert_eq!(ticket_of(""), None);
    }

    #[test]
    fn opens_the_reset_form_on_our_own_server() {
        assert_eq!(form_url(50123, Some("Ab_9")).as_str(), "http://localhost:50123/reset#ticket=Ab_9");
        assert_eq!(form_url(50123, None).as_str(), "http://localhost:50123/reset#failed");
    }
}
