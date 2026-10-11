/**
 * Windows (audit OPS-003). The backup is audited on Windows, where two product
 * bugs lived that macOS and Linux never show, and the suite failed on POSIX
 * assumptions. The windows.yml workflow runs the whole suite there by hand;
 * these pin the parts that can be checked from any platform.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isRootGuide } from "../src/vaultStore.js";

const root = path.resolve(import.meta.dirname, "../../..");

describe("on Windows", () => {
  // chokidar reports C:/…/vault/CLAUDE.md; path.join gives C:\…\vault\CLAUDE.md.
  // The string compare never matched, so the user's guide was indexed and had
  // an id stamped into it.
  it("the vault's CLAUDE.md is recognised however the watcher spells its path", () => {
    expect(isRootGuide("C:\\Users\\j\\vault", "C:/Users/j/vault/CLAUDE.md", path.win32)).toBe(true);
    expect(isRootGuide("C:\\Users\\j\\vault", "C:\\Users\\j\\vault\\CLAUDE.md", path.win32)).toBe(true);
    expect(isRootGuide("C:\\Users\\j\\vault", "C:/Users/j/vault/Notes/CLAUDE.md", path.win32)).toBe(false); // only the root's
    expect(isRootGuide("/v", "/v/./CLAUDE.md", path.posix)).toBe(true);
    expect(isRootGuide("/v", "/v/CLAUDE.md.bak", path.posix)).toBe(false);
    // …and the watcher asks it: no platform here spells paths the way chokidar
    // does on Windows, so the call site is pinned.
    const store = fs.readFileSync(path.join(root, "apps/server/src/vaultStore.ts"), "utf8");
    const ignored = store.split("chokidar.watch(this.root, {")[1]!.split("ignoreInitial")[0]!;
    expect(ignored).toMatch(/if \(isRootGuide\(this\.root, filePath\)\) return true;/);
    expect(ignored).not.toMatch(/filePath === /);
  });

  // pnpm runs scripts through cmd.exe there, which has no `VAR=1 cmd`.
  it("no package script sets an environment variable the POSIX-shell way", () => {
    const scripts = ["package.json", ...["apps", "packages"].flatMap((d) => fs.readdirSync(path.join(root, d)).map((p) => `${d}/${p}/package.json`))]
      .filter((f) => fs.existsSync(path.join(root, f)))
      .flatMap((f) => Object.entries((JSON.parse(fs.readFileSync(path.join(root, f), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}).map(([k, v]) => `${f} ${k}: ${v}`));
    expect(scripts.length).toBeGreaterThan(10);
    expect(scripts.filter((s) => /: (\w+=\S*\s+)+\S/.test(s))).toEqual([]);
  });

  // Git for Windows checks out CRLF by default; tests and the Dockerfile are read line by line.
  it("every checkout is LF", () => {
    expect(fs.readFileSync(path.join(root, ".gitattributes"), "utf8")).toMatch(/^\* text=auto eol=lf$/m);
  });
});
