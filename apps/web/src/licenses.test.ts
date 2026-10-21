/**
 * The build ships third-party notices (audit OPS-011): every package a chunk
 * was built from, with its licence text, and the fonts' OFL; and every
 * production dependency of the server and the MCP server. Orrama is under the
 * AGPL v3 or later, so every one of those dependencies must carry a licence the
 * AGPL can carry, and every package and the LICENSE file say so.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import config from "../vite.config";
import {
  ALLOWED_BY_NAME,
  assetNotice,
  licenceProblem,
  licenseNotices,
  noticeOf,
  NOTICES_FILE,
  noticesText,
  packageDir,
  productionPackages,
  SERVER_NOTICES_FILE,
  SHIPPED_RUNTIMES,
} from "../licenses";

const web = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(web, "../..");
const workspaces = ["apps", "packages"].flatMap((d) =>
  fs.readdirSync(path.join(repo, d)).map((n) => path.join(repo, d, n)).filter((p) => fs.existsSync(path.join(p, "package.json"))),
);

describe("third-party notices", () => {
  it("finds the package a module came from, pnpm's nested store included", () => {
    expect(packageDir("/r/node_modules/.pnpm/react@19.0.0/node_modules/react/cjs/react.js")).toBe(path.join("/r/node_modules/.pnpm/react@19.0.0/node_modules", "react"));
    expect(packageDir("/r/node_modules/.pnpm/@codemirror+view@6/node_modules/@codemirror/view/dist/index.js?commonjs")).toBe(
      path.join("/r/node_modules/.pnpm/@codemirror+view@6/node_modules", "@codemirror", "view"),
    );
    expect(packageDir("/r/apps/web/src/App.tsx")).toBeNull();
    expect(packageDir("\0vite/preload-helper.js")).toBeNull();
  });

  it("emits one notice per bundled package with its licence text, and the fonts' OFL", () => {
    const react = path.dirname(fs.realpathSync(path.join(web, "node_modules/react/package.json")));
    const emitted: { fileName: string; source: string }[] = [];
    const plugin = licenseNotices() as unknown as {
      configResolved(c: { root: string }): void;
      generateBundle(this: { emitFile(f: { fileName: string; source: string }): void }, o: unknown, b: unknown): void;
    };
    plugin.configResolved({ root: web });
    plugin.generateBundle.call({ emitFile: (f) => emitted.push(f) }, {}, {
      "a.js": { type: "chunk", moduleIds: [path.join(react, "index.js"), path.join(react, "cjs/react.production.js"), path.join(web, "src/App.tsx")] },
      "f.woff2": { type: "asset", originalFileNames: ["../../packages/ui/src/fonts/figtree-latin-wght-normal.woff2"] },
      "i.woff2": { type: "asset", originalFileNames: ["../../packages/ui/src/fonts/inter-latin-wght-normal.woff2"] },
    });
    expect(emitted.map((f) => f.fileName)).toEqual([NOTICES_FILE, SERVER_NOTICES_FILE]);
    const text = emitted[0]!.source;
    expect(text.match(/^react@\S+ — MIT$/gm)).toHaveLength(1); // once, however many of its modules
    // React's own LICENSE file, word for word.
    expect(text).toContain(fs.readFileSync(path.join(react, "LICENSE"), "utf8").trim());
    expect(text).toMatch(/Permission is hereby granted, free of charge/);
    expect(text).toMatch(/^ui\/src\/fonts — OFL-1\.1$/m);
    expect(text).toContain("SIL OPEN FONT LICENSE");
    // Both faces' copyright lines: Figtree, and Inter for Clay (19 Oct 2026).
    expect(text).toContain("The Figtree Project Authors");
    expect(text).toContain("The Inter Project Authors");
  });

  it("lists the server's and the MCP server's production dependencies, with their licence text", () => {
    const emitted: { fileName: string; source: string }[] = [];
    const plugin = licenseNotices() as unknown as {
      configResolved(c: { root: string }): void;
      generateBundle(this: { emitFile(f: { fileName: string; source: string }): void }, o: unknown, b: unknown): void;
    };
    plugin.configResolved({ root: web });
    plugin.generateBundle.call({ emitFile: (f) => emitted.push(f) }, {}, {});
    const text = emitted.find((f) => f.fileName === SERVER_NOTICES_FILE)!.source;
    expect(text).toMatch(/^Orrama's server and MCP server includes/);
    // A direct dependency of each, and one only reached through another.
    expect(text).toMatch(/^fastify@\S+ — MIT$/m);
    expect(text).toMatch(/^@modelcontextprotocol\/sdk@\S+ — MIT$/m);
    expect(text).toMatch(/^better-sqlite3@\S+ — MIT$/m);
    expect(text).toMatch(/^bindings@\S+ — MIT$/m);
    const nodemailer = path.dirname(fs.realpathSync(path.join(repo, "apps/server/node_modules/nodemailer/package.json")));
    expect(text).toContain(fs.readFileSync(path.join(nodemailer, "LICENSE"), "utf8").trim());
    // Our own packages are walked through, never listed.
    expect(text).not.toMatch(/^@orrama\//m);
  });

  it("walks dependencies of dependencies, and never lists our own packages", () => {
    const found = productionPackages(SHIPPED_RUNTIMES.map((p) => path.resolve(web, p)));
    const names = [...found.keys()].map((k) => k.slice(0, k.lastIndexOf("@")));
    expect(names).toContain("yaml"); // through @orrama/core
    expect(names).toContain("yjs"); // through @orrama/sync
    expect(names).toContain("unzipper"); // exceljs → unzipper
    // unzipper 0.10's binary → buffers@0.1.1 states no licence; the override in
    // pnpm-workspace.yaml keeps it out.
    expect(names).not.toContain("buffers");
    expect(names.some((n) => n.startsWith("@orrama/"))).toBe(false);
    expect(names).not.toContain("vitest"); // a dev dependency
  });

  it("every production dependency of what Orrama ships has an allowed licence", () => {
    const problems = [...productionPackages(workspaces).values()].map(noticeOf).map(licenceProblem).filter(Boolean);
    expect(problems).toEqual([]);
  });

  it("refuses a licence the AGPL cannot carry, or none, naming the package", () => {
    const at = (license: string, name = "x") => licenceProblem({ name, version: "1.0.0", license, text: null });
    for (const bad of ["GPL-2.0-only", "SSPL-1.0", "EPL-1.0", "CDDL-1.0", "BUSL-1.1", "CC-BY-NC-4.0", "UNLICENSED", "UNKNOWN", "MIT AND GPL-2.0-only", "BSD"]) {
      expect(at(bad, "bad-thing")).toBe(`bad-thing@1.0.0: ${bad}`);
    }
    for (const ok of ["MIT", "LGPL-3.0-or-later", "LGPL-2.1", "MPL-2.0", "GPL-3.0-only", "AGPL-3.0-or-later", "(MIT OR GPL-2.0-only)", "(MIT AND Zlib)", "MIT/X11", "(AFL-2.1 OR BSD-3-Clause)"]) {
      expect(at(ok)).toBeNull();
    }
    // Allowed by name only at the version that was checked.
    expect(Object.keys(ALLOWED_BY_NAME)).toEqual(["duck@0.1.12"]);
    expect(licenceProblem({ name: "duck", version: "0.1.12", license: "BSD", text: null })).toBeNull();
    expect(licenceProblem({ name: "duck", version: "0.2.0", license: "BSD", text: null })).toBe("duck@0.2.0: BSD");
    // A package with no licence at all is flagged, as buffers@0.1.1 would be.
    expect(licenceProblem({ name: "buffers", version: "0.1.1", license: "UNKNOWN", text: null })).toBe("buffers@0.1.1: UNKNOWN");
  });

  it("every package, the desktop crate and LICENSE say AGPL-3.0-or-later", () => {
    for (const p of [repo, ...workspaces]) {
      const pkg = JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8")) as { name: string; license?: string; private?: boolean };
      expect({ name: pkg.name, license: pkg.license, private: pkg.private }).toEqual({ name: pkg.name, license: "AGPL-3.0-or-later", private: true });
    }
    // The text as gnu.org publishes it (https://www.gnu.org/licenses/agpl-3.0.txt), unedited.
    const licence = fs.readFileSync(path.join(repo, "LICENSE"));
    expect(crypto.createHash("sha256").update(licence).digest("hex")).toBe("0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0");
    const notice = fs.readFileSync(path.join(repo, "NOTICE"), "utf8");
    expect(notice).toContain("Copyright © 2026 Jules Timothy Sekelj");
    expect(notice).toContain("terms of the GNU Affero General Public License as published by the Free\nSoftware Foundation, either version 3 of the License, or (at your option) any\nlater version.");
    expect(notice).toContain(NOTICES_FILE);
    expect(notice).toContain(SERVER_NOTICES_FILE);
    expect(fs.existsSync(path.join(repo, "docs/licence"))).toBe(false);
    expect(fs.readFileSync(path.join(repo, "apps/desktop/src-tauri/Cargo.toml"), "utf8")).toMatch(/^license = "AGPL-3\.0-or-later"$/m);
  });

  it("says so when a package ships no licence file", () => {
    expect(noticesText([{ name: "x", version: "1.0.0", license: "MIT", text: null }])).toContain("ships no licence file. Its licence: MIT");
    expect(assetNotice(path.join(web, "src/App.tsx"))).toBeNull();
  });

  it("is part of the build", () => {
    const names = (config as { plugins: unknown[] }).plugins.flat().map((p) => (p as { name?: string })?.name);
    expect(names).toContain("orrama-license-notices");
  });
});
