# Basalt Desktop (Tauri 2 shell)

Thin native shell around the same React app as `apps/web`, plus:

- local vault folder as a real partial checkout (read/write via Tauri commands)
- file watcher → external edits (e.g. Obsidian on the same folder) feed the CRDT
- keychain storage for the auth token, tray quick-capture (planned)

## Build requirements

Needs a Rust toolchain (`rustup`), then:

```sh
pnpm install
pnpm --dir apps/desktop dev     # dev window against the vite dev server
pnpm --dir apps/desktop build   # installers via tauri bundler
```

The shell is deliberately thin (spec §4): all product logic lives in
`packages/core` / `packages/sync`, shared byte-for-byte with web and server.
