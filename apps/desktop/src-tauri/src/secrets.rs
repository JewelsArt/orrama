/// The server's two secrets: made once by the app, kept by it, handed to the server.
///
/// `ORRAMA_JWT_SECRET` signs sessions; `ORRAMA_SECRET_KEY` encrypts what the
/// server stores for the person (mail password, AI key, ChatGPT sign-in, webhook
/// secrets, feed links; apps/server/src/secrets.ts). Losing the key orphans all of
/// that silently, so the one rule here that matters most: **a data folder that
/// holds a database never gets new secrets.** If they can't be read there, nothing
/// starts and the window says why (`Problem::CantRead`). Only a folder without
/// `basalt.db` gets new ones.
///
/// Where they are kept is one small trait with two stores. On Windows the
/// Credential Manager (`keyring`). On the Mac a file only the user can read,
/// `secrets.json` (mode 600, the protection Jules's launchd plist has today),
/// because an unsigned Mac app's Keychain access is tied to its exact build: every
/// update would ask for the password. Once the app is signed with a Developer ID
/// the Mac moves to the Keychain by changing `StoreKind::platform_default` (or
/// `secretStore` in desktop.json): `open` then moves the file's secrets into the
/// Keychain and deletes the file (`migrate`). Jules, 25 Oct 2026.
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// The database whose stored credentials the key unlocks (CLAUDE.md "Still called Basalt").
pub const DATABASE: &str = "basalt.db";
pub const SECRETS_FILE: &str = "secrets.json";
/// The keyring entry's service; its user names the data folder (`keyring_account`).
pub const KEYRING_SERVICE: &str = "com.orrama.desktop";
/// What the server accepts (`assertProductionSecrets`, env.ts); the shell makes 64.
const MIN_LENGTH: usize = 32;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secrets {
    pub jwt_secret: String,
    pub secret_key: String,
}

/// Never printed: a log line or a panic message must not carry them.
impl fmt::Debug for Secrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secrets { .. }")
    }
}

impl Secrets {
    /// Two independent 32-byte secrets from the system's random source, as hex.
    pub fn generate() -> Result<Self, String> {
        Ok(Secrets { jwt_secret: random_hex(32)?, secret_key: random_hex(32)? })
    }

    fn usable(&self) -> bool {
        let ok = |s: &str| s.len() >= MIN_LENGTH && !s.chars().any(char::is_whitespace);
        ok(&self.jwt_secret) && ok(&self.secret_key)
    }

    fn to_json(&self) -> String {
        serde_json::to_string(self).expect("two strings serialise")
    }

    /// Parsed and checked; the error never quotes the text, which may be a secret.
    fn from_json(text: &str) -> Result<Self, String> {
        let s: Secrets = serde_json::from_str(text).map_err(|_| "the stored secrets are not readable JSON".to_string())?;
        if s.usable() {
            Ok(s)
        } else {
            Err("a stored secret is empty or too short".into())
        }
    }
}

pub fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| format!("no random source: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreKind {
    File,
    Keyring,
}

impl StoreKind {
    /// Windows: the Credential Manager. Everywhere else: the file (the Mac until
    /// the app is signed; Linux has no packaged app).
    pub fn platform_default() -> Self {
        if cfg!(windows) {
            StoreKind::Keyring
        } else {
            StoreKind::File
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "file" => Some(StoreKind::File),
            "keyring" => Some(StoreKind::Keyring),
            _ => None,
        }
    }
}

pub trait SecretStore {
    fn kind(&self) -> StoreKind;
    /// `Ok(None)`: nothing stored. `Err`: something is stored, or may be, and can't be read.
    fn read(&self) -> Result<Option<Secrets>, String>;
    fn write(&self, secrets: &Secrets) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// `<data dir>/secrets.json`, readable by its owner only.
pub struct FileStore {
    path: PathBuf,
}

impl FileStore {
    pub fn new(data_dir: &Path) -> Self {
        FileStore { path: data_dir.join(SECRETS_FILE) }
    }

    pub fn exists(&self) -> bool {
        self.path.exists()
    }
}

impl SecretStore for FileStore {
    fn kind(&self) -> StoreKind {
        StoreKind::File
    }

    fn read(&self) -> Result<Option<Secrets>, String> {
        let text = match fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("{SECRETS_FILE} can't be read: {e}")),
        };
        #[cfg(unix)]
        {
            // Someone loosened it (a copy, a restore): put it back to owner-only.
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = fs::metadata(&self.path) {
                if meta.permissions().mode() & 0o077 != 0 {
                    let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600));
                }
            }
        }
        Secrets::from_json(&text).map(Some)
    }

    /// Through a temp file made owner-only before anything is written to it, then a rename.
    fn write(&self, secrets: &Secrets) -> Result<(), String> {
        let tmp = self.path.with_file_name(format!(".{SECRETS_FILE}.tmp"));
        let _ = fs::remove_file(&tmp);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| {
            let mut f = options.open(&tmp)?;
            f.write_all(secrets.to_json().as_bytes())?;
            f.write_all(b"\n")?;
            f.sync_all()?;
            fs::rename(&tmp, &self.path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result.map_err(|e| format!("{SECRETS_FILE} can't be written: {e}"))
    }

    fn delete(&self) -> Result<(), String> {
        match fs::remove_file(&self.path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{SECRETS_FILE} can't be removed: {e}")),
            _ => Ok(()),
        }
    }
}

/// One entry in a keyring (the Credential Manager, the Keychain) holding both secrets.
pub struct KeyringStore {
    entry: keyring_core::Entry,
}

impl KeyringStore {
    pub fn new(store: &Arc<keyring_core::CredentialStore>, account: &str) -> Result<Self, String> {
        let entry = store.build(KEYRING_SERVICE, account, None).map_err(|e| format!("the keyring refused the entry: {e}"))?;
        Ok(KeyringStore { entry })
    }

    /// The system's own store: the Credential Manager on Windows, the login Keychain on the Mac.
    pub fn native(account: &str) -> Result<Self, String> {
        #[cfg(windows)]
        let store: Arc<keyring_core::CredentialStore> = windows_native_keyring_store::Store::new().map_err(|e| format!("Credential Manager: {e}"))?;
        #[cfg(target_os = "macos")]
        let store: Arc<keyring_core::CredentialStore> = apple_native_keyring_store::keychain::Store::new().map_err(|e| format!("Keychain: {e}"))?;
        #[cfg(not(any(windows, target_os = "macos")))]
        let store: Arc<keyring_core::CredentialStore> = return Err(format!("no system keyring on this platform for {account}"));
        Self::new(&store, account)
    }
}

impl SecretStore for KeyringStore {
    fn kind(&self) -> StoreKind {
        StoreKind::Keyring
    }

    fn read(&self) -> Result<Option<Secrets>, String> {
        match self.entry.get_password() {
            Ok(text) => Secrets::from_json(&text).map(Some),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("the keyring can't be read: {e}")),
        }
    }

    fn write(&self, secrets: &Secrets) -> Result<(), String> {
        self.entry.set_password(&secrets.to_json()).map_err(|e| format!("the keyring can't be written: {e}"))
    }

    fn delete(&self) -> Result<(), String> {
        match self.entry.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("the keyring entry can't be removed: {e}")),
        }
    }
}

/// Why the server can't be given its secrets. `detail` is for the log, never the page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    /// A database exists and its key can't be read: start nothing, make nothing.
    CantRead { store: StoreKind, detail: String },
    /// New secrets were made for an empty folder but couldn't be kept.
    CantSave { detail: String },
}

pub fn has_database(data_dir: &Path) -> bool {
    data_dir.join(DATABASE).exists()
}

/// The secrets for this data folder: the stored ones, or new ones when the folder
/// has no database. Never new ones over an existing database.
pub fn ensure(store: &dyn SecretStore, data_dir: &Path) -> Result<Secrets, Problem> {
    let read = store.read();
    if let Ok(Some(s)) = &read {
        return Ok(s.clone());
    }
    if has_database(data_dir) {
        let detail = match read {
            Err(e) => e,
            _ => format!("{DATABASE} exists but no secrets are stored"),
        };
        return Err(Problem::CantRead { store: store.kind(), detail });
    }
    let made = Secrets::generate().map_err(|detail| Problem::CantSave { detail })?;
    store.write(&made).map_err(|detail| Problem::CantSave { detail })?;
    // Believe the store only once it gives them back.
    match store.read() {
        Ok(Some(back)) if back == made => Ok(made),
        Ok(_) => Err(Problem::CantSave { detail: "the secrets read back differ from the ones written".into() }),
        Err(detail) => Err(Problem::CantSave { detail }),
    }
}

/// Moves the file's secrets into another store: write, read back, then delete the
/// file. While the file exists it is the truth (a migration that stopped half way
/// is finished, over whatever the other store holds). A failure leaves the file.
pub fn migrate(file: &FileStore, to: &dyn SecretStore) -> Result<(), String> {
    let Some(secrets) = file.read()? else {
        return Ok(());
    };
    to.write(&secrets)?;
    match to.read()? {
        Some(back) if back == secrets => file.delete(),
        _ => Err("the secrets read back from the new store differ; the file is kept".into()),
    }
}

/// The store this app uses for `data_dir`, after moving a leftover file into a keyring.
pub fn open(kind: StoreKind, data_dir: &Path, keyring_account: &str) -> Result<Box<dyn SecretStore>, Problem> {
    let file = FileStore::new(data_dir);
    match kind {
        StoreKind::File => Ok(Box::new(file)),
        StoreKind::Keyring => {
            let keyring = KeyringStore::native(keyring_account).map_err(|detail| Problem::CantRead { store: kind, detail })?;
            if file.exists() {
                migrate(&file, &keyring).map_err(|detail| Problem::CantRead { store: StoreKind::File, detail })?;
            }
            Ok(Box::new(keyring))
        }
    }
}

/// The keyring entry's user name. The packaged app has one data folder; a test run
/// with `ORRAMA_DATA_DIR` gets an entry of its own, so it never reads the app's.
pub fn keyring_account(data_dir: &Path, overridden: bool) -> String {
    if overridden {
        format!("server secrets for {}", data_dir.display())
    } else {
        "server secrets".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tempdir;
    use std::cell::RefCell;

    fn mock_keyring() -> KeyringStore {
        let store: Arc<keyring_core::CredentialStore> = keyring_core::mock::Store::new().unwrap();
        KeyringStore::new(&store, "server secrets").unwrap()
    }

    /// A store that can't be read, or written, as a locked keyring or a broken disk.
    struct Broken {
        reads: bool,
        written: RefCell<Option<Secrets>>,
    }
    impl SecretStore for Broken {
        fn kind(&self) -> StoreKind {
            StoreKind::Keyring
        }
        fn read(&self) -> Result<Option<Secrets>, String> {
            if self.reads {
                Ok(self.written.borrow().clone())
            } else {
                Err("locked".into())
            }
        }
        fn write(&self, s: &Secrets) -> Result<(), String> {
            *self.written.borrow_mut() = Some(s.clone());
            if self.reads {
                Err("full".into())
            } else {
                Ok(())
            }
        }
        fn delete(&self) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn generated_secrets_are_two_different_64_hex_strings() {
        let s = Secrets::generate().unwrap();
        for v in [&s.jwt_secret, &s.secret_key] {
            assert_eq!(v.len(), 64);
            assert!(v.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        }
        assert_ne!(s.jwt_secret, s.secret_key);
        assert_ne!(Secrets::generate().unwrap(), s);
        assert_eq!(format!("{s:?}"), "Secrets { .. }");
    }

    #[test]
    fn an_empty_folder_gets_secrets_once() {
        let dir = tempdir();
        let store = FileStore::new(&dir);
        let first = ensure(&store, &dir).unwrap();
        fs::write(dir.join(DATABASE), "").unwrap(); // the server made its database
        assert_eq!(ensure(&store, &dir).unwrap(), first);
        assert_eq!(ensure(&FileStore::new(&dir), &dir).unwrap(), first);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir();
        let store = FileStore::new(&dir);
        store.write(&Secrets::generate().unwrap()).unwrap();
        let path = dir.join(SECRETS_FILE);
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600, "written owner-only");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        store.read().unwrap().unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn never_new_secrets_over_a_database() {
        let dir = tempdir();
        fs::write(dir.join(DATABASE), "").unwrap();
        // Nothing stored.
        let store = FileStore::new(&dir);
        assert!(matches!(ensure(&store, &dir), Err(Problem::CantRead { store: StoreKind::File, .. })));
        assert!(!dir.join(SECRETS_FILE).exists(), "nothing was written");
        // Something stored that can't be read: left exactly as it was.
        fs::write(dir.join(SECRETS_FILE), "{\"jwtSecret\":\"").unwrap();
        assert!(matches!(ensure(&store, &dir), Err(Problem::CantRead { .. })));
        assert_eq!(fs::read_to_string(dir.join(SECRETS_FILE)).unwrap(), "{\"jwtSecret\":\"");
        // A keyring that can't be read.
        let locked = Broken { reads: false, written: RefCell::new(None) };
        assert!(matches!(ensure(&locked, &dir), Err(Problem::CantRead { store: StoreKind::Keyring, .. })));
        assert!(locked.written.borrow().is_none(), "nothing was written");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_store_without_a_database_starts_over() {
        let dir = tempdir();
        fs::write(dir.join(SECRETS_FILE), "garbage").unwrap();
        let made = ensure(&FileStore::new(&dir), &dir).unwrap();
        assert_eq!(FileStore::new(&dir).read().unwrap(), Some(made));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn secrets_that_do_not_come_back_are_not_used() {
        let dir = tempdir();
        let full = Broken { reads: true, written: RefCell::new(None) };
        assert!(matches!(ensure(&full, &dir), Err(Problem::CantSave { .. })));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn short_or_spaced_secrets_are_unreadable() {
        assert!(Secrets::from_json("{\"jwtSecret\":\"short\",\"secretKey\":\"short\"}").is_err());
        let long = "a".repeat(40);
        assert!(Secrets::from_json(&format!("{{\"jwtSecret\":\"{long}\",\"secretKey\":\"{long} b\"}}")).is_err());
        assert!(Secrets::from_json(&format!("{{\"jwtSecret\":\"{long}\",\"secretKey\":\"{long}\"}}")).is_ok());
    }

    #[test]
    fn the_keyring_store_round_trips() {
        let dir = tempdir();
        let keyring = mock_keyring();
        assert_eq!(keyring.read().unwrap(), None);
        let made = ensure(&keyring, &dir).unwrap();
        assert_eq!(keyring.read().unwrap(), Some(made.clone()));
        fs::write(dir.join(DATABASE), "").unwrap();
        assert_eq!(ensure(&keyring, &dir).unwrap(), made);
        keyring.delete().unwrap();
        assert!(matches!(ensure(&keyring, &dir), Err(Problem::CantRead { .. })));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migration_moves_the_file_into_the_keyring() {
        let dir = tempdir();
        let file = FileStore::new(&dir);
        let made = ensure(&file, &dir).unwrap();
        fs::write(dir.join(DATABASE), "").unwrap();
        let keyring = mock_keyring();
        // A half-done earlier move left other secrets in the keyring: the file wins.
        keyring.write(&Secrets::generate().unwrap()).unwrap();
        migrate(&file, &keyring).unwrap();
        assert!(!file.exists(), "the file is gone");
        assert_eq!(ensure(&keyring, &dir).unwrap(), made, "the same secrets, so the database still opens");
        // Nothing left to move.
        migrate(&file, &keyring).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    /// A store that keeps something, but not what it was given.
    struct Lying;
    impl SecretStore for Lying {
        fn kind(&self) -> StoreKind {
            StoreKind::Keyring
        }
        fn read(&self) -> Result<Option<Secrets>, String> {
            Secrets::generate().map(Some)
        }
        fn write(&self, _: &Secrets) -> Result<(), String> {
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn a_migration_that_reads_back_other_secrets_keeps_the_file() {
        let dir = tempdir();
        let file = FileStore::new(&dir);
        let made = ensure(&file, &dir).unwrap();
        assert!(migrate(&file, &Lying).is_err());
        assert_eq!(file.read().unwrap(), Some(made));
        assert!(ensure(&Lying, &dir).is_ok(), "a store that answers is believed by ensure");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_migration_keeps_the_file() {
        let dir = tempdir();
        let file = FileStore::new(&dir);
        let made = ensure(&file, &dir).unwrap();
        let full = Broken { reads: true, written: RefCell::new(None) };
        assert!(migrate(&file, &full).is_err());
        assert_eq!(file.read().unwrap(), Some(made));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_platform_default_and_names() {
        assert_eq!(StoreKind::platform_default(), if cfg!(windows) { StoreKind::Keyring } else { StoreKind::File });
        assert_eq!(StoreKind::parse("keyring"), Some(StoreKind::Keyring));
        assert_eq!(StoreKind::parse("file"), Some(StoreKind::File));
        assert_eq!(StoreKind::parse("Keychain"), None);
        let dir = Path::new("/x/y");
        assert_eq!(keyring_account(dir, false), "server secrets");
        assert_ne!(keyring_account(dir, true), "server secrets");
    }
}
