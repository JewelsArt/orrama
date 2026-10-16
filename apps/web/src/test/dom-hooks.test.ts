/**
 * A DOM test file's own afterEach runs before dom-setup.ts's cleanup(): vitest runs after-hooks
 * last-registered first, and the setup file registers first. A hook that un-stubs fetch while
 * the page is still mounted lets an effect that lands in between reach happy-dom's real fetch
 * (macOS CI, run 38884589576: a NetworkError on /api/finance/month/2026-09 after a Money test).
 * So a hook that un-stubs globals unmounts the page first.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = path.resolve(import.meta.dirname, "..");
const domTests = (fs.readdirSync(src, { recursive: true }) as string[])
  .filter((f) => /\.dom\.test\.tsx?$/.test(f))
  .map((f) => f.split(path.sep).join("/"));

/** Each `afterEach(…)` in the text, whole. */
function afterEachHooks(text: string): string[] {
  const out: string[] = [];
  for (let at = text.indexOf("afterEach("); at >= 0; at = text.indexOf("afterEach(", at + 1)) {
    let depth = 0;
    let end = at + "afterEach".length;
    do {
      if (text[end] === "(") depth++;
      else if (text[end] === ")") depth--;
      end++;
    } while (depth > 0 && end < text.length);
    out.push(text.slice(at, end));
  }
  return out;
}

describe("DOM tests", () => {
  it("unmount the page before they un-stub its globals", () => {
    const late = domTests.filter((f) => {
      const text = fs.readFileSync(path.join(src, f), "utf8");
      if (!/\brender(Hook)?\(/.test(text)) return false; // mounts nothing
      return afterEachHooks(text).some((hook) => {
        const unstub = hook.indexOf("unstubAllGlobals");
        if (unstub < 0) return false;
        const cleanup = hook.indexOf("cleanup()");
        return cleanup < 0 || cleanup > unstub;
      });
    });
    expect(late).toEqual([]);
    // The scan reads what it should: the files that un-stub in afterEach.
    expect(domTests).toContain("Finance.dom.test.tsx");
    expect(afterEachHooks("afterEach(() => {\n  cleanup();\n  vi.unstubAllGlobals();\n});\nit()")).toEqual(["afterEach(() => {\n  cleanup();\n  vi.unstubAllGlobals();\n})"]);
  });
});
