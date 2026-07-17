# scripts

## `dev.basalt.server.plist` — run the Basalt server at login

The desktop app (`/Applications/Basalt.app`) is a native window that loads the
Basalt server at `http://localhost:4623` (same-origin: the Fastify server serves
both the built web app and the API). So the app needs that server running.

This LaunchAgent starts it automatically at login and restarts it if it dies
(`KeepAlive`). It runs `pnpm --dir apps/server start` from the repo root; logs go
to `~/.basalt-run/server.log`.

Paths are absolute for this machine (`/Users/jules/basalt`, Homebrew pnpm) — edit
them if the checkout moves.

Install:

```sh
cp scripts/dev.basalt.server.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.basalt.server.plist
launchctl kickstart -k gui/$(id -u)/dev.basalt.server   # start it now
```

Check / stop:

```sh
launchctl print gui/$(id -u)/dev.basalt.server | grep -E 'state|pid'
launchctl bootout gui/$(id -u)/dev.basalt.server        # stop + disable
```

The app also needs the web bundle built once so the server can serve it:
`pnpm --dir apps/web build` (already part of `pnpm tauri build`).
