/**
 * The Tauri shell stays a window: a CSP matching the server's own (it was
 * `csp: null`), and no Rust commands — the two it had took the vault root
 * from the caller and could read or write any file on the Mac.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-desktop-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { app } = await buildServer();
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

const shell = path.resolve(import.meta.dirname, "../../desktop/src-tauri");
const directives = (csp: string) => new Map(csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0]!, d]));

describe("desktop shell", () => {
  it("has a CSP, and it is the server's policy", async () => {
    const conf = JSON.parse(fs.readFileSync(path.join(shell, "tauri.conf.json"), "utf8"));
    const desktop = conf.app.security.csp as string | null;
    expect(desktop).toBeTypeOf("string");
    const served = (await app.inject({ method: "GET", url: "/" })).headers["content-security-policy"] as string;
    const server = directives(served);
    const mine = directives(desktop!);
    for (const [name, value] of server) {
      if (name === "frame-ancestors") continue; // header-only; not valid where Tauri puts it
      if (name === "connect-src") continue; // the desktop names the server's origin explicitly
      expect(mine.get(name), name).toBe(value);
    }
    expect([...mine.keys()].filter((k) => !server.has(k))).toEqual([]);
  });

  it("registers no commands and loads no plugins", () => {
    const rust = fs.readdirSync(path.join(shell, "src")).map((f) => fs.readFileSync(path.join(shell, "src", f), "utf8")).join("\n");
    expect(rust).not.toMatch(/#\[tauri::command\]|invoke_handler|\.plugin\(/);
    const cargo = fs.readFileSync(path.join(shell, "Cargo.toml"), "utf8");
    expect(cargo).not.toMatch(/tauri-plugin-|^notify\s*=/m);
  });
});
