use std::fs;
use std::path::PathBuf;

/// Read a note from the local vault checkout. The web UI running inside the shell
/// calls this instead of HTTP when offline (offline-first, spec §10).
#[tauri::command]
fn read_vault_file(vault_root: String, rel_path: String) -> Result<String, String> {
    let root = PathBuf::from(&vault_root);
    let path = root.join(&rel_path);
    // No traversal outside the vault, mirroring the server's path rules.
    if !path.starts_with(&root) || rel_path.contains("..") {
        return Err("invalid path".into());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_vault_file(vault_root: String, rel_path: String, content: String) -> Result<(), String> {
    let root = PathBuf::from(&vault_root);
    let path = root.join(&rel_path);
    if !path.starts_with(&root) || rel_path.contains("..") {
        return Err("invalid path".into());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![read_vault_file, write_vault_file])
        .run(tauri::generate_context!())
        .expect("error while running basalt");
}
