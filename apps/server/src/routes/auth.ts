import crypto from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { loginSchema, registerSchema } from "@basalt/schema";
import { tables, type Db } from "../db.js";
import { HttpError, type VaultStore } from "../vaultStore.js";

export async function authRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  app.post("/api/auth/register", async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const userCount = db.select().from(tables.users).all().length;

    let teamIds: string[] = [];
    if (userCount > 0) {
      // Not the first user: a valid invite is required (spec §4 auth).
      if (!body.inviteToken) throw new HttpError(403, "an invite is required to join this workspace");
      const invite = db.select().from(tables.invites).where(eq(tables.invites.token, body.inviteToken)).get();
      if (!invite || invite.usedBy || invite.expiresAt < Date.now()) {
        throw new HttpError(403, "invite is invalid, used, or expired");
      }
      teamIds = JSON.parse(invite.teamIds);
      db.update(tables.invites).set({ usedBy: body.email }).where(eq(tables.invites.token, body.inviteToken)).run();
    }

    const id = `u-${crypto.randomUUID().slice(0, 8)}`;
    db.insert(tables.users)
      .values({
        id,
        email: body.email.toLowerCase(),
        username: body.username.toLowerCase(),
        displayName: body.displayName,
        passwordHash: await argonHash(body.password),
        isOwner: userCount === 0, // first user founds the workspace
        createdAt: Date.now(),
      })
      .run();
    for (const teamId of teamIds) {
      db.insert(tables.memberships).values({ id: `m-${crypto.randomUUID().slice(0, 8)}`, userId: id, teamId }).run();
    }
    const token = app.jwt.sign({ sub: id }, { expiresIn: "30d" });
    return reply.send({ token, user: publicUser(db, store, id) });
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const user = db.select().from(tables.users).where(eq(tables.users.email, body.email.toLowerCase())).get();
    if (!user || !(await argonVerify(user.passwordHash, body.password))) {
      throw new HttpError(401, "invalid email or password");
    }
    const token = app.jwt.sign({ sub: user.id }, { expiresIn: "30d" });
    return reply.send({ token, user: publicUser(db, store, user.id) });
  });

  app.get("/api/me", { preHandler: [app.authenticate] }, async (req) => {
    return publicUser(db, store, req.userId);
  });

  /** Profile self-service: character avatar + display name. */
  app.patch("/api/me", { preHandler: [app.authenticate] }, async (req) => {
    const body = (req.body ?? {}) as { avatar?: string; displayName?: string };
    const set: Record<string, string> = {};
    if (body.avatar && /^[a-z-]{2,24}$/.test(body.avatar)) set["avatar"] = body.avatar;
    if (body.displayName && body.displayName.trim().length >= 1 && body.displayName.length <= 80) {
      set["displayName"] = body.displayName.trim();
    }
    if (Object.keys(set).length > 0) {
      db.update(tables.users).set(set).where(eq(tables.users.id, req.userId)).run();
    }
    return publicUser(db, store, req.userId);
  });
}

export function publicUser(db: Db, store: VaultStore, id: string) {
  const u = db.select().from(tables.users).where(eq(tables.users.id, id)).get();
  if (!u) throw new HttpError(404, "user not found");
  const acl = store.aclUser(id);
  const teams = db.select().from(tables.teams).all().filter((t) => acl.teams.includes(t.slug));
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    displayName: u.displayName,
    isOwner: u.isOwner,
    avatar: u.avatar,
    teams,
  };
}
