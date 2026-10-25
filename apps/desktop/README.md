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

## Building the server bundle

The app carries its own server: the official Node build as a Tauri sidecar and the server
bundled into one folder beside it (the contract is in `~/orrama-next/build/2-COMMON.md`).
Both are built, never committed (`.gitignore`):

```sh
pnpm --dir apps/web build                  # once: the web app the bundle serves
pnpm --dir apps/desktop prepare-bundle     # fetch-node + package-server, for this computer
pnpm --dir apps/desktop package-server --target x86_64-pc-windows-msvc   # any target, from any computer
pnpm --dir apps/server exec vitest run test/bundle.test.ts               # the smoke test (skipped if not built)
```

- `fetch-node` puts nodejs.org's Node, unmodified, at
  `src-tauri/binaries/node-<target triple>[.exe]`. The version and every hash are pinned in
  `node-version.json`: the archive must match its pin and that release's `SHASUMS256.txt`, the
  binary its own pin, or nothing is written. A new Node:
  `node scripts/fetch-node.mjs --pin <version>` (a release at least a week old).
- `package-server` builds `src-tauri/resources/server/`: `server.mjs` (the server and the
  workspace packages, esbuild, ESM), `pdfText.worker.mjs`, `node_modules/` with only
  better-sqlite3 and @node-rs/argon2, downloaded prebuilt for the target and the pinned
  Node's ABI and checked by hash and by their headers, `web/`, `package.json`, the licence and
  the notices. It refuses a bundle that would pull in another command's entry point, leave out
  a package the server imports later, or need a module the app doesn't carry.
- Targets: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`. Downloads
  are kept in `node_modules/.cache/orrama-bundle/`.

To run the folder the way the app does (stdin held open: the server stops when it closes):

```sh
ORRAMA_PACKAGED=1 ORRAMA_DATA_DIR=… ORRAMA_DEFAULT_NOTES_DIR=… ORRAMA_JWT_SECRET=… ORRAMA_SECRET_KEY=… PORT=… \
  src-tauri/binaries/node-aarch64-apple-darwin src-tauri/resources/server/server.mjs
```
