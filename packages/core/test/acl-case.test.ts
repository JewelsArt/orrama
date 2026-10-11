/**
 * §5.3 is permissioned by PATH, not by a grant row — so the string that decides
 * it has to mean the same thing the filesystem means.
 *
 * personalOwner matched "Personal/" exactly, and resolvePath preserves the
 * caller's case. On APFS and NTFS, "personal/mara/Inbox.md" and
 * "Personal/mara/Inbox.md" are the SAME physical file, so the lower-case form
 * addressed another user's note while skipping the personal-vault rule entirely
 * — folder grants applied instead, and the write landed as a clobber.
 */
import { describe, expect, it } from "vitest";
import { canEdit, canRead, personalOwner } from "../src/acl.js";
import type { AclNote } from "../src/acl.js";
import type { AclUser } from "../src/types.js";

const mara: AclUser = { id: "u-mara", username: "mara", isOwner: false, teams: ["marketing"] };
const erin: AclUser = { id: "u-erin", username: "erin", isOwner: false, teams: ["engineering"] };

const noteIn = (folder: string): AclNote => ({ folder, onlyTeams: [], shareTeams: [] });

/** A grant on the vault root — the broadest thing a team can be given. */
const rootEditor = (team: string) => [{ team, folder: "", role: "editor" as const }];

describe("personalOwner is case-insensitive, because the filesystem is", () => {
  it("resolves the owner however the path is cased", () => {
    for (const p of ["Personal/mara", "personal/mara", "PERSONAL/mara", "PeRsOnAl/mara"]) {
      expect(personalOwner(p)).toBe("mara");
    }
  });

  it("recognises the root itself in any case", () => {
    for (const p of ["Personal", "personal", "PERSONAL"]) {
      expect(personalOwner(p)).toBe("");
    }
  });

  it("still returns null for a folder that merely starts with the letters", () => {
    // "Personalities/" is not a personal vault, and must not be treated as one.
    expect(personalOwner("Personalities")).toBeNull();
    expect(personalOwner("personalities/notes")).toBeNull();
    expect(personalOwner("Engineering")).toBeNull();
  });

  it("keeps another user out of a lower-cased personal folder", () => {
    // The bug: with a grant on the vault root, erin could read and write
    // personal/mara/* because §5.3 was never consulted for that spelling.
    const grants = rootEditor("engineering");
    for (const folder of ["Personal/mara", "personal/mara"]) {
      const note = noteIn(folder);
      expect(canRead(erin, note, grants)).toBe(false);
      expect(canEdit(erin, note, grants)).toBe(false);
    }
  });

  it("still lets the owner of the folder in, whatever the case", () => {
    const grants = rootEditor("marketing");
    for (const folder of ["Personal/mara", "personal/mara"]) {
      const note = noteIn(folder);
      expect(canRead(mara, note, grants)).toBe(true);
      expect(canEdit(mara, note, grants)).toBe(true);
    }
  });
});

describe("folder grants match the folder the filesystem means (ACL-001, REG-006)", () => {
  // Engineering's own grant restricts it to engineering; marketing edits the
  // root. `engineering/x.md` IS `Engineering/x.md` on APFS, so it must be
  // judged by the Engineering grant, not fall through to the root.
  const grants = [...rootEditor("marketing"), { team: "engineering", folder: "Engineering", role: "editor" as const }];

  it("a case variant of a restricted folder is still restricted", () => {
    for (const folder of ["Engineering", "engineering", "ENGINEERING/Specs"]) {
      expect(canEdit(mara, noteIn(folder), grants)).toBe(false);
      expect(canRead(mara, noteIn(folder), grants)).toBe(false);
      expect(canEdit(erin, noteIn(folder), grants)).toBe(true);
    }
  });

  it("a grant row typed in another case or normalisation still covers its folder", () => {
    const nfd = [{ team: "engineering", folder: "Re\u0301sume\u0301s", role: "editor" as const }];
    expect(canEdit(erin, noteIn("R\u00e9sum\u00e9s/2026"), nfd)).toBe(true);
    expect(canEdit(erin, noteIn("r\u00e9sum\u00e9s"), nfd)).toBe(true);
    expect(canEdit(mara, noteIn("R\u00e9sum\u00e9s"), nfd)).toBe(false);
  });
});
