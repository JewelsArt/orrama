/**
 * Projects as notes: a note becomes a board project purely by carrying a
 * front-matter `project/<slug>` tag (VaultStore.syncProjectRow registers it).
 * These routes are the ergonomic front door — scaffold a fresh project note, or
 * promote an existing note — shared by the web UI, the in-app AI, and MCP.
 */
import type { FastifyInstance } from "fastify";
import { updateFrontmatter } from "@basalt/core";
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

export async function projectRoutes(app: FastifyInstance, store: VaultStore) {
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
}
