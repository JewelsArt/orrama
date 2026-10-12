import crypto from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { and, eq, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { appearanceSchema, loginSchema, passcodeSchema, registerSchema, unlockSchema } from "@basalt/schema";
import { tables, type Db } from "../db.js";
import { LoginLimiter } from "../loginLimit.js";
import { listSessions, openSession, revokeEverything, revokeSession, SESSION_DAYS } from "../sessions.js";
import { RETIRED_USERNAME, usernameRetired } from "../usernames.js";
import { env } from "../env.js";
import { HttpError, type VaultStore } from "../vaultStore.js";

/**
 * Route config that refuses API tokens (`authenticate` in main.ts) with this
 * reason — for routes that create, change or reveal a credential, or decide
 * where one is sent. A token must never be able to trade itself up.
 */
export const sessionOnly = (reason: string) => ({ sessionOnly: reason });

/** Unspent Touch ID challenges kept at once (see putChallenge). */
export const MAX_LIVE_CHALLENGES = 200;

/**
 * A hash to check a password against when the address has no account, made
 * once, on first need. Without it an unknown address answered in under a
 * millisecond and a real one only after Argon2 — a timing oracle for which
 * accounts exist (audit SEC-008).
 */
let dummyHash: Promise<string> | null = null;
const noAccountHash = () => (dummyHash ??= argonHash(crypto.randomBytes(16).toString("hex")));

export async function authRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  /** Passcode, Touch ID and sessions are credentials: changed from a session only. */
  const credentials = { preHandler: [app.authenticate], config: sessionOnly("sign-in methods and sessions are managed from a signed-in session, not with an API token") };
  /** Every way in ends here: a session row, and a token that names it. */
  const signIn = (userId: string, req: FastifyRequest) =>
    app.jwt.sign({ sub: userId, sid: openSession(db, userId, req.headers["user-agent"]) }, { expiresIn: `${SESSION_DAYS}d` });

  // One per server, so each test suite's app starts with a clean count.
  const logins = new LoginLimiter();
  const registrations = new LoginLimiter();
  const tooMany = (reply: FastifyReply, wait: number, what: string) =>
    reply
      .code(429)
      .header("retry-after", String(Math.ceil(wait / 1000)))
      .send({ error: `too many ${what} — try again in ${Math.ceil(wait / 60_000)} min` });

  /** Why an invite cannot be used, or null when it can. Read-only: claiming it is the transaction's job. */
  const inviteProblem = (tx: Pick<Db, "select">, token: string | undefined): string | null => {
    // Not the first user: a valid invite is required (spec §4 auth).
    if (!token) return "an invite is required to join this workspace";
    const invite = tx.select().from(tables.invites).where(eq(tables.invites.token, token)).get();
    if (!invite || invite.usedBy || invite.expiresAt < Date.now()) return "invite is invalid, used, or expired";
    return null;
  };
  const hasUsers = (tx: Pick<Db, "select">) => tx.select({ id: tables.users.id }).from(tables.users).limit(1).all().length > 0;

  app.post("/api/auth/register", async (req, reply) => {
    const wait = registrations.attempt(req.ip);
    if (wait > 0) return tooMany(reply, wait, "sign-up attempts");
    const body = registerSchema.parse(req.body);
    // Refuse what can be refused cheaply before paying for a hash. Anyone who
    // reaches the port can call this, and on an established install every
    // sign-up needs an invite: checking one is a lookup, a hash is the most
    // expensive thing the server does on purpose (audit SEC-011).
    if (hasUsers(db)) {
      const problem = inviteProblem(db, body.inviteToken);
      if (problem) throw new HttpError(403, problem);
    }
    // A removed or renamed account's name still owns Personal/<name>/ by path:
    // whoever took it next read and edited those notes (audit ACL-010).
    if (usernameRetired(db, body.username)) throw new HttpError(409, RETIRED_USERNAME);
    // Hash BEFORE deciding anything. The count used to be read, then the hash
    // awaited (~100 ms), then the row inserted with `isOwner: count === 0` — so
    // two sign-ups on an empty server both saw 0 and both became owner. The
    // check above only turns requests away; every decision below is one
    // synchronous transaction with no await inside, which no other request can
    // interleave with, and it checks again.
    const passwordHash = await argonHash(body.password);
    const id = `u-${crypto.randomUUID().slice(0, 8)}`;
    const teamIds = db.transaction((tx) => {
      const first = !hasUsers(tx);
      if (usernameRetired(tx, body.username)) throw new HttpError(409, RETIRED_USERNAME);
      let teams: string[] = [];
      if (!first) {
        const problem = inviteProblem(tx, body.inviteToken);
        if (problem) throw new HttpError(403, problem);
        const invite = tx.select().from(tables.invites).where(eq(tables.invites.token, body.inviteToken!)).get()!;
        // Claimed only if still unclaimed: one invite, one account.
        const claimed = tx
          .update(tables.invites)
          .set({ usedBy: body.email })
          .where(and(eq(tables.invites.token, invite.token), isNull(tables.invites.usedBy)))
          .run();
        if (claimed.changes !== 1) throw new HttpError(403, "invite is invalid, used, or expired");
        teams = JSON.parse(invite.teamIds);
      }
      tx.insert(tables.users)
        .values({
          id,
          email: body.email.toLowerCase(),
          username: body.username.toLowerCase(),
          displayName: body.displayName,
          passwordHash,
          isOwner: first, // first user founds the workspace
          createdAt: Date.now(),
        })
        .run();
      return teams;
    });
    for (const teamId of teamIds) {
      db.insert(tables.memberships).values({ id: `m-${crypto.randomUUID().slice(0, 8)}`, userId: id, teamId }).run();
    }
    registrations.succeed(req.ip);
    const token = signIn(id, req);
    return reply.send({ token, user: publicUser(db, store, id) });
  });

  app.post("/api/auth/login", async (req, reply) => {
    // Counted before the password is checked, in one synchronous step: while
    // an address is locked out, the right password must look exactly like a
    // wrong one, and a burst sent at once must not all slip under the limit
    // and all cost a hash (loginLimit.ts).
    const wait = logins.attempt(req.ip);
    if (wait > 0) return tooMany(reply, wait, "failed sign-ins");
    const body = loginSchema.parse(req.body);
    const user = db.select().from(tables.users).where(eq(tables.users.email, body.email.toLowerCase())).get();
    const ok = await argonVerify(user?.passwordHash ?? (await noAccountHash()), body.password);
    if (!user || !ok) throw new HttpError(401, "invalid email or password");
    logins.succeed(req.ip);
    db.update(tables.users)
      .set({ passcodeFails: 0, passcodeLockedUntil: null })
      .where(eq(tables.users.id, user.id))
      .run();
    const token = signIn(user.id, req);
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

  /** Set or replace the quick-unlock passcode. A session only: a token that could set one could unlock with it. */
  app.post("/api/auth/passcode", credentials, async (req) => {
    const { passcode } = passcodeSchema.parse(req.body);
    db.update(tables.users)
      .set({ passcodeHash: await argonHash(passcode), passcodeFails: 0, passcodeLockedUntil: null })
      .where(eq(tables.users.id, req.userId))
      .run();
    return { ok: true };
  });

  /** Remove it. Password login still works; this only drops the shortcut. */
  app.delete("/api/auth/passcode", credentials, async (req) => {
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
    // Spend an attempt BEFORE checking the code, in one statement. The count
    // used to be read here and written back after the awaited verify, so
    // every request in a burst saw the same stale count: 300 guesses sent at
    // once were all checked and the counter ended at 0 (audit SEC-001). Now
    // the increment, the limits and the cooldown are one UPDATE, which no
    // other request can interleave with; a request that cannot spend one is
    // refused without ever reaching Argon2.
    const now = Date.now();
    const spent = db
      .update(tables.users)
      .set({
        passcodeFails: sql`${tables.users.passcodeFails} + 1`,
        passcodeLockedUntil: sql`case when (${tables.users.passcodeFails} + 1) % ${MAX_FAILS_BEFORE_COOLDOWN} = 0 then ${now + COOLDOWN_MS} else null end`,
      })
      .where(
        and(
          eq(tables.users.id, user.id),
          isNotNull(tables.users.passcodeHash),
          lt(tables.users.passcodeFails, MAX_FAILS_BEFORE_DISABLE),
          or(isNull(tables.users.passcodeLockedUntil), lte(tables.users.passcodeLockedUntil, now)),
        ),
      )
      .returning({ passcodeHash: tables.users.passcodeHash })
      .get();
    if (!spent?.passcodeHash) {
      const cur = db.select().from(tables.users).where(eq(tables.users.id, user.id)).get();
      if (!cur?.passcodeHash) throw reject(); // removed meanwhile
      if (cur.passcodeFails >= MAX_FAILS_BEFORE_DISABLE) {
        throw new HttpError(403, "too many attempts — sign in with your password");
      }
      const secs = Math.max(1, Math.ceil(((cur.passcodeLockedUntil ?? now) - now) / 1000));
      throw new HttpError(429, `too many attempts — try again in ${secs}s`);
    }
    if (!(await argonVerify(spent.passcodeHash, body.passcode))) throw reject(); // already counted
    db.update(tables.users)
      .set({ passcodeFails: 0, passcodeLockedUntil: null })
      .where(eq(tables.users.id, user.id))
      .run();
    const token = signIn(user.id, req);
    return reply.send({ token, user: publicUser(db, store, user.id) });
  });

  // ── WebAuthn (Touch ID) ──────────────────────────────────────────────────────
  // A self-hosted Basalt is reached at localhost, 127.0.0.1 or a real domain, and
  // WebAuthn treats those as different relying parties: a credential enrolled on
  // one will not verify on another, which is the spec working correctly.
  const rp = (req: { headers: Record<string, unknown> }) => webauthnOrigin(req.headers, env.publicOrigins);

  /**
   * Challenges are spent by a verify; one that is never spent used to stay
   * forever, and login/options takes no sign-in, so every call to it was a
   * permanent row (audit SEC-009). Expired ones go now, and the live ones are
   * capped: a flood evicts the oldest instead of growing the table. (Touch ID
   * waits out a flood; the password still works.)
   */
  const putChallenge = (userId: string | null, challenge: string) => {
    const now = Date.now();
    db.delete(tables.webauthnChallenges).where(lt(tables.webauthnChallenges.expiresAt, now)).run();
    db.run(sql`delete from webauthn_challenges where id in (select id from webauthn_challenges order by expires_at desc limit -1 offset ${MAX_LIVE_CHALLENGES - 1})`);
    const id = `wc-${crypto.randomUUID()}`;
    db.insert(tables.webauthnChallenges)
      .values({ id, userId, challenge, expiresAt: now + 120_000 })
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

  app.post("/api/auth/webauthn/register/options", credentials, async (req) => {
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

  app.post("/api/auth/webauthn/register/verify", credentials, async (req) => {
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

  /**
   * The same answer for every address: a challenge, and no list of devices.
   * It used to 404 an address with no passkey and hand out the stored
   * credential ids of one with a passkey — an account oracle for anyone who
   * can reach the port (audit SEC-008). With no `allowCredentials` the device
   * offers its own passkey for this site (Touch ID enrols a discoverable one,
   * `residentKey: "preferred"` above), and verify still requires the device
   * to belong to the account the challenge was issued for — for an unknown
   * address, none.
   */
  app.post("/api/auth/webauthn/login/options", async (req) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = db.select().from(tables.users).where(eq(tables.users.email, email.toLowerCase())).get();
    const { rpID } = rp(req as never);
    const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
    return { challengeId: putChallenge(user?.id ?? null, options.challenge), options };
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
    const token = signIn(cred.userId, req);
    return reply.send({ token, user: publicUser(db, store, cred.userId) });
  });

  /** Enrolled devices, for the Settings list and its revoke buttons. */
  app.get("/api/auth/webauthn/credentials", credentials, async (req) => {
    return db
      .select()
      .from(tables.webauthnCredentials)
      .where(eq(tables.webauthnCredentials.userId, req.userId))
      .all()
      .map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt }));
  });

  app.delete("/api/auth/webauthn/credentials/:id", credentials, async (req) => {
    const { id } = req.params as { id: string };
    const cred = db.select().from(tables.webauthnCredentials).where(eq(tables.webauthnCredentials.id, id)).get();
    if (!cred || cred.userId !== req.userId) throw new HttpError(404, "not found");
    db.delete(tables.webauthnCredentials).where(eq(tables.webauthnCredentials.id, id)).run();
    return { ok: true };
  });

  // ---- sessions (sessions.ts) ----------------------------------------------

  /** Sign out: this session ends on the server, not just in this browser. */
  app.post("/api/auth/logout", credentials, async (req) => {
    if (req.sessionId) revokeSession(db, req.userId, req.sessionId);
    store.events.emit("session-revoked", { sessionId: req.sessionId });
    return { ok: true };
  });

  /** Where you are signed in, for Settings. */
  app.get("/api/auth/sessions", credentials, async (req) =>
    listSessions(db, req.userId).map((s) => ({ id: s.id, label: s.label, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === req.sessionId })),
  );

  /**
   * Sign out everywhere: every session (this one too), API token, Touch ID
   * device, the passcode and the calendar feed link (sessions.ts). For when
   * the account may have been someone else's for a while.
   */
  app.post("/api/auth/revoke-all", credentials, async (req) => {
    const done = db.transaction((tx) => revokeEverything(tx, req.userId));
    for (const sessionId of done.sessions) store.events.emit("session-revoked", { sessionId });
    return { sessions: done.sessions.length, tokens: done.tokens, devices: done.devices };
  });

  /** End one of your sessions — a lost phone, a borrowed laptop. */
  app.delete("/api/auth/sessions/:id", credentials, async (req) => {
    const { id } = req.params as { id: string };
    if (!revokeSession(db, req.userId, id)) throw new HttpError(404, "not found");
    store.events.emit("session-revoked", { sessionId: id });
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

/**
 * The relying party a WebAuthn ceremony is for, and the origin it must come from.
 *
 * This used to be whatever the request's `Origin` header said, fed straight into
 * `expectedOrigin`/`expectedRPID` — the value the check exists to verify, taken
 * from the party being checked (audit, high). Now:
 *
 *   - with `BASALT_PUBLIC_ORIGINS` set, the origin must be one of them;
 *   - unset, it must be the address the request was actually sent to (`Host`),
 *     which a page on another site cannot satisfy from a browser.
 *
 * The first is the real fix; the second keeps an unconfigured install (and a
 * phone reaching it over Tailscale) working without trusting a cross-site origin.
 */
export function webauthnOrigin(
  headers: Record<string, unknown>,
  allowed: string[],
): { rpID: string; origin: string } {
  const origin = String(headers["origin"] ?? "").replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new HttpError(400, "Touch ID needs the request's Origin");
  }
  const ok = allowed.length > 0 ? allowed.includes(url.origin) : url.host === String(headers["host"] ?? "");
  if (!ok) throw new HttpError(400, "Touch ID is not available from this address");
  return { rpID: url.hostname, origin: url.origin };
}
