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
RUN corepack enable && corepack prepare pnpm@11 --activate
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

FROM node:22-slim
RUN corepack enable && corepack prepare pnpm@11 --activate
WORKDIR /app
COPY --from=build /app .

# The node image already provides an unprivileged `node` user. /data is the
# mounted volume, so it has to be writable by that user, not just by root.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV BASALT_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=4623 \
    NODE_ENV=production
VOLUME /data
EXPOSE 4623

# NODE_ENV=production makes the server refuse to boot while BASALT_JWT_SECRET or
# BASALT_SECRET_KEY still hold a placeholder (apps/server/src/env.ts). That
# refusal is the feature: a forgeable JWT secret signs every session and nothing
# about the running app looks wrong.
CMD ["pnpm", "--dir", "apps/server", "start"]
