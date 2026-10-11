/**
 * Every custom property the web app reads is defined somewhere.
 *
 * The token file was replaced under screens that still speak the old names (--text-faint,
 * --v-pink, --glass…), held up by aliases each wave deletes as its screens move over. An
 * undefined var() fails silently: the property falls back to its initial value and a border,
 * a colour or a whole background disappears. This lists every var(--x) without a fallback in
 * the stylesheets and components, and every name defined anywhere (the token, vision and font
 * files, any rule, or a "--name" a component sets inline), and fails on the difference.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname);
const UI = path.resolve(SRC, "../../../packages/ui/src");

function files(dir: string, ext: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "node_modules" ? [] : files(p, ext);
    return ext.test(d.name) && !/\.test\./.test(d.name) ? [p] : [];
  });
}

const css = [...files(SRC, /\.css$/), ...files(UI, /\.css$/)];
const code = files(SRC, /\.tsx?$/);
const text = (f: string) => fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const defined = new Set<string>();
for (const f of css) for (const m of text(f).matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]!);
// A component defines one as a style key ({ "--c": x }, { ["--c" as string]: x }), through
// setProperty("--c", …), or by assigning vars["--c"] = … (palette.ts).
const SETS = [/["'`](--[\w-]+)["'`](?:\s+as\s+\w+)?\s*\]?\s*:/g, /setProperty\(\s*["'`](--[\w-]+)/g, /\[\s*["'`](--[\w-]+)["'`]\s*\]\s*=[^=]/g];
for (const f of code) for (const re of SETS) for (const m of text(f).matchAll(re)) defined.add(m[1]!);

/** var(--name) with no fallback, or getPropertyValue("--name"): if the name is missing, the
 *  declaration is lost or the canvas draws in a fallback colour. */
const read = new Map<string, string>();
const READS = [/var\(\s*(--[\w-]+)\s*\)/g, /getPropertyValue\(\s*["'`](--[\w-]+)["'`]/g];
for (const f of [...css, ...code])
  for (const re of READS) for (const m of text(f).matchAll(re)) if (!read.has(m[1]!)) read.set(m[1]!, path.relative(SRC, f));

describe("design tokens", () => {
  it("defines every custom property a stylesheet or component reads", () => {
    const missing = [...read].filter(([name]) => !defined.has(name)).map(([name, where]) => `${name} (${where})`);
    expect(missing).toEqual([]);
  });
});
