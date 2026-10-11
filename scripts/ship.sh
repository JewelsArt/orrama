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
# The build the restarted server must report: /api/health's `build` is this
# digest of the index.html it serves (main.ts, buildId).
WANT="$(node -e 'process.stdout.write(require("crypto").createHash("sha1").update(require("fs").readFileSync("apps/web/dist/index.html")).digest("hex").slice(0, 12))')"
# -sTCP:LISTEN matters: without it lsof also returns *client* sockets on 4623.
PID="$(lsof -nP -iTCP:4623 -sTCP:LISTEN -t | head -1 || true)"
if [ -n "$PID" ]; then
  kill "$PID" && echo "  killed $PID (launchd KeepAlive restarts it)"
else
  echo "  nothing was listening on :4623 — waiting for launchd to start it"
fi
bash scripts/await-restart.sh 4623 "$PID" "$WANT"
echo "✓ shipped — ⌘R the desktop app"
if [ "$(git rev-parse --abbrev-ref HEAD)" = "sep-2026-redesign" ]; then
  echo "  main is what is running: git push origin sep-2026-redesign:main"
fi
