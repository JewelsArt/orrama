/**
 * Stamping an id or setting one property must change nothing else in the
 * file (audit root cause #3). Each case below lost or reshaped text the user
 * wrote before: a `---` block that is not a mapping was deleted (STO-002), a
 * CRLF note got `"active\r"` written into it (STO-005), long values were
 * folded, lists re-spaced and a BOM moved into the body (STO-007).
 */
import { describe, expect, it } from "vitest";
import { parseFrontmatter, parseNote, stampId, updateFrontmatter } from "../src/index.js";

const ID = "n-newid";
/** What a stamp may do: add exactly one line, right after the opening fence. */
const stampedAs = (before: string, eol = "\n") => {
  const nl = before.indexOf("\n") + 1;
  return before.slice(0, nl) + `id: ${ID}${eol}` + before.slice(nl);
};

describe("a leading --- block that is not a mapping is left alone (STO-002)", () => {
  const cases: Record<string, string> = {
    "prose between rules": "---\nMeeting notes from Monday\n---\nMore text below.\n",
    "heading and prose": "---\n# Agenda\nDiscuss the budget and the hire\n---\nBody\n",
    "a bare list": "---\n- first idea\n- second idea\n---\nBody\n",
    "only a comment": "---\n# keep: this comment\n---\nBody\n",
  };
  for (const [name, before] of Object.entries(cases)) {
    it(`${name}: flagged, never rewritten`, () => {
      expect(parseFrontmatter(before).notMapping).toBe(true);
      expect(updateFrontmatter(before, (d) => ({ id: ID, ...d }))).toBe(before);
      const s = stampId(before, ID);
      expect(s.ok).toBe(false);
    });
  }

  it("an empty block is not flagged, and takes an id", () => {
    expect(parseFrontmatter("---\n---\nBody\n").notMapping).toBe(false);
    expect(stampId("---\n---\nBody\n", ID)).toEqual({ ok: true, content: `---\nid: ${ID}\n---\nBody\n` });
  });
});

describe("CRLF notes (STO-005)", () => {
  it("parse without a stray \\r in the last value", () => {
    expect(parseFrontmatter("---\r\ntitle: Hello\r\nstatus: active\r\n---\r\nBody\r\n").data).toEqual({ title: "Hello", status: "active" });
    expect(parseFrontmatter("---\r\ntags:\r\n  - project/thesis\r\n---\r\nBody\r\n").data).toEqual({ tags: ["project/thesis"] });
  });

  it("parse a flow list on the last line instead of calling it malformed", () => {
    const r = parseFrontmatter("---\r\ntitle: Hello\r\ntags: [a, b]\r\n---\r\nLine one\r\n");
    expect(r.malformed).toBe(false);
    expect(r.data).toEqual({ title: "Hello", tags: ["a", "b"] });
    expect(parseNote("---\r\ntags: [only/finance, b]\r\n---\r\nx\r\n").onlyTeams).toEqual(["finance"]);
  });

  it("stay CRLF, byte for byte, when an id is stamped", () => {
    for (const before of [
      "---\r\ntitle: Hello\r\n---\r\nBody\r\n",
      "---\r\ntitle: Hello\r\nstatus: active\r\n---\r\nBody\r\n",
      "---\r\ntags:\r\n  - project/thesis\r\n---\r\nBody\r\n",
      "---\r\ntitle: Hello\r\ntags: [a, b]\r\n---\r\nLine one\r\nLine two\r\n",
    ]) {
      expect(stampId(before, ID)).toEqual({ ok: true, content: stampedAs(before, "\r\n") });
    }
  });

  it("get a CRLF block when they had none", () => {
    expect(stampId("# Title\r\nBody\r\n", ID)).toEqual({ ok: true, content: `---\r\nid: ${ID}\r\n---\r\n# Title\r\nBody\r\n` });
  });

  it("stay CRLF when one property is set", () => {
    const before = "---\r\ntitle: Hello\r\nstatus: active\r\n---\r\nBody\r\n";
    expect(updateFrontmatter(before, (d) => ({ ...d, status: "done" }))).toBe("---\r\ntitle: Hello\r\nstatus: done\r\n---\r\nBody\r\n");
  });
});

describe("untouched YAML is untouched (STO-007)", () => {
  const cases: Record<string, string> = {
    "long description": "---\ntitle: Long\ndescription: This is a very long single-line description that goes well past eighty characters in width for sure\n---\nBody\n",
    "flow seq + spacing": '---\ntags: [ a,b ]\naliases:   ["x"]\nempty:\nnull2: ~\n---\nBody\n',
    "block seq flush": "---\ntags:\n- a\n- b\n---\nBody\n",
    "comments and quotes": '---\n# why\ntitle: "Q3: Ops"   # quoted\n\nnested:\n  a: 1\n---\nBody',
  };
  for (const [name, before] of Object.entries(cases)) {
    it(`${name}: a stamp adds the id line and nothing else`, () => {
      expect(stampId(before, ID)).toEqual({ ok: true, content: stampedAs(before) });
    });
  }

  it("a BOM stays at byte 0, with or without front matter", () => {
    expect(stampId("\uFEFF# Title\nBody\n", ID)).toEqual({ ok: true, content: `\uFEFF---\nid: ${ID}\n---\n# Title\nBody\n` });
    expect(stampId("\uFEFF---\ntitle: X\n---\nBody\n", ID)).toEqual({ ok: true, content: `\uFEFF---\nid: ${ID}\ntitle: X\n---\nBody\n` });
  });

  it("setting status on a project note leaves every other line byte-identical", () => {
    const before =
      "---\nid: n-p\ntitle: Graduation thesis\ndescription: A very long description of the thesis project that is far longer than eighty characters, really\ntags: [ project/thesis,school ]\nstatus: active   # set from the board\nstart: 2026-09-01\n---\n# Thesis\n";
    const after = updateFrontmatter(before, (d) => ({ ...d, status: "sleeping" }));
    expect(after).toBe(before.replace("status: active   #", "status: sleeping   #"));
    const added = updateFrontmatter(before, (d) => ({ ...d, deadline: "2027-01-15" }));
    expect(added).toBe(before.replace("start: 2026-09-01\n", "start: 2026-09-01\ndeadline: 2027-01-15\n"));
  });

  it("replacing a carried id touches only its value", () => {
    const before = "---\ntitle: Copy\nid: n-orig   # stamped by Basalt\ntags:\n- a\n---\nBody\n";
    expect(stampId(before, ID)).toEqual({ ok: true, content: before.replace("n-orig", ID) });
  });
});

describe("ids that are not Basalt's (STO-003)", () => {
  it("a numeric id: is the user's field and is not overwritten", () => {
    const before = "---\nid: 202310021230\ntitle: Zettel\n---\n# Zettel\n";
    expect(stampId(before, ID).ok).toBe(false);
    expect(updateFrontmatter(before, (d) => ({ id: ID, ...d }))).toBe(before);
  });

  it("an empty id: is filled in place", () => {
    expect(stampId("---\ntitle: T\nid:\n---\nB\n", ID)).toEqual({ ok: true, content: `---\ntitle: T\nid: ${ID}\n---\nB\n` });
  });
});

describe("a stamp changes one line or nothing (seeded property, 3,000 notes)", () => {
  it("holds over random front matter with CRLF, BOMs, comments and junk", () => {
    let seed = 0xb10c;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const lines = [
      "title: Plain",
      'title: "Quoted: yes"',
      "tags: [a,b]",
      "tags:",
      "- flush",
      "  - indented",
      "# a comment",
      "",
      "description: " + "long ".repeat(30),
      "status: active # inline",
      "Q3 Review: Ops: broken",
      "just prose here",
      "id: n-had",
      "id: 12345",
      "nested:",
      "  k: v",
      "{ flow: map }",
      "dup: 1",
      "dup: 2",
      "    odd indent: x",
    ];
    let stamped = 0;
    for (let round = 0; round < 3000; round++) {
      const eol = rand(3) === 0 ? "\r\n" : "\n";
      const bom = rand(5) === 0 ? "\uFEFF" : "";
      const hasBlock = rand(6) !== 0;
      const block = Array.from({ length: rand(5) }, () => lines[rand(lines.length)]!);
      const body = ["# Heading", "text 🔴", "- [ ] task"].slice(0, rand(4)).join(eol) + (rand(2) ? eol : "");
      const before = bom + (hasBlock ? ["---", ...block, "---"].join(eol) + eol : "") + body;
      const s = stampId(before, ID);
      if (!s.ok) continue; // refused: the store indexes it unstamped (vault-bytes.test.ts)
      stamped++;
      const fm = parseFrontmatter(before);
      if (typeof fm.data["id"] === "string" || fm.data["id"] === null) {
        // Replaced or filled in place: one line differs.
        const a = s.content.split("\n");
        const b = before.split("\n");
        expect(a.length).toBe(b.length);
        expect(a.filter((l, i) => l !== b[i]).length).toBe(1);
      } else if (hasBlock && parseFrontmatter(before).bodyStart > 0) {
        expect(s.content, JSON.stringify(before)).toBe(stampedAs(before, eol === "\r\n" && before.slice(0, before.indexOf("\n")).endsWith("\r") ? "\r\n" : "\n"));
      } else {
        expect(s.content.endsWith(before.slice(bom.length))).toBe(true);
        expect(s.content.startsWith(bom + "---")).toBe(true);
      }
      expect(parseFrontmatter(s.content).data["id"]).toBe(ID);
    }
    // Both outcomes are exercised, not just the easy one.
    expect(stamped).toBeGreaterThan(1000);
    expect(stamped).toBeLessThan(2900);
  });
});
