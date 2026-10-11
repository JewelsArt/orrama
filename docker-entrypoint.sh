#!/bin/sh
# Start the server as the unprivileged `node` user, with /data writable by it.
#
# docker-compose bind-mounts the host's ./data over /data. On a Linux host,
# when ./data does not exist yet, dockerd creates it owned by root, mode 0755,
# so a server already running as `node` could not create basalt.db and the
# container restart-looped (audit OPS-006). So the image starts as root, hands
# /data to node once if node does not own it, and drops to node for good.
# Started as another user (`docker run --user`), it runs the command as is.
set -e
if [ "$(id -u)" = "0" ]; then
  if [ "$(stat -c %u /data)" != "$(id -u node)" ]; then
    chown -R node:node /data
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
