import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { projectName, projectSlugOf } from "@orrama/core";
import { aiConfigSchema, aiInstructionsSchema, grantSchema, inviteCreateSchema, projectCreateSchema, teamCreateSchema } from "@orrama/schema";
import { tables, type Db } from "../db.js";
import { encryptSecret } from "../secrets.js";
import { chatgptCredentials, disconnect as disconnectChatGpt, finishSignIn, listModels as chatgptModels, SIGNED_IN_PAGE, SIWC, startSignIn } from "../chatgpt.js";
import { env } from "../env.js";
import { HttpError, type VaultStore } from "../vaultStore.js";
import { sessionOnly } from "./auth.js";

/** Workspace administration. v1 keeps it simple: owners only. */
export async function adminRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const requireOwner = async (userId: string) => {
    const user = store.aclUser(userId);
    if (!user.isOwner) throw new HttpError(403, "workspace owner required");
    return user;
  };
  // Every admin route is session-only: invites mint accounts, grants and
  // teams decide who reads what, and the AI settings decide where the stored
  // key is sent (audit SEC-004). None of it is for an API token.
  const auth = { preHandler: [app.authenticate], config: sessionOnly("workspace settings are changed from a signed-in session, not with an API token") };

  /** Everything the admin console needs in one round-trip. */
  app.get("/api/admin/overview", auth, async (req) => {
    await requireOwner(req.userId);
    const teams = db.select().from(tables.teams).all();
    const memberships = db.select().from(tables.memberships).all();
    const users = db
      .select({ id: tables.users.id, username: tables.users.username, displayName: tables.users.displayName, isOwner: tables.users.isOwner })
      .from(tables.users)
      .all();
    // Folder list from the vault itself (owners see all), personal space excluded —
    // it is permissioned by path, not by grants.
    const folders = new Set<string>();
    for (const n of store.index.all()) {
      if (n.folder.startsWith("Personal")) continue;
      let cur = n.folder;
      while (cur !== "") {
        folders.add(cur);
        const i = cur.lastIndexOf("/");
        cur = i === -1 ? "" : cur.slice(0, i);
      }
    }
    folders.add("");
    const ws = db.select().from(tables.workspace).all()[0];
    return {
      teams: teams.map((t) => ({
        ...t,
        members: memberships.filter((m) => m.teamId === t.id).map((m) => m.userId),
      })),
      users,
      folders: [...folders].sort(),
      grants: db.select().from(tables.folderGrants).all(),
      projects: db.select().from(tables.projects).all(),
      invites: db.select().from(tables.invites).all().filter((i) => !i.usedBy && i.expiresAt > Date.now()),
      ai: { provider: ws?.aiProvider ?? null, model: ws?.aiModel ?? null, configured: !!ws?.aiKeyEncrypted, instructions: ws?.aiInstructions ?? "", baseUrl: ws?.aiBaseUrl ?? "" },
    };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/grants/:id", auth, async (req) => {
    await requireOwner(req.userId);
    db.delete(tables.folderGrants).where(eq(tables.folderGrants.id, req.params.id)).run();
    return { ok: true };
  });

  app.post("/api/admin/teams", auth, async (req) => {
    await requireOwner(req.userId);
    const body = teamCreateSchema.parse(req.body);
    const team = { id: `t-${crypto.randomUUID().slice(0, 8)}`, slug: body.slug, name: body.name, color: body.color, icon: body.icon ?? "●" };
    db.insert(tables.teams).values(team).run();
    return team;
  });

  app.post<{ Params: { teamId: string } }>("/api/admin/teams/:teamId/members", auth, async (req) => {
    await requireOwner(req.userId);
    const { userId } = (req.body ?? {}) as { userId?: string };
    if (!userId) throw new HttpError(400, "userId required");
    db.insert(tables.memberships)
      .values({ id: `m-${crypto.randomUUID().slice(0, 8)}`, userId, teamId: req.params.teamId })
      .onConflictDoNothing()
      .run();
    return { ok: true };
  });

  app.post("/api/admin/grants", auth, async (req) => {
    await requireOwner(req.userId);
    const body = grantSchema.parse(req.body);
    db.insert(tables.folderGrants)
      .values({ id: `g-${crypto.randomUUID().slice(0, 8)}`, teamId: body.teamId, folder: body.folder, role: body.role })
      .onConflictDoUpdate({ target: [tables.folderGrants.teamId, tables.folderGrants.folder], set: { role: body.role } })
      .run();
    return { ok: true };
  });

  app.get("/api/admin/grants", auth, async (req) => {
    await requireOwner(req.userId);
    return db.select().from(tables.folderGrants).all();
  });

  app.post("/api/admin/projects", auth, async (req) => {
    await requireOwner(req.userId);
    const body = projectCreateSchema.parse(req.body);
    const project = { id: `p-${crypto.randomUUID().slice(0, 8)}`, kind: body.kind, key: body.key, name: body.name, teamId: body.teamId ?? null };
    db.insert(tables.projects).values(project).run();
    return project;
  });

  /** Remove a project from the board. We set hidden=1 rather than delete: projects
   *  auto-register from `project/<slug>` note tags, so a hard delete would just be
   *  resurrected on the next re-index. The note (and its tag) is untouched. */
  app.delete<{ Params: { id: string } }>("/api/admin/projects/:id", auth, async (req) => {
    await requireOwner(req.userId);
    const project = db.select().from(tables.projects).where(eq(tables.projects.id, req.params.id)).get();
    if (!project) throw new HttpError(404, "project not found");
    db.update(tables.projects).set({ hidden: 1 }).where(eq(tables.projects.id, req.params.id)).run();
    return { ok: true };
  });

  /**
   * The projects removed from the board, for its "Removed from the board" shelf (Jules,
   * 23 Oct 2026): each with its name as its note says it, and Put back below. A project whose
   * note is gone is listed by the name it was registered under.
   */
  app.get("/api/admin/projects/hidden", auth, async (req) => {
    await requireOwner(req.userId);
    return db
      .select()
      .from(tables.projects)
      .all()
      .filter((p) => p.hidden && p.kind === "tag" && projectSlugOf(p.key) !== null)
      .map((p) => ({ id: p.id, slug: projectSlugOf(p.key)!, name: projectName(store.projectNote(p.key), p.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  /** Put a removed project back on the board: the flag goes; the note never changed. */
  app.post<{ Params: { id: string } }>("/api/admin/projects/:id/back", auth, async (req) => {
    await requireOwner(req.userId);
    const project = db.select().from(tables.projects).where(eq(tables.projects.id, req.params.id)).get();
    if (!project) throw new HttpError(404, "project not found");
    db.update(tables.projects).set({ hidden: null }).where(eq(tables.projects.id, req.params.id)).run();
    return { ok: true };
  });

  app.post("/api/admin/invites", auth, async (req) => {
    await requireOwner(req.userId);
    const body = inviteCreateSchema.parse(req.body);
    const invite = {
      token: crypto.randomBytes(24).toString("base64url"),
      teamIds: JSON.stringify(body.teamIds),
      createdBy: req.userId,
      expiresAt: Date.now() + body.expiresInHours * 3600_000,
      usedBy: null,
    };
    db.insert(tables.invites).values(invite).run();
    return invite;
  });

  /** The AI settings, for Settings → AI. Never the key: only whether one is stored. */
  app.get("/api/admin/ai", auth, async (req) => {
    await requireOwner(req.userId);
    const ws = db.select().from(tables.workspace).all()[0];
    const gpt = chatgptCredentials(db);
    const configured = ws?.aiProvider === "chatgpt" ? !!gpt && !!ws.aiModel : !!ws?.aiKeyEncrypted;
    return {
      provider: ws?.aiProvider ?? null,
      model: ws?.aiModel ?? null,
      configured,
      instructions: ws?.aiInstructions ?? "",
      baseUrl: ws?.aiBaseUrl ?? "",
      chatgpt: { connected: !!gpt, email: gpt?.email ?? null, manageUsage: SIWC.manageUsage },
    };
  });

  // ---- Sign in with ChatGPT (chatgpt.ts) ------------------------------------

  /**
   * The sign-in URL. OpenAI sends the browser back to 127.0.0.1 on this
   * machine, so it has to start from a browser on this machine: from a phone
   * it would land nowhere. `wait: true` (the desktop app, whose window sends
   * auth.openai.com to the system browser): the page stays and watches
   * GET /api/admin/ai, and the browser is told it can close. Without it (a
   * browser tab on this computer), that tab goes to OpenAI and comes back.
   */
  app.post("/api/admin/ai/chatgpt/start", auth, async (req) => {
    await requireOwner(req.userId);
    const { wait } = z.object({ wait: z.boolean().optional() }).parse(req.body ?? {});
    const local = (h: string) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(h);
    if (!local(req.hostname)) throw new HttpError(400, "Sign in with ChatGPT from Orrama on the computer it runs on — OpenAI returns to that computer.");
    if (wait) return { url: startSignIn(db, env.port, null) };
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    let returnTo = `http://127.0.0.1:${env.port}`;
    try {
      const o = new URL(origin);
      if (o.protocol === "http:" && local(o.hostname)) returnTo = o.origin;
    } catch {
      // no usable Origin: back to the server itself
    }
    return { url: startSignIn(db, env.port, returnTo) };
  });

  /** Where OpenAI sends the browser after sign-in. Unauthenticated by nature; the one-time state is the check. */
  app.get("/callback", async (req, reply) => {
    try {
      const { returnTo } = await finishSignIn(db, req.query as Record<string, string | undefined>);
      if (returnTo === null) return reply.type("text/html; charset=utf-8").send(SIGNED_IN_PAGE);
      return reply.redirect(`${returnTo}/?ai=chatgpt-connected`);
    } catch (err) {
      const msg = err instanceof HttpError ? err.message : "ChatGPT sign-in failed.";
      const esc = msg.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
      return reply
        .code(err instanceof HttpError ? err.statusCode : 500)
        .type("text/html; charset=utf-8")
        .send(`<!doctype html><meta charset="utf-8"><title>Orrama</title><p>${esc}</p><p><a href="/">Back to Orrama</a></p>`);
    }
  });

  /** The models the connected plan offers, for Settings → AI. */
  app.get("/api/admin/ai/chatgpt/models", auth, async (req) => {
    await requireOwner(req.userId);
    return chatgptModels(db);
  });

  app.post("/api/admin/ai/chatgpt/disconnect", auth, async (req) => {
    await requireOwner(req.userId);
    disconnectChatGpt(db);
    return { ok: true };
  });

  /** BYO AI key (spec §9): stored encrypted at rest, never proxied through Orrama-the-company. */
  app.post("/api/admin/ai", auth, async (req) => {
    await requireOwner(req.userId);
    const body = aiConfigSchema.parse(req.body);
    const ws = db.select().from(tables.workspace).all()[0];
    if (!ws) throw new HttpError(500, "workspace not initialized");
    if (body.provider === "chatgpt") {
      // No key: the plan is the credential (sign in first). Only the model changes.
      if (!chatgptCredentials(db)) throw new HttpError(400, "sign in with ChatGPT first");
      db.update(tables.workspace).set({ aiProvider: "chatgpt", aiModel: body.model }).where(eq(tables.workspace.id, ws.id)).run();
      return { ok: true, provider: body.provider, model: body.model };
    }
    // Blank key = keep the existing one; but the first save must include a key.
    const newKey = body.apiKey && body.apiKey.length >= 10 ? body.apiKey : undefined;
    if (!newKey && !ws.aiKeyEncrypted) throw new HttpError(400, "an API key is required");
    // The stored key is sent, as a bearer token, to the openai-compatible
    // address on the next AI call. Keeping it while changing that address
    // handed the key to whoever the new address belongs to, and the key is
    // otherwise never shown (audit SEC-004). A new address needs the key typed
    // again. (Anthropic and Gemini go to their own fixed hosts, so switching
    // between them, or back from ChatGPT, still keeps it.)
    if (!newKey && body.provider === "openai-compatible" && (body.baseUrl || null) !== (ws.aiBaseUrl ?? null)) {
      throw new HttpError(400, "enter the API key again to use it with a new base URL");
    }
    db.update(tables.workspace)
      .set({
        aiProvider: body.provider,
        aiModel: body.model,
        aiBaseUrl: body.baseUrl || null,
        ...(newKey ? { aiKeyEncrypted: encryptSecret(newKey) } : {}),
      })
      .where(eq(tables.workspace.id, ws.id))
      .run();
    return { ok: true, provider: body.provider, model: body.model };
  });

  /** The agent's custom instructions — appended to the built-in app guide (§9). */
  app.post("/api/admin/ai/instructions", auth, async (req) => {
    await requireOwner(req.userId);
    const body = aiInstructionsSchema.parse(req.body);
    const ws = db.select().from(tables.workspace).all()[0];
    if (!ws) throw new HttpError(500, "workspace not initialized");
    db.update(tables.workspace).set({ aiInstructions: body.instructions }).where(eq(tables.workspace.id, ws.id)).run();
    return { ok: true };
  });
}
