/**
 * SIGTERM — how launchd stops the agent — closes the server properly: the
 * process exits 0, and the database is closed, so SQLite checkpoints and
 * removes its WAL. It used to die on the signal with the WAL left behind and
 * the vault watcher still running to the last moment.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-shutdown-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("shutdown", () => {
  it("SIGTERM closes the app and the database, and exits 0", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve(import.meta.dirname, "../src/main.ts")], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, BASALT_DATA_DIR: tmp, BASALT_VAULT_DIR: path.join(tmp, "vault"), PORT: "0", HOST: "127.0.0.1", BASALT_ALLOW_DEV_SECRETS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    for (let i = 0; i < 400 && !/Server listening/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
    expect(out).toMatch(/Server listening/);
    expect(fs.existsSync(path.join(tmp, "basalt.db-wal"))).toBe(true); // open, in WAL mode

    child.kill("SIGTERM");
    const result = await Promise.race([exited, new Promise<"hung">((r) => setTimeout(() => r("hung"), 15_000))]);
    expect(result, out.slice(-400)).toEqual({ code: 0, signal: null });
    expect(out).toMatch(/SIGTERM: closing/);
    expect(fs.existsSync(path.join(tmp, "basalt.db-wal"))).toBe(false); // checkpointed on close
  }, 40_000);

  // The launchd agent does not run node: it runs `pnpm --dir apps/server
  // start`, and launchd signals that pnpm. Verified 2026-10-01 that pnpm
  // passes SIGTERM down (pnpm → tsx → node) — a pnpm that stopped doing so
  // would kill the server mid-write on every logout and `launchctl` stop.
  it("SIGTERM to `pnpm start` — what launchd signals — reaches the server", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "pnpm-"));
    const child = spawn("pnpm", ["--dir", "apps/server", "start"], {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: { ...process.env, BASALT_DATA_DIR: dir, BASALT_VAULT_DIR: path.join(dir, "vault"), PORT: "0", HOST: "127.0.0.1", BASALT_ALLOW_DEV_SECRETS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    for (let i = 0; i < 400 && !/Server listening/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
    expect(out).toMatch(/Server listening/);

    child.kill("SIGTERM"); // pnpm only, as launchd does
    await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
    for (let i = 0; i < 100 && !/SIGTERM: closing/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
    expect(out).toMatch(/SIGTERM: closing/);
    expect(fs.existsSync(path.join(dir, "basalt.db-wal"))).toBe(false); // checkpointed on close
  }, 40_000);
});
