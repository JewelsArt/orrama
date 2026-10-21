import { describe, expect, it } from "vitest";
import { artifactLinks, isPage, pagesOf, pageTitle } from "./projectPages.js";

const file = (name: string) => ({ name, size: 1, mtimeMs: 0, ext: name.slice(name.lastIndexOf(".")) });

describe("the Reader tab's pages", () => {
  it("are the .html and .htm documents, in name order", () => {
    expect(isPage("Map.HTML")).toBe(true);
    expect(isPage("notes.htm")).toBe(true);
    expect(isPage("brief.pdf")).toBe(false);
    expect(isPage("page.html.zip")).toBe(false);
    expect(pagesOf([file("b.html"), file("brief.pdf"), file("A map.htm"), file("page 10.html"), file("page 9.html")]).map((f) => f.name)).toEqual([
      "A map.htm",
      "b.html",
      "page 9.html",
      "page 10.html",
    ]);
    expect(pageTitle("Orrama redesign.html")).toBe("Orrama redesign");
  });

  it("find their claude.ai artifact in the note's Documents lines", () => {
    const note = [
      "## Documents",
      "",
      "- **Orrama redesign.html**: copy of the claude.ai artifact https://claude.ai/artifact/SvVGCLT51cBfvSwFLSe9y6, copied 21 Oct 2026. The canvas.",
      "- **how it works.html**: the explainer, shared with Finance. Copy of https://claude.ai/code/artifact/0b5c-91ef.",
      "- **router code.zip**: https://claude.ai/artifact/NotAPage1",
      "- **brief.html**: no link on this line.",
      "See https://claude.ai/artifact/Elsewhere for **later.html** too.",
    ].join("\n");
    const links = artifactLinks(note);
    expect(links.get("Orrama redesign.html")).toBe("https://claude.ai/artifact/SvVGCLT51cBfvSwFLSe9y6");
    expect(links.get("how it works.html")).toBe("https://claude.ai/code/artifact/0b5c-91ef");
    expect(links.get("later.html")).toBe("https://claude.ai/artifact/Elsewhere");
    expect(links.has("router code.zip")).toBe(false);
    expect(links.has("brief.html")).toBe(false);
  });

  it("keep the first link a file is given", () => {
    const links = artifactLinks("- **a.html**: https://claude.ai/artifact/First\n- **a.html**: https://claude.ai/artifact/Second\n");
    expect(links.get("a.html")).toBe("https://claude.ai/artifact/First");
  });
});
