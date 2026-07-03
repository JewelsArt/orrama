import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { aiConfigSchema, grantSchema, inviteCreateSchema, projectCreateSchema, teamCreateSchema } from "@basalt/schema";
import { tables, type Db } from "../db.js";
import { encryptSecret } from "../secrets.js";
import { HttpError, type VaultStore } from "../vaultStore.js";

/** Workspace administration. v1 keeps it simple: owners only. */
export async function adminRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const requireOwner = async (userId: string) => {
    const user = store.aclUser(userId);
    if (!user.isOwner) throw new HttpError(403, "workspace owner required");
    return user;
  };
  const auth = { preHandler: [app.authenticate] };

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

  /** BYO AI key (spec §9): stored encrypted at rest, never proxied through Basalt-the-company. */
  app.post("/api/admin/ai", auth, async (req) => {
    await requireOwner(req.userId);
    const body = aiConfigSchema.parse(req.body);
    const ws = db.select().from(tables.workspace).all()[0];
    if (!ws) throw new HttpError(500, "workspace not initialized");
    db.update(tables.workspace)
      .set({ aiProvider: body.provider, aiKeyEncrypted: encryptSecret(body.apiKey), aiModel: body.model })
      .where(eq(tables.workspace.id, ws.id))
      .run();
    return { ok: true, provider: body.provider, model: body.model };
  });
}
