/**
 * Contacts are notes, not rows: any readable note tagged #contact (by
 * convention living under Contacts/) with sector/role/company/... frontmatter,
 * plus the companies behind them (#company, Contacts/Companies/). The page is a
 * view over the vault — delete the DB and it rebuilds, share a contact with
 * #share/<team>, keep private ones in your personal folder.
 */
import type { FastifyInstance } from "fastify";
import { parseFrontmatter, parseNote, readSection, updateFrontmatter, type AclUser, type IndexedNote } from "@orrama/core";
import type { Db } from "../db.js";
import { HttpError, type VaultStore } from "../vaultStore.js";

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const isContact = (n: IndexedNote) => n.tags.some((t) => t.tag === "contact");
const isCompany = (n: IndexedNote) => n.tags.some((t) => t.tag === "company");
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
const LINK_RE = /\[\[([^\[\]|#]+?)(?:#[^\[\]|]*)?(?:\\?\|([^\[\]]*))?\]\]/g;

/**
 * A relation field's value as text, whatever YAML made of it: a string, a number, a list (its
 * items, comma-joined), or `[[Acme]]` written without quotes, which YAML reads as a list in a
 * list and Obsidian as a link (read back as `[[Acme]]`).
 */
export function fieldText(v: unknown): string {
  if (Array.isArray(v)) {
    if (v.length === 1 && Array.isArray(v[0]) && v[0].length === 1 && typeof v[0][0] === "string") return `[[${v[0][0]}]]`;
    return v.map(fieldText).filter(Boolean).join(", ");
  }
  return str(v);
}

/** The names a field value gives: its `[[links]]`' targets, else the whole text as written. */
export function namesIn(text: string): { target: string; label: string; link: boolean }[] {
  const links = [...text.matchAll(LINK_RE)].map((m) => ({ target: m[1]!.trim(), label: (m[2] ?? m[1]!.split("/").pop()!).trim(), link: true }));
  if (links.length) return links;
  const t = text.trim();
  return t ? [{ target: t, label: t, link: false }] : [];
}

/**
 * A note as a front-matter link, `[[Contacts/Companies/Acme|Acme]]`: by its path, so it names
 * that note even beside another of the same name, labelled with its title. A path a wiki link
 * can't hold (`[`, `|`, `#`…) is written as the title, which the graph resolves as text.
 */
export function fieldLink(note: { path: string; title: string }): string {
  const stem = note.path.replace(/\.md$/i, "");
  const label = note.title.replace(/[[\]|]/g, " ").replace(/\s+/g, " ").trim();
  return /[[\]|#^]/.test(stem) ? label : `[[${stem}|${label || stem.split("/").pop()!}]]`;
}

/**
 * Who works where, in one place (stage 1, 1F): the company note a person's `company:` names.
 * A link names its note; a plain name is the company of that name (file name or title, as a
 * link would resolve it), else the one company whose name holds it or is held by it ("AMSIB"
 * and "AMSIB (HvA)"), as People always read it. Only companies the reader can read count.
 */
export function companyOf(store: VaultStore, person: IndexedNote, companies: IndexedNote[], among: (n: IndexedNote) => boolean): IndexedNote | null {
  const ids = new Set(companies.map((c) => c.id));
  for (const name of namesIn(fieldText(person.frontmatter["company"]))) {
    const hit = store.index.resolveLink(name.target, undefined, among);
    if (hit && ids.has(hit.id)) return hit;
    if (name.link) continue;
    const want = fold(name.target);
    const same = companies.find((c) => fold(c.title) === want);
    if (same) return same;
    const near = companies.filter((c) => {
      const t = fold(c.title);
      return t.includes(want) || want.includes(t);
    });
    if (near.length === 1) return near[0]!;
  }
  return null;
}

/** A one-line fact a person types: trimmed, no line break, not too long. */
function oneLine(v: unknown, what: string, max = 200): string {
  if (typeof v !== "string") throw new HttpError(400, `${what} must be text`);
  const s = v.trim();
  if (s.length > max || /[\r\n]/.test(s)) throw new HttpError(400, `${what} must be one line, at most ${max} characters`);
  return s;
}

/**
 * Write front matter or refuse: properties that can't be read are a 409 with the sentence to
 * show, never a half change (COMMON rule 1). Returns whether anything changed.
 */
function writeFields(store: VaultStore, user: AclUser, note: IndexedNote, what: string, change: (d: Record<string, unknown>) => Record<string, unknown>): boolean {
  const fm = parseFrontmatter(note.content);
  if (fm.malformed || fm.notMapping) throw new HttpError(409, `This note's properties can't be read, so ${what} wasn't changed. Fix them in the note first.`);
  const want = change({ ...fm.data });
  const next = updateFrontmatter(note.content, () => want);
  if (next === note.content) {
    const same = JSON.stringify(want) === JSON.stringify(fm.data);
    if (same) return false;
    throw new HttpError(409, `This note's properties can't be changed safely, so ${what} wasn't changed. Fix them in the note first.`);
  }
  store.write(user, note.path, next);
  return true;
}

/** Only what the reader can read can be named by a link of theirs (ACL-005). */
function readableAmong(store: VaultStore, user: AclUser): (n: IndexedNote) => boolean {
  const ids = new Set(store.readable(user).map((n) => n.id));
  return (n) => ids.has(n.id);
}

/** The project note a reader can see by its id, or a 400: what `supervises` may name. */
function projectNoteOf(store: VaultStore, user: AclUser, id: string): IndexedNote {
  const note = store.requireReadable(user, id);
  const isProject = store.projects(user).some((p) => store.projectNote(p.key)?.id === note.id);
  if (!isProject) throw new HttpError(400, "not a project note");
  return note;
}

/** YAML list or comma-separated string → trimmed string list (front-matter is hand-written too). */
const strList = (v: unknown): string[] => {
  const raw = Array.isArray(v) ? v.map(str) : str(v).split(",");
  return raw.map((s) => s.trim()).filter(Boolean);
};

export async function contactRoutes(app: FastifyInstance, _db: Db, store: VaultStore) {
  app.get("/api/contacts", { preHandler: [app.authenticate] }, async (req) => {
    const user = store.aclUser(req.userId);
    const readable = store.readable(user);
    const ids = new Set(readable.map((n) => n.id));
    const companies = readable.filter(isCompany);
    return readable
      .filter(isContact)
      .map((n) => ({
        id: n.id,
        name: n.title,
        path: n.path,
        sector: str(n.frontmatter["sector"]) || "Other",
        role: str(n.frontmatter["role"]),
        company: fieldText(n.frontmatter["company"]),
        /** The company note `company:` names (companyOf), or null: a name with no note yet. */
        companyId: companyOf(store, n, companies, (x) => ids.has(x.id))?.id ?? null,
        email: str(n.frontmatter["email"]),
        phone: str(n.frontmatter["phone"]),
        linkedin: str(n.frontmatter["linkedin"]),
        personal: n.folder.startsWith("Personal/"),
      }))
      .sort((a, b) => a.sector.localeCompare(b.sector) || a.name.localeCompare(b.name));
  });

  /**
   * Companies are notes tagged #company: the org behind the contacts. Same deal
   * as contacts — a note is the record, so meeting notes, [[links]] to the people
   * you know there and application tasks all live in the same file. `positions`
   * is the list of role types you actually saw open there.
   */
  app.get("/api/companies", { preHandler: [app.authenticate] }, async (req) => {
    const user = store.aclUser(req.userId);
    return store
      .readable(user)
      .filter((n) => n.tags.some((t) => t.tag === "company"))
      .map((n) => ({
        id: n.id,
        name: n.title,
        path: n.path,
        description: str(n.frontmatter["description"]) || str(n.frontmatter["summary"]),
        sector: str(n.frontmatter["sector"]) || "Other",
        linkedin: str(n.frontmatter["linkedin"]),
        website: str(n.frontmatter["website"]),
        careers: str(n.frontmatter["careers"]),
        location: str(n.frontmatter["location"]),
        positions: strList(n.frontmatter["positions"] ?? n.frontmatter["roles"]),
        personal: n.folder.startsWith("Personal/"),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  /**
   * A person's facts, set from their page (stage 1, 1F): any of role, email, phone, LinkedIn and
   * sector, and where they work (`companyId`: a company note, written as a link, or null to
   * clear it). Written by core's front-matter writer, never by text surgery in the browser (the
   * page once rewrote the first line anywhere in the note that began `sector:`, WEB-022). Front
   * matter that does not parse is not rewritten: the change is refused (409), not dropped.
   */
  app.patch("/api/contacts/:id", { preHandler: [app.authenticate] }, async (req) => {
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, (req.params as { id: string }).id);
    if (!isContact(note)) throw new HttpError(400, "not a contact note");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const set: Record<string, string> = {};
    if (body["sector"] !== undefined) {
      const sector = oneLine(body["sector"], "sector", 60);
      if (!sector) throw new HttpError(400, "sector must be one line, 1–60 characters");
      set["sector"] = sector;
    }
    for (const [k, what] of [["role", "role"], ["email", "email"], ["phone", "phone"], ["linkedin", "LinkedIn"]] as const) {
      if (body[k] !== undefined) set[k] = oneLine(body[k], what);
    }
    if (body["companyId"] !== undefined) {
      if (body["companyId"] === null || body["companyId"] === "") set["company"] = "";
      else {
        const company = store.requireReadable(user, String(body["companyId"]));
        if (!isCompany(company)) throw new HttpError(400, "not a company note");
        set["company"] = fieldLink(company);
      }
    }
    if (Object.keys(set).length === 0) throw new HttpError(400, "nothing to change");
    writeFields(store, user, note, Object.keys(set).length === 1 ? `the ${Object.keys(set)[0]}` : "the details", (d) => {
      for (const [k, v] of Object.entries(set)) {
        // An empty fact the note never had stays unwritten; one it had is emptied, as typed.
        if (v === "" && !Object.hasOwn(d, k)) continue;
        d[k] = v;
      }
      return d;
    });
    return { ok: true };
  });

  /**
   * The projects a person is on, as their page lists them and can take them off (1F): the ones
   * their `supervises:` names, and the ones whose note lists them in `## People` or names them
   * in `involves:`, which a project's Remove takes out. Read from the notes themselves, so it
   * needs no ontology note; only projects the reader can read.
   */
  app.get("/api/contacts/:id/projects", { preHandler: [app.authenticate] }, async (req) => {
    const user = store.aclUser(req.userId);
    const person = store.requireReadable(user, (req.params as { id: string }).id);
    if (!isContact(person)) throw new HttpError(400, "not a contact note");
    const among = readableAmong(store, user);
    const names = (v: unknown) => (Array.isArray(v) && !(v.length === 1 && Array.isArray(v[0])) ? v.map(fieldText) : [fieldText(v)]).flatMap(namesIn);
    const projects = store
      .projects(user)
      .filter((p) => p.kind === "tag")
      .map((p) => ({ slug: p.key.replace(/^project\//, ""), name: p.name, note: store.projectNote(p.key) }))
      .filter((p): p is { slug: string; name: string; note: IndexedNote } => !!p.note && among(p.note));
    const supervised = new Set(names(person.frontmatter["supervises"]).map((n) => store.index.resolveLink(n.target, undefined, among)?.id));
    const out: { id: string; title: string; slug: string; relation: "supervises" | "involved" }[] = [];
    for (const p of projects) {
      const brief = { id: p.note.id, title: p.name, slug: p.slug };
      if (supervised.has(p.note.id)) out.push({ ...brief, relation: "supervises" });
      const listed = parseNote(readSection(p.note.content, "People")).links.some((l) => store.index.resolveLink(l.target, undefined, among)?.id === person.id);
      const involves = names(p.note.frontmatter["involves"]).some((n) => store.index.resolveLink(n.target, undefined, among)?.id === person.id);
      if (listed || involves) out.push({ ...brief, relation: "involved" });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title) || (a.relation < b.relation ? 1 : -1));
  });

  /**
   * "Supervises" from the person's side: `supervises:` on their note names the project, as a
   * link (one value as a string, more as a list, as a person writes them). Adding a project
   * already named is said, not written twice; removing takes out every value naming it.
   */
  app.post("/api/contacts/:id/supervises", { preHandler: [app.authenticate] }, async (req) => {
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, (req.params as { id: string }).id);
    if (!isContact(note)) throw new HttpError(400, "not a contact note");
    const project = projectNoteOf(store, user, String((req.body as { projectId?: unknown } | null)?.projectId ?? ""));
    const among = readableAmong(store, user);
    const names = (v: unknown) => (Array.isArray(v) ? v.map(fieldText) : [fieldText(v)]).filter(Boolean);
    const current = names(note.frontmatter["supervises"]);
    if (current.some((v) => namesIn(v).some((n) => store.index.resolveLink(n.target, undefined, among)?.id === project.id))) return { ok: true, already: true };
    writeFields(store, user, note, "what they supervise", (d) => {
      const link = fieldLink(project);
      const had = d["supervises"];
      d["supervises"] = had === undefined || had === null || had === "" ? link : Array.isArray(had) ? [...had, link] : [had, link];
      return d;
    });
    return { ok: true };
  });

  app.delete("/api/contacts/:id/supervises/:projectId", { preHandler: [app.authenticate] }, async (req) => {
    const user = store.aclUser(req.userId);
    const { id, projectId } = req.params as { id: string; projectId: string };
    const note = store.requireReadable(user, id);
    if (!isContact(note)) throw new HttpError(400, "not a contact note");
    const project = store.requireReadable(user, projectId);
    const among = readableAmong(store, user);
    const names = (v: unknown) => namesIn(fieldText(v)).some((n) => store.index.resolveLink(n.target, undefined, among)?.id === project.id);
    const had = note.frontmatter["supervises"];
    const list = Array.isArray(had) && !(had.length === 1 && Array.isArray(had[0])) ? had : [had];
    const kept = list.filter((v) => !names(v));
    if (kept.length === list.length) return { ok: true, already: true };
    writeFields(store, user, note, "what they supervise", (d) => {
      if (kept.length === 0 || !Array.isArray(had) || (had.length === 1 && Array.isArray(had[0]))) delete d["supervises"];
      else d["supervises"] = kept;
      return d;
    });
    return { ok: true };
  });

  /** Edit the card fields in place. Front-matter only: the body is preserved
   *  byte-for-byte, and `store.write` still runs the normal edit ACL. */
  app.patch("/api/companies/:id", { preHandler: [app.authenticate] }, async (req) => {
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, (req.params as { id: string }).id);
    if (!note.tags.some((t) => t.tag === "company")) throw new HttpError(400, "not a company note");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = ["description", "sector", "linkedin", "website", "careers", "location"] as const;
    writeFields(store, user, note, "the company", (d) => {
      for (const k of fields) {
        if (body[k] === undefined) continue;
        // What they do is read from `description:`, else an older `summary:`: the one the
        // note has is the one changed, never a second beside it.
        const key = k === "description" && !Object.hasOwn(d, "description") && Object.hasOwn(d, "summary") ? "summary" : k;
        d[key] = str(body[k]);
      }
      if (body["positions"] !== undefined) d["positions"] = strList(body["positions"]);
      return d;
    });
    return { ok: true };
  });
}
