#!/usr/bin/env bash
# Typecheck, test, build, and restart the launchd agent that serves the app.
#
# The desktop app loads the *built* bundle from :4623, and @fastify/static
# registers asset routes at boot — so a code change is invisible until both the
# build and the restart have happened. Doing it by hand is how you end up
# debugging a fix that was never actually running.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ typecheck"
pnpm typecheck

echo "→ tests"
pnpm test

echo "→ build web"
pnpm --dir apps/web build

# The vault's .mcp.json runs apps/mcp/dist/index.js; without this step the MCP
# tools Claude uses kept whatever was last built by hand.
echo "→ build mcp"
pnpm --dir apps/mcp build

echo "→ restart server"
# -sTCP:LISTEN matters: without it lsof also returns *client* sockets on 4623.
PID="$(lsof -nP -iTCP:4623 -sTCP:LISTEN -t | head -1 || true)"
[ -n "$PID" ] && kill "$PID" && echo "  killed $PID (launchd KeepAlive restarts it)"
for _ in $(seq 1 30); do
  sleep 1
  if curl -fsS localhost:4623/api/health >/dev/null 2>&1; then
    echo "  up: $(curl -s localhost:4623/api/health)"
    echo "✓ shipped — ⌘R the desktop app"
    exit 0
  fi
done
echo "✗ server did not come back on :4623" >&2
exit 1
