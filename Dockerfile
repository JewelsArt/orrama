# syntax=docker/dockerfile:1
#
# Basalt self-host image: the Fastify API and the built web app in one container.
#
# Debian slim rather than Alpine, deliberately. better-sqlite3 installs via
# `prebuild-install || node-gyp rebuild`: it fetches a prebuilt binary when one
# matches the platform, and otherwise compiles from source. Prebuilts are
# published for glibc Linux but not for musl, so on node:22-alpine every build
# fell through to node-gyp — which needs python3, make and g++, none of which
# that image contains. The build simply failed. Debian gets the prebuilt binary
# and needs no toolchain at all. (@node-rs/argon2 ships musl and glibc both, so
# it was never the problem.)
#
# Works on arm64 and x64, so this builds for a Raspberry Pi as well as a VPS.

FROM node:22-slim AS build
# The version the repo pins (package.json packageManager), not "some 11.x".
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app

# Manifests before source, so editing a .ts file does not invalidate the
# dependency layer. Every workspace package needs its package.json here or
# pnpm cannot resolve the workspace.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json    packages/core/
COPY packages/schema/package.json  packages/schema/
COPY packages/sync/package.json    packages/sync/
COPY packages/ui/package.json      packages/ui/
COPY apps/desktop/package.json     apps/desktop/
COPY apps/mcp/package.json         apps/mcp/
COPY apps/server/package.json      apps/server/
COPY apps/web/package.json         apps/web/

# --frozen-lockfile, not the previous --frozen-lockfile=false: the committed
# lockfile decides the versions. Without it a rebuild a year from now quietly
# resolves different ones, which is how a working image stops working with no
# change to the repo.
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --dir apps/web build
# The server and what it needs at run time, nothing else: no vite, vitest,
# typescript or Tauri CLI in the image (audit OPS-006). tsx is a production
# dependency because it is how the server runs (OPS-011).
RUN pnpm --filter @orrama/server deploy --prod --legacy /out/apps/server

FROM node:22-slim
WORKDIR /app
# The server finds the web app at ../../web/dist from its own src (main.ts).
COPY --from=build /out/apps/server apps/server
COPY --from=build /app/apps/web/dist apps/web/dist
COPY docker-entrypoint.sh /usr/local/bin/basalt-entrypoint

# /app stays root's: the server process cannot rewrite its own code (tsx would
# recompile a changed src/*.ts on the next start). Only /data is node's, and
# the entrypoint re-owns a bind-mounted /data that dockerd made for root.
RUN mkdir -p /data && chown node:node /data

ENV BASALT_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=4623 \
    NODE_ENV=production
VOLUME /data
EXPOSE 4623

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4623/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# The server refuses to boot while BASALT_JWT_SECRET or BASALT_SECRET_KEY is
# missing, short or a placeholder, whatever NODE_ENV says (apps/server/src/
# env.ts). That refusal is the feature: a forgeable JWT secret signs every
# session and nothing about the running app looks wrong.
#
# Node itself is PID 1, not pnpm: `docker stop` sends SIGTERM to PID 1, and
# pnpm died on it without passing it on — the server's graceful close (watcher,
# requests, the SQLite WAL checkpoint; main.ts) never ran and the container
# exited 1 with the WAL left behind. The entrypoint execs, so node takes its
# place. Same command `pnpm start` runs, minus pnpm.
WORKDIR /app/apps/server
ENTRYPOINT ["basalt-entrypoint"]
CMD ["node", "--import", "tsx", "src/main.ts"]
