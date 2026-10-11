/**
 * One version, written down in one changelog (CHANGELOG.md, CLAUDE.md
 * "Releases"). The version lives in twelve places — nine package.json files,
 * the Tauri config, Cargo.toml (and its lock) and the MCP server's handshake — and a release
 * bumps all of them; this fails the moment one is missed, or the version has
 * no dated changelog entry.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const version = (JSON.parse(read("package.json")) as { version: string }).version;

describe("release", () => {
  it("every package, the desktop shell and the MCP server carry the root version", () => {
    const found: Record<string, string | undefined> = {};
    for (const dir of ["packages", "apps"]) {
      for (const name of fs.readdirSync(path.join(ROOT, dir))) {
        const rel = `${dir}/${name}/package.json`;
        if (fs.existsSync(path.join(ROOT, rel))) found[rel] = (JSON.parse(read(rel)) as { version?: string }).version;
      }
    }
    found["apps/desktop/src-tauri/tauri.conf.json"] = (JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")) as { version?: string }).version;
    found["apps/desktop/src-tauri/Cargo.toml"] = /^version\s*=\s*"([^"]+)"/m.exec(read("apps/desktop/src-tauri/Cargo.toml"))?.[1];
    // Cargo.lock follows Cargo.toml only on the next cargo build; desktop.yml
    // runs `cargo check --locked`, which fails when they disagree (OPS-010).
    found["apps/desktop/src-tauri/Cargo.lock"] = /name = "basalt-desktop"\nversion = "([^"]+)"/.exec(read("apps/desktop/src-tauri/Cargo.lock"))?.[1];
    found["apps/mcp/src/index.ts"] = /name: "basalt-mcp",\s*version: "([^"]+)"/.exec(read("apps/mcp/src/index.ts"))?.[1];
    expect(Object.keys(found).length).toBe(12);
    expect(Object.entries(found).filter(([, v]) => v !== version)).toEqual([]);
  });

  it("the changelog has a dated entry for this version, under an Unreleased section", () => {
    const log = read("CHANGELOG.md");
    expect(log).toMatch(/^## \[Unreleased\]$/m);
    expect(log).toMatch(new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\] — \\d{4}-\\d{2}-\\d{2}$`, "m"));
    expect(log).toContain(`[${version}]: https://`);
  });
});
