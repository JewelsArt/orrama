# Installing Orrama

Setting Orrama up on a fresh machine, start to finish. Every command here was run
against a clean `git clone` on macOS (Apple Silicon) and the timings are real.

There is a shortcut at the top and the reasoning underneath it. If something breaks,
**Troubleshooting** at the bottom covers the failures you are actually likely to hit.

---

## Quickstart

```bash
git clone https://github.com/JewelsArt/Basalt-backup.git orrama
cd orrama

pnpm install                      # ~3s warm, ~1min on a cold pnpm store
pnpm --dir apps/web build         # ~2s  — builds the UI the server serves
export ORRAMA_JWT_SECRET=$(openssl rand -hex 32)   # keep both — see Security
export ORRAMA_SECRET_KEY=$(openssl rand -hex 32)
pnpm --dir apps/server start      # serves API + UI on http://127.0.0.1:4623
```

Open <http://127.0.0.1:4623>. A fresh install shows **Create your account** —
the first account founds the workspace and owns it. Nothing is sent anywhere;
there is no Orrama account service.

The server refuses to start without the two secrets. Save the values you
generated wherever you start the server from (a launchd plist, a compose `.env`):
a new `ORRAMA_JWT_SECRET` signs everyone out, and a new `ORRAMA_SECRET_KEY`
makes the stored mail password and AI key unreadable.

> **Do not run `pnpm build`** unless you have a Rust toolchain — see the next section.

---

## What you need

| | Required | Notes |
|---|---|---|
| **Node** | ≥ 22 | `node --version` |
| **pnpm** | 11.9.0 | `npm i -g pnpm@11.9.0`. Other 11.x versions are fine |
| **Rust** | **Only for the desktop app** | Not needed to run Orrama |

### The Rust trap

`pnpm build` and `pnpm dev` are Turborepo tasks that fan out to **every** workspace
package — including `apps/desktop`, which is a Tauri app and needs `cargo`. On a
machine without Rust, both fail. With Rust, `pnpm build` takes **1m51s**, most of it
compiling a desktop binary and a `.dmg` you probably did not want yet.

Orrama's server, web app and shared packages need none of that. Use the scoped
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

### 3. Generate the secrets

```bash
export ORRAMA_JWT_SECRET=$(openssl rand -hex 32)
export ORRAMA_SECRET_KEY=$(openssl rand -hex 32)
```

The server refuses to boot without them (see **Security**). Keep the values: the
next start needs the same ones.

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
sign-in form. Either way you land on Today.

### Looking around with a sample vault instead

```bash
pnpm --dir apps/server seed     # 13 demo notes, three demo accounts
pnpm --dir apps/server dev      # http://127.0.0.1:4627, dev secrets allowed
```

`seed` and `dev` are a scratch install: they keep their database and vault in
`apps/server/data-dev`, never in `apps/server/data`, and `dev` listens on 4627,
not 4623. The demo accounts (`jules` / `erin` / `mara` `@orrama.dev`, password
`orrama-demo`) have passwords printed in the source, so they are a way to look
around, not an account. `seed` refuses a vault that already holds notes.

### 5. Set up quick unlock (optional)

Settings → **Unlock** offers a 4-digit passcode, and Touch ID where the device
supports it. Both are shortcuts over an account that already exists: the password
stays the credential, and is the only way back in if the passcode locks out.

The passcode is checked on the server, not in the browser — five wrong tries start
a cooldown and ten disable it — so it is a real gate rather than a screen you can
skip past with devtools.

---

## Pointing Orrama at your own vault

This is the setup most people want: Orrama reading the notes they already have.

```bash
ORRAMA_VAULT_DIR="$HOME/Obsidian Vault" pnpm --dir apps/server start
```

Orrama reads and writes **those files, live** — the same folder Obsidian opens. The
database stays in `ORRAMA_DATA_DIR` and never moves into your notes, because it is
only a cache of them.

Two things to know before you do this:

- **Back your vault up first.** Orrama writes to these files. `git init` in the vault,
  or copy the folder somewhere, before pointing a new tool at years of notes.
- **The index builds on first boot.** A large vault takes a moment to scan; the app is
  usable as soon as the server reports listening.

Your account comes from the **Create your account** screen on first start (step 4),
not from seeding — `seed` only fills an empty scratch vault, and refuses one that
holds notes.

---

## Configuration

All optional. Set them in the environment before starting the server.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4623` (`dev`: `4627`) | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. `0.0.0.0` exposes it on your network |
| `ORRAMA_DATA_DIR` | `./data` (`dev`, `seed`: `./data-dev`) | Database and default vault location; relative to `apps/server` when run through `pnpm --dir apps/server` |
| `ORRAMA_VAULT_DIR` | `<dataDir>/vault` | Point at an existing vault (above) |
| `ORRAMA_JWT_SECRET` | dev placeholder | Signs session tokens — **must be set**, see Security |
| `ORRAMA_SECRET_KEY` | dev placeholder | Encrypts stored AI and mail credentials at rest — **must be set** |
| `ORRAMA_CORS_ORIGIN` | `false` | Allow specific cross-origin browsers |
| `ORRAMA_ALLOW_DEV_SECRETS` | unset | `1` boots on placeholder secrets anyway |

These were called `BASALT_*` before the rename to Orrama, and only the `ORRAMA_*` names
are read now. An install set up before then must rename each one (same value) in the
launchd plist, the shell, Docker's `.env` and the MCP server's config: the server, its
scripts and the MCP server refuse to start while a `BASALT_` variable has no `ORRAMA_`
twin, and say which.

### Security

The two secrets ship with placeholder values that are published in this repo.
They are unsafe for anything reachable by anyone else: the JWT secret signs
every session, so a known value lets anyone who reaches the port mint a
workspace-owner session, and the secret key decrypts the stored mail password
and AI key, so a copy of `basalt.db` decrypts both offline.

**Orrama refuses to boot while either holds a placeholder.** Generate real ones:

```bash
export ORRAMA_JWT_SECRET=$(openssl rand -hex 32)
export ORRAMA_SECRET_KEY=$(openssl rand -hex 32)
```

The refusal does not depend on `NODE_ENV`. It used to, and that was worse than
useless: an operator who forgets to set secrets is exactly the operator who
forgets to set `NODE_ENV`, so the guard stayed silent on the installs that
needed it. For a throwaway install nobody else can reach, opt out explicitly
with `ORRAMA_ALLOW_DEV_SECRETS=1` — `pnpm --dir apps/server dev` already does,
and keeps its own data folder and port for that reason.

**Rotating `ORRAMA_SECRET_KEY` on a database that already holds credentials**
does not re-encrypt them; it makes them undecryptable, and the symptom is mail
that quietly stops connecting. Migrate first, with the server stopped:

```bash
ORRAMA_OLD_SECRET_KEY=<old> ORRAMA_SECRET_KEY=<new> pnpm --dir apps/server rotate-secret-key --apply
```

Without `--apply` it reports what it would do and writes nothing, which is how
you confirm the old key is the right one. And note what rotation cannot undo: a
credential that was protected by a published key was readable by anyone holding
the database. Rotate the credential itself at the provider too.

---

## Other ways to run it

### Keep it running in the background (macOS)

A `launchd` agent with `KeepAlive` restarts the server on boot and on crash.
`scripts/dev.basalt.server.plist` is the template and `scripts/README.md` the
install steps: create `~/.basalt-run`, fill in the secrets, the vault and the
public origins (the server refuses the `REPLACE_ME` placeholders), `chmod 600`,
then `launchctl bootstrap`.

After changing web code, rebuild and restart — editing source alone changes nothing,
because the server serves the built bundle and registers static files at boot. The
repo's `pnpm ship` does typecheck → test → build → restart in one step.

### Docker

```bash
export ORRAMA_JWT_SECRET=$(openssl rand -hex 32)
export ORRAMA_SECRET_KEY=$(openssl rand -hex 32)
docker compose up
```

Export both secrets first. Without them compose substitutes `change-me-please`,
which is on the refused-placeholder list, and the container exits with
`Refusing to start:` rather than booting on a forgeable session secret.

Builds and runs on **arm64 and x64**, so a Raspberry Pi works as well as a VPS.
The image holds the server's production dependencies and the built web app,
nothing else (no build tools, tests or desktop CLI). It starts as root only long
enough to hand `./data` to the unprivileged `node` user — on a Linux host, dockerd
creates a missing `./data` owned by root — then runs the server as `node`, which
cannot write the app's own code. `/data` is a volume: your notes and database
live in `./data` on the host and survive `docker restart`, `down` and `up`.
`docker ps` shows the container's health from `/api/health`.

Verified end to end on arm64 (Docker 29, colima's Linux VM, with `/data` created
by dockerd as root): build, placeholder-secret refusal, first boot, health
status, and a clean `docker stop` (exit 0, WAL checkpointed). CI builds and boots
the image on Linux for every push. `.dockerignore` keeps every `data/`, `*.db`,
`exports/` and `.env` out of the build, so a rebuild never copies your notes or
database into the image.

**Only this machine can reach it.** Compose publishes `127.0.0.1:4623`, not every
interface: the sign-in is a password and a 4-digit unlock, and a VPS's public
address is the whole internet. See **Reaching it from elsewhere**.

**Port conflict.** If you already run Orrama on the host (a launchd agent, say),
the container cannot take 4623. Change the host side of the mapping in
`docker-compose.yml` (`127.0.0.1:4700:4623`), or stop the other one.

### Reaching it from elsewhere

Put something in front that brings TLS and its own access control, and keep
Orrama itself on loopback:

- **Tailscale** (simplest): `tailscale serve --bg 4623` gives
  `https://<machine>.<tailnet>.ts.net`, reachable only from your own devices.
- **A reverse proxy** (Caddy, nginx) on a domain, with TLS and its own
  authentication or an IP allow-list in front of Orrama.

Then tell Orrama its new name, or it answers 421 to every request that arrives
under it: `ORRAMA_PUBLIC_ORIGINS=https://<machine>.<tailnet>.ts.net` (compose
passes it through; for launchd, the plist). Touch ID trusts only those origins.

### Desktop app

Needs Rust (`rustup`), then:

```bash
pnpm --dir apps/desktop build     # ~1m51s, produces Orrama.app and a .dmg
```

Output lands in `apps/desktop/src-tauri/target/release/bundle/`. The app is an
unsigned Tauri window pointed at the server, so macOS Gatekeeper will complain on
first open.

---

## Backing up

Two things to keep:

- **The vault** — your Markdown folder. Back it up like any folder (git, Time
  Machine, a copy). Task status, time blocks and events live in it.
- **What only the database holds** — accounts, task comments and descriptions,
  project settings, AI settings, tokens, webhooks, history:

  ```bash
  ORRAMA_VAULT_DIR=/path/to/your/vault pnpm --dir apps/server export
  ```

  writes `apps/server/data/exports/orrama-export-<date>-<time>/` with a restorable
  `basalt.db`, a readable `export.json` (no passwords, hashes or keys) and a
  README on how to restore. It is safe to run while the server is up. Keep the
  folder private; it will not write into the vault.

## Troubleshooting

**`Refusing to start — Orrama reads only ORRAMA_* variables now`**
A `BASALT_` variable from before the rename is still set. Rename it as the message says
(see **Configuration**).

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
Something already holds the port — often a previous Orrama.
`lsof -nP -iTCP:4623 -sTCP:LISTEN -t` gives the PID. Use that exact command: a bare
`lsof -ti :4623` also matches *client* sockets, and killing one of those has taken
down an unrelated app before.

**Notes do not appear after editing them outside Orrama**
The watcher indexes external edits. If the vault is on a network or cloud-synced
volume the events may not fire; restart the server to force a re-index.

**Exits immediately with "Refusing to start"**
`ORRAMA_JWT_SECRET` or `ORRAMA_SECRET_KEY` is still a placeholder. That refusal
is deliberate and no longer depends on `NODE_ENV` — see **Security**. Export
real values and bring it up again, or set `ORRAMA_ALLOW_DEV_SECRETS=1` if this
is a scratch install nobody else can reach.

**Mail stopped connecting after changing `ORRAMA_SECRET_KEY`**
The stored password is still encrypted under the old key. Restore it, or run
`rotate-secret-key` with both keys — see **Security**.

**Starting over**
Do not just delete the database. The notes, task status, time blocks and events
come back from the Markdown, but these exist only in `basalt.db`: accounts,
passwords, sessions, passkeys and API tokens; the mail password, AI key and
ChatGPT sign-in; webhooks and calendar feeds; task comments and descriptions,
assignees set in the app, project hidden flags; staged mail drafts; and every
note's history, the only copy of text that was overwritten. Export first, with the
server stopped:

```bash
ORRAMA_VAULT_DIR=/path/to/your/vault pnpm --dir apps/server export
rm apps/server/data/basalt.db apps/server/data/basalt.db-shm apps/server/data/basalt.db-wal
```

The next start re-indexes the vault and offers **Create your account**. Your `.md`
files are untouched. To get the old database back, copy the export's `basalt.db`
into place (its README says how).

---

## For an AI agent setting this up

Run in order, from the repo root. Stop on first failure.

```bash
node --version                                  # require >= 22
pnpm --version                                  # require 11.x; npm i -g pnpm@11.9.0
pnpm install                                    # expect exit 0
pnpm --dir apps/web build                       # expect apps/web/dist/index.html
export ORRAMA_JWT_SECRET=$(openssl rand -hex 32)  # hand both values to the human: the
export ORRAMA_SECRET_KEY=$(openssl rand -hex 32)  # next start needs the same ones
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
  `ORRAMA_DATA_DIR`. Do not let a test run inherit the default `./data`.
- **Never delete `apps/server/data`** (or the `basalt.db` in it) on a machine where
  Orrama is in use: it holds accounts, credentials, comments, drafts and history
  that exist nowhere else. `dev` and `seed` use `apps/server/data-dev`.
- Verify by HTTP, not by reading the log: a successful boot line does not prove the
  static bundle registered.

Full test suite, if you want a signal before starting anything:

```bash
pnpm test        # every package
pnpm typecheck
```

Both are safe — they use temporary directories and never touch `apps/server/data`.
