/// Starting, watching and stopping the app's own server.
///
/// The shell runs `node server.mjs` (2-COMMON.md, the shell ↔ server contract):
/// the official Node build beside the app's executable, the bundled server in its
/// resources. It chooses the port (port.rs), gives the server its secrets
/// (secrets.rs), a new launch id and the launch's shell token (reset.rs), and
/// shows the window only once `/api/health` answers with that id (health.rs). A server that exits on its own is started
/// again after 1 s, 5 s, then 15 s; a fourth exit inside a minute stops trying and
/// the window says Orrama couldn't start. Quitting closes the server's stdin (the
/// server stops cleanly when it closes, 2A), waits up to 10 s, then kills it. A
/// shell that dies closes that stdin too, so no server outlives the app.
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::{health, port, secrets};

/// After this long without an answer the start counts as failed.
const BOOT_LIMIT: Duration = Duration::from_secs(300);
/// Quitting waits this long for the server to close before killing it.
const STOP_LIMIT: Duration = Duration::from_secs(10);
const RESTART_DELAYS: [Duration; 3] = [Duration::from_secs(1), Duration::from_secs(5), Duration::from_secs(15)];
const CRASH_WINDOW: Duration = Duration::from_secs(60);

/// How long to wait before starting the server again, given how long ago each exit
/// was (this one included, at zero): 1 s, 5 s, 15 s for the first, second and third
/// inside a minute; None for a fourth, which means stop trying.
pub fn restart_delay(exits_ago: &[Duration]) -> Option<Duration> {
    let recent = exits_ago.iter().filter(|ago| **ago < CRASH_WINDOW).count();
    RESTART_DELAYS.get(recent.saturating_sub(1)).copied()
}

/// What is run: a Node binary, its arguments, where the built web app is.
#[derive(Debug, Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub web_dist: PathBuf,
}

/// What the server is told, besides what it inherits.
pub struct EnvContext<'a> {
    pub data_dir: &'a Path,
    pub web_dist: &'a Path,
    pub log_file: &'a Path,
    pub port: u16,
    pub secrets: &'a secrets::Secrets,
    pub launch_id: &'a str,
    /// New each launch of the app, never said back by the server: what lets the shell, and
    /// only the shell, ask for a password reset (reset.rs).
    pub shell_token: &'a str,
    pub default_notes_dir: Option<&'a OsString>,
}

/// Names the server must never take from the person's own environment: every
/// `ORRAMA_*` (the contract), the `BASALT_*` names the server refuses to boot
/// beside (env.ts `renamedEnvProblems`), and what would change how Node or the
/// listener behave. Compared without case: Windows' variables have none.
fn inherited_ok(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    !(n.starts_with("ORRAMA_") || n.starts_with("BASALT_") || matches!(n.as_str(), "PORT" | "HOST" | "NODE_OPTIONS" | "NODE_PATH"))
}

/// The server's whole environment: the person's, filtered, then the contract's.
pub fn server_env(inherited: impl IntoIterator<Item = (OsString, OsString)>, ctx: &EnvContext) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = inherited.into_iter().filter(|(k, _)| k.to_str().is_some_and(inherited_ok)).collect();
    let origin = format!("http://localhost:{}", ctx.port);
    let ours: [(&str, OsString); 11] = [
        ("ORRAMA_PACKAGED", "1".into()),
        ("ORRAMA_DATA_DIR", ctx.data_dir.into()),
        ("ORRAMA_WEB_DIST", ctx.web_dist.into()),
        ("ORRAMA_LOG_FILE", ctx.log_file.into()),
        ("PORT", ctx.port.to_string().into()),
        ("HOST", "127.0.0.1".into()),
        ("ORRAMA_PUBLIC_ORIGINS", origin.into()),
        ("ORRAMA_JWT_SECRET", ctx.secrets.jwt_secret.clone().into()),
        ("ORRAMA_SECRET_KEY", ctx.secrets.secret_key.clone().into()),
        ("ORRAMA_LAUNCH_ID", ctx.launch_id.into()),
        ("ORRAMA_SHELL_TOKEN", ctx.shell_token.into()),
    ];
    env.extend(ours.into_iter().map(|(k, v)| (OsString::from(k), v)));
    if let Some(dir) = ctx.default_notes_dir {
        env.push(("ORRAMA_DEFAULT_NOTES_DIR".into(), dir.clone()));
    }
    env
}

/// What the window should show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Starting,
    Ready { port: u16 },
    Failed,
    /// A database exists and its key can't be read: nothing was started.
    KeyMissing(secrets::StoreKind),
}

pub struct Config {
    pub data_dir: PathBuf,
    pub data_dir_overridden: bool,
    pub default_notes_dir: Option<OsString>,
    pub launch: Launch,
    /// This launch's shell token (`ORRAMA_SHELL_TOKEN`), the same for every restart of the server.
    pub shell_token: String,
}

impl Config {
    pub fn log_file(&self) -> PathBuf {
        self.data_dir.join("logs").join("server.log")
    }
}

struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
}

struct Shared {
    quitting: AtomicBool,
    child: Mutex<Option<Running>>,
    retry: Mutex<bool>,
    wake: Condvar,
}

pub struct Supervisor {
    shared: Arc<Shared>,
    log_file: PathBuf,
}

impl Supervisor {
    pub fn start(config: Config, on_status: impl Fn(Status) + Send + 'static) -> Self {
        let shared = Arc::new(Shared { quitting: AtomicBool::new(false), child: Mutex::new(None), retry: Mutex::new(false), wake: Condvar::new() });
        let log_file = config.log_file();
        let s = shared.clone();
        thread::spawn(move || watch(&s, &config, &on_status));
        Supervisor { shared, log_file }
    }

    /// Try again, from the couldn't-start or the can't-read-the-key page.
    pub fn retry(&self) {
        *self.shared.retry.lock().unwrap() = true;
        self.shared.wake.notify_all();
    }

    /// Quit: close the server's stdin, wait up to 10 s, then kill it. Blocks.
    pub fn stop(&self) {
        self.shared.quitting.store(true, Ordering::SeqCst);
        self.shared.wake.notify_all();
        let running = self.shared.child.lock().unwrap().take();
        if let Some(running) = running {
            stop_child(running, &self.log_file);
        }
    }
}

fn stop_child(mut running: Running, log_file: &Path) {
    drop(running.stdin.take());
    let started = Instant::now();
    while started.elapsed() < STOP_LIMIT {
        if let Ok(Some(status)) = running.child.try_wait() {
            shell_log(log_file, &format!("the server stopped ({status})"));
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    shell_log(log_file, "the server did not stop within 10 s: killing it");
    let _ = running.child.kill();
    let _ = running.child.wait();
}

/// The supervisor's thread: secrets, port, start, wait, watch, restart.
fn watch(shared: &Shared, config: &Config, on_status: &dyn Fn(Status)) {
    let log_file = config.log_file();
    let quitting = || shared.quitting.load(Ordering::SeqCst);
    'session: while !quitting() {
        if let Err(e) = fs::create_dir_all(log_file.parent().expect("logs folder")) {
            eprintln!("orrama: can't make the logs folder: {e}");
        }
        on_status(Status::Starting);
        let secrets = match load_secrets(config) {
            Ok(s) => s,
            Err(problem) => {
                match &problem {
                    secrets::Problem::CantRead { store, detail } => {
                        shell_log(&log_file, &format!("not starting: the secret key can't be read ({detail}), and a database exists"));
                        on_status(Status::KeyMissing(*store));
                    }
                    secrets::Problem::CantSave { detail } => {
                        shell_log(&log_file, &format!("not starting: new secrets couldn't be kept ({detail})"));
                        on_status(Status::Failed);
                    }
                }
                if wait_for_retry(shared) {
                    continue 'session;
                }
                return;
            }
        };
        let mut exits: Vec<Instant> = Vec::new();
        loop {
            if quitting() {
                return;
            }
            let outcome = run_once(shared, config, &secrets, on_status);
            match outcome {
                Outcome::Quit => return,
                Outcome::Ended(why) => {
                    shell_log(&log_file, &why);
                    exits.push(Instant::now());
                }
            }
            let now = Instant::now();
            exits.retain(|t| now.duration_since(*t) < CRASH_WINDOW);
            let ago: Vec<Duration> = exits.iter().map(|t| now.duration_since(*t)).collect();
            match restart_delay(&ago) {
                Some(delay) => {
                    shell_log(&log_file, &format!("starting the server again in {} s", delay.as_secs()));
                    on_status(Status::Starting);
                    if sleep_unless_quit(shared, delay) {
                        return;
                    }
                }
                None => {
                    shell_log(&log_file, "the server stopped 4 times within a minute: not starting it again until Try again");
                    on_status(Status::Failed);
                    if wait_for_retry(shared) {
                        continue 'session;
                    }
                    return;
                }
            }
        }
    }
}

enum Outcome {
    Quit,
    /// The server is gone (or never came up); the reason, for the log.
    Ended(String),
}

fn load_secrets(config: &Config) -> Result<secrets::Secrets, secrets::Problem> {
    fs::create_dir_all(&config.data_dir).map_err(|e| secrets::Problem::CantSave { detail: format!("the data folder can't be made: {e}") })?;
    let desktop = port::read_desktop(&config.data_dir);
    let kind = desktop.secret_store.as_deref().and_then(secrets::StoreKind::parse).unwrap_or_else(secrets::StoreKind::platform_default);
    let account = secrets::keyring_account(&config.data_dir, config.data_dir_overridden);
    let store = secrets::open(kind, &config.data_dir, &account)?;
    secrets::ensure(store.as_ref(), &config.data_dir)
}

/// One start of the server, until it is ready and then gone, or the app quits.
fn run_once(shared: &Shared, config: &Config, secrets: &secrets::Secrets, on_status: &dyn Fn(Status)) -> Outcome {
    let log_file = config.log_file();
    let mut desktop = port::read_desktop(&config.data_dir);
    let Some(port) = port::choose_port(desktop.port, port::is_free, port::os_port) else {
        return Outcome::Ended("no free port on this computer".into());
    };
    if desktop.port != Some(port) {
        desktop.port = Some(port);
        if let Err(e) = port::write_desktop(&config.data_dir, &desktop) {
            shell_log(&log_file, &format!("the port couldn't be kept in desktop.json: {e}"));
        }
    }
    let launch_id = match secrets::random_hex(16) {
        Ok(id) => id,
        Err(e) => return Outcome::Ended(e),
    };
    let child = match spawn(config, secrets, port, &launch_id) {
        Ok(c) => c,
        Err(e) => return Outcome::Ended(format!("the server couldn't be started: {e}")),
    };
    shell_log(&log_file, &format!("started the server (pid {}) on port {port}", child.child.id()));
    {
        let mut slot = shared.child.lock().unwrap();
        if shared.quitting.load(Ordering::SeqCst) {
            stop_child(child, &log_file);
            return Outcome::Quit;
        }
        *slot = Some(child);
    }

    // Wait for our server to answer.
    let started = Instant::now();
    loop {
        if shared.quitting.load(Ordering::SeqCst) {
            return Outcome::Quit;
        }
        if let Some(ended) = exited(shared) {
            return Outcome::Ended(ended);
        }
        if health::fetch(port).is_some_and(|r| health::is_our_launch(&r, &launch_id)) {
            break;
        }
        if started.elapsed() > BOOT_LIMIT {
            let running = shared.child.lock().unwrap().take();
            if let Some(running) = running {
                stop_child(running, &log_file);
            }
            return Outcome::Ended(format!("the server didn't answer within {} s", BOOT_LIMIT.as_secs()));
        }
        thread::sleep(Duration::from_millis(250));
    }
    shell_log(&log_file, &format!("the server answers on port {port}"));
    on_status(Status::Ready { port });

    // Watch it.
    loop {
        if shared.quitting.load(Ordering::SeqCst) {
            return Outcome::Quit;
        }
        if let Some(ended) = exited(shared) {
            return Outcome::Ended(ended);
        }
        thread::sleep(Duration::from_millis(500));
    }
}

/// Whether the running server has exited (and then forgets it), with how.
fn exited(shared: &Shared) -> Option<String> {
    let mut slot = shared.child.lock().unwrap();
    let running = slot.as_mut()?;
    match running.child.try_wait() {
        Ok(Some(status)) => {
            *slot = None;
            Some(format!("the server stopped unexpectedly ({status})"))
        }
        Ok(None) => None,
        Err(e) => {
            *slot = None;
            Some(format!("the server can't be watched: {e}"))
        }
    }
}

fn spawn(config: &Config, secrets: &secrets::Secrets, port: u16, launch_id: &str) -> std::io::Result<Running> {
    let log_file = config.log_file();
    let log = OpenOptions::new().create(true).append(true).open(&log_file)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&log_file, fs::Permissions::from_mode(0o600));
    }
    let env = server_env(
        std::env::vars_os(),
        &EnvContext {
            data_dir: &config.data_dir,
            web_dist: &config.launch.web_dist,
            log_file: &log_file,
            port,
            secrets,
            launch_id,
            shell_token: &config.shell_token,
            default_notes_dir: config.default_notes_dir.as_ref(),
        },
    );
    let mut cmd = Command::new(&config.launch.program);
    cmd.args(&config.launch.args)
        .current_dir(&config.launch.cwd)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    #[cfg(unix)]
    {
        // Its own process group: a Ctrl-C meant for `tauri dev` reaches the shell
        // only, and the server stops through its stdin like any other quit.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        // No console window for node.exe.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take();
    Ok(Running { child, stdin })
}

/// True when the app is quitting (the wait was cut short).
fn sleep_unless_quit(shared: &Shared, delay: Duration) -> bool {
    let guard = shared.retry.lock().unwrap();
    let _ = shared.wake.wait_timeout_while(guard, delay, |_| !shared.quitting.load(Ordering::SeqCst)).unwrap();
    shared.quitting.load(Ordering::SeqCst)
}

/// Waits for Try again; false when the app quits instead.
fn wait_for_retry(shared: &Shared) -> bool {
    let mut retry = shared.retry.lock().unwrap();
    *retry = false;
    while !*retry && !shared.quitting.load(Ordering::SeqCst) {
        retry = shared.wake.wait(retry).unwrap();
    }
    *retry = false;
    !shared.quitting.load(Ordering::SeqCst)
}

/// A line from the shell in the server's log, in the server's own form (pino's
/// JSON lines), so "Show the log" tells the whole story. Never a secret.
pub fn shell_log(log_file: &Path, msg: &str) {
    let time = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let line = serde_json::json!({ "level": 30, "time": time as u64, "name": "shell", "msg": msg });
    // One write, so the line never interleaves with the server's own.
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_file) {
        let _ = f.write_all(format!("{line}\n").as_bytes());
    }
    eprintln!("orrama shell: {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    #[test]
    fn backs_off_then_gives_up() {
        assert_eq!(restart_delay(&[secs(0)]), Some(secs(1)));
        assert_eq!(restart_delay(&[secs(3), secs(0)]), Some(secs(5)));
        assert_eq!(restart_delay(&[secs(10), secs(7), secs(0)]), Some(secs(15)));
        assert_eq!(restart_delay(&[secs(27), secs(24), secs(19), secs(0)]), None);
    }

    #[test]
    fn exits_more_than_a_minute_ago_are_forgotten() {
        // One exit an hour: each is a first.
        assert_eq!(restart_delay(&[secs(3600), secs(0)]), Some(secs(1)));
        assert_eq!(restart_delay(&[secs(61), secs(60), secs(59), secs(0)]), Some(secs(5)));
    }

    fn ctx_env(inherited: Vec<(&str, &str)>, notes: Option<&OsString>) -> Vec<(String, String)> {
        let s = secrets::Secrets { jwt_secret: "j".repeat(64), secret_key: "k".repeat(64) };
        let env = server_env(
            inherited.into_iter().map(|(k, v)| (k.into(), v.into())),
            &EnvContext {
                data_dir: Path::new("/data"),
                web_dist: Path::new("/res/server/web"),
                log_file: Path::new("/data/logs/server.log"),
                port: 50123,
                secrets: &s,
                launch_id: "abc",
                shell_token: "t0k",
                default_notes_dir: notes,
            },
        );
        env.into_iter().map(|(k, v)| (k.into_string().unwrap(), v.into_string().unwrap())).collect()
    }

    fn get<'a>(env: &'a [(String, String)], k: &str) -> Vec<&'a str> {
        env.iter().filter(|(n, _)| n == k).map(|(_, v)| v.as_str()).collect()
    }

    #[test]
    fn the_server_gets_the_contract_and_none_of_the_persons_orrama_settings() {
        let env = ctx_env(
            vec![
                ("PATH", "/usr/bin"),
                ("HOME", "/Users/f"),
                ("ORRAMA_VAULT_DIR", "/elsewhere"),
                ("orrama_secret_key", "weak"),
                ("BASALT_DATA_DIR", "/old"),
                ("PORT", "1"),
                ("NODE_OPTIONS", "--require evil"),
                ("ORRAMA_SHELL_TOKEN", "the person's own"),
            ],
            None,
        );
        assert_eq!(get(&env, "PATH"), ["/usr/bin"]);
        assert_eq!(get(&env, "HOME"), ["/Users/f"]);
        for gone in ["ORRAMA_VAULT_DIR", "orrama_secret_key", "BASALT_DATA_DIR", "NODE_OPTIONS", "ORRAMA_DEFAULT_NOTES_DIR"] {
            assert!(get(&env, gone).is_empty(), "{gone} passed through");
        }
        assert_eq!(get(&env, "ORRAMA_PACKAGED"), ["1"]);
        assert_eq!(get(&env, "ORRAMA_DATA_DIR"), ["/data"]);
        assert_eq!(get(&env, "ORRAMA_WEB_DIST"), ["/res/server/web"]);
        assert_eq!(get(&env, "ORRAMA_LOG_FILE"), ["/data/logs/server.log"]);
        assert_eq!(get(&env, "PORT"), ["50123"]);
        assert_eq!(get(&env, "HOST"), ["127.0.0.1"]);
        assert_eq!(get(&env, "ORRAMA_PUBLIC_ORIGINS"), ["http://localhost:50123"]);
        assert_eq!(get(&env, "ORRAMA_JWT_SECRET"), ["j".repeat(64).as_str()]);
        assert_eq!(get(&env, "ORRAMA_SECRET_KEY"), ["k".repeat(64).as_str()]);
        assert_eq!(get(&env, "ORRAMA_LAUNCH_ID"), ["abc"]);
        assert_eq!(get(&env, "ORRAMA_SHELL_TOKEN"), ["t0k"], "the shell's own token, never one from outside");
    }

    #[test]
    fn the_default_notes_folder_passes_through_when_the_shell_has_one() {
        let notes = OsString::from("/scratch/notes");
        let env = ctx_env(vec![("ORRAMA_DEFAULT_NOTES_DIR", "/from/user")], Some(&notes));
        assert_eq!(get(&env, "ORRAMA_DEFAULT_NOTES_DIR"), ["/scratch/notes"]);
    }

    /// A stand-in server: answers /api/health with its launch id, stops when stdin closes.
    const FAKE: &str = r#"
const http = require("http");
const id = process.env.ORRAMA_LAUNCH_ID;
http.createServer((q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify({ ok: true, notes: 0, build: null, launch: id })); })
  .listen(Number(process.env.PORT), "127.0.0.1");
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
"#;

    #[test]
    fn a_missing_key_starts_nothing_then_try_again_starts_and_quit_stops() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("no node on PATH: skipped");
            return;
        }
        let dir = crate::testutil::tempdir();
        let script = dir.join("fake.cjs");
        fs::write(&script, FAKE).unwrap();
        fs::write(dir.join(secrets::DATABASE), "").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let config = Config {
            data_dir: dir.clone(),
            data_dir_overridden: true,
            default_notes_dir: None,
            launch: Launch { program: "node".into(), args: vec![script.into()], cwd: dir.clone(), web_dist: dir.clone() },
            shell_token: secrets::random_hex(32).unwrap(),
        };
        let log = config.log_file();
        let sup = Supervisor::start(config, move |s| tx.send(s).unwrap());
        let next = || rx.recv_timeout(Duration::from_secs(20)).expect("a status");
        // The store the key is missing from is this platform's: the file, or on Windows the
        // Credential Manager (an entry of this test's own, keyring_account).
        let store = secrets::StoreKind::platform_default();
        assert_eq!(next(), Status::Starting);
        assert_eq!(next(), Status::KeyMissing(store));
        assert!(!dir.join(secrets::SECRETS_FILE).exists(), "no new key over a database");

        // The key comes back (restored from a backup): Try again. On Windows the file
        // moves into the Credential Manager first.
        let s = secrets::Secrets::generate().unwrap();
        secrets::SecretStore::write(&secrets::FileStore::new(&dir), &s).unwrap();
        sup.retry();
        assert_eq!(next(), Status::Starting);
        let Status::Ready { port } = next() else { panic!("not ready") };
        assert_eq!(port::read_desktop(&dir).port, Some(port), "the port is kept");
        assert!(health::fetch(port).is_some());
        if store == secrets::StoreKind::Keyring {
            assert!(!dir.join(secrets::SECRETS_FILE).exists(), "the file moved into the keyring");
            let keyring = secrets::open(store, &dir, &secrets::keyring_account(&dir, true)).unwrap();
            assert!(keyring.read().unwrap() == Some(s.clone()), "the keyring holds the restored key");
            keyring.delete().unwrap();
        }

        sup.stop();
        assert!(health::fetch(port).is_none(), "the server is gone");
        let text = fs::read_to_string(&log).unwrap();
        // The exit as Rust's ExitStatus says it: "exit code: 0" on Windows, "exit status: 0" elsewhere.
        let stopped = if cfg!(windows) { "the server stopped (exit code: 0)" } else { "the server stopped (exit status: 0)" };
        assert!(text.contains(stopped), "{text}");
        assert!(!text.contains(&s.secret_key) && !text.contains(&s.jwt_secret), "no secret in the log");
        let _ = fs::remove_dir_all(&dir);
    }
}
