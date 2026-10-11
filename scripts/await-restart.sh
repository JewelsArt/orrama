#!/usr/bin/env bash
# Wait until the server on <port> is a NEW process serving <build>.
#
#   scripts/await-restart.sh <port> <old-pid or ""> <expected build id>
#
# `pnpm ship` used to call it done on the first 200 from /api/health — any
# server would do: an old process that never restarted, a hand-started one
# from another checkout, a launchd agent that is not loaded (audit OPS-005).
# Two things prove the deploy: the process listening is not the one that was
# killed (so tsx recompiled the server), and /api/health's `build` — the digest
# of the index.html that process serves — is the bundle just built.
# AWAIT_SECONDS (default 30) bounds the wait.
set -uo pipefail
PORT=$1; OLD=$2; WANT=$3
for _ in $(seq 1 "${AWAIT_SECONDS:-30}"); do
  sleep 1
  # -sTCP:LISTEN matters: without it lsof also returns *client* sockets.
  NOW="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  [ -n "$NOW" ] && [ "$NOW" != "$OLD" ] || continue
  BODY="$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null)" || continue
  GOT="$(printf '%s' "$BODY" | sed -n 's/.*"build":"\([0-9a-f]*\)".*/\1/p')"
  if [ "$GOT" = "$WANT" ]; then
    echo "  up: pid $NOW, build $GOT"
    exit 0
  fi
  echo "✗ pid $NOW on :$PORT serves build ${GOT:-none}, not $WANT — is the agent running from this checkout?" >&2
  exit 1
done
echo "✗ no new server with build $WANT on :$PORT after ${AWAIT_SECONDS:-30}s (was pid ${OLD:-none})" >&2
exit 1
