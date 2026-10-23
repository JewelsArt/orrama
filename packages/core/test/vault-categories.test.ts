/** Life-area rules as vault data: `| Category | Matches |`, phrases or /regex/, first row wins. */
import { describe, expect, it } from "vitest";
import { REGEX_BUDGET, REGEX_HAY, STARTER_AREAS, areaOfNote, areaRules, areaSlug, categorizeNote, cleanLifeAreas, lifeAreasNote, lifeAreasOf, parseLifeAreas, parseVaultCategoryRules, splitMatches, writeLifeAreas } from "../src/index.js";

const RULES = parseVaultCategoryRules(`# Vault categories

| Category | Matches |
| --- | --- |
| School | universit, /\\blaw\\b/, amsib |
| Work | scooperz, law-firm |
| Claude & tools | /agents, 07-claude |
| Holidays | beach |
| Knowledge | /([/ |
`);

describe("vault category rules", () => {
  it("reads phrases and regexes, keeps order, drops broken regexes", () => {
    expect(RULES.map((r) => [r.id, r.matches.map(String)])).toEqual([
      ["school", ["universit", "/\\blaw\\b/i", "amsib"]],
      ["work", ["scooperz", "law-firm"]],
      ["claude-tools", ["/agents", "07-claude"]],
      ["holidays", ["beach"]],
    ]);
  });

  it("the first matching row wins; nothing matching is Personal", () => {
    const c = (path: string, tags: string[] = []) => categorizeNote({ path, tags }, RULES);
    expect(c("04-Projects/thesis.md", ["amsib"])).toBe("school");
    expect(c("Notes/Company law.md")).toBe("school"); // the regex's word boundary
    expect(c("Notes/law-firm visit.md")).toBe("school"); // matches both rows: the first wins
    expect(c("Notes/Scooperz lawn party.md")).toBe("work"); // "lawn" is not the word "law"
    expect(c(".claude/agents/reviewer.md")).toBe("claude-tools"); // a phrase starting with "/"
    expect(c("01-Me/profile.md")).toBe("personal");
  });
});

/** Jules's note as it was written before areas were a list: four rows, Personal implied (structure, not his words). */
const BEFORE = `---
tags:
  - vault-categories
---
# Vault categories

Which area each note falls in. The first row that matches wins; anything unmatched is Personal.

| Category | Matches |
| --- | --- |
| School | universit, resit, /\\blaw\\b/, school-resits, /\\bexam\\b/, amsib |
| Work | scooperz, career, dashboard, portfolio, contact |
| Knowledge | 03-knowledge, knowledge/ |
| Claude & tools | 07-claude, city map, skills, claude.md, /agents, claude sessions |
`;

describe("the areas are a list", () => {
  it("a note written before the list reads as the same five, Personal last and the catch-all", () => {
    const areas = parseLifeAreas(BEFORE)!;
    expect(areas.map((a) => [a.id, a.name, a.catchAll])).toEqual([
      ["school", "School", false],
      ["work", "Work", false],
      ["knowledge", "Knowledge", false],
      ["claude-tools", "Claude & tools", false],
      ["personal", "Personal", true],
    ]);
    expect(areas[0]!.words).toEqual(["universit", "resit", "/\\blaw\\b/", "school-resits", "/\\bexam\\b/", "amsib"]);
  });

  it("every note lands where the old rules put it", () => {
    const areas = lifeAreasOf(BEFORE);
    const rules = areaRules(areas);
    const cases: [string, string[], string][] = [
      ["02-Areas/School/Resit plan.md", [], "school"],
      ["Notes/Company law.md", [], "school"],
      ["04-Projects/scooperz-crm.md", ["project/scooperz-crm"], "work"],
      ["03-Knowledge/Typography.md", [], "knowledge"],
      ["07-Claude/skills/x.md", [], "claude-tools"],
      [".claude/agents/reviewer.md", [], "claude-tools"],
      ["01-Me/Journal/2026-10-01.md", ["journal"], "personal"],
      ["Contacts/Sam Rivera.md", ["contact"], "work"],
    ];
    for (const [path, tags, want] of cases) expect([path, areaOfNote({ path, tags }, areas, rules).id]).toEqual([path, want]);
  });

  it("a row says it is the catch-all; any name, any number of areas, ids are slugs", () => {
    const areas = parseLifeAreas("| Area | Matches |\n| --- | --- |\n| Family | |\n| Home | everything else |\n| Running | strava |\n| École | /cours/ |\n")!;
    expect(areas.map((a) => [a.id, a.catchAll, a.words])).toEqual([
      ["family", false, []],
      ["home", true, []],
      ["running", false, ["strava"]],
      ["ecole", false, ["/cours/"]],
    ]);
    expect(categorizeNote({ path: "Notes/run.md", tags: [] }, areaRules(areas), "home")).toBe("home");
    expect(categorizeNote({ path: "Notes/strava week.md", tags: [] }, areaRules(areas), "home")).toBe("running");
    expect(areaSlug("Claude & tools")).toBe("claude-tools");
    expect(areaSlug("!!!")).toBe("area");
  });

  it("without a note, a vault has Work and Personal", () => {
    expect(lifeAreasOf(null).map((a) => a.name)).toEqual(["Work", "Personal"]);
    expect(lifeAreasOf("# Just prose\n").map((a) => a.name)).toEqual(["Work", "Personal"]);
    expect(STARTER_AREAS.filter((a) => a.catchAll).map((a) => a.id)).toEqual(["personal"]);
  });
});

describe("a project's area", () => {
  const areas = lifeAreasOf(BEFORE);
  const project = (fm: Record<string, unknown>, path = "04-Projects/plan.md") => areaOfNote({ path, tags: ["project", "project/plan"], frontmatter: fm, project: true }, areas);

  it("area: is read before the words", () => {
    expect(project({ area: "Knowledge" }, "04-Projects/scooperz-pitch.md")).toEqual({ id: "knowledge", source: "named" });
    expect(project({ area: "claude & TOOLS" })).toEqual({ id: "claude-tools", source: "named" });
    // An area the list doesn't have is no area: the words, then the rest.
    expect(project({ area: "Mars" }, "04-Projects/scooperz-pitch.md")).toEqual({ id: "work", source: "words" });
  });

  it("an old domain: is read after the words, as the board read it", () => {
    expect(project({ domain: "academic" })).toEqual({ id: "school", source: "domain" });
    expect(project({ domain: "professional" })).toEqual({ id: "work", source: "domain" });
    expect(project({ domain: "personal" })).toEqual({ id: "personal", source: "domain" });
    expect(project({ domain: "academic" }, "04-Projects/scooperz-pitch.md")).toEqual({ id: "work", source: "words" });
    expect(project({ domain: "academic", area: "Knowledge" })).toEqual({ id: "knowledge", source: "named" });
    // A list without School: academic means nothing.
    expect(areaOfNote({ path: "a.md", tags: [], frontmatter: { domain: "academic" }, project: true }, lifeAreasOf(null))).toEqual({ id: "personal", source: "rest" });
  });

  it("only a project's own note reads area: and domain:", () => {
    expect(areaOfNote({ path: "Notes/a.md", tags: [], frontmatter: { area: "Knowledge", domain: "academic" } }, areas)).toEqual({ id: "personal", source: "rest" });
  });
});

describe("writing the list", () => {
  it("replaces the table in place and keeps every other byte", () => {
    const next = cleanLifeAreas([
      { name: "Work", words: ["scooperz", "career"] },
      { name: "Home", catchAll: true },
      { name: "Family" },
      { name: "School", words: ["universit", "/\\blaw\\b/"] },
    ]);
    if (!next.ok) throw new Error(next.reason);
    const out = writeLifeAreas(BEFORE, next.areas);
    if (!out.ok) throw new Error(out.reason);
    expect(out.content.slice(0, BEFORE.indexOf("| Category"))).toBe(BEFORE.slice(0, BEFORE.indexOf("| Category")));
    expect(out.content.slice(BEFORE.indexOf("| Category"))).toBe(
      "| Area | Matches |\n| --- | --- |\n| Work | scooperz, career |\n| Home | everything else |\n| Family | |\n| School | universit, /\\blaw\\b/ |\n",
    );
    // and reads back as what was written
    expect(parseLifeAreas(out.content)).toEqual(next.areas);
  });

  it("a new note reads back as its list", () => {
    const areas = STARTER_AREAS.map((a) => ({ ...a }));
    expect(parseLifeAreas(lifeAreasNote(areas))).toEqual(areas);
  });

  it("refuses a table with columns of its own, or two tables", () => {
    const areas = lifeAreasOf(null);
    expect(writeLifeAreas("| Area | Matches | Colour |\n| --- | --- | --- |\n| Work | x | red |\n", areas).ok).toBe(false);
    expect(writeLifeAreas("| Area | Matches |\n|---|---|\n| A | |\n\ntext\n\n| Area | Matches |\n|---|---|\n| B | |\n", areas).ok).toBe(false);
  });

  it("a note with no table gets one at its end", () => {
    const out = writeLifeAreas("---\ntags: [vault-categories]\n---\n# Areas\n", lifeAreasOf(null));
    expect(out.ok && out.content).toBe("---\ntags: [vault-categories]\n---\n# Areas\n\n| Area | Matches |\n| --- | --- |\n| Work | |\n| Personal | everything else |\n");
  });

  it("refuses a list it can't write", () => {
    const bad = (input: Parameters<typeof cleanLifeAreas>[0]) => {
      const r = cleanLifeAreas(input);
      return r.ok ? null : r.reason;
    };
    expect(bad([])).toBe("Keep at least one area.");
    expect(bad([{ name: "Work" }])).toBe("One area takes everything else.");
    expect(bad([{ name: "Home", catchAll: true }, { name: "home!" }])).toBe("There are two areas called home!.");
    expect(bad([{ name: " ", catchAll: true }])).toBe("Every area needs a name.");
    expect(bad([{ name: "Home", catchAll: true }, { name: "A", words: ["x".repeat(81)] }])).toMatch(/at most 80/);
    // A pipe or comma in a phrase can't split the row: it becomes a space.
    const ok = cleanLifeAreas([{ name: "Home", catchAll: true }, { name: "A|B", words: ["a, b", "c|d", "/x,y/"] }]);
    expect(ok.ok && ok.areas[1]).toEqual({ id: "a-b", name: "A B", words: ["a b", "c d", "/x,y/"], catchAll: false });
  });
});

describe("regex rules (COR-020, INP-003)", () => {
  const rulesOf = (matches: string) => parseVaultCategoryRules(`| Category | Matches |\n| --- | --- |\n| Work | ${matches} |\n`);

  it("a /…/g rule categorises every matching note the same way", () => {
    const rules = rulesOf("/scooperz/gi");
    const paths = ["04-Projects/scooperz/a.md", "04-Projects/scooperz/b.md", "04-Projects/scooperz/c.md", "04-Projects/scooperz/d.md"];
    expect(paths.map((path) => categorizeNote({ path, tags: [] }, rules))).toEqual(["work", "work", "work", "work"]);
  });

  it("a comma inside a regex does not split it", () => {
    expect(rulesOf("/ch(apter){1,2}/, amsib, /a{1,2}b/i").map((r) => r.matches.map(String))).toEqual([["/ch(apter){1,2}/i", "amsib", "/a{1,2}b/i"]]);
    expect(splitMatches("/a,b/, c , /[,/]x/g,d")).toEqual(["/a,b/", "c", "/[,/]x/g", "d"]);
    expect(splitMatches("/agents, 07-claude")).toEqual(["/agents", "07-claude"]);
  });

  it("a catastrophic-backtracking pattern runs in a small fixed time", () => {
    const rules = parseVaultCategoryRules("| Category | Matches |\n| --- | --- |\n| School | /^([^~]+)+~/, /(a|a)*b/ |\n");
    expect(rules[0]!.matches).toHaveLength(2);
    const t = performance.now();
    for (let i = 0; i < 200; i++) {
      categorizeNote({ path: `01-Me/Journal/2026-10-${i} a long realistic daily note name.md`, tags: ["journal", "a".repeat(400)] }, rules);
    }
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it("a regex reads a note's first REGEX_HAY characters; a phrase reads them all", () => {
    const tags = ["x".repeat(REGEX_HAY), "zzz"];
    expect(categorizeNote({ path: "a.md", tags }, rulesOf("/zzz/"))).toBe("personal");
    expect(categorizeNote({ path: "a.md", tags }, rulesOf("zzz"))).toBe("work");
    expect(categorizeNote({ path: "a.md", tags: ["zzz"] }, rulesOf("/zzz/"))).toBe("work");
  });

  it("regexes past the rule set's budget are dropped", () => {
    const big = "/(abcdefghij){40}/";
    const rules = rulesOf(Array.from({ length: 8 }, () => big).join(", ") + ", phrase");
    const kept = rules[0]!.matches.filter((m) => typeof m !== "string");
    expect(kept.length).toBeLessThan(8);
    expect(kept.reduce((s, m) => s + (m as { size: number }).size, 0)).toBeLessThanOrEqual(REGEX_BUDGET);
    expect(rules[0]!.matches).toContain("phrase");
  });
});
