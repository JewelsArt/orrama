// Basalt desktop shell. Deliberately thin: the vault engine, sync client, and UI
// are TypeScript (packages/core, packages/sync, apps/web) — this binary provides
// the window, native file access to the local vault checkout, and a file watcher
// that feeds external edits (e.g. from Obsidian) back into the CRDT.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    basalt_desktop_lib::run()
}
