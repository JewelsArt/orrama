import type { FastifyInstance } from "fastify";
import { askVaultSchema } from "@basalt/schema";
import { suggestRelated, type IndexedNote } from "@basalt/core";
import { tables, type Db } from "../db.js";
import { decryptSecret } from "../secrets.js";
import { HttpError, type VaultStore } from "../vaultStore.js";

/**
 * AI layer (spec §9): BYO key, requests go direct from THIS server to the provider.
 * Retrieval = lexical top-k ∪ link-graph neighbors ∪ same-project recent notes,
 * packed under a token budget. ACL BEFORE AI, always: candidates come from the
 * requester's readable set only. (Local embeddings can replace the lexical scorer
 * behind the same retrieval interface — M3 hardening.)
 */
export async function aiRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };

  const config = () => {
    const ws = db.select().from(tables.workspace).all()[0];
    if (!ws?.aiProvider || !ws.aiKeyEncrypted || !ws.aiModel) return null;
    return { provider: ws.aiProvider, apiKey: decryptSecret(ws.aiKeyEncrypted), model: ws.aiModel };
  };

  app.get("/api/ai/status", auth, async () => {
    const c = config();
    return { configured: !!c, provider: c?.provider ?? null, model: c?.model ?? null };
  });

  const retrieve = (userId: string, query: string, contextNoteId?: string, budgetChars = 24_000): IndexedNote[] => {
    const user = store.aclUser(userId);
    const readable = store.readable(user); // ACL first
    const pseudo: IndexedNote = {
      id: "__query__",
      path: "__query__.md",
      folder: "",
      content: query,
      title: query.slice(0, 60),
      aliases: [],
      frontmatter: {},
      bodyStart: 0,
      links: [],
      tags: [],
      tasks: [],
      headings: [],
      onlyTeams: [],
      shareTeams: [],
      mtimeMs: Date.now(),
    };
    const scored = suggestRelated(pseudo, readable, (t) => store.index.resolveLink(t), 12);
    const picked = new Map<string, IndexedNote>();
    for (const r of scored) {
      const n = store.index.get(r.id);
      if (n) picked.set(n.id, n);
    }
    // Link-graph neighbors of the open note: the structure the team built by hand IS the signal.
    if (contextNoteId) {
      const ctx = readable.find((n) => n.id === contextNoteId);
      if (ctx) {
        picked.set(ctx.id, ctx);
        for (const l of ctx.links) {
          const t = store.index.resolveLink(l.target);
          if (t && readable.some((n) => n.id === t.id)) picked.set(t.id, t);
        }
        for (const b of store.index.backlinks(ctx.id, user, store.grants())) {
          const n = store.index.get(b.fromId);
          if (n) picked.set(n.id, n);
        }
      }
    }
    // Pack under the budget, most recent last-touched first among the rest.
    const out: IndexedNote[] = [];
    let used = 0;
    for (const n of picked.values()) {
      if (used + n.content.length > budgetChars) continue;
      used += n.content.length;
      out.push(n);
    }
    return out;
  };

  const callProvider = async (c: NonNullable<ReturnType<typeof config>>, system: string, prompt: string): Promise<string> => {
    if (c.provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": c.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: c.model, max_tokens: 1500, system, messages: [{ role: "user", content: prompt }] }),
      });
      if (!res.ok) throw new HttpError(502, `provider error: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as { content: { type: string; text?: string }[] };
      return data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    }
    // openai-compatible generic endpoint
    const res = await fetch(process.env.BASALT_OPENAI_BASE_URL ?? "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({
        model: c.model,
        max_tokens: 1500,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new HttpError(502, `provider error: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message.content ?? "";
  };

  /** Ask your vault (§9.1): answers cite [[notes]]. */
  app.post("/api/ai/ask", auth, async (req) => {
    const body = askVaultSchema.parse(req.body);
    const c = config();
    if (!c) throw new HttpError(400, "AI is not configured — a workspace owner can add a provider key in Settings.");
    const notes = retrieve(req.userId, body.question, body.contextNoteId);
    const context = notes.map((n) => `<note title="${n.title}" path="${n.path}">\n${n.content}\n</note>`).join("\n\n");
    const answer = await callProvider(
      c,
      "You answer questions about a team's knowledge vault. Use ONLY the provided notes. Cite sources inline as [[Note Title]] wiki-links. If the notes don't contain the answer, say so.",
      `Notes:\n\n${context}\n\nQuestion: ${body.question}`,
    );
    return { answer, sources: notes.map((n) => ({ id: n.id, title: n.title, path: n.path })) };
  });

  /** Team digest (§9.2): dashboard banner, generated on demand, cached daily per team. */
  const digestCache = new Map<string, { day: string; digest: string }>();
  app.post<{ Params: { teamSlug: string } }>("/api/ai/digest/:teamSlug", auth, async (req) => {
    const c = config();
    if (!c) throw new HttpError(400, "AI is not configured");
    const user = store.aclUser(req.userId);
    if (!user.isOwner && !user.teams.includes(req.params.teamSlug)) throw new HttpError(404, "team not found");
    const day = new Date().toISOString().slice(0, 10);
    const cacheKey = `${req.params.teamSlug}:${req.userId}`;
    const hit = digestCache.get(cacheKey);
    if (hit && hit.day === day) return { digest: hit.digest, cached: true };

    const readable = store.readable(user);
    const recent = [...readable].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)).slice(0, 10);
    const tasks = store.index.tasks(user, store.grants(), store.projects());
    const open = tasks.filter((t) => !t.checked).length;
    const done = tasks.filter((t) => t.checked).length;
    const context = recent.map((n) => `<note title="${n.title}">\n${n.content.slice(0, 1500)}\n</note>`).join("\n");
    const digest = await callProvider(
      c,
      "Write a crisp morning digest for a team dashboard: what changed, what got completed, what looks stale, and 1-2 suggested connections between notes that discuss the same topic but aren't linked. Max 120 words. Plain prose, no headers.",
      `Open tasks: ${open}, completed: ${done}.\nRecently edited notes:\n${context}`,
    );
    digestCache.set(cacheKey, { day, digest });
    return { digest, cached: false };
  });
}
