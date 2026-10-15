/**
 * main.ts starts the server only when it is the program being run. The old
 * guard was a substring match on "main.ts": a compiled dist/main.js started
 * and exited 0 without a word, and any path containing the string counted.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isEntry } from "../src/entry.js";
import { canSymlink } from "./helpers/platform.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-entry-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("isEntry", () => {
  const main = path.join(tmp, "main.ts");
  const built = path.join(tmp, "dist", "main.js");
  fs.mkdirSync(path.dirname(built));
  fs.writeFileSync(main, "");
  fs.writeFileSync(built, "");
  fs.writeFileSync(path.join(tmp, "domain.ts"), "");
  const links = canSymlink(tmp);
  if (links) fs.symlinkSync(main, path.join(tmp, "server"));

  it("is the file being run, whatever it is called", () => {
    expect(isEntry(pathToFileURL(main).href, main)).toBe(true);
    expect(isEntry(pathToFileURL(built).href, built)).toBe(true); // the compiled build
    if (links) expect(isEntry(pathToFileURL(main).href, path.join(tmp, "server"))).toBe(true); // via a symlink
    expect(isEntry(pathToFileURL(main).href, path.relative(process.cwd(), main))).toBe(true);
  });

  it("is not a file that merely has main.ts in its name, or an import", () => {
    expect(isEntry(pathToFileURL(main).href, path.join(tmp, "domain.ts"))).toBe(false);
    expect(isEntry(pathToFileURL(main).href, "/usr/lib/node_modules/vitest/vitest.mjs")).toBe(false);
    expect(isEntry(pathToFileURL(main).href, undefined)).toBe(false);
  });
});

describe("launching the server", () => {
  it.skipIf(!canSymlink(os.tmpdir()))("under a name that is not main.ts, it still listens instead of exiting (needs a symlink: skipped where they need admin)", async () => {
    // What a compiled build (dist/main.js) looks like to the old guard, without a build step.
    const link = path.join(tmp, "basalt-server.ts");
    fs.symlinkSync(path.resolve(import.meta.dirname, "../src/main.ts"), link);
    const data = fs.mkdtempSync(path.join(tmp, "data-"));
    const child = spawn(process.execPath, ["--import", "tsx", link], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, ORRAMA_DATA_DIR: data, ORRAMA_VAULT_DIR: path.join(data, "vault"), PORT: "0", HOST: "127.0.0.1", ORRAMA_ALLOW_DEV_SECRETS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const result = await new Promise<string>((resolve) => {
      const t = setTimeout(() => resolve("timeout"), 20_000);
      child.on("exit", (code) => (clearTimeout(t), resolve(`exited ${code}`)));
      const poll = setInterval(() => {
        if (/Server listening/.test(out)) {
          clearInterval(poll);
          clearTimeout(t);
          resolve("listening");
        }
      }, 50);
    });
    child.kill("SIGKILL");
    expect(result, out.slice(-500)).toBe("listening");
  }, 30_000);
});
