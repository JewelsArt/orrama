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
import { appendToSection, canEdit, canRead, readSection, readSectionItems, updateFrontmatter, writeSection } from "@basalt/core";
import { tables, type Db } from "../db.js";
import { HttpError, type VaultStore } from "../vaultStore.js";

export const PROJECTS_DIR = "04-Projects";
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

/** The starter body for a new project note — carries the tags that put it on the board. */
export function projectNoteScaffold(name: string, slug: string, domain?: Domain): string {
  return [
    "---",
    `title: ${name}`,
    "tags:",
    "  - project",
    `  - project/${slug}`,
    "  - active",
    ...(domain ? [`domain: ${domain}`] : []),
    "---",
    "",
    `# ${name}`,
    "",
    "> New project. Add checkbox tasks below — they flow to the board, planning, and dashboard.",
    "",
    "- [ ] First step",
    "",
  ].join("\n");
}

const isProjectTag = (t: { line: number; tag: string }) => t.line === 0 && /^project\/[a-z0-9]/i.test(t.tag);

/** Sections the workspace owns inside the project note. Headings, not database rows. */
const SEC = { goals: "Goals", prompt: "Prompt", decisions: "Decisions", inbox: "Inbox", people: "People" } as const;

/**
 * A slug is a path segment, so it gets the grammar of one.
 *
 * `openProject` resolves a slug by matching any readable note's tag, and
 * front-matter tags reach `normalizeTag` without passing TAG_RE — so a note
 * carrying `tags: ["project/../../../../apps/web/dist"]` used to hand that
 * string straight to path.join. noteWriteSchema's no-`..` rule guards the note's
 * PATH, not its contents, and `safeName` hardens the filename only. The result
 * was mkdirSync creating a directory anywhere on disk and an upload landing in
 * a statically-served folder: arbitrary write, then stored XSS on the app's own
 * origin. The AI agent's write_note tool takes a model-supplied path, so a
 * hostile email could start the chain.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

const assertSlug = (slug: string): string => {
  if (!SLUG_RE.test(slug)) throw new HttpError(404, "project not found");
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
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f]/.test(raw)) throw new HttpError(400, "invalid filename");
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

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function projectRoutes(app: FastifyInstance, store: VaultStore, db: Db) {
  const auth = { preHandler: [app.authenticate] };

  /** Scaffold a fresh project note under 04-Projects/ and put it on the board. */
  app.post("/api/projects", auth, async (req) => {
    const body = (req.body ?? {}) as { name?: string; domain?: string };
    const name = body.name?.trim();
    if (!name || name.length > 120) throw new HttpError(400, "name required (max 120)");
    const slug = slugify(name);
    const relPath = `${PROJECTS_DIR}/${slug}.md`;
    if (store.index.getByPath(relPath)) throw new HttpError(409, "a project note with that name already exists");
    const user = store.aclUser(req.userId);
    const note = store.write(user, relPath, projectNoteScaffold(name, slug, asDomain(body.domain)));
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

  // ---- The workspace ------------------------------------------------------

  /** Resolve <slug> to its registered row + note, ACL-checked (404, never 403). */
  const openProject = (userId: string, slug: string) => {
    // Before anything is looked up: a slug that cannot be a directory name
    // cannot be a project either, and 404 rather than 400 keeps this from
    // reporting which slugs exist (§5.4).
    assertSlug(slug);
    const user = store.aclUser(userId);
    const row = db.select().from(tables.projects).where(eq(tables.projects.key, `project/${slug}`)).get();
    const grants = store.grants();
    // The note is the project; the row is only its registration.
    const note =
      store.index.getByPath(`${PROJECTS_DIR}/${slug}.md`) ??
      store.readable(user).find((n) => n.tags.some((t) => t.tag === `project/${slug}`));
    if (!note || !canRead(user, note, grants)) throw new HttpError(404, "project not found");
    return { user, grants, row, note };
  };

  /** Every project the caller can see, for the board and for `list_projects`. */
  app.get("/api/projects", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const grants = store.grants();
    const rows = db.select().from(tables.projects).all().filter((p) => !p.hidden);
    const defs = rows.map((p) => ({ kind: p.kind, key: p.key, name: p.name }));
    const progress = new Map(store.index.progress(user, grants, defs).map((p) => [p.project, p]));
    const readable = store.readable(user);

    // Dates per project, from its own open tasks: the Dashboard's Projects card
    // wants "what is next here and how much of it is late", and a project-level
    // `deadline:` answers neither (one note in the vault carries one). Computed
    // from the same task scan the board already runs, so this costs nothing.
    const today = iso(new Date());
    const openByProject = new Map<string, { nextDue: string | null; overdue: number }>();
    for (const t of store.index.tasks(user, grants, defs)) {
      if (t.checked || !t.project) continue;
      const cur = openByProject.get(t.project) ?? { nextDue: null, overdue: 0 };
      if (t.due) {
        if (t.due < today) cur.overdue++;
        else if (!cur.nextDue || t.due < cur.nextDue) cur.nextDue = t.due;
      }
      openByProject.set(t.project, cur);
    }

    return rows
      .map((p) => {
        const slug = p.key.startsWith("project/") ? p.key.slice("project/".length) : p.key;
        // The note may live anywhere (a personal project note is still a project),
        // so match on the tag and fall back to the conventional path.
        const note =
          readable.find((n) => n.tags.some((t) => t.tag === p.key)) ?? readable.find((n) => n.path === `${PROJECTS_DIR}/${slug}.md`);
        const prog = progress.get(p.name);
        const dates = openByProject.get(p.name);
        const fm = (note?.frontmatter ?? {}) as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
        return {
          slug,
          key: p.key,
          name: p.name,
          domain: p.domain ?? null,
          noteId: note ? note.id : null,
          total: prog?.total ?? 0,
          done: prog?.done ?? 0,
          status: str(fm["status"]) || null,
          start: str(fm["start"]) || null,
          deadline: str(fm["deadline"]) || null,
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

    const defs = row ? [{ kind: row.kind, key: row.key, name: row.name }] : [];
    const tasks = store.index.tasks(user, grants, defs).filter((t) => t.project === row?.name);
    const objects = db.select().from(tables.taskObjects).all();
    const objByKey = new Map(objects.map((o) => [`${o.noteId}:${o.blockId}`, o]));

    // People and companies are whatever the note links to that is a contact or a
    // company note — the picker writes those links, so the panel is just a view.
    const linked = new Map<string, { id: string; title: string; kind: string; role: string; company: string; linkedin: string; path: string }>();
    for (const link of note.links) {
      const target = store.index.resolveLink(link.target);
      if (!target || !canRead(user, target, grants) || linked.has(target.id)) continue;
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
      });
    }

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
      name: row?.name ?? note.title,
      noteId: note.id,
      path: note.path,
      domain: row?.domain ?? str(fm["domain"]) ?? null,
      status: str(fm["status"]),
      start: str(fm["start"]),
      deadline: str(fm["deadline"]),
      prompt: readSection(note.content, SEC.prompt),
      goals: readSectionItems(note.content, SEC.goals),
      decisions: readSectionItems(note.content, SEC.decisions),
      inbox: readSectionItems(note.content, SEC.inbox),
      people: [...linked.values()],
      files,
      content: note.content,
      canEdit: canEdit(user, note, grants),
      total: tasks.length,
      done: tasks.filter((t) => t.checked).length,
      tasks: tasks.map((t) => ({ ...t, object: t.blockId ? (objByKey.get(`${t.noteId}:${t.blockId}`) ?? null) : null })),
    };
  });

  /** Header fields (front-matter) and the agent prompt (a section) in one place. */
  app.patch<{ Params: { slug: string } }>("/api/projects/:slug", auth, async (req) => {
    const { user, note } = openProject(req.userId, req.params.slug);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

    let next = note.content;
    if (body["prompt"] !== undefined) next = writeSection(next, SEC.prompt, str(body["prompt"]));
    if (body["goals"] !== undefined) next = writeSection(next, SEC.goals, str(body["goals"]));
    const fmFields = ["status", "start", "deadline", "domain"] as const;
    if (fmFields.some((k) => body[k] !== undefined)) {
      next = updateFrontmatter(next, (d) => {
        for (const k of fmFields) if (body[k] !== undefined) d[k] = str(body[k]);
        return d;
      });
    }
    store.write(user, note.path, next);
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
    const today = new Date().toISOString().slice(0, 10);
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
    store.write(user, note.path, appendToSection(note.content, SEC.people, `- [[${target.title}]]`));
    return { ok: true };
  });

  /** Detach a person/company: drop their [[link]] line from ## People. */
  app.delete<{ Params: { slug: string; noteId: string } }>("/api/projects/:slug/people/:noteId", auth, async (req) => {
    const { user, note } = openProject(req.userId, req.params.slug);
    const target = store.requireReadable(user, req.params.noteId);
    const body = readSection(note.content, SEC.people);
    const kept = body
      .split("\n")
      .filter((line) => {
        const m = /\[\[([^\]|#]+)/.exec(line);
        return !m || store.index.resolveLink(m[1]!)?.id !== target.id;
      })
      .join("\n")
      .trim();
    if (kept === body.trim()) return { ok: true, already: true };
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
      const data = Buffer.from(String(body.dataBase64 ?? ""), "base64");
      if (data.length === 0) throw new HttpError(400, "empty file");
      if (data.length > MAX_UPLOAD) throw new HttpError(413, "file too large (25 MB max)");

      const dir = filesDirFor(store.vaultRoot, req.params.slug);
      fs.mkdirSync(dir, { recursive: true });
      const abs = path.join(dir, name);
      if (path.dirname(abs) !== dir) throw new HttpError(400, "invalid filename");
      fs.writeFileSync(abs, data);
      return { ok: true, name, size: data.length };
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
      .header("content-disposition", `${INLINE_OK.has(ext) ? "inline" : "attachment"}; filename="${name.replace(/"/g, "")}"`)
      .send(fs.createReadStream(abs));
  });

  /**
   * A .docx as readable HTML, converted here rather than in the browser:
   * mammoth's browser build never settles under our bundler, and Node has the
   * APIs it actually wants. Output is mammoth's own restricted element set
   * (headings, lists, tables, emphasis, embedded images) — scrubbed of scripts
   * and event handlers before it is handed to a `dangerouslySetInnerHTML`.
   */
  app.get<{ Params: { slug: string; name: string } }>("/api/projects/:slug/files/:name/html", auth, async (req) => {
    openProject(req.userId, req.params.slug); // readable project = readable documents
    const name = safeName(req.params.name);
    if (!name.toLowerCase().endsWith(".docx")) throw new HttpError(400, "only .docx converts to HTML");
    const dir = filesDirFor(store.vaultRoot, req.params.slug);
    const abs = path.join(dir, name);
    if (path.dirname(abs) !== dir || !fs.existsSync(abs)) throw new HttpError(404, "file not found");
    const { convertToHtml } = await import("mammoth");
    const res = await convertToHtml({ path: abs });
    const html = res.value
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
      .replace(/\son\w+\s*=\s*'[^']*'/gi, "");
    return { html, messages: res.messages.length };
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

    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(abs);

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
