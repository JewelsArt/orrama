/// Updates (2E; Jules, 27 Oct 2026: D10).
///
/// At launch and every 6 hours while the app is open, the shell reads the release feed
/// (`plugins.updater.endpoints` in tauri.conf.json: the `latest.json` of the newest
/// GitHub release), and when it names a newer version it downloads that build and checks
/// its signature against the public key in the same config. Then a native dialog says
/// "Orrama <version> is ready." with the first lines of the release's notes, and two
/// buttons: Restart now, Later. Later asks again at the next launch, not before.
///
/// Restart now stops the server first, the same way quitting does (its stdin closes, it
/// checkpoints and exits; killed after 10 s), and only then installs: on Windows the
/// installer can't replace a `node.exe` that is running, and on both a database half
/// written by a server killed mid-update is the worst outcome. Then the app starts again
/// as the new version; its server copies the database before any schema change (db.ts).
///
/// Driven from Rust only: no page is granted the updater (capability.rs grants the
/// folder chooser and nothing else). Debug builds never update.
use std::time::Duration;

use semver::Version;

/// How often an open app looks again.
pub const EVERY: Duration = Duration::from_secs(6 * 3600);

/// Whether the feed's version is one to offer: newer than this build, and a release
/// (a test build's `-test.N` or any other pre-release is never offered to a friend).
pub fn offered(current: &Version, remote: &Version) -> bool {
    remote > current && remote.pre.is_empty()
}

/// The dialog's text: the version, then the first lines of the release's notes (Markdown
/// marks dropped), at most 3 lines and about 300 characters.
pub fn message(version: &str, notes: Option<&str>) -> String {
    let mut out = format!("Orrama {version} is ready.");
    let mut lines = notes
        .unwrap_or("")
        .lines()
        .map(|l| l.trim().trim_start_matches('#').trim())
        .filter(|l| !l.is_empty())
        .map(|l| match l.strip_prefix("- ").or_else(|| l.strip_prefix("* ")) {
            Some(item) => format!("• {item}"),
            None => l.to_string(),
        })
        .take(3)
        .peekable();
    if lines.peek().is_some() {
        out.push_str("\n\n");
        let text = lines.collect::<Vec<_>>().join("\n");
        if text.chars().count() > 300 {
            out.extend(text.chars().take(299));
            out.push('…');
        } else {
            out.push_str(&text);
        }
    }
    out
}

/// What the person answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    RestartNow,
    Later,
}

/// What the checks need from the app: the feed, the dialog, the clock. A trait so the
/// order is tested without a network or a window.
pub trait Feed {
    /// A newer build, downloaded and its signature checked; None when there is none.
    type Ready;
    fn check(&mut self) -> Result<Option<Self::Ready>, String>;
    fn ask(&mut self, ready: &Self::Ready) -> Answer;
    /// Stop the server, install, start the app again (`restart_into`).
    fn restart(&mut self, ready: Self::Ready);
    /// Waits `EVERY`; false when the app is going away.
    fn wait(&mut self) -> bool;
    fn log(&mut self, msg: &str);
}

/// The checks of one launch: one now, then one every 6 hours, until the person says Later
/// (asked again at the next launch) or the app quits. A failed check (offline, the feed
/// down) is logged and tried again at the next one.
pub fn run<F: Feed>(feed: &mut F) {
    loop {
        match feed.check() {
            Ok(Some(ready)) => match feed.ask(&ready) {
                Answer::RestartNow => {
                    feed.restart(ready);
                    return;
                }
                Answer::Later => {
                    feed.log("a new version is ready: Later, asked again at the next launch");
                    return;
                }
            },
            Ok(None) => {}
            Err(e) => feed.log(&format!("couldn't look for a new version: {e}")),
        }
        if !feed.wait() {
            return;
        }
    }
}

/// Restart now, in this order: stop the server (blocks until it has exited, or was
/// killed after 10 s), install, start the app again. On Windows a successful install
/// never returns (the installer takes over and starts the new version). When installing
/// fails, the app starts again as it was, and with it its server.
pub fn restart_into(stop_server: impl FnOnce(), install: impl FnOnce() -> Result<(), String>, relaunch: impl FnOnce(), log: impl Fn(&str)) {
    stop_server();
    match install() {
        Ok(()) => log("the new version is installed: starting it"),
        Err(e) => log(&format!("the new version couldn't be installed ({e}): starting this one again")),
    }
    relaunch();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn only_a_newer_release_is_offered() {
        assert!(offered(&v("0.1.90"), &v("0.1.91")));
        assert!(offered(&v("0.1.9"), &v("0.1.10")), "numbers, not text");
        assert!(offered(&v("0.1.91"), &v("0.2.0")));
        assert!(!offered(&v("0.1.91"), &v("0.1.91")), "the same version");
        assert!(!offered(&v("0.1.91"), &v("0.1.90")), "never back");
        assert!(!offered(&v("0.1.90"), &v("0.1.91-test.4")), "a test build is never offered");
        assert!(!offered(&v("0.1.90"), &v("0.2.0-beta.1")));
    }

    #[test]
    fn the_dialog_says_the_version_and_the_first_lines() {
        assert_eq!(message("0.1.91", None), "Orrama 0.1.91 is ready.");
        assert_eq!(message("0.1.91", Some("  \n")), "Orrama 0.1.91 is ready.");
        assert_eq!(
            message("0.1.91", Some("## Fixed\n\n- Notes keep their title\n* Mail opens faster\n- Fourth line\n")),
            "Orrama 0.1.91 is ready.\n\nFixed\n• Notes keep their title\n• Mail opens faster"
        );
        let long = "a".repeat(400);
        let m = message("1.0.0", Some(&long));
        assert!(m.ends_with('…'));
        assert_eq!(m.chars().count(), "Orrama 1.0.0 is ready.\n\n".chars().count() + 300);
    }

    /// A feed whose answers are scripted, recording what happened in order.
    struct Script {
        checks: Vec<Result<Option<&'static str>, String>>,
        answers: Vec<Answer>,
        waits: usize,
        done: Vec<String>,
    }

    impl Feed for Script {
        type Ready = &'static str;
        fn check(&mut self) -> Result<Option<&'static str>, String> {
            self.done.push("check".into());
            if self.checks.is_empty() {
                Ok(None)
            } else {
                self.checks.remove(0)
            }
        }
        fn ask(&mut self, ready: &&'static str) -> Answer {
            self.done.push(format!("ask {ready}"));
            self.answers.remove(0)
        }
        fn restart(&mut self, ready: &'static str) {
            self.done.push(format!("restart {ready}"));
        }
        fn wait(&mut self) -> bool {
            self.done.push("wait".into());
            self.waits = self.waits.saturating_sub(1);
            self.waits > 0
        }
        fn log(&mut self, msg: &str) {
            self.done.push(format!("log {msg}"));
        }
    }

    fn script(checks: Vec<Result<Option<&'static str>, String>>, answers: Vec<Answer>, waits: usize) -> Vec<String> {
        let mut s = Script { checks, answers, waits, done: vec![] };
        run(&mut s);
        s.done
    }

    #[test]
    fn checks_at_launch_then_every_six_hours() {
        assert_eq!(script(vec![Ok(None), Ok(None), Ok(None)], vec![], 3), ["check", "wait", "check", "wait", "check", "wait"]);
        assert_eq!(EVERY, Duration::from_secs(21_600));
    }

    #[test]
    fn later_asks_again_only_at_the_next_launch() {
        let done = script(vec![Ok(Some("0.1.91"))], vec![Answer::Later], 5);
        assert_eq!(done, ["check", "ask 0.1.91", "log a new version is ready: Later, asked again at the next launch"]);
    }

    #[test]
    fn restart_now_restarts_into_the_new_version() {
        let done = script(vec![Ok(None), Ok(Some("0.1.91"))], vec![Answer::RestartNow], 5);
        assert_eq!(done, ["check", "wait", "check", "ask 0.1.91", "restart 0.1.91"]);
    }

    #[test]
    fn a_failed_check_is_logged_and_tried_again() {
        let done = script(vec![Err("offline".into()), Ok(Some("0.1.91"))], vec![Answer::Later], 5);
        assert_eq!(done[..3], ["check", "log couldn't look for a new version: offline", "wait"]);
        assert_eq!(done[3..5], ["check", "ask 0.1.91"]);
    }

    #[test]
    fn the_server_stops_before_the_install_and_the_app_starts_again_after() {
        for outcome in [Ok(()), Err("disk full".to_string())] {
            let order = RefCell::new(Vec::<String>::new());
            let failed = outcome.is_err();
            restart_into(
                || order.borrow_mut().push("stop".into()),
                || {
                    assert_eq!(order.borrow().as_slice(), ["stop"], "nothing installed while the server runs");
                    order.borrow_mut().push("install".into());
                    outcome
                },
                || order.borrow_mut().push("relaunch".into()),
                |m| order.borrow_mut().push(format!("log {m}")),
            );
            let order = order.into_inner();
            assert_eq!(order[0], "stop");
            assert_eq!(order[1], "install");
            assert_eq!(order.last().unwrap(), "relaunch", "the app always comes back, its server with it");
            assert_eq!(order[2].contains("couldn't be installed (disk full)"), failed, "{order:?}");
        }
    }
}
