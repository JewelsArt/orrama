/**
 * The image's PID 1 must be node, not pnpm: `docker stop` sends SIGTERM to
 * PID 1, and pnpm died on it without passing it on, so the server's graceful
 * close never ran (container exit 1, SQLite WAL left behind). Verified with a
 * real `docker build` + `docker stop` on 2026-09-30; this pins the line.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Dockerfile", () => {
  it("runs the server as node itself", () => {
    const docker = fs.readFileSync(path.resolve(import.meta.dirname, "../../../Dockerfile"), "utf8");
    const cmd = docker.split("\n").filter((l) => l.startsWith("CMD ")).pop();
    expect(cmd).toBe('CMD ["node", "--import", "tsx", "src/main.ts"]');
    expect(docker).toMatch(/^WORKDIR \/app\/apps\/server$/m);
  });
});
