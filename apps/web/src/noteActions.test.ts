/** The shared client's pure parts (1C): names, paths, and the sentence a rename shows. */
import { describe, expect, it } from "vitest";
import { folderOf, linkersSentence, nameOf, nameProblem, notePath } from "./noteActions.js";
import { parseRoute, routeHref } from "./ui/router.js";

describe("paths and names", () => {
  it("splits and joins a note's folder and name", () => {
    expect(folderOf("Ideas/Sub/Reading.md")).toBe("Ideas/Sub");
    expect(folderOf("Reading.md")).toBe("");
    expect(nameOf("Ideas/Reading.md")).toBe("Reading");
    expect(notePath("", "Reading")).toBe("Reading.md");
    expect(notePath("Ideas", "Reading")).toBe("Ideas/Reading.md");
  });

  it("a name with a slash or a leading dot is refused before it is sent", () => {
    expect(nameProblem("  ", "note")).toBe("Give the note a name.");
    expect(nameProblem("a/b", "note")).toMatch(/use Move/);
    expect(nameProblem(".hidden", "folder")).toMatch(/dot/);
    expect(nameProblem("Fine name", "folder")).toBeNull();
  });
});

describe("linkersSentence", () => {
  const n = (canEdit: boolean) => ({ id: "x", path: "x.md", title: "x", links: 1, canEdit });
  it("says how many notes' links follow, and how many links won't", () => {
    expect(linkersSentence(null)).toBeNull();
    expect(linkersSentence({ notes: [], other: 0 })).toBeNull();
    expect(linkersSentence({ notes: [n(true)], other: 0 })).toBe("1 note links here; its links will follow.");
    expect(linkersSentence({ notes: [n(true), n(true), n(false)], other: 1 })).toBe(
      "2 notes link here; their links will follow. 1 link won't follow: it's written another way or in a note you can't change.",
    );
  });
});

describe("the Trash view's address", () => {
  it("/notes/trash round-trips, and is not a note called trash", () => {
    expect(parseRoute("/notes/trash")).toEqual({ kind: "notes", trash: true });
    expect(routeHref({ kind: "notes", trash: true })).toBe("/notes/trash");
    expect(parseRoute("/notes/Ideas/trash")).toEqual({ kind: "notes", path: "Ideas/trash" });
  });
});
