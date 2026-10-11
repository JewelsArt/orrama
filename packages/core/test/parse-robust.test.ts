/**
 * parseNote never throws on user text (audit COR-002). One stray `%` in a
 * markdown link target used to throw URIError out of decodeURIComponent, and
 * a note that throws is skipped at boot, left stale by the watcher and
 * refused on save.
 */
import { describe, expect, it } from "vitest";
import { parseNote, VaultIndex } from "../src/index.js";

describe("a stray % in a markdown link", () => {
  it("parses, and keeps the note's tasks", () => {
    for (const md of [
      "Progress ![chart](growth%.png)\n- [ ] pay rent\n",
      "[budget](<Budget 100% final.pdf>)\n- [ ] pay rent\n",
      "[deal](www.shop.com/50%off)\n- [ ] pay rent\n",
      "[x](<a 100% b.md>)\n- [ ] pay rent\n",
    ]) {
      expect(parseNote(md).tasks.map((t) => t.text)).toEqual(["pay rent"]);
    }
  });

  it("still links a .md target, decoded when it decodes and as written when it does not", () => {
    expect(parseNote("[x](<a 100% b.md>)").links.map((l) => l.target)).toEqual(["a 100% b"]);
    expect(parseNote("[x](a%20b.md)").links.map((l) => l.target)).toEqual(["a b"]);
  });

  it("does not stop the index from building", () => {
    const idx = new VaultIndex([
      { path: "Budget.md", content: "Savings ![chart](growth%.png)\n- [ ] pay rent\n" },
      { path: "Fine.md", content: "# Fine\n" },
    ]);
    expect(idx.all().map((n) => n.path).sort()).toEqual(["Budget.md", "Fine.md"]);
  });
});

describe("random punctuation", () => {
  // A small deterministic generator, so a failure names its seed.
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const ALPHABET = "%[]()<>#|\\^`~*_-+:!/.@ \t\r\n\"'{}xa1é—\u{1F600}\uD800".split("");
  const PIECES = ["[[", "]]", "](", ")", "- [ ] ", "> ", "1. ", "```", "~~~", "---\n", "#tag", "%", "%E0%A4%A", "\r\n", "tags: ", "only/"];

  it("never throws", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      let s = "";
      const n = Math.floor(r() * 80);
      for (let i = 0; i < n; i++) s += r() < 0.3 ? PIECES[Math.floor(r() * PIECES.length)] : ALPHABET[Math.floor(r() * ALPHABET.length)];
      try {
        parseNote(s);
      } catch (e) {
        throw new Error(`seed ${seed}: ${JSON.stringify(s)} threw ${(e as Error).message}`);
      }
    }
  });
});
