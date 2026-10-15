# scripts

## `dev.basalt.server.plist` — run the Basalt server at login

The desktop app (`/Applications/Basalt.app`) is a native window that loads the
Basalt server at `http://localhost:4623` (same-origin: the Fastify server serves
both the built web app and the API). So the app needs that server running.

This LaunchAgent starts it at login and restarts it if it dies (`KeepAlive`).
It runs `node --import tsx src/main.ts` in `apps/server` — what `pnpm start`
runs, without pnpm in between, so launchd's SIGTERM reaches the server and it
closes cleanly. Logs go to `~/.basalt-run/server.log`.

It is a template. Paths are absolute for this machine (`/Users/jules/basalt`,
`~/Obsidian Vault`, Homebrew node) — edit them if anything moves — and the two
secrets are `REPLACE_ME`, which the server refuses to start on.

Install:

```sh
mkdir -p ~/.basalt-run                      # launchd does not create the log folder
pnpm --dir apps/web build                   # the server serves the built bundle
cp scripts/dev.basalt.server.plist ~/Library/LaunchAgents/
chmod 600 ~/Library/LaunchAgents/dev.basalt.server.plist   # it holds the secrets
# Edit the copy: both REPLACE_ME (openssl rand -hex 32 each), ORRAMA_VAULT_DIR,
# and ORRAMA_PUBLIC_ORIGINS (every address Basalt is reached at).
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.basalt.server.plist
launchctl kickstart -k gui/$(id -u)/dev.basalt.server   # start it now
curl -s http://127.0.0.1:4623/api/health                 # {"ok":true,…}
```

**Keep the two secrets** in a password manager. They exist only in the installed
plist; `pnpm --dir apps/server export` does not contain them, and a database
restored under a different `ORRAMA_SECRET_KEY` cannot read its mail password,
AI key or ChatGPT sign-in.

Check / stop:

```sh
launchctl print gui/$(id -u)/dev.basalt.server | grep -E 'state|pid'
launchctl bootout gui/$(id -u)/dev.basalt.server        # stop + disable
```

## `ship.sh` — `pnpm ship`

Typecheck, tests, web and MCP builds, then restart the agent and wait
(`await-restart.sh`) until a **new** process on :4623 reports the **build just
made** in `/api/health`. Anything else — the old process still up, a server from
another checkout, nothing listening — fails the ship instead of printing
"shipped".

## Others

- `webkit-snap.swift` — a WKWebView snapshot of a page: check CSP and rendering
  changes in WebKit (the desktop app's engine), not only Chrome.
- `graphify.mjs` — regenerates `codebase-graph.md`.
- `merge-vaults.mjs` — the one-off that folded Basalt's old vault copy into the
  Obsidian vault (kept for reference).
