/**
 * The app's own executable is named the way Tauri names it (scripts/bundle-common.mjs,
 * `mainBinaryName`): the installed Windows app is `orrama-desktop.exe`, not `Orrama.exe`, and
 * scripts/install-check.mjs waited 60 s for a file that never comes (release run 41647589904).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const { mainBinaryName } = (await import(pathToFileURL(path.join(root, "scripts/bundle-common.mjs")).href)) as { mainBinaryName(dir?: string): string };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-main-binary-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A src-tauri folder with these files. */
function shell(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(tmp, "shell-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
const CARGO = '[package]\nauthors = ["Someone"]\nname = "x-desktop"\nversion = "0.1.0"\n\n[lib]\nname = "x_desktop_lib"\n\n[dependencies]\nname = "not-this"\n';

describe("the app's own executable", () => {
  it("is the crate's package name when the config names none, never the product name", () => {
    expect(mainBinaryName(shell({ "Cargo.toml": CARGO, "tauri.conf.json": JSON.stringify({ productName: "X" }) }))).toBe("x-desktop");
  });

  it("is mainBinaryName when a config sets it, the bundle config first", () => {
    expect(mainBinaryName(shell({ "Cargo.toml": CARGO, "tauri.conf.json": JSON.stringify({ productName: "X", mainBinaryName: "X" }) }))).toBe("X");
    const both = shell({ "Cargo.toml": CARGO, "tauri.conf.json": JSON.stringify({ mainBinaryName: "X" }), "tauri.bundle.conf.json": JSON.stringify({ mainBinaryName: "Y" }) });
    expect(mainBinaryName(both)).toBe("Y");
  });

  it("is orrama-desktop for this app, as the built .app holds it", () => {
    expect(mainBinaryName()).toBe("orrama-desktop");
  });
});
