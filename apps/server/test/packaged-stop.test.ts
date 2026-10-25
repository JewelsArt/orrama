/**
 * The desktop app stops its server by closing the server's stdin (it quits, or it dies) or by
 * writing the line `stop`: Windows has no SIGTERM for a child, and a hard kill leaves the
 * database's WAL behind. Either way the server closes as it does on SIGTERM and exits 0. Its
 * log is the file the shell names (`ORRAMA_LOG_FILE`), rotated like launchd's. From the
 * checkout nothing changes: launchd gives the server a closed stdin and it keeps running.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/** The exit code, or "still running" after `ms`: a test that waits for an exit must not hang past its own finally. */
const exitWithin = (exited: Promise<number | null>, ms = 15_000) =>
  Promise.race([exited, new Promise<"still running">((r) => setTimeout(() => r("still running"), ms))]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-packaged-stop-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MAIN = path.resolve(import.meta.dirname, "../src/main.ts");

/** Starts the server through tsx with stdout and stderr in `log`; resolves once it listens, with its port. */
async function start(name: string, extra: NodeJS.ProcessEnv, stdin: "pipe" | "ignore") {
  const data = path.join(tmp, name, "data");
  const log = path.join(data, "logs", "server.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  if (!fs.existsSync(log)) fs.writeFileSync(log, "");
  const fd = fs.openSync(log, "a");
  const env: NodeJS.ProcessEnv = { ...process.env, ORRAMA_DATA_DIR: data, PORT: "0", HOST: "127.0.0.1", ORRAMA_JWT_SECRET: "j".repeat(64), ORRAMA_SECRET_KEY: "k".repeat(64), ...extra };
  for (const k of ["ORRAMA_VAULT_DIR", "ORRAMA_ALLOW_DEV_SECRETS", "ORRAMA_PACKAGED", "ORRAMA_LOG_FILE", "ORRAMA_DEFAULT_NOTES_DIR"]) if (!(k in extra)) delete env[k];
  const child = spawn(process.execPath, ["--import", "tsx", MAIN], { cwd: path.dirname(MAIN), env, stdio: [stdin, fd, fd] });
  fs.closeSync(fd);
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  let port = 0;
  for (let i = 0; i < 600 && !port; i++) {
    const m = /Server listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(log, "utf8"));
    if (m) port = Number(m[1]);
    else await new Promise((r) => setTimeout(r, 50));
  }
  return { child, exited, port, data, log };
}

const stopped = async (s: { child: ChildProcess; exited: Promise<number | null> }) => {
  if (s.child.exitCode === null) s.child.kill("SIGKILL");
  await s.exited;
};

const packaged = (name: string) => ({
  ORRAMA_PACKAGED: "1",
  ORRAMA_DEFAULT_NOTES_DIR: path.join(tmp, name, "notes"),
  ORRAMA_LOG_FILE: path.join(tmp, name, "data", "logs", "server.log"),
});

describe("the server inside the app", () => {
  it("stops cleanly when its stdin closes: exit 0, the WAL checkpointed away; its log rotates", async () => {
    const env = packaged("closed");
    fs.mkdirSync(path.dirname(env.ORRAMA_LOG_FILE), { recursive: true });
    fs.writeFileSync(env.ORRAMA_LOG_FILE, `${"x".repeat(1023)}\n`.repeat(6 * 1024)); // 6 MB
    const s = await start("closed", env, "pipe");
    try {
      expect(s.port).toBeGreaterThan(0);
      expect(fs.readFileSync(s.log, "utf8")).toContain("log rotated");
      // A write, so the database has a WAL to leave behind.
      const r = await fetch(`http://127.0.0.1:${s.port}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "sam@example.test", username: "sam", displayName: "Sam", password: "correct horse battery" }),
      });
      expect(r.status).toBe(200);
      expect(fs.existsSync(path.join(s.data, "basalt.db-wal"))).toBe(true);
      s.child.stdin!.end();
      expect(await exitWithin(s.exited)).toBe(0);
      expect(fs.readFileSync(s.log, "utf8")).toContain("stdin closed: closing");
      expect(fs.existsSync(path.join(s.data, "basalt.db-wal"))).toBe(false);
    } finally {
      await stopped(s);
    }
  }, 60_000);

  it("stops on the line `stop`", async () => {
    const s = await start("stop", packaged("stop"), "pipe");
    try {
      expect(s.port).toBeGreaterThan(0);
      s.child.stdin!.write("hello\nst");
      s.child.stdin!.write("op\n");
      expect(await exitWithin(s.exited)).toBe(0);
      expect(fs.readFileSync(s.log, "utf8")).toContain("stop: closing");
    } finally {
      await stopped(s);
    }
  }, 60_000);
});

describe("the server from the checkout", () => {
  it("keeps running with a closed stdin, as under launchd", async () => {
    const s = await start("launchd", {}, "ignore");
    try {
      expect(s.port).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 500));
      expect(s.child.exitCode).toBeNull();
      expect((await fetch(`http://127.0.0.1:${s.port}/api/health`)).status).toBe(200);
    } finally {
      await stopped(s);
    }
  }, 60_000);
});
