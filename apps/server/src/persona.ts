/**
 * The account's persona note (ME, Nov 2026): which note it is, where a new one goes, and what Orr
 * may read to write one. The page (routes/persona.ts), the agent's get_persona and draft_email
 * (routes/ai.ts) and MCP all go through `personaNote`, so they agree on which note is "you".
 *
 * The persona is the ACCOUNT's (schema 4's ACL, Control's answer, 19 Nov): a note tagged
 * `#persona` that the account can edit, never in another account's Personal folder, and never
 * one another account could read, unless it sits in the account's own Personal folder (which is
 * theirs by path). On a one-account install that is simply the note tagged #persona, wherever it
 * is. Ranked like the finance ledgers (ACL-011): Personal/<me>/ first, then 01-Me/, then the note
 * made first, then path, so the choice never flips with index order.
 */
import { canEdit, canRead, personalOwner, type AclNote, type AclUser, type IndexedNote, PERSONA_TAG } from "@orrama/core";
import { tables, type Db } from "./db.js";
import type { VaultStore } from "./vaultStore.js";

/** Whether an account other than `user` (owners aside) could read `note`: as calendarNotes.ts's ACL-009 rule. */
function exposed(db: Db, store: VaultStore, user: AclUser, note: AclNote): boolean {
  const grants = store.grants();
  return db
    .select()
    .from(tables.users)
    .all()
    .some((u) => u.id !== user.id && !u.isOwner && canRead(store.aclUser(u.id), note, grants));
}

const rank = (n: IndexedNote, me: string) => (personalOwner(n.folder) === me ? 0 : n.path.startsWith("01-Me/") ? 1 : 2);

/** Every note that could be the account's persona, best first. */
export function personaCandidates(db: Db, store: VaultStore, user: AclUser): IndexedNote[] {
  const grants = store.grants();
  const me = user.username.toLowerCase();
  return store
    .readable(user)
    .filter((n) => n.tags.some((t) => t.tag === PERSONA_TAG))
    .filter((n) => {
      const owner = personalOwner(n.folder);
      if (owner === me) return true;
      return owner === null && canEdit(user, n, grants) && !exposed(db, store, user, n);
    })
    .sort((a, b) => rank(a, me) - rank(b, me) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.path < b.path ? -1 : 1));
}

/** The account's persona note, or undefined when it has none. */
export const personaNote = (db: Db, store: VaultStore, user: AclUser): IndexedNote | undefined => personaCandidates(db, store, user)[0];

/** Where a new persona note goes: `01-Me/` when it would be the account's alone, else its Personal folder. */
export function personaHome(db: Db, store: VaultStore, user: AclUser): string {
  const shared: AclNote = { folder: "01-Me", onlyTeams: [], shareTeams: [] };
  const dir = canEdit(user, shared, store.grants()) && !exposed(db, store, user, shared) ? "01-Me" : `Personal/${user.username}`;
  for (let n = 1; ; n++) {
    const path = `${dir}/${n === 1 ? "persona" : `persona ${n}`}.md`;
    if (!store.index.getByPath(path)) return path;
  }
}

/**
 * What Orr leaves out when it writes a persona, whatever is switched on: money, an address,
 * health and family (Jules, 3 Nov). Judged on a note's path and tags, so a note filed under
 * Finance or tagged #health is never read.
 */
const PRIVATE = /\b(finance|finances|money|bank|banking|budget|salary|salaries|payslips?|subscriptions?|income|spending|tax|taxes|invoices?|health|medical|doctor|therapy|family|address|addresses|passwords?)\b/i;
const MONEY_TAGS = new Set(["income", "subscriptions", "payslips", "spending-categories", "own-accounts", "finance"]);

export function isPrivate(n: IndexedNote): boolean {
  if (n.tags.some((t) => MONEY_TAGS.has(t.tag) || PRIVATE.test(t.tag.replace(/[/_-]/g, " ")))) return true;
  return PRIVATE.test(n.path.replace(/[/_-]/g, " "));
}

export interface PersonaSources {
  projects: IndexedNote[];
  notes: IndexedNote[];
  people: IndexedNote[];
  chats: IndexedNote[];
}

const isContact = (n: IndexedNote) => n.tags.some((t) => t.tag === "contact" || t.tag === "company");

/** What Orr could read for a persona: the account's readable notes, private ones left out, by kind. */
export function personaSources(store: VaultStore, user: AclUser): PersonaSources {
  const readable = store.readable(user).filter((n) => !isPrivate(n) && !n.tags.some((t) => t.tag === PERSONA_TAG));
  const projectIds = new Set(
    store
      .projects(user)
      .filter((p) => p.kind === "tag")
      .map((p) => store.projectNote(p.key)?.id)
      .filter((x): x is string => !!x),
  );
  const out: PersonaSources = { projects: [], notes: [], people: [], chats: [] };
  for (const n of readable) {
    if (projectIds.has(n.id)) out.projects.push(n);
    else if (n.kind === "conversation") out.chats.push(n);
    else if (isContact(n)) out.people.push(n);
    else out.notes.push(n);
  }
  const newest = (a: IndexedNote, b: IndexedNote) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0);
  for (const k of Object.keys(out) as (keyof PersonaSources)[]) out[k].sort(newest);
  return out;
}

/** Enough to read for a first draft: at least 3 projects or 20 notes (the mockup's threshold, 5 Nov). */
export const ENOUGH = { projects: 3, notes: 20 };
export const enoughToRead = (s: { projects: number; notes: number }) => s.projects >= ENOUGH.projects || s.notes >= ENOUGH.notes;
