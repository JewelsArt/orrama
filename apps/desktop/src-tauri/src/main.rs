// Basalt desktop shell. Deliberately thin: the vault engine, sync client, and UI
// are TypeScript (packages/core, packages/sync, apps/web), served by the local
// server — this binary is the window around it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    basalt_desktop_lib::run()
}
