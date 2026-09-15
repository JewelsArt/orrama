# Installing Basalt

Setting Basalt up on a fresh machine, start to finish. Every command here was run
against a clean `git clone` on macOS (Apple Silicon) and the timings are real.

There is a shortcut at the top and the reasoning underneath it. If something breaks,
**Troubleshooting** at the bottom covers the failures you are actually likely to hit.

---

## Quickstart

```bash
git clone https://github.com/JewelsArt/Basalt-backup.git basalt
cd basalt

pnpm install                      # ~3s warm, ~1min on a cold pnpm store
pnpm --dir apps/web build         # ~2s  — builds the UI the server serves
pnpm --dir apps/server start      # serves API + UI on http://127.0.0.1:4623
```

Open <http://127.0.0.1:4623>. A fresh install shows **Create your account** —
the first account founds the workspace and owns it. Nothing is sent anywhere;
there is no Basalt account service.

> **Do not run `pnpm build`** unless you have a Rust toolchain — see the next section.

---

## What you need

| | Required | Notes |
|---|---|---|
| **Node** | ≥ 22 | `node --version` |
| **pnpm** | 11.9.0 | `npm i -g pnpm@11.9.0`. Other 11.x versions are fine |
| **Rust** | **Only for the desktop app** | Not needed to run Basalt |

### The Rust trap

`pnpm build` and `pnpm dev` are Turborepo tasks that fan out to **every** workspace
package — including `apps/desktop`, which is a Tauri app and needs `cargo`. On a
machine without Rust, both fail. With Rust, `pnpm build` takes **1m51s**, most of it
compiling a desktop binary and a `.dmg` you probably did not want yet.

Basalt's server, web app and shared packages need none of that. Use the scoped
commands instead:

```bash
pnpm --dir apps/web build      # instead of pnpm build
pnpm --dir apps/server start   # instead of pnpm dev
```

Only reach for `pnpm build` when you actually want a desktop bundle.

---

## Step by step

### 1. Install dependencies

```bash
pnpm install
```

513 packages across 7 workspace projects. **Verify:** `node_modules/` exists at the
repo root and inside each `apps/*` and `packages/*`.

### 2. Build the web UI

```bash
pnpm --dir apps/web build
```

The server serves a *built* bundle from `apps/web/dist` and registers those static
files at boot. Skip this and the server runs but every page is a 404.

**Verify:** `apps/web/dist/index.html` exists.

### 3. (Optional) Start from a sample vault

```bash
pnpm --dir apps/server seed
```

Not required. It creates 13 Markdown files — linked notes, tags, checkbox tasks,
projects and contacts — so the dashboard and graph have something to show, plus
three demo accounts (`jules` / `erin` / `mara` `@basalt.dev`, password
`basalt-demo`).

Those demo passwords are printed in the source, so they are a way to look around,
not an account. If you seed and then intend to keep the install, turn one into a
real account:

```bash
pnpm --dir apps/server account
```

It asks for an email, a name and a password, typed interactively. Skip seeding
entirely and the app offers **Create your account** on first open instead.

### 4. Start the server

```bash
pnpm --dir apps/server start
```

One process serves both the JSON API and the web UI on **<http://127.0.0.1:4623>**.
It runs TypeScript directly through `tsx`, so there is no server build step.

**Verify:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4623/          # expect 200
curl -s http://127.0.0.1:4623/api/auth/status                            # {"needsSetup":true} on a fresh install
```

Open the URL. On a fresh install you get **Create your account**; after that, a
sign-in form. Either way you land on the Dashboard.

### 5. Set up quick unlock (optional)

Settings → **Unlock** offers a 4-digit passcode, and Touch ID where the device
supports it. Both are shortcuts over an account that already exists: the password
stays the credential, and is the only way back in if the passcode locks out.

The passcode is checked on the server, not in the browser — five wrong tries start
a cooldown and ten disable it — so it is a real gate rather than a screen you can
skip past with devtools.

---

## Pointing Basalt at your own vault

This is the setup most people want: Basalt reading the notes they already have.

```bash
BASALT_VAULT_DIR="$HOME/Obsidian Vault" pnpm --dir apps/server start
```

Basalt reads and writes **those files, live** — the same folder Obsidian opens. The
database stays in `BASALT_DATA_DIR` and never moves into your notes, because it is
only a cache of them.

Two things to know before you do this:

- **Back your vault up first.** Basalt writes to these files. `git init` in the vault,
  or copy the folder somewhere, before pointing a new tool at years of notes.
- **The index builds on first boot.** A large vault takes a moment to scan; the app is
  usable as soon as the server reports listening.

You still need step 3 to have run at least once to create an account — seeding writes
demo notes into `data/vault`, which is separate from the vault you point at here.

---

## Configuration

All optional. Set them in the environment before starting the server.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4623` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. `0.0.0.0` exposes it on your network |
| `BASALT_DATA_DIR` | `./data` | Database and default vault location |
| `BASALT_VAULT_DIR` | `<dataDir>/vault` | Point at an existing vault (above) |
| `BASALT_JWT_SECRET` | dev placeholder | Signs session tokens |
| `BASALT_SECRET_KEY` | dev placeholder | Encrypts stored AI and mail credentials at rest |
| `BASALT_CORS_ORIGIN` | permissive | Restrict browser origins |

### Security

The two secrets ship with placeholder values so local development works with zero
config. They are genuinely unsafe for anything reachable by other people: the JWT
secret signs every session, so a known value lets anyone mint a workspace-owner
session, and the secret key decrypts stored credentials.

Basalt refuses to boot with `NODE_ENV=production` while either still holds a
placeholder. Generate real ones:

```bash
export BASALT_JWT_SECRET=$(openssl rand -hex 32)
export BASALT_SECRET_KEY=$(openssl rand -hex 32)
```

And change the demo passwords, or delete the demo accounts once you have made your
own via `POST /api/auth/register`.

---

## Other ways to run it

### Keep it running in the background (macOS)

A `launchd` agent with `KeepAlive` restarts the server on boot and on crash. Adapt
`~/Library/LaunchAgents/dev.basalt.server.plist` to run
`pnpm --dir apps/server start` from your checkout.

After changing web code, rebuild and restart — editing source alone changes nothing,
because the server serves the built bundle and registers static files at boot. The
repo's `pnpm ship` does typecheck → test → build → restart in one step.

### Docker

```bash
export BASALT_JWT_SECRET=$(openssl rand -hex 32)
export BASALT_SECRET_KEY=$(openssl rand -hex 32)
docker compose up
```

Export both secrets first. Without them compose substitutes `change-me-please`,
which is on the refused-placeholder list, and the container exits with
`Refusing to start:` rather than booting on a forgeable session secret.

Builds and runs on **arm64 and x64**, so a Raspberry Pi works as well as a VPS.
The image is ~248 MB, builds in about 80 seconds, boots in about 4, and runs as
the unprivileged `node` user. `/data` is a volume: your notes and database live
there and survive `docker restart`, `down` and `up`.

Verified end to end on arm64 (Docker 29, colima): build, placeholder-secret
refusal, first-run account creation through the API, and data surviving a
container restart. The image carries no database, no vault and no host-built
binaries — `.dockerignore` keeps the build context at ~2 MB.

**Port conflict.** Compose publishes `4623:4623`. If you already run Basalt on
the host (a launchd agent, say), the container cannot take that port. Change the
host side of the mapping in `docker-compose.yml`, or stop the other one.

### Desktop app

Needs Rust (`rustup`), then:

```bash
pnpm --dir apps/desktop build     # ~1m51s, produces Basalt.app and a .dmg
```

Output lands in `apps/desktop/src-tauri/target/release/bundle/`. The app is an
unsigned Tauri window pointed at the server, so macOS Gatekeeper will complain on
first open.

---

## Troubleshooting

**`cargo: command not found` / build hangs for minutes**
You ran `pnpm build` or `pnpm dev` without Rust. Use the scoped commands from
**The Rust trap**.

**The sign-in form rejects everything on a brand-new install**
There are no accounts yet, and you should be seeing the setup screen instead.
Check `curl -s http://127.0.0.1:4623/api/auth/status` — if it says
`{"needsSetup":true}` but you get a login form, the web bundle is stale: rebuild
with `pnpm --dir apps/web build` and restart.

**Locked out of the passcode**
Ten wrong entries disable it deliberately. Choose "Use password instead" on the
lock screen; a successful password login clears the counter. Forgotten the
password too? `pnpm --dir apps/server account` sets a new one.

**Every page is a blank 404 but the API responds**
`apps/web/dist` is missing. Run `pnpm --dir apps/web build`.

**`EADDRINUSE` on 4623**
Something already holds the port — often a previous Basalt.
`lsof -nP -iTCP:4623 -sTCP:LISTEN -t` gives the PID. Use that exact command: a bare
`lsof -ti :4623` also matches *client* sockets, and killing one of those has taken
down an unrelated app before.

**Notes do not appear after editing them outside Basalt**
The watcher indexes external edits. If the vault is on a network or cloud-synced
volume the events may not fire; restart the server to force a re-index.

**Container exits immediately with "Refusing to start"**
`BASALT_JWT_SECRET` or `BASALT_SECRET_KEY` is still a placeholder. That refusal
is deliberate — see **Security**. Export real values and bring it up again.

**Starting over**
The database is disposable — it is an index of the Markdown, not the source of truth:

```bash
rm -rf data/basalt.db data/basalt.db-shm data/basalt.db-wal
pnpm --dir apps/server seed
```

Your `.md` files are untouched.

---

## For an AI agent setting this up

Run in order, from the repo root. Stop on first failure.

```bash
node --version                                  # require >= 22
pnpm --version                                  # require 11.x; npm i -g pnpm@11.9.0
pnpm install                                    # expect exit 0
pnpm --dir apps/web build                       # expect apps/web/dist/index.html
pnpm --dir apps/server start &                  # backgrounded; serves :4623
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4623/     # expect 200
curl -s http://127.0.0.1:4623/api/auth/status                     # {"needsSetup":true}
```

The install is then complete: a human creates the first account in the browser.
Do not run `seed` to get past this — it exists for the sample vault, and its demo
passwords are public. There is no way to create the first account from the command
line by design; `account` edits one that already exists.

Rules that are not obvious from the scripts:

- **Never run `pnpm build` or `pnpm dev`** to get a running server. Both invoke the
  Tauri desktop build and need a Rust toolchain. Use the scoped commands above.
- **`seed` is optional and is NOT how you get an account.** It loads a sample vault
  and demo logins whose passwords are in the repo. A fresh install offers account
  creation in the browser; that is the intended path.
- **`apps/web` must be built before the server starts**, not after — static files are
  registered at boot.
- The server needs no build; it runs TypeScript via `tsx`.
- To isolate a test instance from an existing one, set `PORT` **and**
  `BASALT_DATA_DIR`. Do not let a test run inherit the default `./data`.
- Verify by HTTP, not by reading the log: a successful boot line does not prove the
  static bundle registered.

Full test suite, if you want a signal before starting anything:

```bash
pnpm test        # 262 cases: 150 core, 6 sync, 106 server
pnpm typecheck   # 5 packages
```

Both are safe — they use temporary directories and never touch `data/`.
