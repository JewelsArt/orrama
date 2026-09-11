import crypto from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { appearanceSchema, loginSchema, passcodeSchema, registerSchema, unlockSchema } from "@basalt/schema";
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
    db.update(tables.users)
      .set({ passcodeFails: 0, passcodeLockedUntil: null })
      .where(eq(tables.users.id, user.id))
      .run();
    const token = app.jwt.sign({ sub: user.id }, { expiresIn: "30d" });
    return reply.send({ token, user: publicUser(db, store, user.id) });
  });

  app.get("/api/me", { preHandler: [app.authenticate] }, async (req) => {
    return publicUser(db, store, req.userId);
  });

  /** Profile self-service: character avatar, display name, appearance. */
  app.patch("/api/me", { preHandler: [app.authenticate] }, async (req) => {
    const body = (req.body ?? {}) as { avatar?: string; displayName?: string; appearance?: unknown };
    const set: Record<string, string> = {};
    if (body.avatar && /^[a-z-]{2,24}$/.test(body.avatar)) set["avatar"] = body.avatar;
    if (body.displayName && body.displayName.trim().length >= 1 && body.displayName.length <= 80) {
      set["displayName"] = body.displayName.trim();
    }
    // Parsed, not stored as sent: this JSON comes back out as CSS custom
    // properties, so the strict shape in appearanceSchema is the point.
    if (body.appearance !== undefined) {
      set["appearance"] = JSON.stringify(appearanceSchema.parse(body.appearance));
    }
    if (Object.keys(set).length > 0) {
      db.update(tables.users).set(set).where(eq(tables.users.id, req.userId)).run();
    }
    return publicUser(db, store, req.userId);
  });

  // ── First run ────────────────────────────────────────────────────────────────
  /**
   * Is this an empty install? The web app asks before rendering anything, so a
   * fresh server shows "create your account" instead of a login form nobody can
   * satisfy. Deliberately unauthenticated and deliberately minimal: it answers
   * one boolean and never reveals who exists once setup is done.
   */
  app.get("/api/auth/status", async () => {
    const userCount = db.select().from(tables.users).all().length;
    return { needsSetup: userCount === 0 };
  });

  // ── Quick unlock (passcode / Touch ID) ───────────────────────────────────────
  // A passcode is a convenience over an account that already exists, never a
  // replacement for the password. Four digits is 10,000 combinations, so the
  // secret is not what makes this safe — the counter below is. Five wrong tries
  // starts a cooldown; ten disables the passcode outright and forces a real
  // password login, which is the only thing that clears the counter.
  const MAX_FAILS_BEFORE_COOLDOWN = 5;
  const MAX_FAILS_BEFORE_DISABLE = 10;
  const COOLDOWN_MS = 60_000;

  /**
   * Which quick-unlock methods this account has enrolled. Answers false/false for
   * an unknown address rather than 404, so it cannot be used to enumerate accounts.
   */
  app.post("/api/auth/unlock/options", async (req) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = db.select().from(tables.users).where(eq(tables.users.email, email.toLowerCase())).get();
    if (!user) return { passcode: false, webauthn: false };
    const creds = db
      .select()
      .from(tables.webauthnCredentials)
      .where(eq(tables.webauthnCredentials.userId, user.id))
      .all();
    return {
      passcode: Boolean(user.passcodeHash) && user.passcodeFails < MAX_FAILS_BEFORE_DISABLE,
      webauthn: creds.length > 0,
    };
  });

  /** Set or replace the quick-unlock passcode. Requires a live session. */
  app.post("/api/auth/passcode", { preHandler: [app.authenticate] }, async (req) => {
    const { passcode } = passcodeSchema.parse(req.body);
    db.update(tables.users)
      .set({ passcodeHash: await argonHash(passcode), passcodeFails: 0, passcodeLockedUntil: null })
      .where(eq(tables.users.id, req.userId))
      .run();
    return { ok: true };
  });

  /** Remove it. Password login still works; this only drops the shortcut. */
  app.delete("/api/auth/passcode", { preHandler: [app.authenticate] }, async (req) => {
    db.update(tables.users)
      .set({ passcodeHash: null, passcodeFails: 0, passcodeLockedUntil: null })
      .where(eq(tables.users.id, req.userId))
      .run();
    return { ok: true };
  });

  app.post("/api/auth/unlock", async (req, reply) => {
    const body = unlockSchema.parse(req.body);
    const user = db.select().from(tables.users).where(eq(tables.users.email, body.email.toLowerCase())).get();
    // Same error for "no such user", "no passcode set" and "wrong passcode":
    // the unlock screen must not become an account oracle.
    const reject = () => new HttpError(401, "incorrect passcode");
    if (!user || !user.passcodeHash) throw reject();
    if (user.passcodeFails >= MAX_FAILS_BEFORE_DISABLE) {
      throw new HttpError(403, "too many attempts — sign in with your password");
    }
    if (user.passcodeLockedUntil && user.passcodeLockedUntil > Date.now()) {
      const secs = Math.ceil((user.passcodeLockedUntil - Date.now()) / 1000);
      throw new HttpError(429, `too many attempts — try again in ${secs}s`);
    }
    if (!(await argonVerify(user.passcodeHash, body.passcode))) {
      const fails = user.passcodeFails + 1;
      db.update(tables.users)
        .set({
          passcodeFails: fails,
          passcodeLockedUntil: fails % MAX_FAILS_BEFORE_COOLDOWN === 0 ? Date.now() + COOLDOWN_MS : null,
        })
        .where(eq(tables.users.id, user.id))
        .run();
      throw reject();
    }
    db.update(tables.users)
      .set({ passcodeFails: 0, passcodeLockedUntil: null })
      .where(eq(tables.users.id, user.id))
      .run();
    const token = app.jwt.sign({ sub: user.id }, { expiresIn: "30d" });
    return reply.send({ token, user: publicUser(db, store, user.id) });
  });

  // ── WebAuthn (Touch ID) ──────────────────────────────────────────────────────
  // rpID and origin are derived from the request rather than configured, because
  // a self-hosted Basalt is reached at localhost, 127.0.0.1 or a real domain and
  // WebAuthn treats those as different relying parties. A credential enrolled on
  // one simply will not verify on another, which is the spec working correctly.
  const rp = (req: { headers: Record<string, unknown> }) => {
    const origin = String(req.headers["origin"] ?? "");
    let host = "localhost";
    try {
      host = new URL(origin).hostname;
    } catch {
      /* no Origin header: fall through to the default */
    }
    return { rpID: host, origin };
  };

  const putChallenge = (userId: string | null, challenge: string) => {
    const id = `wc-${crypto.randomUUID()}`;
    db.insert(tables.webauthnChallenges)
      .values({ id, userId, challenge, expiresAt: Date.now() + 120_000 })
      .run();
    return id;
  };

  /** Take a challenge and delete it in one step: replaying one must not work. */
  const takeChallenge = (id: string) => {
    const row = db.select().from(tables.webauthnChallenges).where(eq(tables.webauthnChallenges.id, id)).get();
    if (row) db.delete(tables.webauthnChallenges).where(eq(tables.webauthnChallenges.id, id)).run();
    if (!row || row.expiresAt < Date.now()) throw new HttpError(400, "challenge expired — try again");
    return row;
  };

  app.post("/api/auth/webauthn/register/options", { preHandler: [app.authenticate] }, async (req) => {
    const user = db.select().from(tables.users).where(eq(tables.users.id, req.userId)).get();
    if (!user) throw new HttpError(404, "user not found");
    const existing = db
      .select()
      .from(tables.webauthnCredentials)
      .where(eq(tables.webauthnCredentials.userId, user.id))
      .all();
    const { rpID } = rp(req as never);
    const options = await generateRegistrationOptions({
      rpName: "Basalt",
      rpID,
      userID: new TextEncoder().encode(user.id),
      userName: user.email,
      userDisplayName: user.displayName,
      attestationType: "none",
      // Platform authenticator + required user verification is what makes this
      // Touch ID rather than a roaming security key.
      authenticatorSelection: { residentKey: "preferred", userVerification: "required", authenticatorAttachment: "platform" },
      excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
    });
    return { challengeId: putChallenge(user.id, options.challenge), options };
  });

  app.post("/api/auth/webauthn/register/verify", { preHandler: [app.authenticate] }, async (req) => {
    const body = req.body as { challengeId: string; response: never; label?: string };
    const challenge = takeChallenge(body.challengeId);
    const { rpID, origin } = rp(req as never);
    const result = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!result.verified || !result.registrationInfo) throw new HttpError(400, "could not verify this device");
    const cred = result.registrationInfo.credential;
    db.insert(tables.webauthnCredentials)
      .values({
        id: `wa-${crypto.randomUUID().slice(0, 8)}`,
        userId: req.userId,
        credentialId: cred.id,
        publicKey: Buffer.from(cred.publicKey).toString("base64url"),
        counter: cred.counter,
        transports: JSON.stringify(cred.transports ?? []),
        label: (body.label ?? "This device").slice(0, 60),
        createdAt: Date.now(),
      })
      .run();
    return { ok: true };
  });

  app.post("/api/auth/webauthn/login/options", async (req) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = db.select().from(tables.users).where(eq(tables.users.email, email.toLowerCase())).get();
    const creds = user
      ? db.select().from(tables.webauthnCredentials).where(eq(tables.webauthnCredentials.userId, user.id)).all()
      : [];
    if (creds.length === 0) throw new HttpError(404, "no device enrolled for this account");
    const { rpID } = rp(req as never);
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      allowCredentials: creds.map((c) => ({
        id: c.credentialId,
        transports: JSON.parse(c.transports ?? "[]"),
      })),
    });
    return { challengeId: putChallenge(user!.id, options.challenge), options };
  });

  app.post("/api/auth/webauthn/login/verify", async (req, reply) => {
    const body = req.body as { challengeId: string; response: { id: string } };
    const challenge = takeChallenge(body.challengeId);
    const cred = db
      .select()
      .from(tables.webauthnCredentials)
      .where(eq(tables.webauthnCredentials.credentialId, body.response.id))
      .get();
    if (!cred || cred.userId !== challenge.userId) throw new HttpError(401, "unknown device");
    const { rpID, origin } = rp(req as never);
    const result = await verifyAuthenticationResponse({
      response: body.response as never,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: cred.credentialId,
        publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64url")),
        counter: cred.counter,
      },
    });
    if (!result.verified) throw new HttpError(401, "could not verify this device");
    db.update(tables.webauthnCredentials)
      .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: Date.now() })
      .where(eq(tables.webauthnCredentials.id, cred.id))
      .run();
    const token = app.jwt.sign({ sub: cred.userId }, { expiresIn: "30d" });
    return reply.send({ token, user: publicUser(db, store, cred.userId) });
  });

  /** Enrolled devices, for the Settings list and its revoke buttons. */
  app.get("/api/auth/webauthn/credentials", { preHandler: [app.authenticate] }, async (req) => {
    return db
      .select()
      .from(tables.webauthnCredentials)
      .where(eq(tables.webauthnCredentials.userId, req.userId))
      .all()
      .map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt }));
  });

  app.delete("/api/auth/webauthn/credentials/:id", { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const cred = db.select().from(tables.webauthnCredentials).where(eq(tables.webauthnCredentials.id, id)).get();
    if (!cred || cred.userId !== req.userId) throw new HttpError(404, "not found");
    db.delete(tables.webauthnCredentials).where(eq(tables.webauthnCredentials.id, id)).run();
    return { ok: true };
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
    /** Re-validated on the way out too: a row written by an older build, or by
     *  hand, must not become the one path that skips the grammar. */
    appearance: safeAppearance(u.appearance),
    teams,
  };
}

function safeAppearance(raw: string | null) {
  if (!raw) return null;
  try {
    const parsed = appearanceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // not JSON at all
  }
}
