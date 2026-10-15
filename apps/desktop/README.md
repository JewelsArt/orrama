# Orrama Desktop (Tauri 2 shell)

Thin native shell: a window on the local server (`http://localhost:4623`),
which serves the same React app as `apps/web` and the API, same-origin. It has
no Tauri commands, no plugins and no capabilities — file access, the vault
watcher and sync all live in the server, and the page the server serves gets
no IPC at all.

The window opens on the small bundled page in `src-tauri/fallback/` ("Orrama
isn't running") and moves to the server only once `GET /api/health` answers the
way Orrama does (`is_orrama` in `src/lib.rs`, checked every 2 s). With the agent
down and something else on 4623, that something is never shown inside a window
called Orrama. `security.csp` applies to the bundled page; the server's own
pages carry the server's CSP header.

There is no web build inside the app and no dev window on the vite server: the
window always shows the server on 4623. To see a web change in the app,
`pnpm ship` (CLAUDE.md, "Start here").

## Build requirements

Needs a Rust toolchain (`rustup`), then:

```sh
pnpm install
pnpm --dir apps/desktop dev     # the shell, debug build, against the server on 4623
pnpm --dir apps/desktop build   # installers via tauri bundler
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib   # is_orrama
```

The shell is deliberately thin (spec §4): all product logic lives in
`packages/core` / `packages/sync`, shared byte-for-byte with web and server.
