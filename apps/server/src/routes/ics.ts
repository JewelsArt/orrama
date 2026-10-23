/**
 * Calendar interop without OAuth (spec: self-hosted ethos first).
 *
 * Inbound — subscribe to any ICS URL (Google Calendar's "secret address in
 * iCal format", Outlook, Apple, university timetables). Events render in the
 * Planning grid as a read-only layer, visible only to the feed's owner: an
 * external calendar is personal by default, unlike Orrama events.
 *
 * Outbound — every user can mint a private feed URL of their own blocks +
 * events and subscribe to it from Google/Apple/phone. The token is the whole
 * secret (like Google's), so it's rotatable and revocable.
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { canRead } from "@orrama/core";
import { feedPatchSchema } from "@orrama/schema";
import { ownerOf, seriesOf } from "../calendarNotes.js";
import { tables, type Db } from "../db.js";
import { buildIcs, expandIcsReport, parseIcs, type IcsDetails, type IcsExportItem, type VEvent } from "../ics.js";
import { decryptSecret, encryptSecret } from "../secrets.js";
import { BlockedTargetError, safeFetch } from "../safeFetch.js";
import { HttpError, type VaultStore } from "../vaultStore.js";
import { sessionOnly } from "./auth.js";

const FEED_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FEED_BYTES = 5 * 1024 * 1024;

/** The feed's `lastError` when its repeating events were too many to expand in full. */
export const TRUNCATED = "too many repeating events, some are not shown";

const cache = new Map<string, { at: number; events: VEvent[] }>();

/** For tests and the refresh endpoint. */
export function dropFeedCache(feedId?: string) {
  if (feedId) cache.delete(feedId);
  else cache.clear();
}

/**
 * The feed's text, through safeFetch: public addresses only (or ones named in
 * ORRAMA_FETCH_ALLOW), redirects re-checked, size capped while reading. The
 * error says what kind of failure it was, never what the far end answered.
 */
async function fetchIcsText(url: string): Promise<string> {
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(url, { headers: { accept: "text/calendar, text/plain, */*" }, timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_FEED_BYTES });
  } catch (err) {
    if (err instanceof BlockedTargetError) throw new Error("that address is on a private network (set ORRAMA_FETCH_ALLOW to allow it)");
    throw new Error(err instanceof Error && err.message === "response too large" ? "feed too large" : "the feed could not be reached");
  }
  if (res.status < 200 || res.status >= 300) throw new Error("the feed refused the request");
  if (!res.text.includes("BEGIN:VCALENDAR")) throw new Error("not an ICS calendar");
  return res.text;
}

type FeedRow = typeof tables.icsFeeds.$inferSelect;

/** Parsed events for a feed, cached ~10 min; keeps stale data on fetch errors. */
async function feedEvents(db: Db, feed: FeedRow, force = false): Promise<VEvent[]> {
  const hit = cache.get(feed.id);
  if (!force && hit && Date.now() - hit.at < FEED_TTL_MS) return hit.events;
  try {
    const events = parseIcs(await fetchIcsText(decryptSecret(feed.urlEncrypted)));
    cache.set(feed.id, { at: Date.now(), events });
    db.update(tables.icsFeeds).set({ lastSyncedAt: Date.now(), lastError: null }).where(eq(tables.icsFeeds.id, feed.id)).run();
    return events;
  } catch (err) {
    db.update(tables.icsFeeds)
      .set({ lastError: err instanceof Error ? err.message : String(err) })
      .where(eq(tables.icsFeeds.id, feed.id))
      .run();
    return hit?.events ?? [];
  }
}

export interface IcsCalItem {
  id: string;
  title: string;
  date: string;
  startMin: number;
  durationMin: number;
  ownerId: string;
  username: string;
  mine: boolean;
  source: "ics";
  readonly: true;
  feedLabel: string;
  /** The feed it came from, and the colour it is drawn in (null: the plain dashed look). */
  feedId: string;
  color: string | null;
  allDay: boolean;
  /** Where, what and the call, as the feed gave them (clean text and http(s) links only, `ics.ts`). */
  details?: IcsDetails;
}

/** All ICS occurrences in range for the requesting user's own feeds. */
export async function icsEventsFor(db: Db, userId: string, username: string, from: string, to: string): Promise<IcsCalItem[]> {
  const feeds = db.select().from(tables.icsFeeds).where(eq(tables.icsFeeds.ownerId, userId)).all();
  const out: IcsCalItem[] = [];
  await Promise.all(
    feeds.map(async (feed) => {
      const { occurrences, truncated } = expandIcsReport(await feedEvents(db, feed), from, to);
      // A feed whose rules need more work than one expansion may spend shows
      // what fitted, and says so where a feed's trouble is shown (audit INP-002).
      if (truncated) db.update(tables.icsFeeds).set({ lastError: TRUNCATED }).where(eq(tables.icsFeeds.id, feed.id)).run();
      for (let i = 0; i < occurrences.length; i++) {
        const o = occurrences[i]!;
        out.push({
          id: `ics-${feed.id}-${i}`,
          title: o.title,
          date: o.date,
          startMin: o.startMin,
          durationMin: o.durationMin,
          ownerId: userId,
          username,
          mine: true,
          source: "ics",
          readonly: true,
          feedLabel: feed.label,
          feedId: feed.id,
          color: feed.color ?? null,
          allDay: o.allDay,
          ...(o.details && { details: o.details }),
        });
      }
    }),
  );
  return out;
}

const feedPublic = (f: FeedRow, host: string | null) => ({
  id: f.id,
  label: f.label,
  color: f.color ?? null,
  host,
  createdAt: f.createdAt,
  lastSyncedAt: f.lastSyncedAt,
  lastError: f.lastError,
});

const hostOf = (f: FeedRow) => {
  try {
    return new URL(decryptSecret(f.urlEncrypted)).host;
  } catch {
    return null;
  }
};

export async function icsRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };

  // ---- inbound feeds -------------------------------------------------------

  app.get("/api/calendar/feeds", auth, async (req) => {
    return db
      .select()
      .from(tables.icsFeeds)
      .where(eq(tables.icsFeeds.ownerId, req.userId))
      .all()
      .map((f) => feedPublic(f, hostOf(f)));
  });

  app.post("/api/calendar/feeds", auth, async (req) => {
    const body = (req.body ?? {}) as { label?: string; url?: string };
    const label = body.label?.trim();
    if (!label || label.length > 60) throw new HttpError(400, "label required (max 60)");
    let url: URL;
    try {
      url = new URL(body.url ?? "");
    } catch {
      throw new HttpError(400, "invalid URL");
    }
    // Google hands these out as webcal:// sometimes; it's plain https underneath.
    if (url.protocol === "webcal:") url = new URL(`https:${(body.url ?? "").slice("webcal:".length)}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "URL must be http(s) or webcal");

    // Validate now so a typo'd secret address fails loudly, not silently in the grid.
    let count = 0;
    try {
      count = parseIcs(await fetchIcsText(url.href)).length;
    } catch (err) {
      throw new HttpError(400, `could not read feed: ${err instanceof Error ? err.message : err}`);
    }
    const feed = {
      id: `feed-${crypto.randomUUID().slice(0, 8)}`,
      ownerId: req.userId,
      label,
      urlEncrypted: encryptSecret(url.href),
      createdAt: Date.now(),
      lastSyncedAt: Date.now(),
      lastError: null,
      color: null,
    };
    db.insert(tables.icsFeeds).values(feed).run();
    return { ...feedPublic(feed, url.host), eventCount: count };
  });

  app.post<{ Params: { id: string } }>("/api/calendar/feeds/:id/refresh", auth, async (req) => {
    const feed = db.select().from(tables.icsFeeds).where(eq(tables.icsFeeds.id, req.params.id)).get();
    if (!feed || feed.ownerId !== req.userId) throw new HttpError(404, "feed not found");
    dropFeedCache(feed.id);
    const events = await feedEvents(db, feed, true);
    const fresh = db.select().from(tables.icsFeeds).where(eq(tables.icsFeeds.id, feed.id)).get()!;
    return { ...feedPublic(fresh, hostOf(fresh)), eventCount: events.length };
  });

  /** Rename a subscribed calendar, or give it a colour: what it is called and drawn in, here only. */
  app.patch<{ Params: { id: string } }>("/api/calendar/feeds/:id", auth, async (req) => {
    const body = feedPatchSchema.parse(req.body ?? {});
    const feed = db.select().from(tables.icsFeeds).where(eq(tables.icsFeeds.id, req.params.id)).get();
    if (!feed || feed.ownerId !== req.userId) throw new HttpError(404, "feed not found");
    db.update(tables.icsFeeds)
      .set({ ...(body.label !== undefined && { label: body.label }), ...(body.color !== undefined && { color: body.color }) })
      .where(eq(tables.icsFeeds.id, feed.id))
      .run();
    const fresh = db.select().from(tables.icsFeeds).where(eq(tables.icsFeeds.id, feed.id)).get()!;
    return feedPublic(fresh, hostOf(fresh));
  });

  app.delete<{ Params: { id: string } }>("/api/calendar/feeds/:id", auth, async (req) => {
    const feed = db.select().from(tables.icsFeeds).where(eq(tables.icsFeeds.id, req.params.id)).get();
    if (!feed || feed.ownerId !== req.userId) throw new HttpError(404, "feed not found");
    db.delete(tables.icsFeeds).where(eq(tables.icsFeeds.id, feed.id)).run();
    dropFeedCache(feed.id);
    return { ok: true };
  });

  // ---- outbound feed -------------------------------------------------------

  /** The feed token is a credential (it reads the calendar with no sign-in): a session only. */
  const feedTokenAuth = { preHandler: [app.authenticate], config: sessionOnly("the calendar feed link is managed from a signed-in session, not with an API token") };

  app.get("/api/me/ics-token", feedTokenAuth, async (req) => {
    const u = db.select().from(tables.users).where(eq(tables.users.id, req.userId)).get();
    return { token: u?.icsToken ?? null };
  });

  /** Mint (or rotate) the private feed token. Old URL stops working immediately. */
  app.post("/api/me/ics-token", feedTokenAuth, async (req) => {
    const token = crypto.randomBytes(20).toString("hex");
    db.update(tables.users).set({ icsToken: token }).where(eq(tables.users.id, req.userId)).run();
    return { token };
  });

  app.delete("/api/me/ics-token", feedTokenAuth, async (req) => {
    db.update(tables.users).set({ icsToken: null }).where(eq(tables.users.id, req.userId)).run();
    return { ok: true };
  });

  /**
   * The feed itself — token-authenticated, no JWT: Google's fetcher is the
   * client here. Serves the owner's events + task blocks, ACL-checked so a
   * block on a note the owner has since lost access to never leaks.
   */
  app.get<{ Params: { token: string } }>("/ics/:token", async (req, reply) => {
    const token = req.params.token.replace(/\.ics$/, "");
    if (!/^[0-9a-f]{40}$/.test(token)) throw new HttpError(404, "not found");
    const user = db.select().from(tables.users).where(eq(tables.users.icsToken, token)).get();
    if (!user) throw new HttpError(404, "not found");

    const items: IcsExportItem[] = [];
    for (const ev of db.select().from(tables.events).where(eq(tables.events.ownerId, user.id)).all()) {
      // A series goes out as one event with its rule, as calendars write them.
      const s = seriesOf(ev);
      items.push({
        uid: ev.id,
        title: ev.title,
        date: ev.date,
        startMin: ev.startMin,
        durationMin: ev.durationMin,
        allDay: s.allDay,
        rule: s.rule,
        skip: s.skip,
        ...(ev.place && { location: ev.place }),
        ...(ev.notes && { description: ev.notes }),
      });
    }

    const aclUser = store.aclUser(user.id);
    const grants = store.grants();
    const objects = new Map(db.select().from(tables.taskObjects).all().map((o) => [o.id, o]));
    // Your calendar notes: time booked there is yours whoever the step names. Steps made from a
    // project carry no `@you`, and keyed on the assignee alone they never reached the feed.
    const mine = new Set(store.index.all().filter((n) => ownerOf(n) === user.username).map((n) => n.id));
    for (const block of db.select().from(tables.taskBlocks).all()) {
      const obj = objects.get(block.taskObjectId);
      if (!obj || !(obj.assigneeId === user.id || (block.calNoteId !== null && mine.has(block.calNoteId)))) continue;
      const note = store.index.get(obj.noteId);
      if (!note || !canRead(aclUser, note, grants)) continue;
      const text = note.tasks.find((t) => t.blockId === obj.blockId)?.text ?? "Task";
      items.push({ uid: block.id, title: text, date: block.date, startMin: block.startMin, durationMin: block.durationMin });
    }

    reply.header("content-type", "text/calendar; charset=utf-8");
    reply.header("cache-control", "private, max-age=300");
    return buildIcs(`Orrama — ${user.displayName}`, items);
  });
}
