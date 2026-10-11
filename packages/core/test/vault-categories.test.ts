/** Life-area rules as vault data: `| Category | Matches |`, phrases or /regex/, first row wins. */
import { describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CATEGORY_RULES, REGEX_BUDGET, REGEX_HAY, categorizeNote, parseVaultCategoryRules, splitMatches } from "../src/index.js";

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
  it("reads phrases and regexes, keeps order, drops unknown areas and broken regexes", () => {
    expect(RULES.map((r) => [r.id, r.matches.map(String)])).toEqual([
      ["school", ["universit", "/\\blaw\\b/i", "amsib"]],
      ["work", ["scooperz", "law-firm"]],
      ["tools", ["/agents", "07-claude"]],
    ]);
  });

  it("the first matching row wins; nothing matching is Personal", () => {
    const c = (path: string, tags: string[] = []) => categorizeNote({ path, tags }, RULES);
    expect(c("04-Projects/thesis.md", ["amsib"])).toBe("school");
    expect(c("Notes/Company law.md")).toBe("school"); // the regex's word boundary
    expect(c("Notes/law-firm visit.md")).toBe("school"); // matches both rows: the first wins
    expect(c("Notes/Scooperz lawn party.md")).toBe("work"); // "lawn" is not the word "law"
    expect(c(".claude/agents/reviewer.md")).toBe("tools"); // a phrase starting with "/"
    expect(c("01-Me/profile.md")).toBe("personal");
  });

  it("defaults know only the PARA folders", () => {
    expect(categorizeNote({ path: "03-Knowledge/x.md", tags: [] }, DEFAULT_VAULT_CATEGORY_RULES)).toBe("knowledge");
    expect(categorizeNote({ path: "04-Projects/scooperz.md", tags: [] }, DEFAULT_VAULT_CATEGORY_RULES)).toBe("personal");
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
