# Orrama Desktop (Tauri 2 shell)

The app a friend downloads: a window around Orrama's own server, which the
shell starts, watches and stops. The server serves the same React app as
`apps/web` and the API, same-origin, on `http://localhost:<port>`. The shell has
no Tauri commands and no capabilities: file access, the vault watcher and sync
all live in the server, and the page the server serves gets no IPC at all.

## What the shell does (`src-tauri/src/`)

- **Starts the server** (`server.rs`): the official Node build beside the app's
  executable (`externalBin`) runs `server/server.mjs` from the resources, with the
  environment of the shell ↔ server contract (`~/orrama-next/build/2-COMMON.md`)
  and none of the person's own `ORRAMA_*` (or `BASALT_*`, `NODE_OPTIONS`,
  `NODE_PATH`). stdout and stderr go to `<data dir>/logs/server.log`, opened in
  append mode; the shell writes its own lines there too (`"name":"shell"`).
- **Shows it only when it is its own** (`health.rs`): the window opens on the
  bundled "Starting Orrama…" page (`src-tauri/fallback/`) and moves to the server
  once `/api/health` answers as Orrama (`is_orrama`) **with this launch's id**
  (`is_our_launch`, `ORRAMA_LAUNCH_ID`, new each start).
- **The port** (`port.rs`): the one used last time if it is free, else 4623 if
  free, else one the system gives; kept in `<data dir>/desktop.json`, because
  Sign in with ChatGPT registers `http://127.0.0.1:<port>/callback` per install.
- **Watches it**: a server that exits is started again after 1 s, 5 s, 15 s; a
  fourth exit within a minute shows "Orrama couldn't start" with Show the log and
  Try again. A start that never answers counts as an exit after 5 minutes.
- **Stops it**: quitting (⌘Q, the Dock's Quit, closing the window) closes the
  server's stdin, waits up to 10 s, then kills it. A shell that is killed closes
  that stdin too, and the server stops on its own (2A's side).
- **Secrets** (`secrets.rs`): two 32-byte secrets made on first launch and kept by
  the shell: on Windows in the Credential Manager, on the Mac in
  `<data dir>/secrets.json` (owner-only) until the app is signed, then the
  Keychain (`secretStore: "keyring"` in desktop.json moves the file there). A data
  folder with a database never gets new ones: if they can't be read, nothing
  starts and the window says "Orrama can't read its key".
- **One Orrama at a time**: the single-instance plugin; a second launch brings
  the first window forward and starts nothing.
- **Links** (`window.rs`): the window stays on its own page and the server;
  `target=_blank`, `window.open` and any other address (auth.openai.com
  included) open in the system browser. Downloads go to Downloads under their
  own name.

The data folder is the app's local data folder (`~/Library/Application
Support/com.orrama.desktop`, `%LOCALAPPDATA%\com.orrama.desktop`), or
`ORRAMA_DATA_DIR` from the shell's own environment. `ORRAMA_DEFAULT_NOTES_DIR`
from the shell's environment is passed to the server (where "Start empty" and the
example go instead of `~/Orrama`). Both work in debug and release builds.

## Running it

Needs a Rust toolchain (`rustup`). **On Jules's Mac always give it a scratch data
folder and notes folder**: the default ones are a friend's, and his own Orrama
(`/Applications/Orrama.app`, `dev.basalt.app`, the agent on :4623) must not be
touched. With 4623 taken the app picks another port and keeps it.

```sh
pnpm install
mkdir -p ~/basalt-scratch/me/data ~/basalt-scratch/me/notes
ORRAMA_DATA_DIR=~/basalt-scratch/me/data ORRAMA_DEFAULT_NOTES_DIR=~/basalt-scratch/me/notes \
  pnpm --dir apps/desktop dev        # tauri dev: debug build, one window
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
```

A debug build runs, in this order: `ORRAMA_DEV_SERVER_DIR` (an `apps/server`
folder, with the system Node and tsx; its `../web/dist` is the web app), else the
prepared bundle when `src-tauri/binaries/node-<triple>` and
`src-tauri/resources/server/server.mjs` exist, else this checkout's `apps/server`
with tsx. A release build only ever runs the bundle. The web app must be built
for the tsx case (`pnpm --dir apps/web exec vite build`, never into the live
checkout's `apps/web/dist`).

A release build takes the bundle's files from `tauri.bundle.conf.json`
(`externalBin`, `resources`), kept out of `tauri.conf.json` so `cargo check`,
`cargo test` and `tauri dev` work on a checkout where the bundle was never
prepared:

```sh
pnpm --dir apps/desktop tauri build --config src-tauri/tauri.bundle.conf.json
open -n src-tauri/target/release/bundle/macos/Orrama.app \
  --env ORRAMA_DATA_DIR=$HOME/basalt-scratch/me/data --env ORRAMA_DEFAULT_NOTES_DIR=$HOME/basalt-scratch/me/notes
```

The shell is deliberately thin (spec §4): all product logic lives in
`packages/core` / `packages/sync`, shared byte-for-byte with web and server.

## Building the server bundle

The app carries its own server: the official Node build as a Tauri sidecar and the server
bundled into one folder beside it (the contract is in `~/orrama-next/build/2-COMMON.md`).
Both are built, never committed (`.gitignore`):

```sh
pnpm --dir apps/web build                  # once: the web app the bundle serves
pnpm --dir apps/desktop prepare-bundle     # fetch-node + package-server + desktop notices, for this computer
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

## Release builds

One script makes the installer, on Jules's Mac and on CI's Windows runner alike
(`scripts/release-build.mjs`): the licence guards (npm and Rust), the web app built into
`node_modules/.cache/orrama-release/web` (never `apps/web/dist`, which the live server on this
Mac serves), the pinned Node, the server bundle, the desktop notices, then `tauri build` with
`tauri.bundle.conf.json`.

```sh
pnpm --dir apps/desktop release:mac        # Orrama_<v>_aarch64.dmg, ~1.5 min warm, 45 MB
node scripts/install-check.mjs --app apps/desktop/src-tauri/target/release/bundle/macos/Orrama.app
gh workflow run release.yml --ref main -f version=<v>      # the Windows installer, on a runner
```

- **Mac:** Apple silicon only (Jules, 25 Oct 2026), macOS 13.5 and later (Node 24's own minimum),
  ad-hoc signed (`signingIdentity: "-"`): Gatekeeper says it can't verify the app, and System
  Settings → Privacy & Security → Open Anyway opens it, once. Tauri re-signs everything inside,
  the Node binary too, so `hardenedRuntime` is off: with it on, Node would lose the JIT entitlement
  its own signature carried. The .dmg shows the AGPL before it opens (`licenseFile`).
- **Windows:** the NSIS installer only (per user, no admin prompt; an MSI needs WiX and a
  per-machine install), English, the WebView2 bootstrapper when WebView2 is missing, the AGPL on
  its licence page. Unsigned: SmartScreen's "More info → Run anyway". Built by `release.yml`
  (windows-latest), which then installs it silently into a temp folder, runs and stops the
  installed server, uninstalls, and drafts the GitHub release.
- **Notices:** `resources/server/` carries `LICENSE`, `NOTICE` and three notices files: the web
  app's, the server's, and `THIRD_PARTY_NOTICES_DESKTOP.txt` (Node's licence and the Rust crates
  of the window, `scripts/desktop-notices.mjs`, also copied into `web/` so Settings can link it).
  The crates' licences are kept in `apps/desktop/crate-licences.json` and checked by
  `apps/web/src/crateLicences.test.ts`: after a crate is added or bumped, run
  `node scripts/desktop-notices.mjs --licences` and that test, and commit both.
- **Size:** `[profile.release]` in `Cargo.toml` (one codegen unit, LTO, `opt-level = "s"`,
  stripped) takes the shell from 10.3 MB to 4.5 MB. Node is ~117 MB of the 144 MB app.
