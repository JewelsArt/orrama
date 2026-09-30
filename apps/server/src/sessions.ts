/**
 * Sign-in sessions you can end (audit B7).
 *
 * A session was a bare 30-day JWT: nothing on the server knew it existed, so
 * "Sign out" only forgot it in one browser, and a token copied out of a log or
 * a lost laptop stayed good for a month — the only way to end it was rotating
 * BASALT_JWT_SECRET, which signed out every device at once.
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

/** Revoke one of `userId`'s sessions. False when it is not theirs or already ended. */
export function revokeSession(db: Db, userId: string, sessionId: string, now = Date.now()): boolean {
  const res = db
    .update(tables.sessions)
    .set({ revokedAt: now })
    .where(and(eq(tables.sessions.id, sessionId), eq(tables.sessions.userId, userId), isNull(tables.sessions.revokedAt)))
    .run();
  return res.changes > 0;
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
