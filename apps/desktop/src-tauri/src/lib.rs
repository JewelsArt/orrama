/// The window, and nothing else.
///
/// The shell loads the running server (http://localhost:4623, which serves the
/// app and the API same-origin), so it needs no commands of its own. It used to
/// register `read_vault_file` / `write_vault_file`, which took the vault root
/// FROM THE CALLER — anything able to invoke them could read or write any file
/// on the Mac — and nothing in the app ever called them. Removed with the
/// never-initialised fs/dialog plugins and the `notify` watcher; the server's
/// watcher is the one that feeds outside edits into the CRDT.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running basalt");
}
