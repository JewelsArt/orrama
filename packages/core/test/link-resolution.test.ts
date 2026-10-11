/**
 * Links resolve the way Obsidian resolves them (audit COR-016).
 *
 * A markdown link written relative to its note — `[up](../Up.md)`,
 * `[child](sub/Child.md)`, Obsidian's "Relative path to file" format — was
 * looked up as if it were a vault path, and never matched. And keys were
 * lower-cased but not Unicode-normalised: `[[Résumé]]` typed (composed, NFC)
 * missed a file whose name macOS tools stored decomposed (NFD).
 */
import { describe, expect, it } from "vitest";
import { VaultIndex } from "../src/vault.js";

const NFD = "Résumé";
const NFC = "Résumé";

const index = new VaultIndex([
  { path: "Projects/Thesis/Plan.md", content: "---\nid: n-plan\n---\n[up](../Up.md) [child](sub/Child.md) [here](./Sibling.md) [abs](Projects/Up.md) [[" + NFC + "]] [[Up]] [[Sibling]]\n" },
  { path: "Projects/Up.md", content: "---\nid: n-up\n---\n# Up\n" },
  { path: "Projects/Thesis/sub/Child.md", content: "---\nid: n-child\n---\n# Child\n" },
  { path: "Projects/Thesis/Sibling.md", content: "---\nid: n-sibling\n---\n# Sibling\n" },
  { path: "Sibling.md", content: "---\nid: n-root-sibling\n---\n# Root sibling\n" },
  { path: `${NFD}.md`, content: "---\nid: n-resume\n---\n# CV\n" },
  { path: "Other/Note.md", content: "---\nid: n-other\n---\n[[" + NFD + "]] [wiki-style path](sub/Child.md)\n" },
]);
const plan = index.get("n-plan")!;
const target = (raw: string) => plan.links.find((l) => l.raw.includes(raw))!;

describe("markdown links relative to their note", () => {
  it("../ and sub/ resolve from the linking note's folder", () => {
    expect(index.resolveLinkOf(plan, target("../Up.md"))?.id).toBe("n-up");
    expect(index.resolveLinkOf(plan, target("sub/Child.md"))?.id).toBe("n-child");
  });

  it("./ means this folder, before a same-named note elsewhere", () => {
    expect(index.resolveLinkOf(plan, target("./Sibling.md"))?.id).toBe("n-sibling");
  });

  it("a vault-absolute path still resolves", () => {
    expect(index.resolveLinkOf(plan, target("Projects/Up.md"))?.id).toBe("n-up");
  });

  it("a relative path that names nothing there falls back to the vault-wide lookup", () => {
    const other = index.get("n-other")!;
    expect(index.resolveLinkOf(other, other.links.find((l) => l.raw.includes("sub/Child"))!)).toBeUndefined();
  });

  it("a wiki link is never relative: it resolves as any link does", () => {
    const wiki = plan.links.find((l) => l.raw === "[[Sibling]]")!;
    expect(index.resolveLinkOf(plan, wiki)?.id).toBe(index.resolveLink("Sibling")?.id);
    expect(index.resolveLinkOf(plan, wiki)?.id).toBe("n-root-sibling");
  });

  it("backlinks count them", () => {
    expect(index.backlinks("n-up").map((b) => b.fromId)).toContain("n-plan");
    expect(index.backlinks("n-child").map((b) => b.fromId)).toEqual(["n-plan"]);
  });
});

describe("Unicode normalisation", () => {
  it("[[Résumé]] typed composed finds the decomposed file, and the other way round", () => {
    expect(index.resolveLink(NFC)?.id).toBe("n-resume");
    expect(index.resolveLink(NFD)?.id).toBe("n-resume");
    expect(index.resolveLink(`${NFC}.md`)?.id).toBe("n-resume");
    expect(index.backlinks("n-resume").map((b) => b.fromId).sort()).toEqual(["n-other", "n-plan"]);
  });
});
