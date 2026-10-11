/**
 * One hand (§8 #12): the six glyph icons (› ✕ × ‹ ↵ ✎) became line icons, and the native
 * prompt, alert and confirm became the Dialog. Finance keeps its glyphs until R10 redraws it.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(path.join(dir, d.name)) : /\.tsx?$/.test(d.name) && !/\.test\./.test(d.name) ? [path.join(dir, d.name)] : [],
  );
/** Lines of code, without comments. */
const code = (f: string) =>
  fs
    .readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ""))
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ""));
const scan = (re: RegExp, skip: (f: string) => boolean = () => false) =>
  files(SRC)
    .filter((f) => !skip(f))
    .flatMap((f) => code(f).flatMap((line, i) => (re.test(line) ? [`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`] : [])));

describe("one hand", () => {
  it("no glyph stands in for an icon: the six are line icons now", () => {
    const glyph = "[›✕×‹↵✎]";
    // a glyph alone on a JSX line, alone in an element, or leading a label; or a keycap on screen
    const re = new RegExp(`^\\s*${glyph}\\s*$|>\\s*${glyph}\\s*<|^\\s*[‹›]\\s+\\w|<kbd>`);
    expect(scan(re, (f) => path.basename(f) === "Finance.tsx")).toEqual([]);
  });

  it("no native prompt, alert or confirm: the Dialog asks", () => {
    expect(scan(/(^|[^.\w])(window\.)?(prompt|alert|confirm)\(/)).toEqual([]);
  });
});
