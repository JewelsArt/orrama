import type { FastifyInstance } from "fastify";
import type { VaultStore } from "../vaultStore.js";

/**
 * What Notes home says about the vault (structure.md §2.3, R7): the notes you pinned and the
 * counts that left Today (§2.1 "Gone": Vault overview, Notes written). The tree already gives
 * every note's path, area and open tasks; this adds what only the index knows — front matter,
 * a note's kind, and done tasks. Everything is the reader's readable vault (ACL-filtered).
 *
 * A pin is the note's own front matter, `pinned: true` (Jules's choice, 11 Oct 2026): it
 * follows the note to every device and shows in Obsidian. Saved conversations — a note of
 * kind "conversation", or a transcript in `Claude Sessions/` (home.ts counts those apart too)
 * — are counted as conversations, not as notes written.
 */
const SESSION_DIR = "Claude Sessions/";

/** `pinned: true`, as YAML or as a hand-typed word. */
export const isPinned = (v: unknown): boolean => v === true || (typeof v === "string" && /^(true|yes)$/i.test(v.trim()));

export async function notesHomeRoutes(app: FastifyInstance, store: VaultStore) {
  app.get("/api/notes/overview", { preHandler: [app.authenticate] }, async (req) => {
    const user = store.aclUser(req.userId);
    const readable = store.readable(user);
    const conversation = (n: (typeof readable)[number]) => n.kind === "conversation" || n.path.startsWith(SESSION_DIR);
    const tasks = store.index.tasks(user, store.grants(), store.projects(user));
    return {
      pinned: readable
        .filter((n) => isPinned(n.frontmatter["pinned"]))
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
        .map((n) => n.id),
      notes: readable.filter((n) => !conversation(n)).length,
      conversations: readable.filter(conversation).length,
      openTasks: tasks.filter((t) => !t.checked).length,
      doneTasks: tasks.filter((t) => t.checked).length,
    };
  });
}
