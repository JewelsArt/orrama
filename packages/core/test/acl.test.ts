import { describe, expect, it } from "vitest";
import {
  canEdit,
  canRead,
  filterReadable,
  folderRole,
  validateEdit,
  type AclNote,
  type AclUser,
  type FolderGrant,
} from "../src/index.js";

const eng = (over: Partial<AclUser> = {}): AclUser => ({
  id: "u-eng",
  username: "erin",
  teams: ["engineering"],
  isOwner: false,
  ...over,
});
const mkt = (over: Partial<AclUser> = {}): AclUser => ({
  id: "u-mkt",
  username: "mara",
  teams: ["marketing"],
  isOwner: false,
  ...over,
});
const owner: AclUser = { id: "u-own", username: "olive", teams: [], isOwner: true };

const grants: FolderGrant[] = [
  { team: "engineering", folder: "Engineering", role: "editor" },
  { team: "marketing", folder: "Marketing", role: "editor" },
  { team: "marketing", folder: "Shared", role: "viewer" },
  { team: "engineering", folder: "Shared", role: "editor" },
];

const note = (folder: string, only: string[] = [], share: string[] = []): AclNote => ({
  folder,
  onlyTeams: only,
  shareTeams: share,
});

describe("§5.1 folder baseline", () => {
  it("grants by nearest ancestor folder", () => {
    expect(folderRole(eng(), "Engineering/Sub/Deep", grants)).toBe("editor");
    expect(folderRole(mkt(), "Engineering/Sub", grants)).toBeNull();
  });

  it("takes max role across the user's teams", () => {
    const both = eng({ teams: ["engineering", "marketing"] });
    expect(folderRole(both, "Shared", grants)).toBe("editor");
  });

  it("subfolder grants override the parent baseline (can restrict)", () => {
    const g = [...grants, { team: "marketing", folder: "Engineering/Public", role: "viewer" as const }];
    // marketing gets the subfolder in, engineering still governed by nearest grant level
    expect(folderRole(mkt(), "Engineering/Public", g)).toBe("viewer");
    // engineering has no grant at the nearest granted folder → overridden out
    expect(folderRole(eng(), "Engineering/Public", g)).toBeNull();
  });

  it("ungranted folders are invisible (no role)", () => {
    expect(folderRole(eng(), "Finance", grants)).toBeNull();
    expect(canRead(eng(), note("Finance"), grants)).toBe(false);
  });
});

describe("§5.2 tag overlays", () => {
  it("#only restricts within a readable folder", () => {
    const n = note("Shared", ["engineering"]);
    expect(canRead(eng(), n, grants)).toBe(true);
    expect(canRead(mkt(), n, grants)).toBe(false); // folder-readable but locked out by #only
  });

  it("multiple #only tags are a union", () => {
    const n = note("Shared", ["engineering", "marketing"]);
    expect(canRead(mkt(), n, grants)).toBe(true);
  });

  it("#only never grants access to users without folder/share access", () => {
    expect(canRead(mkt(), note("Engineering", ["marketing"]), grants)).toBe(false);
  });

  it("#share grants read (not edit) across folder boundaries", () => {
    const n = note("Engineering", [], ["marketing"]);
    expect(canRead(mkt(), n, grants)).toBe(true);
    expect(canEdit(mkt(), n, grants)).toBe(false);
    expect(canEdit(eng(), n, grants)).toBe(true);
  });

  it("#only wins over #share", () => {
    const n = note("Engineering", ["engineering"], ["marketing"]);
    expect(canRead(mkt(), n, grants)).toBe(false);
  });

  it("workspace owners see everything (§5.3.4, documented superuser)", () => {
    expect(canRead(owner, note("Finance", ["engineering"]), grants)).toBe(true);
    expect(canEdit(owner, note("Finance", ["engineering"]), grants)).toBe(true);
  });
});

describe("§5.3 abuse rules (server-enforced)", () => {
  it("rule 1: adding #only/<team> requires membership of <team>", () => {
    const before = note("Shared");
    const after = note("Shared", ["marketing"]);
    const res = validateEdit(eng(), before, after, grants);
    expect(res).toMatchObject({ ok: false, rule: "only-tag-membership", team: "marketing" });
  });

  it("rule 1: removing #only/<team> requires membership too", () => {
    const before = note("Shared", ["engineering", "marketing"]);
    const after = note("Shared", ["engineering"]);
    // erin (engineering) tries to strip marketing's lock — rejected
    expect(validateEdit(eng(), before, after, grants)).toMatchObject({
      ok: false,
      rule: "only-tag-membership",
      team: "marketing",
    });
    // a member of marketing with edit rights could — but marketing is only viewer on Shared
    expect(validateEdit(mkt(), before, after, grants)).toMatchObject({ ok: false, rule: "no-edit-access" });
  });

  it("rule 1: members may add their own team's #only", () => {
    expect(validateEdit(eng(), note("Shared"), note("Shared", ["engineering"]), grants)).toEqual({ ok: true });
  });

  it("rule 2: an edit can never lock the editor out of the note", () => {
    const both = eng({ teams: ["engineering", "marketing"] });
    // both-member adds #only/marketing then also removes... construct: after-state readable? Add #only for a team
    // the actor belongs to → fine; but an actor removing their own access is rejected:
    const before = note("Shared", ["engineering", "marketing"]);
    const after = note("Shared", ["marketing"]); // erin removes engineering → she can no longer read
    expect(validateEdit(eng(), before, after, grants)).toMatchObject({ ok: false, rule: "self-lockout" });
    // whereas the dual-team member can do the same edit safely
    expect(validateEdit(both, before, after, grants)).toEqual({ ok: true });
  });

  it("rule 3: #share tags are managed by anyone with edit rights", () => {
    expect(validateEdit(eng(), note("Engineering"), note("Engineering", [], ["marketing"]), grants)).toEqual({ ok: true });
    expect(validateEdit(eng(), note("Engineering", [], ["marketing"]), note("Engineering"), grants)).toEqual({ ok: true });
    // but edit rights are required at all
    expect(validateEdit(mkt(), note("Engineering", [], ["marketing"]), note("Engineering"), grants)).toMatchObject({
      ok: false,
      rule: "no-edit-access",
    });
  });

  it("rule 4: owners bypass tag-membership but are never locked out anyway", () => {
    const res = validateEdit(owner, note("Shared"), note("Shared", ["marketing"]), grants);
    expect(res).toEqual({ ok: true });
  });
});

describe("§5.4 leak rules", () => {
  it("filterReadable drops unreadable notes entirely", () => {
    const notes = [
      { ...note("Engineering"), title: "eng" },
      { ...note("Marketing"), title: "mkt" },
      { ...note("Shared", ["engineering"]), title: "locked" },
      { ...note("Engineering", [], ["marketing"]), title: "shared-out" },
    ];
    const visible = filterReadable(mkt(), notes, grants).map((n) => n.title);
    expect(visible).toEqual(["mkt", "shared-out"]);
    expect(visible).not.toContain("locked");
  });
});
