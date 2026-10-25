/**
 * The desktop app's window is built from Rust crates, and the app ships them: each must carry a
 * licence the AGPL can carry, by the same rule as the npm packages (`ALLOWED_LICENCES`).
 *
 * `apps/desktop/crate-licences.json` holds every crate in Cargo.lock with the licence its
 * Cargo.toml states, written by `node scripts/desktop-notices.mjs --licences` from `cargo
 * metadata`, so this runs without a Rust toolchain. Every release build refuses a list that no
 * longer matches Cargo.lock (the same script, writing the notices), and so does this test: a
 * crate added or bumped is checked here before it ships.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { crateLicenceProblem } from "../licenses";

const repo = path.resolve(import.meta.dirname, "../../..");
const licences = JSON.parse(fs.readFileSync(path.join(repo, "apps/desktop/crate-licences.json"), "utf8")) as Record<string, string>;

/** Every crate Cargo.lock takes from a registry or a repository, as name@version. */
function lockedCrates(lock: string): string[] {
  return lock
    .split(/^\[\[package\]\]$/m)
    .slice(1)
    .filter((block) => /^source = /m.test(block))
    .map((block) => `${/^name = "([^"]+)"/m.exec(block)![1]}@${/^version = "([^"]+)"/m.exec(block)![1]}`)
    .sort();
}

describe("the desktop app's Rust crates", () => {
  it("lists exactly the crates in Cargo.lock", () => {
    const lock = fs.readFileSync(path.join(repo, "apps/desktop/src-tauri/Cargo.lock"), "utf8");
    const locked = lockedCrates(lock);
    expect(locked.length).toBeGreaterThan(100);
    expect(Object.keys(licences).sort(), "run node scripts/desktop-notices.mjs --licences after changing Cargo.lock").toEqual(locked);
    // The window's own crates and the secret store's, by name.
    for (const name of ["tauri", "tauri-plugin-single-instance", "keyring-core", "windows-native-keyring-store", "apple-native-keyring-store"]) {
      expect(locked.some((k) => k.startsWith(`${name}@`)), name).toBe(true);
    }
  });

  it("every crate has a licence the AGPL can carry", () => {
    const problems = Object.entries(licences).map(([key, licence]) => {
      const at = key.lastIndexOf("@");
      return crateLicenceProblem(key.slice(0, at), key.slice(at + 1), licence);
    });
    expect(problems.filter(Boolean)).toEqual([]);
  });

  it("reads Cargo's spellings and refuses what the AGPL cannot carry, naming the crate", () => {
    for (const ok of ["MIT OR Apache-2.0", "MIT/Apache-2.0", "Apache-2.0 / MIT", "Unlicense/MIT", "Apache-2.0 WITH LLVM-exception", "(MIT OR Apache-2.0) AND Unicode-3.0", "BSD-3-Clause AND MIT", "MPL-2.0", "Zlib OR Apache-2.0 OR MIT"]) {
      expect(crateLicenceProblem("x", "1.0.0", ok), ok).toBeNull();
    }
    for (const bad of ["GPL-2.0-only", "GPL-2.0", "MIT AND GPL-2.0-only", "GPL-2.0-only WITH Classpath-exception-2.0", "SSPL-1.0", "UNKNOWN", "SEE FILE LICENSE"]) {
      expect(crateLicenceProblem("bad-crate", "0.1.0", bad), bad).toBe(`bad-crate@0.1.0: ${bad}`);
    }
  });

  it("reads Cargo.lock's packages, leaving out the crate itself", () => {
    const lock = '[[package]]\nname = "orrama-desktop"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.1"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n';
    expect(lockedCrates(lock)).toEqual(["serde@1.0.1"]);
  });
});
