/**
 * The agent's log stays under a cap (logging.ts, audit B7). launchd appends to
 * ~/.basalt-run/server.log forever; by September it was 6.4 MB and climbing.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { rotateLogIfLarge } from "../src/logging.js";
import { POSIX_MODES } from "./helpers/platform.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-logrotate-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * Whether this platform can stat a handle opened for append, which is how the
 * server knows its stdout is the log file. Where it cannot, rotation is off
 * (rotateLogIfLarge answers false) and there is nothing to test.
 */
const STAT_APPEND = (() => {
  const fd = fs.openSync(path.join(tmp, "probe.log"), "a");
  try {
    fs.fstatSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
})();
const NO_STAT = "(skipped: this platform cannot stat an append-mode handle)";

describe("rotateLogIfLarge", () => {
  it.skipIf(!STAT_APPEND)(`past the cap: the contents move to .1 (owner-only) and the log starts again ${STAT_APPEND ? "" : NO_STAT}`, () => {
    const file = path.join(tmp, "a.log");
    const fd = fs.openSync(file, "a"); // how launchd opens StandardOutPath
    try {
      fs.writeSync(fd, "old line\n".repeat(20));
      expect(rotateLogIfLarge({ fd, file, maxBytes: 100 })).toBe(true);
      expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("old line\n".repeat(20));
      if (POSIX_MODES) expect(fs.statSync(`${file}.1`).mode & 0o777).toBe(0o600);
      fs.writeSync(fd, "new line\n");
      expect(fs.readFileSync(file, "utf8")).toBe("new line\n"); // appended at the new end, no hole
    } finally {
      fs.closeSync(fd);
    }
  });

  it("under the cap: nothing happens", () => {
    const file = path.join(tmp, "b.log");
    const fd = fs.openSync(file, "a");
    try {
      fs.writeSync(fd, "short\n");
      expect(rotateLogIfLarge({ fd, file, maxBytes: 100 })).toBe(false);
      expect(fs.existsSync(`${file}.1`)).toBe(false);
      expect(fs.readFileSync(file, "utf8")).toBe("short\n");
    } finally {
      fs.closeSync(fd);
    }
  });

  it("a file that merely has the name is not ours to truncate", () => {
    const ours = path.join(tmp, "ours.log");
    const named = path.join(tmp, "named.log");
    fs.writeFileSync(named, "someone else's\n".repeat(20));
    const fd = fs.openSync(ours, "a");
    try {
      fs.writeSync(fd, "ours\n".repeat(40));
      expect(rotateLogIfLarge({ fd, file: named, maxBytes: 100 })).toBe(false);
      expect(fs.readFileSync(named, "utf8")).toBe("someone else's\n".repeat(20));
      expect(fs.statSync(ours).size).toBe("ours\n".length * 40);
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe("the server under launchd", () => {
  it.skipIf(!STAT_APPEND)(`rotates an over-size log when it starts ${STAT_APPEND ? "" : NO_STAT}`, async () => {
    const home = path.join(tmp, "home");
    const log = path.join(home, ".basalt-run", "server.log");
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, `${"x".repeat(1023)}\n`.repeat(6 * 1024)); // 6 MB
    const fd = fs.openSync(log, "a");
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve(import.meta.dirname, "../src/main.ts")], {
      cwd: path.resolve(import.meta.dirname, ".."),
      // os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
      env: { ...process.env, HOME: home, USERPROFILE: home, ORRAMA_DATA_DIR: path.join(tmp, "data"), ORRAMA_VAULT_DIR: path.join(tmp, "vault"), PORT: "0", HOST: "127.0.0.1", ORRAMA_ALLOW_DEV_SECRETS: "1" },
      stdio: ["ignore", fd, fd],
    });
    fs.closeSync(fd);
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    try {
      for (let i = 0; i < 400 && !fs.readFileSync(log, "utf8").includes("Server listening"); i++) await new Promise((r) => setTimeout(r, 50));
      const now = fs.readFileSync(log, "utf8");
      expect(now).toContain("Server listening");
      expect(now).toContain("log rotated");
      expect(fs.statSync(log).size).toBeLessThan(64 * 1024);
      expect(fs.statSync(`${log}.1`).size).toBeGreaterThanOrEqual(6 * 1024 * 1024);
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  }, 40_000);
});
