/**
 * Projects as notes: a note becomes a board project purely by carrying a
 * front-matter `project/<slug>` tag (VaultStore.syncProjectRow registers it).
 * These routes are the ergonomic front door — scaffold a fresh project note, or
 * promote an existing note — shared by the web UI, the in-app AI, and MCP.
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { appendToSection, areaSlug, canEdit, canRead, isoLocal, parseNote, PROJECT_SLUG_RE, PROJECTS_DIR, projectName, projectNoteFor, projectSlugOf, readSection, readSectionItems, updateFrontmatter, writeSection, type IndexedNote } from "@orrama/core";
import { tables, type Db } from "../db.js";
import { defaultBoard, normalizeBoard, placeMissing } from "../board.js";
import { sanitizeDocHtml } from "../docHtml.js";
import { isPageName, PAGE_CSP } from "../pageSandbox.js";
import { readPptx, SLIDE_CAPS } from "../slides.js";
import { DOCX_CAPS, officeRefusal, readOfficeFile, XLSX_CAPS } from "../zip.js";
import { HttpError, type VaultStore } from "../vaultStore.js";
import { writeFileAtomic } from "../atomicWrite.js";
import { CONTROL_CHARS, contentDisposition, numbered, storeUpload, unportableName } from "../uploads.js";
import { tokenWriter } from "../agentWrites.js";
import { areasFor } from "../lifeAreas.js";

// In core since the store names projects by their note (COR-004); here for the routes that import them.
export { PROJECTS_DIR, projectNoteFor };
export const DOMAINS = ["personal", "professional", "academic"] as const;
export type Domain = (typeof DOMAINS)[number];

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";

export const asDomain = (d: unknown): Domain | undefined => (DOMAINS.includes(d as Domain) ? (d as Domain) : undefined);

/**
 * A project's group inside its area (front matter `group:`, "Scooperz", "Websites"): one line of
 * free text, its spaces collapsed, at most 60 characters. The Projects board splits an area's
 * projects by it; empty is no group.
 */
export const GROUP_MAX = 60;
export const asGroup = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim().slice(0, GROUP_MAX).trim() : "");

/**
 * The starter body for a new project note: the tags that put it on the board, and a status.
 * `planned`, the ontology's "not started": a project just made has no work behind it yet, and
 * the person moves it to on track from the header when it starts. It used to carry an `active`
 * tag and no status, so every new project opened on "No status yet: pick one", and picking one
 * then made the tag and the status disagree (inventory §1). No line teaches Markdown: the
 * first step is the example of a step.
 */
export function projectNoteScaffold(name: string, slug: string, domain?: Domain, area?: string): string {
  const text = [
    "---",
    `title: ${name}`,
    "tags:",
    "  - project",
    `  - project/${slug}`,
    "status: planned",
    ...(domain && !area ? [`domain: ${domain}`] : []),
    "---",
    "",
    `# ${name}`,
    "",
    "- [ ] First step",
    "",
  ].join("\n");
  // The area as the header's menu writes it: the same YAML writer, quoting what needs it.
  return area ? updateFrontmatter(text, (d) => ({ ...d, area })) : text;
}

const isProjectTag = (t: { line: number; tag: string }) => t.line === 0 && projectSlugOf(t.tag) !== null;

/** Sections the workspace owns inside the project note. Headings, not database rows. */
const SEC = { goals: "Goals", prompt: "Prompt", decisions: "Decisions", inbox: "Inbox", people: "People" } as const;

/**
 * A link that names exactly this note (COR-017): its vault path, which outranks
 * every title, alias and filename when links resolve, with its title shown. A
 * bare `[[title]]` resolves to whichever note has that filename first — a
 * meeting log named after the person — and the person never appears. A path a
 * wiki link cannot hold (`[`, `]`, `|`, `#`, `^`) is written as a Markdown link.
 */
export function linkTo(note: { path: string; title: string }): string {
  const stem = note.path.replace(/\.md$/i, "");
  const label = note.title.replace(/[[\]|]/g, " ").replace(/\s+/g, " ").trim() || stem.split("/").pop()!;
  if (!/[[\]|#^]/.test(stem)) return `[[${stem}|${label}]]`;
  const href = note.path.split("/").map((p) => encodeURIComponent(p).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
  return `[${label}](${href})`;
}

/**
 * A slug is a path segment, so it gets the grammar of one.
 *
 * `openProject` resolves a slug by matching any readable note's tag, and
 * front-matter tags used to skip the tag grammar — so a note
 * carrying `tags: ["project/../../../../apps/web/dist"]` used to hand that
 * string straight to path.join. noteWriteSchema's no-`..` rule guards the note's
 * PATH, not its contents, and `safeName` hardens the filename only. The result
 * was mkdirSync creating a directory anywhere on disk and an upload landing in
 * a statically-served folder: arbitrary write, then stored XSS on the app's own
 * origin. The AI agent's write_note tool takes a model-supplied path, so a
 * hostile email could start the chain.
 */
// One grammar for every project slug, the one registration uses (core
// PROJECT_SLUG_RE, audit REG-017): one path segment, no `.`, `/` or `\`.
const assertSlug = (slug: string): string => {
  if (!PROJECT_SLUG_RE.test(slug)) throw new HttpError(404, "project not found");
  return slug;
};

/**
 * Documents live beside the note: 04-Projects/<slug>/files/.
 *
 * Validates, then re-checks the RESOLVED path. The grammar alone would do it,
 * but the containment assertion is what keeps this correct if the grammar is
 * ever loosened — the same order VaultStore.resolvePath uses.
 */
const filesDirFor = (root: string, slug: string) => {
  const dir = path.join(root, PROJECTS_DIR, assertSlug(slug), "files");
  const base = path.resolve(root, PROJECTS_DIR);
  const resolved = path.resolve(dir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new HttpError(404, "project not found");
  }
  return dir;
};

/**
 * A filename is data, not a path. Strip every separator, refuse dotfiles and
 * traversal outright, and cap the length — the upload target is then a plain
 * name inside a directory we chose, never something the client can steer.
 */
function safeName(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  // Judge the string the client sent, not what basename() salvages from it:
  // "../../escape.pdf" would flatten to a perfectly innocent name, which hides a
  // caller that is clearly trying to walk out of the directory.
  if (raw === "" || raw.length > 120) throw new HttpError(400, "invalid filename");
  if (raw.startsWith(".") || raw.includes("..")) throw new HttpError(400, "invalid filename");
  if (/[/\\]/.test(raw) || CONTROL_CHARS.test(raw)) throw new HttpError(400, "invalid filename");
  const base = path.basename(raw);
  if (base !== raw) throw new HttpError(400, "invalid filename");
  return base;
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".csv": "text/csv", ".txt": "text/plain",
  ".md": "text/markdown", ".json": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
/** Anything scriptable is downloaded, never rendered: an inline .html or .svg on
 *  our own origin would run with the session's cookies. */
const INLINE_OK = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".txt", ".csv", ".md"]);
const MAX_UPLOAD = 25 * 1024 * 1024;
/** Spreadsheet preview caps — enough to read, not enough to hang the view. */
const MAX_SHEETS = 12;
const MAX_ROWS = 500;
const MAX_COLS = 40;

/** The wall-calendar date, in the timezone the server is standing in. */
const iso = isoLocal;

export async function projectRoutes(app: FastifyInstance, store: VaultStore, db: Db) {
  const auth = { preHandler: [app.authenticate] };

  /** Scaffold a fresh project note under 04-Projects/ and put it on the board. */
  app.post("/api/projects", auth, async (req) => {
    const body = (req.body ?? {}) as { name?: string; domain?: string; area?: string };
    const name = body.name?.trim();
    if (!name || name.length > 120) throw new HttpError(400, "name required (max 120)");
    const slug = slugify(name);
    const relPath = `${PROJECTS_DIR}/${slug}.md`;
    const user = store.aclUser(req.userId);
    const area = body.area === undefined ? undefined : areaNamed(user, body.area);
    // Create-only, so `04-Projects/Thesis.md` is not replaced by the scaffold
    // for "thesis" (slugify lower-cases; an exact-case check missed it).
    const note = store.write(user, relPath, projectNoteScaffold(name, slug, asDomain(body.domain), area), undefined, undefined, { create: true });
    return { ok: true, noteId: note.id, path: note.path, slug, key: `project/${slug}` };
  });

  /** Promote an existing note: add the project tags so it joins the board. */
  app.post("/api/projects/promote", auth, async (req) => {
    const body = (req.body ?? {}) as { noteId?: string; domain?: string };
    if (!body.noteId) throw new HttpError(400, "noteId required");
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, body.noteId);
    const already = note.tags.find(isProjectTag);
    if (already) return { ok: true, alreadyProject: true, key: already.tag };

    const slug = slugify(note.title);
    const domain = asDomain(body.domain);
    const updated = updateFrontmatter(note.content, (d) => {
      const raw = (d as Record<string, unknown>)["tags"];
      const tags = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
      if (!tags.includes("project")) tags.push("project");
      if (!tags.some((t) => t.startsWith("project/"))) tags.push(`project/${slug}`);
      return { ...(d as Record<string, unknown>), tags, ...(domain ? { domain } : {}) };
    });
    const saved = store.write(user, note.path, updated);
    return { ok: true, noteId: saved.id, key: `project/${slug}` };
  });

  /** The name of the reader's life area `v` names (by name or id, any case), or a 400 saying so. */
  const areaNamed = (user: ReturnType<typeof store.aclUser>, v: unknown): string => {
    const id = typeof v === "string" ? areaSlug(v) : "";
    const area = areasFor(store, user).areas.find((a) => a.id === id);
    if (!area) throw new HttpError(400, "That life area doesn't exist.");
    return area.name;
  };

  // ---- The workspace ------------------------------------------------------

  /** Resolve <slug> to its registered row + note, ACL-checked (404, never 403). */
  const openProject = (userId: string, slug: string) => {
    // Before anything is looked up: a slug that cannot be a directory name
    // cannot be a project either, and 404 rather than 400 keeps this from
    // reporting which slugs exist (§5.4).
    slug = assertSlug(slug.normalize("NFC")); // tags are NFC (parse.ts)
    const user = store.aclUser(userId);
    const row = db.select().from(tables.projects).where(eq(tables.projects.key, `project/${slug}`)).get();
    const grants = store.grants();
    // The note is the project; the row is only its registration. Which note
    // that is never depends on who asks (store.projectNote): picked from the
    // caller's readable notes, a note of their own tagged `project/<slug>`
    // opened another team's documents and board (audit ACL-002).
    const note = store.projectNote(`project/${slug}`);
    if (!note || !canRead(user, note, grants)) throw new HttpError(404, "project not found");
    return { user, grants, row, note };
  };

  /** Every project the caller can see, for the board and for `list_projects`. */
  app.get("/api/projects", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const grants = store.grants();
    // Only projects whose slug every route accepts: a card that cannot be
    // opened is worse than none (REG-017). Joined by key, never by name, and
    // named by the project note the caller can read (COR-004).
    const defs = store.projects(user).filter((p) => p.kind !== "tag" || projectSlugOf(p.key) !== null);
    const rows = db.select().from(tables.projects).all().filter((p) => defs.some((d) => d.key === p.key));
    const progress = new Map(store.index.progress(user, grants, defs).map((p) => [p.key, p]));
    const readable = store.readable(user);
    const keyOf = new Map(readable.map((n) => [n.id, store.index.projectKeyOf(n, defs)]));

    // Dates per project, from its own open tasks: the Dashboard's Projects card
    // wants "what is next here and how much of it is late", and a project-level
    // `deadline:` answers neither (one note in the vault carries one). Computed
    // from the same task scan the board already runs, so this costs nothing.
    const today = iso(new Date());
    const openByProject = new Map<string, { nextDue: string | null; overdue: number }>();
    for (const t of store.index.tasks(user, grants, defs)) {
      const key = keyOf.get(t.noteId);
      if (t.checked || !key) continue;
      const cur = openByProject.get(key) ?? { nextDue: null, overdue: 0 };
      if (t.due) {
        if (t.due < today) cur.overdue++;
        else if (!cur.nextDue || t.due < cur.nextDue) cur.nextDue = t.due;
      }
      openByProject.set(key, cur);
    }

    return rows
      .map((p) => {
        const slug = p.key.startsWith("project/") ? p.key.slice("project/".length) : p.key;
        // The note may live anywhere (a personal project note is still a project),
        // and is the same note whoever asks (ACL-002); defs holds only readable ones.
        const def = defs.find((d) => d.key === p.key);
        const note = def ? store.projectNote(p.key) : undefined;
        const prog = progress.get(p.key);
        const dates = openByProject.get(p.key);
        const fm = (note?.frontmatter ?? {}) as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
        return {
          slug,
          key: p.key,
          name: projectName(note, p.name),
          domain: p.domain ?? null,
          noteId: note ? note.id : null,
          total: prog?.total ?? 0,
          done: prog?.done ?? 0,
          status: str(fm["status"]) || null,
          start: str(fm["start"]) || null,
          deadline: str(fm["deadline"]) || null,
          group: asGroup(fm["group"]) || null,
          nextDue: dates?.nextDue ?? null,
          overdue: dates?.overdue ?? 0,
        };
      })
      .filter((p) => p.noteId !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  /**
   * The whole workspace in one call: front-matter header, the note itself, the
   * sections it owns, its tasks, the contacts/companies it links to, and the
   * documents on disk. The web page and the MCP `get_project` tool both read this.
   */
  app.get<{ Params: { slug: string } }>("/api/projects/:slug", auth, async (req) => {
    const { user, grants, row, note } = openProject(req.userId, req.params.slug);
    const fm = note.frontmatter as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

    // Membership as every other surface decides it: against ALL projects, then
    // this one's key. With only this project's definition, a note tagged with
    // two projects counted in both here and in one on the board (COR-006).
    const defs = store.projects(user);
    const inProject = (n: IndexedNote | undefined) => !!row && !!n && store.index.projectKeyOf(n, defs) === row.key;
    const tasks = store.index.tasks(user, grants, defs).filter((t) => inProject(store.index.get(t.noteId)));
    const objects = db.select().from(tables.taskObjects).all();
    const objByKey = new Map(objects.map((o) => [`${o.noteId}:${o.blockId}`, o]));

    // People and companies are whatever the note links to that is a contact or a
    // company note — the picker writes those links, so the panel is just a view.
    const readable = (n: IndexedNote) => canRead(user, n, grants); // links resolve among the readable (ACL-005)
    // Who the note also links outside `## People`: Remove takes only the line
    // there, so they stay listed, and the page's Confirm says so.
    const inText = new Set<string>();
    for (const link of parseNote(writeSection(note.content, SEC.people, "")).links) {
      const target = store.index.resolveLink(link.target, undefined, readable);
      if (target) inText.add(target.id);
    }
    const linked = new Map<string, { id: string; title: string; kind: string; role: string; company: string; linkedin: string; path: string; inText: boolean }>();
    for (const link of note.links) {
      const target = store.index.resolveLink(link.target, undefined, readable);
      if (!target || linked.has(target.id)) continue;
      const kind = target.tags.some((t) => t.tag === "company") ? "company" : target.tags.some((t) => t.tag === "contact") ? "contact" : "";
      if (!kind) continue;
      const tfm = target.frontmatter as Record<string, unknown>;
      linked.set(target.id, {
        id: target.id,
        title: target.title,
        kind,
        role: str(tfm["role"]),
        company: str(tfm["company"]),
        linkedin: str(tfm["linkedin"]),
        path: target.path,
        inText: inText.has(target.id),
      });
    }

    // The project's own notes. `projectOf` already decides membership (nearest
    // project folder, else the first `project/` tag), so this is a view over the
    // same rule the task counts use — a note sitting in 04-Projects/<slug>/ that
    // carries no project tag deliberately does not appear here.
    const notes = store
      .readable(user)
      .filter((n) => n.id !== note.id && inProject(n))
      .map((n) => ({
        id: n.id,
        title: n.title,
        path: n.path,
        mtimeMs: n.mtimeMs ?? 0,
        tasks: n.tasks.length,
        done: n.tasks.filter((t) => t.checked).length,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const dir = filesDirFor(store.vaultRoot, req.params.slug);
    const files = fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile() && !e.name.startsWith("."))
          .map((e) => {
            const st = fs.statSync(path.join(dir, e.name));
            return { name: e.name, size: st.size, mtimeMs: st.mtimeMs, ext: path.extname(e.name).toLowerCase() };
          })
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
      : [];

    return {
      slug: req.params.slug,
      key: row?.key ?? `project/${req.params.slug}`,
      // The project is the note: its title: is the name (COR-004), not the row's,
      // which froze whichever tagged note was indexed first.
      name: projectName(note, row?.name ?? note.title),
      noteId: note.id,
      path: note.path,
      // One of the three, or null — not "" for an absent field, nor whatever text front matter holds.
      domain: asDomain(row?.domain ?? fm["domain"]) ?? null,
      status: str(fm["status"]),
      start: str(fm["start"]),
      deadline: str(fm["deadline"]),
      group: asGroup(fm["group"]),
      prompt: readSection(note.content, SEC.prompt),
      goals: readSectionItems(note.content, SEC.goals),
      goalsSource: readSection(note.content, SEC.goals),
      decisions: readSectionItems(note.content, SEC.decisions),
      inbox: readSectionItems(note.content, SEC.inbox),
      people: [...linked.values()],
      notes,
      files,
      content: note.content,
      canEdit: canEdit(user, note, grants),
      total: tasks.length,
      done: tasks.filter((t) => t.checked).length,
      tasks: tasks.map((t) => ({
        ...t,
        section: sectionOf(t),
        object: t.blockId ? (objByKey.get(`${t.noteId}:${t.blockId}`) ?? null) : null,
      })),
    };

    /**
     * What a step belongs to, for the grouped to-do: the nearest `##` heading
     * above it in the project note ("Research plan — due 19 October"), or, for a
     * step in one of the project's other notes, that note's title. The note's
     * own structure is the grouping, so reordering sections regroups the list.
     */
    function sectionOf(t: { noteId: string; line: number; noteTitle: string }): string {
      if (t.noteId !== note.id) return t.noteTitle;
      const above = note.headings.filter((h) => h.level <= 2 && h.line < t.line).at(-1);
      return above && above.level === 2 ? above.text : "Steps";
    }
  });

  // ---- Documents board ----------------------------------------------------

  /** The files in a project's folder, by name. */
  const projectFiles = (slug: string): string[] => {
    const dir = filesDirFor(store.vaultRoot, slug);
    return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name) : [];
  };
  const boardPath = (slug: string) => path.join(path.dirname(filesDirFor(store.vaultRoot, slug)), "documents.canvas");

  /**
   * The board, as saved — minus cards whose file is gone — plus a card for any
   * file that has none yet. A project that never had a board gets its files in
   * one box. Reading never writes: the file changes only when someone edits.
   */
  app.get<{ Params: { slug: string } }>("/api/projects/:slug/board", auth, async (req) => {
    const { user, grants, note } = openProject(req.userId, req.params.slug);
    const files = projectFiles(req.params.slug);
    const abs = boardPath(req.params.slug);
    let board;
    if (fs.existsSync(abs)) {
      try {
        board = placeMissing(normalizeBoard(JSON.parse(fs.readFileSync(abs, "utf8")), req.params.slug, new Set(files)), req.params.slug, files);
      } catch {
        // A canvas edited by hand into something unreadable is not a reason to
        // lose the documents view: start from the default, and say so.
        board = { ...defaultBoard(req.params.slug, files), unreadable: true };
      }
    } else board = defaultBoard(req.params.slug, files);
    return { ...board, canEdit: canEdit(user, note, grants) };
  });

  /** Save the board. Editors only; validated like a read, written atomically. */
  app.put<{ Params: { slug: string } }>("/api/projects/:slug/board", auth, async (req) => {
    const { user, grants, note } = openProject(req.userId, req.params.slug);
    if (!canEdit(user, note, grants)) throw new HttpError(403, "you cannot edit this project");
    let board;
    try {
      board = normalizeBoard(req.body, req.params.slug, new Set(projectFiles(req.params.slug)));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : "invalid board");
    }
    const abs = boardPath(req.params.slug);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeFileAtomic(abs, JSON.stringify(board, null, 2) + "\n");
    return board;
  });

  /** Header fields (front-matter) and the agent prompt (a section) in one place. */
  app.patch<{ Params: { slug: string } }>("/api/projects/:slug", auth, async (req) => {
    const { user, note } = openProject(req.userId, req.params.slug);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    // A section is written as sent, less the blank lines around it: indentation
    // and a line's trailing spaces are the user's (COR-005).
    const section = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "") : "");

    let next = note.content;
    if (body["prompt"] !== undefined) next = writeSection(next, SEC.prompt, section(body["prompt"]));
    if (body["goals"] !== undefined) next = writeSection(next, SEC.goals, section(body["goals"]));
    const fmFields = ["status", "start", "deadline", "domain"] as const;
    // A life area is written by its name, and replaces the old `domain:` that stood for it (1D).
    const area = body["area"] === undefined ? undefined : areaNamed(user, body["area"]);
    if (fmFields.some((k) => body[k] !== undefined) || body["group"] !== undefined || area !== undefined) {
      const before = next;
      next = updateFrontmatter(next, (d) => {
        for (const k of fmFields) if (body[k] !== undefined) d[k] = str(body[k]);
        // No group is no `group:` line, not an empty one.
        if (body["group"] !== undefined) d["group"] = asGroup(body["group"]) || undefined;
        if (area !== undefined) {
          d["area"] = area;
          d["domain"] = undefined;
        }
        return d;
      });
      if (area !== undefined && next === before && note.frontmatter["area"] !== area) throw new HttpError(409, "The project's properties can't be read, so its area wasn't changed. Open the note to fix them.");
    }
    // The prompt is owner-authored: an API token may not change it, here or
    // through a heading slipped into the goals (agentWrites.ts).
    store.write(user, note.path, next, undefined, undefined, { guard: req.viaToken ? tokenWriter : undefined });
    return { ok: true };
  });

  /** Append one dated line to a section: a decision, a captured thought, a person. */
  const appendLine = (slug: string, userId: string, heading: string, line: string) => {
    const { user, note } = openProject(userId, slug);
    store.write(user, note.path, appendToSection(note.content, heading, line));
  };

  app.post<{ Params: { slug: string } }>("/api/projects/:slug/decisions", auth, async (req) => {
    const text = String((req.body as { text?: string })?.text ?? "").trim().replace(/\n/g, " ");
    if (!text) throw new HttpError(400, "text required");
    // A decision is logged under the day it was made HERE, not in UTC —
    // one written at 00:30 used to carry yesterday's date.
    const today = isoLocal();
    appendLine(req.params.slug, req.userId, SEC.decisions, `- **${today}** — ${text}`);
    return { ok: true };
  });

  /** Quick capture: a thought, or a `- [ ]` task that joins the board immediately. */
  app.post<{ Params: { slug: string } }>("/api/projects/:slug/capture", auth, async (req) => {
    const body = (req.body ?? {}) as { text?: string; task?: boolean };
    const text = String(body.text ?? "").trim().replace(/\n/g, " ");
    if (!text) throw new HttpError(400, "text required");
    appendLine(req.params.slug, req.userId, body.task ? "Tasks" : SEC.inbox, body.task ? `- [ ] ${text}` : `- ${text}`);
    return { ok: true };
  });

  /** Attach a contact/company note by writing a real [[link]] into ## People. */
  app.post<{ Params: { slug: string } }>("/api/projects/:slug/people", auth, async (req) => {
    const { user, grants, note } = openProject(req.userId, req.params.slug);
    const noteId = String((req.body as { noteId?: string })?.noteId ?? "");
    const target = store.requireReadable(user, noteId);
    if (!canRead(user, target, grants)) throw new HttpError(404, "note not found");
    if (note.links.some((l) => store.index.resolveLink(l.target)?.id === target.id)) return { ok: true, already: true };
    store.write(user, note.path, appendToSection(note.content, SEC.people, `- ${linkTo(target)}`));
    return { ok: true };
  });

  /** Detach a person/company: drop their [[link]] line from ## People. */
  app.delete<{ Params: { slug: string; noteId: string } }>("/api/projects/:slug/people/:noteId", auth, async (req) => {
    const { user, note } = openProject(req.userId, req.params.slug);
    const target = store.requireReadable(user, req.params.noteId);
    const body = readSection(note.content, SEC.people);
    // Every line with a link — wiki or Markdown, by path, title or alias — that
    // lands on this note goes; the rest of the section stays as it is.
    const kept = body
      .split("\n")
      .filter((line) => !parseNote(line).links.some((l) => store.index.resolveLink(l.target)?.id === target.id))
      .join("\n")
      .replace(/^(?:[ \t]*\n)+/, "")
      .replace(/(?:\n[ \t]*)+$/, "");
    if (kept === body) return { ok: true, already: true };
    store.write(user, note.path, writeSection(note.content, SEC.people, kept));
    return { ok: true };
  });

  // ---- Documents ----------------------------------------------------------

  /** Upload a document into 04-Projects/<slug>/files/. Editors only. */
  app.post<{ Params: { slug: string } }>(
    "/api/projects/:slug/files",
    { preHandler: [app.authenticate], bodyLimit: MAX_UPLOAD + 2 * 1024 * 1024 },
    async (req) => {
      const { user, grants, note } = openProject(req.userId, req.params.slug);
      if (!canEdit(user, note, grants)) throw new HttpError(403, "you cannot edit this project");
      const body = (req.body ?? {}) as { name?: string; dataBase64?: string };
      const name = safeName(body.name);
      const unportable = unportableName(name);
      if (unportable) throw new HttpError(400, unportable);
      const data = Buffer.from(String(body.dataBase64 ?? ""), "base64");
      if (data.length === 0) throw new HttpError(400, "empty file");
      if (data.length > MAX_UPLOAD) throw new HttpError(413, "file too large (25 MB max)");

      const dir = filesDirFor(store.vaultRoot, req.params.slug);
      if (path.dirname(path.join(dir, name)) !== dir) throw new HttpError(400, "invalid filename");
      if (name.toLowerCase().endsWith(".md")) {
        // A .md in the vault is a note: the watcher indexes it and Obsidian
        // opens it. Stored as bytes, it skipped every rule a note is created
        // under — an editor of a project note kept in Engineering planted
        // notes in 04-Projects/<slug>/files, where they are a viewer, with any
        // #only tag or another note's id — so it is created as a note, by the
        // same write as New note, and named like any upload when taken.
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(data);
        } catch {
          throw new HttpError(415, "a .md file must be UTF-8 text");
        }
        const folder = path.relative(store.vaultRoot, dir).split(path.sep).join("/");
        for (let n = 1; n < 1000; n++) {
          const want = n === 1 ? name : numbered(name, n);
          try {
            const note = store.write(user, `${folder}/${want}`, text, undefined, undefined, { create: true, guard: req.viaToken ? tokenWriter : undefined });
            return { ok: true, name: path.posix.basename(note.path), unchanged: false, size: data.length };
          } catch (err) {
            const taken = store.index.getByPath(`${folder}/${want}`) || fs.existsSync(path.join(dir, want));
            if (!(err instanceof HttpError && err.statusCode === 409 && taken)) throw err;
          }
        }
        throw new HttpError(409, "no free name for that file");
      }
      // Never over an existing document: a second report.docx is kept as
      // "report (2).docx", and the answer says so (uploads.ts).
      const stored = storeUpload(dir, name, data);
      return { ok: true, name: stored.name, unchanged: stored.unchanged, size: data.length };
    },
  );

  app.get<{ Params: { slug: string; name: string } }>("/api/projects/:slug/files/:name", auth, async (req, reply) => {
    openProject(req.userId, req.params.slug); // readable project = readable documents
    const name = safeName(req.params.name);
    const dir = filesDirFor(store.vaultRoot, req.params.slug);
    const abs = path.join(dir, name);
    if (path.dirname(abs) !== dir || !fs.existsSync(abs)) throw new HttpError(404, "file not found");
    const ext = path.extname(name).toLowerCase();
    return reply
      .header("content-type", MIME[ext] ?? "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", contentDisposition(INLINE_OK.has(ext) ? "inline" : "attachment", name))
      .send(fs.createReadStream(abs));
  });

  /**
   * An .html document as the page it is, for the reader's frame: a saved
   * claude.ai artifact, a report. Its own scripts run, inside the sandbox
   * `pageSandbox.ts` describes (an opaque origin: no session, no reach into
   * Orrama). Read access as for the raw file; nothing but .html/.htm.
   *
   * `no-cache` plus Last-Modified, so the reader revalidates instead of
   * fetching again: a canvas copy with its screenshots inlined is 70 MB.
   */
  app.get<{ Params: { slug: string; name: string } }>("/api/projects/:slug/files/:name/page", auth, async (req, reply) => {
    openProject(req.userId, req.params.slug); // readable project = readable documents
    const name = safeName(req.params.name);
    if (!isPageName(name)) throw new HttpError(400, "only .html opens as a page");
    const dir = filesDirFor(store.vaultRoot, req.params.slug);
    const abs = path.join(dir, name);
    if (path.dirname(abs) !== dir || !fs.existsSync(abs)) throw new HttpError(404, "file not found");
    const modified = new Date(Math.floor(fs.statSync(abs).mtimeMs / 1000) * 1000);
    reply
      .header("content-security-policy", PAGE_CSP)
      .header("cache-control", "private, no-cache")
      .header("last-modified", modified.toUTCString())
      .header("referrer-policy", "no-referrer");
    const since = Date.parse(String(req.headers["if-modified-since"] ?? ""));
    if (!Number.isNaN(since) && since >= modified.getTime()) return reply.code(304).send();
    return reply.header("content-type", "text/html; charset=utf-8").send(fs.createReadStream(abs));
  });

  /**
   * A .docx as readable HTML, converted here rather than in the browser:
   * mammoth's browser build never settles under our bundler, and Node has the
   * APIs it actually wants. Output is mammoth's own restricted element set
   * (headings, lists, tables, emphasis, embedded images) — rebuilt from an
   * allowlist (docHtml.ts) before it is handed to a `dangerouslySetInnerHTML`.
   */
  app.get<{ Params: { slug: string; name: string } }>("/api/projects/:slug/files/:name/html", auth, async (req) => {
    openProject(req.userId, req.params.slug); // readable project = readable documents
    const name = safeName(req.params.name);
    if (!name.toLowerCase().endsWith(".docx")) throw new HttpError(400, "only .docx converts to HTML");
    const dir = filesDirFor(store.vaultRoot, req.params.slug);
    const abs = path.join(dir, name);
    if (path.dirname(abs) !== dir || !fs.existsSync(abs)) throw new HttpError(404, "file not found");
    // Every part inflated within DOCX_CAPS before mammoth sees a byte (zip.ts).
    const buf = await readOfficeFile(abs, DOCX_CAPS).catch(officeRefusal("document"));
    const { convertToHtml } = await import("mammoth");
    const res = await convertToHtml({ buffer: buf }).catch(officeRefusal("document"));
    // An allowlist rebuild, not a scrub: a link keeps its target only for
    // http(s), mailto, tel and #anchors (see docHtml.ts).
    return { html: sanitizeDocHtml(res.value), messages: res.messages.length };
  });

  /**
   * A spreadsheet as plain rows, parsed here for the same reason .docx is: Node
   * has the libraries, the browser bundle stays small, and the client only ever
   * receives text. Capped hard — a workbook is a data dump, and the reader is
   * for *reading*, not for loading 50k rows into the DOM.
   */
  app.get<{ Params: { slug: string; name: string } }>("/api/projects/:slug/files/:name/sheet", auth, async (req) => {
    openProject(req.userId, req.params.slug); // readable project = readable documents
    const name = safeName(req.params.name);
    if (!/\.(xlsx|xlsm)$/i.test(name)) throw new HttpError(400, "only .xlsx converts to rows");
    const dir = filesDirFor(store.vaultRoot, req.params.slug);
    const abs = path.join(dir, name);
    if (path.dirname(abs) !== dir || !fs.existsSync(abs)) throw new HttpError(404, "file not found");

    const buf = await readOfficeFile(abs, XLSX_CAPS).catch(officeRefusal("workbook"));
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    // exceljs's d.ts redeclares Buffer as an ArrayBuffer; at run time it takes a Node Buffer.
    await wb.xlsx.load(buf as unknown as ArrayBuffer).catch(officeRefusal("workbook"));

    const cell = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === "object") {
        const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[]; hyperlink?: string };
        if (o.richText) return o.richText.map((r) => r.text).join("");
        if (o.result !== undefined) return cell(o.result);
        if (o.text !== undefined) return String(o.text);
        if (o.hyperlink) return String(o.hyperlink);
        return "";
      }
      return String(v);
    };

    const sheets = wb.worksheets.slice(0, MAX_SHEETS).map((ws) => {
      const rows: string[][] = [];
      let truncated = false;
      ws.eachRow({ includeEmpty: false }, (row, n) => {
        if (n > MAX_ROWS) {
          truncated = true;
          return;
        }
        // `row.values` is 1-based AND sparse: `.map` skips the holes, which then
        // serialise as nulls and reach the client as non-strings. Build it dense.
        const values = Array.isArray(row.values) ? row.values : [];
        const width = Math.min(Math.max(values.length - 1, 0), MAX_COLS);
        rows.push(Array.from({ length: width }, (_, i) => cell(values[i + 1])));
      });
      const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
      return {
        name: ws.name,
        rows: rows.map((r) => [...r, ...Array(Math.max(0, width - r.length)).fill("")]),
        truncated: truncated || ws.actualColumnCount > MAX_COLS,
        totalRows: ws.actualRowCount,
      };
    });
    return { sheets, sheetCount: wb.worksheets.length };
  });

  /**
   * A .pptx as slides — text, tables, notes and raster images as data, never
   * markup (slides.ts). Caps live there; a deck that is not a deck is a 422,
   * not a 500.
   */
  app.get<{ Params: { slug: string; name: string } }>("/api/projects/:slug/files/:name/slides", auth, async (req) => {
    openProject(req.userId, req.params.slug); // readable project = readable documents
    const name = safeName(req.params.name);
    if (!name.toLowerCase().endsWith(".pptx")) throw new HttpError(400, "only .pptx converts to slides");
    const dir = filesDirFor(store.vaultRoot, req.params.slug);
    const abs = path.join(dir, name);
    if (path.dirname(abs) !== dir || !fs.existsSync(abs)) throw new HttpError(404, "file not found");
    if (fs.statSync(abs).size > SLIDE_CAPS.fileBytes) throw new HttpError(413, "presentation too large to preview");
    try {
      return readPptx(fs.readFileSync(abs));
    } catch {
      throw new HttpError(422, "could not read this presentation");
    }
  });

  app.delete<{ Params: { slug: string; name: string } }>("/api/projects/:slug/files/:name", auth, async (req) => {
    const { user, grants, note } = openProject(req.userId, req.params.slug);
    if (!canEdit(user, note, grants)) throw new HttpError(403, "you cannot edit this project");
    const name = safeName(req.params.name);
    const dir = filesDirFor(store.vaultRoot, req.params.slug);
    const abs = path.join(dir, name);
    if (path.dirname(abs) !== dir || !fs.existsSync(abs)) throw new HttpError(404, "file not found");
    fs.unlinkSync(abs);
    return { ok: true };
  });
}
