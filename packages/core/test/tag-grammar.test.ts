/**
 * One tag grammar for inline `#tags` and front-matter `tags:`.
 *
 * Inline tags were ASCII-only — `#réunion` was filed as `r`, `#été` as no tag
 * at all — and front-matter tags had no grammar, so `tags: [my tag]` indexed a
 * tag with a space in it. Both now follow the same rule (parse.ts TAG_BODY);
 * the editor's chips use the same TAG_RE.
 */
import { describe, expect, it } from "vitest";
import { canRead, parseNote, TAG_RE, type AclUser, type FolderGrant } from "../src/index.js";

const inline = (body: string) => parseNote(`---\nid: n-1\n---\n${body}\n`).tags.map((t) => t.tag);
const front = (tags: string[]) =>
  parseNote(`---\nid: n-1\ntags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]\n---\nbody\n`).tags.map((t) => t.tag);

describe("inline #tags", () => {
  it("take letters of any script, whole", () => {
    expect(inline("#réunion #Été #straße/über #日本語 #ünïcödé-2")).toEqual(["réunion", "été", "straße/über", "日本語", "ünïcödé-2"]);
  });

  it("are one tag however the accent was typed", () => {
    const composed = "#café"; // é as one character
    const decomposed = "#café"; // e + combining acute, as macOS file names spell it
    expect(inline(`${composed} ${decomposed}`)).toEqual(["café", "café"]);
  });

  it("still keep colours, issue numbers and headings out", () => {
    expect(inline("color: #0a0a0a; see #123 and #2026")).toEqual([]);
    expect(parseNote("# Title\n").tags).toEqual([]);
  });

  it("still stop where they always did", () => {
    expect(inline("(#a/b) #end. #x/ mail#notatag #one#two")).toEqual(["a/b", "end", "x", "one"]);
    expect(inline("project/2026 #project/2026 #t_1-x")).toEqual(["project/2026", "t_1-x"]);
  });

  it("TAG_RE is what the editor draws chips with — same matches", () => {
    const line = "notes #réunion, #été and #0a0a0a";
    expect([...line.matchAll(TAG_RE)].map((m) => m[2])).toEqual(["réunion", "été"]);
  });
});

describe("front-matter tags", () => {
  it("follow the inline grammar: case-folded, # and spaces trimmed", () => {
    expect(front(["Project/Atlas", "#Hashed", " padded ", "réunion"])).toEqual(["project/atlas", "hashed", "padded", "réunion"]);
  });

  it("outside it, are dropped", () => {
    expect(front(["my tag", "a.b", "2026", "comma,sep", "ok"])).toEqual(["ok"]);
  });

  it("still never take a path escape", () => {
    expect(front(["project/../../etc", "a\\b"])).toEqual([]);
  });

  it("keep a malformed only/ tag, so the note stays restricted", () => {
    const n = parseNote(`---\nid: n-1\ntags: ["only/finance team"]\n---\nbody\n`);
    expect(n.tags.map((t) => t.tag)).toEqual(["only/finance team"]);
    expect(n.onlyTeams).toEqual(["finance team"]);
    const erin: AclUser = { id: "u-1", username: "erin", teams: ["engineering"], isOwner: false };
    const grants: FolderGrant[] = [{ team: "engineering", folder: "", role: "editor" }];
    expect(canRead(erin, { folder: "", onlyTeams: n.onlyTeams, shareTeams: n.shareTeams }, grants)).toBe(false);
  });
});
