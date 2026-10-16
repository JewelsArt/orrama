/**
 * Sign-in sessions you can end (audit B7).
 *
 * A session was a bare 30-day JWT: nothing on the server knew it existed, so
 * "Sign out" only forgot it in one browser, and a token copied out of a log or
 * a lost laptop stayed good for a month — the only way to end it was rotating
 * ORRAMA_JWT_SECRET, which signed out every device at once.
 *
 * Now every sign-in opens a row here and the token carries its id (`sid`).
 * Every request, and the live-sync socket, needs that row to exist and not be
 * revoked. Sign-out revokes its own row; Settings lists the others to revoke.
 * A token from before this (no `sid`) is refused: one sign-in per device.
 */
import crypto from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import { tables, type Db } from "./db.js";

export const SESSION_DAYS = 30;
const DAY = 86_400_000;
/** last_seen_at is a hint for the Settings list, not an audit trail: written at most once a minute. */
const SEEN_EVERY_MS = 60_000;

/** "Mac · Safari" from a User-Agent — enough to tell your devices apart. */
export function sessionLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const app =
    /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /AppleWebKit/.test(ua) ? "Desktop app" : "";
  return [device, app].filter(Boolean).join(" · ") || "Unknown device";
}

/** Open a session for a sign-in; returns its id, for the token's `sid`. */
export function openSession(db: Db, userId: string, userAgent: string | undefined, now = Date.now()): string {
  // Expired sessions are dead weight: the token they back no longer verifies.
  db.delete(tables.sessions).where(lt(tables.sessions.createdAt, now - SESSION_DAYS * DAY)).run();
  const id = `s-${crypto.randomUUID()}`;
  db.insert(tables.sessions).values({ id, userId, label: sessionLabel(userAgent), createdAt: now, lastSeenAt: now, revokedAt: null }).run();
  return id;
}

/**
 * The user a verified token speaks for, or null when its session is gone,
 * revoked, someone else's, or it has none (a token from before sessions).
 */
export function sessionUser(db: Db, payload: { sub?: unknown; sid?: unknown }, now = Date.now()): string | null {
  if (typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;
  const row = db.select().from(tables.sessions).where(eq(tables.sessions.id, payload.sid)).get();
  if (!row || row.userId !== payload.sub || row.revokedAt !== null) return null;
  if (now - (row.lastSeenAt ?? 0) > SEEN_EVERY_MS) {
    db.update(tables.sessions).set({ lastSeenAt: now }).where(eq(tables.sessions.id, row.id)).run();
  }
  return row.userId;
}

/**
 * Give a live session a new id, for the switch from a stored token to the cookie (WEB-013,
 * `POST /api/auth/exchange`). The row stays the same session — its label, its sign-in time, its
 * place in Settings — but every token naming the old id stops working, so the token a browser
 * kept in its storage can be traded in once, and a copy of it is worth nothing after. Returns
 * the new id and when the session began (it still ends 30 days after that), or null when the
 * old id names no live session of `userId`'s.
 */
export function rekeySession(db: Db, userId: string, sessionId: string): { id: string; createdAt: number } | null {
  const id = `s-${crypto.randomUUID()}`;
  const row = db
    .update(tables.sessions)
    .set({ id })
    .where(and(eq(tables.sessions.id, sessionId), eq(tables.sessions.userId, userId), isNull(tables.sessions.revokedAt)))
    .returning({ id: tables.sessions.id, createdAt: tables.sessions.createdAt })
    .get();
  return row ?? null;
}

/** Revoke one of `userId`'s sessions. False when it is not theirs or already ended. */
export function revokeSession(db: Db, userId: string, sessionId: string, now = Date.now()): boolean {
  const res = db
    .update(tables.sessions)
    .set({ revokedAt: now })
    .where(and(eq(tables.sessions.id, sessionId), eq(tables.sessions.userId, userId), isNull(tables.sessions.revokedAt)))
    .run();
  return res.changes > 0;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * End every way into an account at once: all its sessions, API tokens and
 * Touch ID devices, its quick-unlock passcode and its calendar feed link.
 * What a password change does, and what "Sign out everywhere" does.
 *
 * A password change used to leave all of it working — the attacker's 30-day
 * session, the API token they made, a passkey they enrolled — and revoking
 * sessions by hand left the tokens, which could mint a fresh session (audit
 * SEC-007). Run it inside the caller's transaction when it goes with another
 * write. Returns the revoked session ids, so their live-sync sockets can be
 * closed (`session-revoked`), and what else was removed.
 */
export function revokeEverything(db: Db | Tx, userId: string, now = Date.now()) {
  const live = and(eq(tables.sessions.userId, userId), isNull(tables.sessions.revokedAt));
  const sessions = db.select({ id: tables.sessions.id }).from(tables.sessions).where(live).all().map((s) => s.id);
  db.update(tables.sessions).set({ revokedAt: now }).where(live).run();
  const tokens = db.delete(tables.apiTokens).where(eq(tables.apiTokens.userId, userId)).run().changes;
  const devices = db.delete(tables.webauthnCredentials).where(eq(tables.webauthnCredentials.userId, userId)).run().changes;
  db.update(tables.users)
    .set({ passcodeHash: null, passcodeFails: 0, passcodeLockedUntil: null, icsToken: null })
    .where(eq(tables.users.id, userId))
    .run();
  return { sessions, tokens, devices };
}

/** A user's live sessions, newest first, for Settings. */
export function listSessions(db: Db, userId: string, now = Date.now()) {
  return db
    .select()
    .from(tables.sessions)
    .where(and(eq(tables.sessions.userId, userId), isNull(tables.sessions.revokedAt)))
    .all()
    .filter((s) => s.createdAt > now - SESSION_DAYS * DAY)
    .sort((a, b) => b.createdAt - a.createdAt);
}
