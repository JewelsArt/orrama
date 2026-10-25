/// Whether something on a port is Orrama, and whether it is the server this app started.
///
/// The window shows a server only when both hold: `is_orrama` (it answers the way
/// Orrama's `/api/health` does) and `is_our_launch` (its `launch` is the id this app
/// gave its own child). Before the shell started its own server it showed whatever
/// answered on 4623 as Orrama (audit OPS-010 made that at least an Orrama); now a
/// stale or foreign Orrama on the port is not enough either.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Whether an HTTP response is Orrama's `/api/health`: a 200 whose JSON body
/// says `"ok":true` and carries the `build` and `notes` fields.
pub fn is_orrama(response: &str) -> bool {
    let Some((head, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let status = head.lines().next().unwrap_or("");
    let ok_status = status.starts_with("HTTP/1.1 200") || status.starts_with("HTTP/1.0 200");
    let json = head.to_ascii_lowercase().contains("content-type: application/json");
    ok_status && json && body.contains("\"ok\":true") && body.contains("\"build\":") && body.contains("\"notes\":")
}

/// Whether an Orrama health response carries this launch's id (`"launch"`, set from
/// `ORRAMA_LAUNCH_ID` by the server). Read as JSON, so a `launch` inside some other
/// field's text never counts.
pub fn is_our_launch(response: &str, launch_id: &str) -> bool {
    if launch_id.is_empty() || !is_orrama(response) {
        return false;
    }
    let Some((_, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    // The object itself: a chunked answer wraps it in chunk sizes.
    let json = match (body.find('{'), body.rfind('}')) {
        (Some(a), Some(b)) if a < b => &body[a..=b],
        _ => return false,
    };
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(v) => v.get("launch").and_then(|l| l.as_str()) == Some(launch_id),
        Err(_) => false,
    }
}

/// `GET /api/health` on 127.0.0.1:<port>, the raw response (at most 64 KB), or None
/// when nothing answers.
pub fn fetch(port: u16) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(1)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET /api/health HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    let _ = stream.take(64 * 1024).read_to_string(&mut response);
    Some(response)
}

#[cfg(test)]
mod tests {
    use super::{is_orrama, is_our_launch};

    const HEAD: &str = "HTTP/1.1 200 OK\r\ncontent-type: application/json; charset=utf-8\r\n\r\n";
    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn knows_orrama_health() {
        assert!(is_orrama(&format!("{HEAD}{{\"ok\":true,\"notes\":3,\"build\":\"ca300d99b0ef\"}}")));
        assert!(is_orrama(&format!("{HEAD}{{\"ok\":true,\"notes\":0,\"build\":null}}")));
    }

    #[test]
    fn refuses_anything_else() {
        assert!(!is_orrama(&format!("{HEAD}{{\"ok\":true}}"))); // some other app's health
        assert!(!is_orrama("HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n\r\n<html>\"ok\":true \"build\": \"notes\":</html>"));
        assert!(!is_orrama("HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"notes\":1,\"build\":null}"));
        assert!(!is_orrama(""));
    }

    #[test]
    fn knows_its_own_launch() {
        let ours = format!("{HEAD}{{\"ok\":true,\"notes\":3,\"build\":null,\"source\":\"x\",\"launch\":\"{ID}\"}}");
        assert!(is_our_launch(&ours, ID));
        let chunked = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n4e\r\n{{\"ok\":true,\"notes\":0,\"build\":null,\"launch\":\"{ID}\"}}\r\n0\r\n\r\n");
        assert!(is_our_launch(&chunked, ID));
    }

    #[test]
    fn refuses_another_launch_or_none() {
        // Another Orrama (Jules's own agent, a stale server): no id, null, or someone else's.
        assert!(!is_our_launch(&format!("{HEAD}{{\"ok\":true,\"notes\":3,\"build\":null}}"), ID));
        assert!(!is_our_launch(&format!("{HEAD}{{\"ok\":true,\"notes\":3,\"build\":null,\"launch\":null}}"), ID));
        assert!(!is_our_launch(&format!("{HEAD}{{\"ok\":true,\"notes\":3,\"build\":null,\"launch\":\"ffffffffffffffffffffffffffffffff\"}}"), ID));
        // The id elsewhere in the body is not the launch field.
        assert!(!is_our_launch(&format!("{HEAD}{{\"ok\":true,\"notes\":3,\"build\":null,\"source\":\"\\\"launch\\\":\\\"{ID}\\\"\"}}"), ID));
        // Not Orrama at all, even with the right id.
        assert!(!is_our_launch(&format!("{HEAD}{{\"ok\":true,\"launch\":\"{ID}\"}}"), ID));
        // An empty id never matches.
        assert!(!is_our_launch(&format!("{HEAD}{{\"ok\":true,\"notes\":3,\"build\":null,\"launch\":\"\"}}"), ""));
    }
}
