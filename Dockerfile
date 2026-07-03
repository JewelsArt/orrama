# Basalt self-host image: server + built web app in one container.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@11 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile=false
RUN pnpm --dir apps/web build

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@11 --activate
WORKDIR /app
COPY --from=build /app .
ENV BASALT_DATA_DIR=/data HOST=0.0.0.0 PORT=4623 NODE_ENV=production
VOLUME /data
EXPOSE 4623
CMD ["pnpm", "--dir", "apps/server", "start"]
