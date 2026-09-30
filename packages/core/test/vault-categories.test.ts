/** Life-area rules as vault data: `| Category | Matches |`, phrases or /regex/, first row wins. */
import { describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CATEGORY_RULES, categorizeNote, parseVaultCategoryRules } from "../src/index.js";

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
