/**
 * The permission model (spec §5). This is THE ACL implementation — sync manifests,
 * search, graph, task lists, dashboard aggregates, and AI retrieval must all call
 * these functions. Never reimplement filtering elsewhere.
 */
import type { AclUser, FolderGrant, Role, TeamId } from "./types.js";

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

export function maxRole(a: Role | null, b: Role | null): Role | null {
  if (!a) return b;
  if (!b) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

export function roleAtLeast(role: Role | null, min: Role): boolean {
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Minimal note shape the ACL needs; IndexedNote satisfies it. */
export interface AclNote {
  folder: string;
  onlyTeams: TeamId[];
  shareTeams: TeamId[];
}

function ancestors(folder: string): string[] {
  // "a/b/c" → ["a/b/c", "a/b", "a", ""] — "" is the vault root.
  const out: string[] = [];
  let cur = folder;
  while (cur !== "") {
    out.push(cur);
    const idx = cur.lastIndexOf("/");
    cur = idx === -1 ? "" : cur.slice(0, idx);
  }
  out.push("");
  return out;
}

/**
 * Folder baseline (§5.1): walk up from the note's folder; the FIRST ancestor that has
 * any explicit grant decides — the user's role there is their max role across their
 * teams' grants at that folder, or null if their teams have none. This makes a
 * subfolder grant a true override: it can restrict as well as extend the baseline.
 * Workspace owners are handled by callers (they bypass folder rules).
 */
export function folderRole(user: AclUser, folder: string, grants: FolderGrant[]): Role | null {
  const byFolder = new Map<string, FolderGrant[]>();
  for (const g of grants) {
    const list = byFolder.get(g.folder) ?? [];
    list.push(g);
    byFolder.set(g.folder, list);
  }
  for (const anc of ancestors(folder)) {
    const here = byFolder.get(anc);
    if (!here || here.length === 0) continue;
    let role: Role | null = null;
    for (const g of here) {
      if (user.teams.includes(g.team)) role = maxRole(role, g.role);
    }
    return role; // nearest folder with ANY grant decides, even if that means null
  }
  return null;
}

function passesOnlyFilter(user: AclUser, note: AclNote): boolean {
  if (note.onlyTeams.length === 0) return true;
  return note.onlyTeams.some((t) => user.teams.includes(t));
}

/**
 * Read access (§5.2): owners always; otherwise the user must pass the #only/ filter
 * (restrict overlay wins over everything), and then either have folder read access
 * or be in a #share/ team (share grants read-only access across folder boundaries).
 */
export function canRead(user: AclUser, note: AclNote, grants: FolderGrant[]): boolean {
  if (user.isOwner) return true;
  if (!passesOnlyFilter(user, note)) return false;
  if (roleAtLeast(folderRole(user, note.folder, grants), "viewer")) return true;
  return note.shareTeams.some((t) => user.teams.includes(t));
}

/** Edit access: #share never grants edit; cross-team edit rights come from folders only. */
export function canEdit(user: AclUser, note: AclNote, grants: FolderGrant[]): boolean {
  if (user.isOwner) return true;
  if (!passesOnlyFilter(user, note)) return false;
  return roleAtLeast(folderRole(user, note.folder, grants), "editor");
}

export type EditRejection =
  | { ok: false; rule: "no-edit-access"; message: string }
  | { ok: false; rule: "only-tag-membership"; message: string; team: TeamId }
  | { ok: false; rule: "self-lockout"; message: string };

export type EditValidation = { ok: true } | EditRejection;

/**
 * Server-enforced edit rules (§5.3). `before` is the note state on the server,
 * `after` the state the edit would produce. Reject on sync with a clear error.
 */
export function validateEdit(
  user: AclUser,
  before: AclNote,
  after: AclNote,
  grants: FolderGrant[],
): EditValidation {
  if (!canEdit(user, before, grants)) {
    return { ok: false, rule: "no-edit-access", message: "You do not have edit access to this note." };
  }

  if (!user.isOwner) {
    // Rule 1: touching a #only/<team> tag requires membership of <team>.
    const beforeOnly = new Set(before.onlyTeams);
    const afterOnly = new Set(after.onlyTeams);
    const touched = [
      ...[...afterOnly].filter((t) => !beforeOnly.has(t)),
      ...[...beforeOnly].filter((t) => !afterOnly.has(t)),
    ];
    for (const team of touched) {
      if (!user.teams.includes(team)) {
        return {
          ok: false,
          rule: "only-tag-membership",
          team,
          message: `Only members of "${team}" (or the workspace owner) may add or remove #only/${team}.`,
        };
      }
    }
  }

  // Rule 2: an edit may never produce a state the editor themselves cannot read.
  if (!canRead(user, after, grants)) {
    return {
      ok: false,
      rule: "self-lockout",
      message: "This edit would make the note unreadable to you, so it was rejected.",
    };
  }

  return { ok: true };
}

/** Filter any note-shaped list down to what the user may read. Use for every user-facing surface. */
export function filterReadable<T extends AclNote>(
  user: AclUser,
  notes: T[],
  grants: FolderGrant[],
): T[] {
  return notes.filter((n) => canRead(user, n, grants));
}
