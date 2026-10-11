/**
 * An `#only/<team>` restriction survives every ordinary way of writing it
 * (audit ACL-006), and front-matter tags are read the way Obsidian reads them
 * (COR-018). The restriction was read from the parsed tag list, so anything
 * that stopped a tag from parsing — one YAML error, `tags: a, b`, `tag:` —
 * dropped it, and the note fell back to its folder grant. A note whose
 * restriction cannot be read is restricted to owners, never opened.
 */
import { describe, expect, it } from "vitest";
import { canRead, OWNERS_ONLY, parseNote, type AclUser, type FolderGrant } from "../src/index.js";

const mara: AclUser = { id: "u-mara", username: "mara", isOwner: false, teams: ["marketing"] };
const eve: AclUser = { id: "u-eve", username: "eve", isOwner: false, teams: ["engineering"] };
const owner: AclUser = { id: "u-own", username: "own", isOwner: true, teams: [] };
const grants: FolderGrant[] = [
  { team: "marketing", folder: "", role: "viewer" },
  { team: "engineering", folder: "", role: "viewer" },
];
const reads = (u: AclUser, md: string) => {
  const p = parseNote(md, "x");
  return canRead(u, { folder: "Shared", onlyTeams: p.onlyTeams, shareTeams: p.shareTeams }, grants);
};

describe("#only/ fails closed (ACL-006)", () => {
  const ROWS: Record<string, string> = {
    "control: tags: [only/engineering]": "---\ntags: [only/engineering]\n---\nbody\n",
    "one unquoted colon in the title": "---\ntitle: Q3 Review: Ops\ntags: [only/engineering]\n---\nbody\n",
    "comma-separated string": "---\ntags: work, only/engineering\n---\nbody\n",
    "space-separated string": "---\ntags: work only/engineering\n---\nbody\n",
    "singular tag: key": "---\ntag: only/engineering\n---\nbody\n",
    "#-prefixed in the front matter": "---\ntags: [\"#only/engineering\"]\n---\nbody\n",
    "inline after a one-line ```code```": "```js```\n\n#only/engineering\nbody\n",
    "inline after an indented ```": "    ```\n#only/engineering\nbody\n",
  };
  for (const [name, md] of Object.entries(ROWS)) {
    it(`${name}: restricted to engineering`, () => {
      expect(parseNote(md, "x").onlyTeams).toEqual(["engineering"]);
      expect(reads(mara, md)).toBe(false);
      expect(reads(eve, md)).toBe(true);
    });
  }

  it("a malformed block naming several teams keeps all of them", () => {
    const md = "---\ntitle: A: B\ntags: [only/engineering, \"only/legal\", share/marketing]\n---\n";
    expect(parseNote(md).onlyTeams.sort()).toEqual(["engineering", "legal"]);
    // A share/ read off a block that does not parse is not applied: it would widen who reads.
    expect(parseNote(md).shareTeams).toEqual([]);
  });

  it("a malformed block that mentions only/ with no readable team is for owners only", () => {
    for (const md of ["---\ntitle: A: B\ntags: [only/]\n---\nbody\n", "---\ntitle: A: B\ntags: [\"only/  \"]\n---\n"]) {
      expect(parseNote(md).onlyTeams).toEqual([OWNERS_ONLY]);
      expect(reads(mara, md)).toBe(false);
      expect(reads(eve, md)).toBe(false);
      expect(reads(owner, md)).toBe(true);
    }
  });

  it("a well-formed only/ naming no team is for owners only too", () => {
    expect(parseNote("---\ntags: [only/]\n---\n").onlyTeams).toEqual([OWNERS_ONLY]);
    expect(parseNote("---\ntags: \"only/\"\n---\n").onlyTeams).toEqual([OWNERS_ONLY]);
  });

  it("a malformed block without only/ restricts nothing", () => {
    expect(parseNote("---\ntitle: A: B\n---\nbody\n").onlyTeams).toEqual([]);
    // Nor does a word that only contains it: a URL path.
    expect(parseNote("---\ntitle: A: B\nsource: https://x.example/only/this\n---\n").onlyTeams).toEqual([]);
  });
});

describe("front-matter tags as Obsidian reads them (COR-018)", () => {
  const tagsOf = (fm: string) => parseNote(`---\n${fm}\n---\nbody\n`).tags.map((t) => t.tag);

  it("a comma- or space-separated string is several tags", () => {
    expect(tagsOf("tags: project/thesis, active")).toEqual(["project/thesis", "active"]);
    expect(tagsOf("tags: project/thesis active")).toEqual(["project/thesis", "active"]);
    expect(tagsOf("tags: '#a, #b'")).toEqual(["a", "b"]);
  });

  it("the singular tag: key counts, alongside tags:", () => {
    expect(tagsOf("tag: contact")).toEqual(["contact"]);
    expect(tagsOf("tags: [a]\ntag: b")).toEqual(["a", "b"]);
  });

  it("a list stays a list", () => {
    expect(tagsOf("tags: [project/thesis, active]")).toEqual(["project/thesis", "active"]);
  });

  it("aliases: A, B is two aliases; alias: works too", () => {
    expect(parseNote("---\naliases: Thesis, Scriptie\n---\n").aliases).toEqual(["Thesis", "Scriptie"]);
    expect(parseNote("---\nalias: Scriptie\n---\n").aliases).toEqual(["Scriptie"]);
    expect(parseNote("---\naliases: [Thesis, \"Graduation, 2026\"]\n---\n").aliases).toEqual(["Thesis", "Graduation, 2026"]);
  });

  it("tags: handbook, only/engineering restricts the note to engineering", () => {
    expect(parseNote("---\ntags: handbook, only/engineering\n---\n").onlyTeams).toEqual(["engineering"]);
  });
});
