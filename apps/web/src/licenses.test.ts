/**
 * The build ships third-party notices (audit OPS-011): every package a chunk
 * was built from, with its licence text, and the fonts' OFL.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import config from "../vite.config";
import { assetNotice, licenseNotices, NOTICES_FILE, noticesText, packageDir } from "../licenses";

const web = path.resolve(import.meta.dirname, "..");

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
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.fileName).toBe(NOTICES_FILE);
    const text = emitted[0]!.source;
    expect(text.match(/^react@\S+ — MIT$/gm)).toHaveLength(1); // once, however many of its modules
    // React's own LICENSE file, word for word.
    expect(text).toContain(fs.readFileSync(path.join(react, "LICENSE"), "utf8").trim());
    expect(text).toMatch(/Permission is hereby granted, free of charge/);
    expect(text).toMatch(/^ui\/src\/fonts — OFL-1\.1$/m);
    expect(text).toContain("SIL OPEN FONT LICENSE");
  });

  it("says so when a package ships no licence file", () => {
    expect(noticesText([{ name: "x", version: "1.0.0", license: "MIT", text: null }])).toContain("ships no licence file. Its licence: MIT");
    expect(assetNotice(path.join(web, "src/App.tsx"))).toBeNull();
  });

  it("is part of the build", () => {
    const names = (config as { plugins: unknown[] }).plugins.flat().map((p) => (p as { name?: string })?.name);
    expect(names).toContain("basalt-license-notices");
  });
});
