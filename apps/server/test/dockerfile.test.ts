/**
 * The self-host image (Dockerfile, docker-entrypoint.sh, .dockerignore,
 * docker-compose.yml).
 *
 * The image's PID 1 must be node, not pnpm: `docker stop` sends SIGTERM to
 * PID 1, and pnpm died on it without passing it on, so the server's graceful
 * close never ran (container exit 1, SQLite WAL left behind). Verified with a
 * real `docker build` + `docker stop` on 2026-09-30; this pins the line. The
 * rest was verified on 2026-10-11 against a Linux docker host (colima) and is
 * pinned here; CI builds and boots the image on Linux (docker.yml).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const lines = (f: string) => read(f).split(/\r?\n/);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-docker-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("Dockerfile", () => {
  it("runs the server as node itself", () => {
    const cmd = lines("Dockerfile").filter((l) => l.startsWith("CMD ")).pop();
    expect(cmd).toBe('CMD ["node", "--import", "tsx", "src/main.ts"]');
    expect(read("Dockerfile")).toMatch(/^WORKDIR \/app\/apps\/server$/m);
  });

  // OPS-006: the runtime stage carried the whole build (vite, vitest,
  // typescript, the Tauri CLI, tests) and gave node write access to its own code.
  it("ships only the server's production install and the built web app, owned by root", () => {
    const runtime = read("Dockerfile").split(/^FROM /m).pop()!;
    expect(runtime).not.toMatch(/COPY --from=build \/app \./);
    expect(runtime).toMatch(/COPY --from=build \/out\/apps\/server apps\/server/);
    expect(runtime).toMatch(/COPY --from=build \/app\/apps\/web\/dist apps\/web\/dist/);
    expect(read("Dockerfile")).toMatch(/pnpm --filter @orrama\/server deploy --prod/);
    expect(runtime).toMatch(/chown node:node \/data$/m);
    expect(runtime).not.toMatch(/chown[^\n]*\/app/);
    expect(runtime).not.toMatch(/^USER /m); // the entrypoint drops to node
    expect(runtime).toMatch(/^ENTRYPOINT \["orrama-entrypoint"\]$/m);
    expect(runtime).toMatch(/^HEALTHCHECK /m);
    expect(runtime).not.toMatch(/corepack|pnpm install/);
    expect(read("Dockerfile")).toMatch(/corepack prepare pnpm@11\.9\.0 /);
  });
});

// OPS-006: dockerd creates a missing ./data as root, and a server already
// running as node could not open /data/basalt.db — a restart loop on any Linux
// host. The entrypoint, as root, hands /data to node and drops privileges.
describe.skipIf(process.platform === "win32")("docker-entrypoint.sh", () => {
  /** Run the entrypoint with id/stat/chown/setpriv stubbed, as uid `uid` with /data owned by `owner`. */
  function run(uid: number, owner: number) {
    const bin = fs.mkdtempSync(path.join(tmp, "bin-"));
    const log = path.join(bin, "log");
    const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub("id", `[ "$1" = "-u" ] && [ "$2" = "node" ] && { echo 1000; exit 0; }; echo ${uid}`);
    stub("stat", `echo ${owner}`);
    stub("chown", `echo "chown $*" >> ${log}`);
    stub("setpriv", `echo "setpriv $*" >> ${log}`);
    stub("node", `echo "node $*" >> ${log}`);
    const r = spawnSync("sh", [path.join(root, "docker-entrypoint.sh"), "node", "--import", "tsx", "src/main.ts"], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin` },
    });
    expect(r.status, r.stderr).toBe(0);
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  }

  it("as root, on a /data root owns, hands it to node and runs the server as node", () => {
    expect(run(0, 0)).toEqual(["chown -R node:node /data", "setpriv --reuid=node --regid=node --init-groups node --import tsx src/main.ts"]);
  });

  it("as root, on a /data node already owns, changes nothing and still drops to node", () => {
    expect(run(0, 1000)).toEqual(["setpriv --reuid=node --regid=node --init-groups node --import tsx src/main.ts"]);
  });

  it("started as another user, runs the command as is", () => {
    expect(run(1000, 0)).toEqual(["node --import tsx src/main.ts"]);
  });
});

/** Docker's .dockerignore matching, as far as these patterns need: `**` any depth, `*` within a segment; a matched folder takes its contents. */
function ignored(rel: string, patterns: string[]): boolean {
  const re = (p: string) =>
    new RegExp(
      `^${p
        .split(/(\*\*\/|\*\*|\*|\?)/)
        .map((t) => ({ "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*", "?": "[^/]" })[t] ?? t.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
        .join("")}$`,
    );
  const parts = rel.split("/");
  return patterns.some((p) => parts.some((_, i) => re(p).test(parts.slice(0, i + 1).join("/"))));
}

describe(".dockerignore", () => {
  const patterns = lines(".dockerignore").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  // REG-010: compose keeps the vault and basalt.db in the repo-root ./data, and
  // `*.db` matches only at the context root, so a rebuild copied both in.
  it("keeps every database, vault, export and env file out of the build context", () => {
    for (const p of [
      "data/basalt.db",
      "data/basalt.db-wal",
      "data/vault/Secret.md",
      "data/exports/orrama-export-1/export.json",
      "apps/server/data/basalt.db",
      "apps/server/data-dev/vault/Welcome.md",
      "apps/server/x.db",
      "nested/deep/y.db-shm",
      "apps/server/.env",
      "apps/web/.env.local",
      "apps/server/exports/a.json",
    ]) {
      expect(ignored(p, patterns), p).toBe(true);
    }
  });

  it("still sends the source", () => {
    for (const p of ["apps/server/src/main.ts", "apps/server/package.json", "packages/core/src/parse.ts", "pnpm-lock.yaml", "docker-entrypoint.sh", "apps/web/index.html"]) {
      expect(ignored(p, patterns), p).toBe(false);
    }
  });
});

// SEC-012: `4623:4623` published the sign-in surface on every host interface.
describe("docker-compose.yml", () => {
  it("publishes the server to this machine only", () => {
    const ports = read("docker-compose.yml").match(/^\s+- "([^"]+)"$/gm)!.map((l) => l.trim().slice(3, -1)).filter((p) => /:\d+$/.test(p));
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) expect(p).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
  });

  it("and the guide says how to reach it from elsewhere, safely", () => {
    const remote = read("INSTALL.md").split("### Reaching it from elsewhere")[1]!.split(/\n## /)[0]!;
    expect(remote).toMatch(/tailscale serve/);
    expect(remote).toMatch(/ORRAMA_PUBLIC_ORIGINS=/);
    expect(read("docker-compose.yml")).toMatch(/ORRAMA_PUBLIC_ORIGINS: \$\{ORRAMA_PUBLIC_ORIGINS:-\}/);
  });
});
