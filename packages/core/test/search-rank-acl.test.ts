/**
 * Search ranks with the reader's own corpus (audit ACL-008). The idf half of
 * the score counted every note in the vault, so a reader with two probe
 * notes of their own could watch their order flip as unreadable notes
 * mentioning a word were added — a count of private notes, by query.
 */
import { describe, expect, it } from "vitest";
import { VaultIndex, type AclUser, type FolderGrant } from "../src/index.js";

const erin: AclUser = { id: "u-erin", username: "erin", isOwner: false, teams: ["engineering"] };
const owner: AclUser = { id: "u-jules", username: "jules", isOwner: true, teams: [] };
const grants: FolderGrant[] = [{ team: "engineering", folder: "Engineering", role: "editor" }];

const vault = (secret: number) =>
  new VaultIndex([
    { path: "Engineering/a.md", content: "---\nid: n-a\n---\nlayoffs layoffs layoffs picnic\n" },
    { path: "Engineering/b.md", content: "---\nid: n-b\n---\npicnic picnic picnic layoffs\n" },
    ...Array.from({ length: secret }, (_, i) => ({ path: `Marketing/s${i}.md`, content: `---\nid: n-s${i}\n---\nlayoffs planned for march\n` })),
    ...Array.from({ length: 6 }, (_, i) => ({ path: `Marketing/f${i}.md`, content: `---\nid: n-f${i}\n---\nfiller text about other things\n` })),
  ]);
const order = (v: VaultIndex, who: AclUser) => v.search("layoffs picnic", who, grants).map((n) => n.path);

describe("search ranking", () => {
  it("orders a reader's notes the same however many unreadable notes share the terms", () => {
    const none = order(vault(0), erin);
    expect(none).toEqual(["Engineering/a.md", "Engineering/b.md"]);
    for (const secret of [1, 5, 20]) expect(order(vault(secret), erin)).toEqual(none);
  });

  it("orders a reader's notes the same however large the part they cannot read", () => {
    // The note count is the reader's too: with "picnic" common and "layoffs"
    // rare among erin's notes, a thousand unreadable notes saying neither
    // moved the balance between the two words and flipped the order.
    const v = (hidden: number) =>
      new VaultIndex([
        { path: "Engineering/a.md", content: "---\nid: n-a\n---\nlayoffs picnic picnic picnic picnic picnic picnic\n" },
        { path: "Engineering/b.md", content: "---\nid: n-b\n---\nlayoffs layoffs picnic aa bb cc dd\n" },
        ...Array.from({ length: 8 }, (_, i) => ({ path: `Engineering/c${i}.md`, content: `---\nid: n-c${i}\n---\npicnic notes ${i}\n` })),
        ...Array.from({ length: hidden }, (_, i) => ({ path: `Marketing/h${i}.md`, content: `---\nid: n-h${i}\n---\nunrelated ${i}\n` })),
      ]);
    expect(order(v(1000), erin)).toEqual(order(v(0), erin));
  });

  it("still ranks by the whole vault for a reader who can read all of it", () => {
    // With five notes saying "layoffs", "picnic" is the rarer word, so the note heavy on it leads.
    expect(order(vault(5), owner).slice(0, 2)).toEqual(["Engineering/b.md", "Engineering/a.md"]);
  });
});
