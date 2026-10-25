/**
 * The desktop app's own notices (scripts/desktop-notices.mjs): the Node it ships and the Rust
 * crates its window is compiled from, each with the licence text it ships, or the SPDX text of its
 * licence when it ships none. What the app carries is checked on a real build by
 * scripts/install-check.mjs; this holds the rules.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
type Pkg = { id: string; name: string; version: string; license: string | null; license_file?: string | null; authors?: string[]; manifest_path: string; source: string | null };
type Meta = { packages: Pkg[]; resolve: { root: string; nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] } };
const notices = (await import(pathToFileURL(path.join(root, "scripts/desktop-notices.mjs")).href)) as {
  NOTICES_FILE: string;
  textsFor(expr: string): string[];
  shippedCrates(meta: Meta): Pkg[];
  crateLicences(meta: Meta): Record<string, string>;
  noticesText(o: { triple: string; node: { version: string; text: string }; crates: Pkg[] }): string;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-notices-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A crate on disk, with the licence files given. */
function crate(name: string, license: string | null, files: Record<string, string> = {}, extra: Partial<Pkg> = {}): Pkg {
  const dir = path.join(tmp, `${name}-1.0.0`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Cargo.toml"), `[package]\nname = "${name}"\n`);
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  return { id: name, name, version: "1.0.0", license, manifest_path: path.join(dir, "Cargo.toml"), source: "registry+https://github.com/rust-lang/crates.io-index", ...extra };
}

const APACHE = "Apache License\n   Version 2.0, January 2004\n\n(the terms)\n";

describe("the desktop notices", () => {
  it("lists the crates compiled into the window: normal dependencies, not build scripts' or tests'", () => {
    const me = { id: "me", name: "orrama-desktop", version: "0.1.0", license: "AGPL-3.0-or-later", manifest_path: "", source: null };
    const meta: Meta = {
      packages: [me, crate("tauri", "Apache-2.0 OR MIT"), crate("serde", "MIT OR Apache-2.0"), crate("tauri-build", "Apache-2.0 OR MIT"), crate("cc", "MIT OR Apache-2.0"), crate("tempfile", "MIT OR Apache-2.0")],
      resolve: {
        root: "me",
        nodes: [
          { id: "me", deps: [{ pkg: "tauri", dep_kinds: [{ kind: null }] }, { pkg: "tauri-build", dep_kinds: [{ kind: "build" }] }, { pkg: "tempfile", dep_kinds: [{ kind: "dev" }] }] },
          { id: "tauri", deps: [{ pkg: "serde", dep_kinds: [{ kind: null }] }, { pkg: "cc", dep_kinds: [{ kind: "build" }] }] },
          { id: "serde", deps: [] },
        ],
      },
    };
    expect(notices.shippedCrates(meta).map((p) => p.name).sort()).toEqual(["serde", "tauri"]);
    // The licence list holds every crate in the lock, whatever it is for, and never the app itself.
    expect(Object.keys(notices.crateLicences(meta))).toEqual(["cc@1.0.0", "serde@1.0.0", "tauri-build@1.0.0", "tauri@1.0.0", "tempfile@1.0.0"]);
  });

  it("prints each licence text once, under every crate that ships it, and the SPDX text for a crate that ships none", () => {
    const crates = [
      crate("alpha", "MIT OR Apache-2.0", { "LICENSE-APACHE": APACHE, "LICENSE-MIT": "MIT License\n\nCopyright (c) Alpha's authors\n" }),
      crate("beta", "Apache-2.0", { LICENSE: APACHE.replace("   Version", "\t\tVersion") }),
      crate("gamma", "BSD-3-Clause", {}, { authors: ["Gamma Author <g@example.com>"] }),
      crate("delta", "Zlib OR Apache-2.0 OR MIT", {}),
    ];
    const text = notices.noticesText({ triple: "x86_64-pc-windows-msvc", node: { version: "24.22.0", text: "Node.js is licensed for use as follows:\n(MIT)" }, crates });
    expect(text).toMatch(/^Orrama's desktop app includes/);
    expect(text).toContain("Built for x86_64-pc-windows-msvc.");
    expect(text).toContain("Node.js 24.22.0 — MIT");
    expect(text).toContain("Node.js is licensed for use as follows:");
    expect(text).toContain("Rust crates (4)");
    // The Apache text once, under both crates, whatever its indentation.
    expect(text.split("Version 2.0, January 2004")).toHaveLength(2);
    expect(text).toContain("alpha@1.0.0 — MIT OR Apache-2.0\nbeta@1.0.0 — Apache-2.0\n");
    expect(text).toContain("Copyright (c) Alpha's authors");
    // No file: the crate's authors, and the text of its licence (one choice of an OR) at the end.
    expect(text).toContain("gamma@1.0.0 — BSD-3-Clause\n  by Gamma Author <g@example.com>");
    expect(text).toMatch(/delta@1\.0\.0 — Zlib OR Apache-2\.0 OR MIT\n-+\n\n\(ships no licence file: MIT,/);
    const tail = text.slice(text.indexOf("Licence texts for the crates that ship none"));
    expect(tail).toContain(fs.readFileSync(path.join(root, "apps/desktop/licences/BSD-3-Clause.txt"), "utf8").trim());
    expect(tail).toContain(fs.readFileSync(path.join(root, "apps/desktop/licences/MIT.txt"), "utf8").trim());
    expect(tail).not.toContain("Apache License"); // only the texts a crate needed
  });

  it("picks one choice of an OR and every part of an AND, in Cargo's spellings too", () => {
    expect(notices.textsFor("MIT OR Apache-2.0")).toEqual(["MIT"]);
    expect(notices.textsFor("Apache-2.0/MIT")).toEqual(["MIT"]);
    expect(notices.textsFor("(MIT OR Apache-2.0) AND Unicode-3.0")).toEqual(["MIT", "Unicode-3.0"]);
    expect(notices.textsFor("Apache-2.0 WITH LLVM-exception")).toEqual(["Apache-2.0"]);
    expect(notices.textsFor("MPL-2.0")).toEqual(["MPL-2.0"]);
    // An AND inside an OR's choice.
    expect(notices.textsFor("(Zlib AND BSD-3-Clause) OR MIT")).toEqual(["MIT"]);
    expect(notices.textsFor("(Zlib AND BSD-3-Clause) OR Unlicense")).toEqual(["Zlib", "BSD-3-Clause"]);
    expect(notices.textsFor("(Zlib AND BSD-3-Clause) AND MIT")).toEqual(["Zlib", "BSD-3-Clause", "MIT"]);
  });

  it("is named in NOTICE, beside the web app's and the server's", () => {
    expect(notices.NOTICES_FILE).toBe("THIRD_PARTY_NOTICES_DESKTOP.txt");
    expect(fs.readFileSync(path.join(root, "NOTICE"), "utf8")).toContain(notices.NOTICES_FILE);
  });
});
