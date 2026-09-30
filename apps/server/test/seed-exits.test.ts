/**
 * `pnpm seed` must finish. seed.ts boots a VaultStore to stamp the notes' ids,
 * and load() starts a vault watcher; without close() the process never exited,
 * and every test that imports seed in-process carried a second, stale store
 * that logged the server's writes against its own seed-time doc.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-seed-exit-"));
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

it("pnpm seed exits on its own", async () => {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, ["--import", "tsx", "src/seed.ts"], {
    cwd,
    env: { ...process.env, BASALT_DATA_DIR: dataDir, BASALT_VAULT_DIR: path.join(dataDir, "vault") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  const exited = await new Promise<number | "hung">((resolve) => {
    const timer = setTimeout(() => resolve("hung"), 15_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
  if (exited === "hung") child.kill("SIGKILL");
  expect(out).toContain("seeded:");
  expect(exited).toBe(0);
}, 25_000);
