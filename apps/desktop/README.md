# Basalt Desktop (Tauri 2 shell)

Thin native shell: a window on the local server (`http://localhost:4623`),
which serves the same React app as `apps/web` and the API, same-origin. It has
no Tauri commands and no plugins — file access, the vault watcher and sync all
live in the server. `security.csp` mirrors the server's own policy so a
Tauri-served page (`tauri dev`, `frontendDist`) is never without one.

## Build requirements

Needs a Rust toolchain (`rustup`), then:

```sh
pnpm install
pnpm --dir apps/desktop dev     # dev window against the vite dev server
pnpm --dir apps/desktop build   # installers via tauri bundler
```

The shell is deliberately thin (spec §4): all product logic lives in
`packages/core` / `packages/sync`, shared byte-for-byte with web and server.
