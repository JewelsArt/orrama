/**
 * The settings variables are ORRAMA_* since the rename (R13), and only those are read. A
 * BASALT_* variable without its ORRAMA_* twin is a switch-over left half done: every entry
 * point refuses to start and says which variable to set, rather than running on defaults (a
 * default vault folder is the wrong vault, a default key cannot decrypt the credentials).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { renamedEnvProblems } from "../src/env.js";

const server = path.resolve(import.meta.dirname, "..");
const tsx = pathToFileURL(path.join(server, "node_modules/tsx/dist/loader.mjs")).href;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-renamed-env-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SECRET = "s3cret-value-that-must-never-be-printed-0123456789";

function run(script: string, env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BASALT|ORRAMA)_|^PORT$/.test(k)));
  const r = spawnSync(process.execPath, ["--import", tsx, path.join(server, script)], {
    cwd: tmp,
    env: { ...clean, PORT: "0", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("renamed settings variables", () => {
  it("names every BASALT_ variable whose ORRAMA_ twin is missing, and never its value", () => {
    const problems = renamedEnvProblems({ BASALT_VAULT_DIR: "/v", BASALT_SECRET_KEY: SECRET, BASALT_URL: "x", ORRAMA_URL: "x", HOME: "/h" });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^BASALT_SECRET_KEY is set but ORRAMA_SECRET_KEY is not/);
    expect(problems[1]).toMatch(/^BASALT_VAULT_DIR is set but ORRAMA_VAULT_DIR is not/);
    expect(problems.join(" ")).not.toContain(SECRET);
    // The twin set, even empty, is the switch done: the old name is simply not read.
    expect(renamedEnvProblems({ BASALT_DATA_DIR: "/d", ORRAMA_DATA_DIR: "" })).toEqual([]);
    expect(renamedEnvProblems({ ORRAMA_DATA_DIR: "/d" })).toEqual([]);
  });

  it("the server and every script refuse to start on a half-done switch", () => {
    const vault = path.join(tmp, "vault");
    fs.mkdirSync(vault, { recursive: true });
    for (const script of ["src/main.ts", "src/seed.ts", "src/export.ts", "src/rotate-secret-key.ts", "src/account.ts"]) {
      const r = run(script, { BASALT_VAULT_DIR: vault, BASALT_SECRET_KEY: SECRET, ORRAMA_DATA_DIR: path.join(tmp, "data") });
      expect(r.code, `${script}: ${r.out}`).not.toBe(0);
      expect(r.out, script).toMatch(/Orrama reads only ORRAMA_\* variables/);
      expect(r.out, script).toMatch(/BASALT_VAULT_DIR is set but ORRAMA_VAULT_DIR is not/);
      expect(r.out, script).toMatch(/BASALT_SECRET_KEY is set but ORRAMA_SECRET_KEY is not/);
      expect(r.out, script).not.toContain(SECRET);
    }
    // Nothing was written before the refusal.
    expect(fs.existsSync(path.join(tmp, "data"))).toBe(false);
    expect(fs.readdirSync(vault)).toEqual([]);
  });
});
