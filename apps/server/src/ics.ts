/**
 * Minimal ICS (RFC 5545) interop — calendar sync with zero Google API setup.
 * Inbound: parse a subscribed feed (Google's "secret address in iCal format",
 * Outlook, Apple, university timetables) into occurrences on the Planning grid.
 * Outbound: serve the user's blocks + events as a feed Google can subscribe to.
 *
 * Not a full RRULE engine — it covers what real-world calendar exports emit:
 * DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYDAY (incl. nth-weekday), BYMONTHDAY,
 * COUNT, UNTIL, EXDATE, RECURRENCE-ID overrides, STATUS:CANCELLED.
 */

import { Parser } from "htmlparser2";

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAY_MS = 86_400_000;
const MAX_OCCURRENCES = 3000;
/**
 * How much one expansion may do for a whole feed: every generator step and
 * every occurrence kept, across all its events. A feed is untrusted input and
 * expansion runs on the event loop. The rules no longer walk from DTSTART to
 * the window (see generateStarts), so an ordinary feed spends a few steps per
 * rule; this bounds a hostile one. Past it the expansion stops and says so
 * (`truncated`), rather than freezing the server for minutes (audit INP-002).
 */
export const MAX_EXPAND_STEPS = 200_000;

/** Wall-clock time in a named timezone (how ICS thinks about recurring times). */
interface Wall {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  tz: string; // IANA name, "UTC", or "local"
  allDay: boolean;
}

export interface VEvent {
  uid: string;
  title: string;
  start: Wall;
  durationMin: number; // for allDay: whole days * 1440
  rrule: Record<string, string> | null;
  exdates: number[]; // UTC ms of excluded occurrence starts
  recurrenceId: number | null; // UTC ms of the occurrence this overrides
  cancelled: boolean;
  /** What the card shows besides the time; each override carries its own. */
  details?: IcsDetails;
}

/**
 * What a feed says about an event besides its time: where, what, and the call.
 * The feed is untrusted input, so all of it is already clean here — text only
 * (a description's HTML read down to its words), capped, and the two links
 * kept only when they are http(s).
 */
export interface IcsDetails {
  location?: string;
  description?: string;
  /** The event's own URL property. */
  url?: string;
  /** The meeting to join: Google's X-GOOGLE-CONFERENCE, else a known meeting link in the text. */
  conference?: string;
}

/** One concrete occurrence, in server-local calendar coordinates. */
export interface IcsOccurrence {
  uid: string;
  title: string;
  date: string; // YYYY-MM-DD
  startMin: number;
  durationMin: number;
  allDay: boolean;
  details?: IcsDetails;
}

/* ---------- timezone math (Intl-based, no tz database dependency) ---------- */

const dtfCache = new Map<string, Intl.DateTimeFormat>();
const dtf = (tz: string) => {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    dtfCache.set(tz, f);
  }
  return f;
};

function intlOffsetMs(ts: number, tz: string): number {
  const parts: Record<string, string> = {};
  for (const p of dtf(tz).formatToParts(new Date(ts))) parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour! % 24, +parts.minute!, +parts.second!);
  return asUtc - ts;
}

/**
 * `${tz}|${UTC day}` → the zone's offset that whole day, or null for a day it
 * changes (asked exactly then). `formatToParts` costs microseconds and a 5 MB
 * feed asks hundreds of thousands of times, almost always about the same few
 * hundred days: parsing one took 1.4 s on the event loop (audit INP-002).
 */
const offsetDays = new Map<string, number | null>();

/** How far `tz` is ahead of UTC at instant `ts`, in ms. */
function tzOffsetMs(ts: number, tz: string): number {
  const day = Math.floor(ts / DAY_MS);
  const key = `${tz}|${day}`;
  let off = offsetDays.get(key);
  if (off === undefined) {
    const a = intlOffsetMs(day * DAY_MS, tz);
    off = a === intlOffsetMs((day + 1) * DAY_MS, tz) ? a : null;
    if (offsetDays.size >= 100_000) offsetDays.clear();
    offsetDays.set(key, off);
  }
  return off ?? intlOffsetMs(ts, tz);
}

function resolveTz(tz: string): string {
  if (tz === "local") return LOCAL_TZ;
  try {
    dtf(tz);
    return tz;
  } catch {
    return "UTC"; // unknown TZID (e.g. exotic Windows name) — better than dropping the event
  }
}

/** Wall-clock in its timezone → UTC ms. Two passes to land on the right side of DST. */
export function wallToUtc(w: Wall): number {
  const tz = resolveTz(w.tz);
  const naive = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  let ts = naive - tzOffsetMs(naive, tz);
  ts = naive - tzOffsetMs(ts, tz);
  return ts;
}

/* ---------- parsing ---------- */

function unfold(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter((l) => l.length > 0);
}

function parseProp(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const idx = line.indexOf(":");
  if (idx < 0) return null;
  const [name, ...paramParts] = line.slice(0, idx).split(";");
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name!.toUpperCase(), params, value: line.slice(idx + 1) };
}

function parseDt(value: string, params: Record<string, string>): Wall | null {
  if (params["VALUE"] === "DATE" || /^\d{8}$/.test(value)) {
    if (!/^\d{8}$/.test(value)) return null;
    return { y: +value.slice(0, 4), mo: +value.slice(4, 6), d: +value.slice(6, 8), h: 0, mi: 0, tz: params["TZID"] ?? "local", allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return null;
  return {
    y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +m[4]!, mi: +m[5]!,
    tz: m[7] === "Z" ? "UTC" : (params["TZID"] ?? "local"),
    allDay: false,
  };
}

/** PT1H30M / P1D style durations → minutes. */
function parseDuration(value: string): number | null {
  const m = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m) return null;
  const min = (+(m[2] ?? 0)) * 7 * 1440 + (+(m[3] ?? 0)) * 1440 + (+(m[4] ?? 0)) * 60 + (+(m[5] ?? 0)) + Math.round((+(m[6] ?? 0)) / 60);
  return m[1] ? -min : min;
}

/**
 * RFC 5545 TEXT, in one pass: `\n` is a line break, `\,` `\;` `\\` the character.
 * Two passes read `\\n` (an escaped backslash, then n) as a line break.
 */
function unescapeText(v: string): string {
  return v.replace(/\\(.)/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** A description longer than this is cut, with an ellipsis: it is a card, not a reader. */
export const MAX_DESCRIPTION = 2000;
const MAX_LOCATION = 300;
const MAX_URL = 2000;

/** An http(s) URL as written, or undefined. Nothing else becomes a link (no javascript:, no data:). */
export function httpUrl(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v || v.length > MAX_URL || /[\s<>"]/.test(v)) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Hosts whose links are a meeting to join, for feeds that do not name it (Outlook, Teams, Zoom invites). */
const MEETING_HOSTS = /^(?:meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|(?:[\w-]+\.)?zoom\.us|(?:[\w-]+\.)?webex\.com|whereby\.com)$/i;
const URLS = /https?:\/\/[^\s<>"()\[\]]+/g;
/** URLS without the g flag, for `.test()` (a global regex keeps its lastIndex between calls). */
const HAS_URL = new RegExp(URLS.source);

/** Tags whose end is a line break in the text they become. */
const BLOCK_TAGS = new Set(["br", "p", "div", "li", "ul", "ol", "tr", "table", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr"]);
/** Dropped with everything inside them. */
const OPAQUE_TAGS = new Set(["script", "style", "head", "title", "template", "iframe", "object", "svg", "math", "noscript"]);
const LOOKS_HTML = /<\/?(?:a|b|i|u|br|p|div|span|ul|ol|li|strong|em|html|body|font|table|h[1-6])\b[^>]*>/i;

/**
 * A description as plain text. Google writes descriptions edited in its web
 * app as HTML; that is read down to its words here and never rendered. A link
 * whose words are not its address keeps the address after them, so it can
 * still be followed. Not yet capped (`capped`).
 */
export function descriptionText(raw: string): string {
  let text = raw;
  if (LOOKS_HTML.test(raw)) {
    let out = "";
    let opaque = 0;
    const links: { href: string | undefined; at: number }[] = [];
    const parser = new Parser(
      {
        onopentag(name, attrs) {
          if (OPAQUE_TAGS.has(name)) opaque++;
          else if (name === "a") links.push({ href: httpUrl(attrs["href"]), at: out.length });
          else if (name === "br") out += "\n";
        },
        ontext(t) {
          if (opaque === 0) out += t;
        },
        onclosetag(name) {
          if (OPAQUE_TAGS.has(name)) opaque = Math.max(0, opaque - 1);
          else if (name === "a") {
            const link = links.pop();
            // Words that already hold an address (Google wraps its own in a redirect) need no second one.
            if (link?.href && !HAS_URL.test(out.slice(link.at))) out += ` ${link.href}`;
          } else if (name !== "br" && BLOCK_TAGS.has(name) && !out.endsWith("\n")) out += "\n";
        },
      },
      { decodeEntities: true, lowerCaseTags: true },
    );
    parser.write(raw);
    parser.end();
    text = out;
  }
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** At most MAX_DESCRIPTION characters, never half of one, with an ellipsis when cut. */
function capped(text: string): string {
  if (text.length <= MAX_DESCRIPTION) return text;
  return `${Array.from(text).slice(0, MAX_DESCRIPTION).join("").trimEnd()}…`;
}

/** The first meeting link in some text, or undefined. */
function meetingLinkIn(text: string | undefined): string | undefined {
  for (const m of text?.matchAll(URLS) ?? []) {
    const url = httpUrl(m[0].replace(/[.,;:!?]+$/, ""));
    if (!url) continue;
    try {
      if (MEETING_HOSTS.test(new URL(url).hostname)) return url;
    } catch {
      /* not a URL after all */
    }
  }
  return undefined;
}

/**
 * Google's own "Join with Google Meet … Please do not edit this section." block,
 * fenced by `-::~:~::~:…::-` lines. With the meeting as its own button it only
 * repeats it (and the dial-in numbers), so it goes.
 */
const GOOGLE_INVITE_BLOCK = /-::~[:~]*::-[\s\S]*?-::~[:~]*::-/g;

/** A line of Google's Meet footer after the join line: its links, a number to dial, or nothing. */
const MEET_FOOTER_LINE = /^\s*$|https?:\/\/(?:meet\.google\.com|tel\.meet|support\.google\.com)\/|\+\d[\d\s()-]{6,}/;

/**
 * Google's feed also writes the call as a footer with no fences, in the
 * calendar's language ("Deelnemen via Google Meet: …", "Of bel: …", "Ga voor
 * meer informatie over Meet naar …"). It is told by its shape, not its words:
 * from the line that holds the call's own address to the end, every line is
 * a Meet, tel.meet or support link, a number to dial, or blank. Anything else
 * after it, and the text is left alone.
 */
function withoutMeetFooter(text: string, conference: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.includes(conference));
  if (at < 0 || !lines.slice(at + 1).every((l) => MEET_FOOTER_LINE.test(l))) return text;
  return lines.slice(0, at).join("\n").trim();
}

/** The event's details from its raw properties, clean, or undefined when it has none. */
function detailsOf(raw: { location?: string; description?: string; url?: string; conference?: string }): IcsDetails | undefined {
  let text = raw.description ? descriptionText(raw.description) : "";
  const location = raw.location?.replace(/\s+/g, " ").trim().slice(0, MAX_LOCATION) || undefined;
  const conference = httpUrl(raw.conference) ?? meetingLinkIn(location) ?? meetingLinkIn(text);
  // Before the cap, which could cut the block's closing fence off.
  if (conference) text = withoutMeetFooter(text.replace(GOOGLE_INVITE_BLOCK, "").trim(), conference);
  const description = text ? capped(text) : undefined;
  const details: IcsDetails = {};
  if (location) details.location = location;
  if (description) details.description = description;
  const url = httpUrl(raw.url);
  if (url) details.url = url;
  if (conference) details.conference = conference;
  return Object.keys(details).length > 0 ? details : undefined;
}

export function parseIcs(text: string): VEvent[] {
  const lines = unfold(text);
  const events: VEvent[] = [];
  let cur: Partial<VEvent> & { start?: Wall; end?: Wall; durationRaw?: number; raw?: { location?: string; description?: string; url?: string; conference?: string } } | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = { exdates: [], rrule: null, recurrenceId: null, cancelled: false, title: "(untitled)", raw: {} };
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur?.uid && cur.start) {
        let durationMin: number;
        if (cur.durationRaw !== undefined) durationMin = Math.max(cur.durationRaw, 0);
        else if (cur.end) durationMin = Math.max(Math.round((wallToUtc(cur.end) - wallToUtc(cur.start)) / 60_000), 0);
        else durationMin = cur.start.allDay ? 1440 : 60;
        if (cur.start.allDay && durationMin < 1440) durationMin = 1440;
        events.push({
          uid: cur.uid,
          title: cur.title ?? "(untitled)",
          start: cur.start,
          durationMin,
          rrule: cur.rrule ?? null,
          exdates: cur.exdates ?? [],
          recurrenceId: cur.recurrenceId ?? null,
          cancelled: cur.cancelled ?? false,
          details: detailsOf(cur.raw ?? {}),
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const prop = parseProp(line);
    if (!prop) continue;
    switch (prop.name) {
      case "UID":
        cur.uid = prop.value;
        break;
      case "SUMMARY":
        cur.title = unescapeText(prop.value);
        break;
      case "LOCATION":
        cur.raw!.location = unescapeText(prop.value);
        break;
      case "DESCRIPTION":
        cur.raw!.description = unescapeText(prop.value);
        break;
      case "URL":
        cur.raw!.url = prop.value;
        break;
      case "X-GOOGLE-CONFERENCE":
        cur.raw!.conference = prop.value;
        break;
      case "DTSTART":
        cur.start = parseDt(prop.value, prop.params) ?? cur.start;
        break;
      case "DTEND":
        cur.end = parseDt(prop.value, prop.params) ?? cur.end;
        break;
      case "DURATION":
        cur.durationRaw = parseDuration(prop.value) ?? cur.durationRaw;
        break;
      case "RRULE": {
        const rule: Record<string, string> = {};
        for (const part of prop.value.split(";")) {
          const eq = part.indexOf("=");
          if (eq > 0) rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
        }
        cur.rrule = rule;
        break;
      }
      case "EXDATE":
        for (const v of prop.value.split(",")) {
          const w = parseDt(v.trim(), prop.params);
          if (w) cur.exdates!.push(wallToUtc(w));
        }
        break;
      case "RECURRENCE-ID": {
        const w = parseDt(prop.value, prop.params);
        if (w) cur.recurrenceId = wallToUtc(w);
        break;
      }
      case "STATUS":
        cur.cancelled = prop.value.toUpperCase() === "CANCELLED";
        break;
    }
  }
  return events;
}

/* ---------- recurrence expansion ---------- */

const DOW = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function wallDayNumber(w: Wall): number {
  return Math.floor(Date.UTC(w.y, w.mo - 1, w.d) / 86_400_000);
}

function addDays(w: Wall, days: number): Wall {
  const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + days));
  return { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayOf(w: Wall): number {
  return new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Date of the nth (or -nth) weekday of a month, or null. */
function nthWeekday(y: number, mo: number, dow: number, nth: number): number | null {
  const dim = daysInMonth(y, mo);
  if (nth > 0) {
    const firstDow = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    const day = 1 + ((dow - firstDow + 7) % 7) + (nth - 1) * 7;
    return day <= dim ? day : null;
  }
  const lastDow = new Date(Date.UTC(y, mo - 1, dim)).getUTCDay();
  const day = dim - ((lastDow - dow + 7) % 7) + (nth + 1) * 7;
  return day >= 1 ? day : null;
}

/** A whole number ≥ 1 as RRULE writes it, or null. `+"X"` is NaN and `+"1e400"` Infinity, and either reached Date.UTC. */
function positiveInt(v: string): number | null {
  return /^\d{1,9}$/.test(v) && +v > 0 ? +v : null;
}

/** What one expansion has left to spend (MAX_EXPAND_STEPS), shared by every event in the feed. */
interface Budget {
  left: number;
  truncated: boolean;
}

/**
 * Generate occurrence start Walls for one master event, honoring COUNT/UNTIL.
 * Occurrences are counted from DTSTART (COUNT semantics) and kept from the
 * window — but the periods before the window are COUNTED, not walked: each
 * frequency jumps straight to the first period that can reach the window.
 * Walking them is what let a daily event begun in 1900 cost 46,000 steps,
 * each with a timezone conversion, for one week of calendar: ten of them in
 * a feed blocked the server for 5 s, 500 for 5 minutes (audit INP-002).
 */
function generateStarts(ev: VEvent, windowStartDay: number, windowEndDay: number, budget: Budget): Wall[] {
  const rule = ev.rrule;
  if (!rule) return [ev.start];
  const freq = rule["FREQ"];
  const interval = positiveInt(rule["INTERVAL"] ?? "1");
  const count = rule["COUNT"] === undefined ? Infinity : positiveInt(rule["COUNT"]);
  // A rule that cannot be read is the master's own occurrence, like an
  // unsupported FREQ — not a RangeError that dropped every event in the feed.
  if (interval === null || count === null) return [ev.start];
  let untilMs = Infinity;
  if (rule["UNTIL"]) {
    const w = parseDt(rule["UNTIL"], /Z$/.test(rule["UNTIL"]) ? {} : { TZID: ev.start.tz });
    if (w) untilMs = w.allDay ? wallToUtc({ ...w, h: 23, mi: 59 }) : wallToUtc(w);
  }
  // A wall date is within a day of its UTC date, so only a day next to
  // UNTIL's needs the exact (Intl) instant.
  const untilDay = Math.floor(untilMs / DAY_MS);
  const startDay = wallDayNumber(ev.start);
  // Occurrences are COUNTED from DTSTART and KEPT from the window. Keeping
  // them all is what made a long-running daily event vanish: the cap filled up
  // with occurrences from years ago and the loop stopped before today. The
  // slack is for an all-day event that began before the window and still
  // covers part of it.
  const keepFrom = windowStartDay - 2 - Math.ceil(ev.durationMin / 1440);
  const keepDate = new Date(keepFrom * DAY_MS);
  const out: Wall[] = [];
  let emitted = 0;
  const step = (): boolean => {
    if (--budget.left >= 0) return true;
    budget.truncated = true;
    return false;
  };
  const push = (w: Wall): boolean => {
    const day = wallDayNumber(w);
    if (day < startDay) return true; // before DTSTART: not an occurrence
    if (day > untilDay + 1 || (day >= untilDay - 1 && wallToUtc(w) > untilMs)) return false;
    emitted++;
    if (emitted > count) return false;
    if (day >= keepFrom) out.push(w);
    return out.length < MAX_OCCURRENCES;
  };
  // Every loop below stops on `!(day <= end)`, which a NaN day (a date past
  // what Date can hold, from a huge INTERVAL) also satisfies.

  if (freq === "DAILY") {
    // One occurrence per period, so the days before the window are a count.
    const first = Math.max(0, Math.ceil((keepFrom - startDay) / interval));
    emitted = first;
    for (let i = first; step(); i++) {
      const w = addDays(ev.start, i * interval);
      if (!(wallDayNumber(w) <= windowEndDay)) break;
      if (!push(w)) break;
    }
  } else if (freq === "WEEKLY") {
    const bydays = (rule["BYDAY"]?.split(",") ?? [DOW[weekdayOf(ev.start)]!]).map((s) => DOW.indexOf(s.trim())).filter((n) => n >= 0);
    // Weeks start Monday (WKST default); walk week by week emitting each BYDAY.
    const dowStart = weekdayOf(ev.start);
    const weekMonday = addDays(ev.start, -((dowStart + 6) % 7));
    const mondayDay = wallDayNumber(weekMonday);
    const weekDows = [1, 2, 3, 4, 5, 6, 0].filter((dow) => bydays.includes(dow));
    // Every week emits all its days, except the first, which skips those before DTSTART.
    const first = Math.max(0, Math.ceil((keepFrom - 6 - mondayDay) / (interval * 7)));
    if (first > 0) emitted = weekDows.filter((dow) => mondayDay + ((dow + 6) % 7) >= startDay).length + (first - 1) * weekDows.length;
    outer: for (let week = first; step(); week++) {
      const base = addDays(weekMonday, week * interval * 7);
      if (!(wallDayNumber(base) <= windowEndDay + 7)) break;
      for (const dow of weekDows) {
        const w = addDays(base, (dow + 6) % 7);
        if (!push(w)) break outer;
      }
    }
  } else if (freq === "MONTHLY") {
    /**
     * BYMONTHDAY and BYDAY are comma-separated LISTS, and a BYMONTHDAY may be
     * negative — counted back from the end of the month. Reading either with a
     * single `+()` is where three real rules went wrong (audit):
     *
     *   BYMONTHDAY=-1   `+"-1"` is -1, used as a day NUMBER. On a timed event
     *                   that silently became the 30th of the month before; on
     *                   an all-day one it rendered as the literal "2026-03--1".
     *   BYMONTHDAY=1,15 `+"1,15"` is NaN, every comparison against it false,
     *                   so a semi-monthly payday produced nothing at all.
     *   BYDAY=MO,WE     the single-term regex did not match, so the rule fell
     *                   through to DTSTART's own day of the month.
     */
    const bymonthdays = (rule["BYMONTHDAY"]?.split(",") ?? [])
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) <= 31);
    const bydays = (rule["BYDAY"]?.split(",") ?? [])
      .map((s) => /^([+-]?\d+)?([A-Z]{2})$/.exec(s.trim().toUpperCase()))
      .filter((m): m is RegExpExecArray => m !== null && DOW.includes(m[2]!));

    /** The days of month `mo` of year `y` the rule names, ascending. */
    const daysOf = (y: number, mo: number): number[] => {
      const dim = daysInMonth(y, mo);

      // A negative day counts back from the end: -1 is the last day.
      const fromMonthday = bymonthdays.map((n) => (n > 0 ? n : dim + 1 + n)).filter((d) => d >= 1 && d <= dim);

      let days: number[];
      if (bydays.length > 0) {
        const fromDay: number[] = [];
        for (const m of bydays) {
          const dow = DOW.indexOf(m[2]!);
          if (m[1]) {
            const d = nthWeekday(y, mo, dow, Number.parseInt(m[1], 10));
            if (d !== null) fromDay.push(d);
          } else {
            // No ordinal: every such weekday in the month (RFC 5545 §3.3.10).
            for (let nth = 1; nth <= 5; nth++) {
              const d = nthWeekday(y, mo, dow, nth);
              if (d !== null) fromDay.push(d);
            }
          }
        }
        // Both given: BYDAY is limited to the days BYMONTHDAY names.
        days = fromMonthday.length > 0 ? fromDay.filter((d) => fromMonthday.includes(d)) : fromDay;
      } else if (bymonthdays.length > 0) {
        // A BYMONTHDAY the month is too short to hold yields NOTHING for that
        // month. Testing `fromMonthday.length` here instead sent a 30th
        // through to the DTSTART fallback and put February on the 15th.
        days = fromMonthday;
      } else {
        // Neither: DTSTART's own day, skipping months too short to hold it
        // rather than rolling over into the next one.
        days = ev.start.d <= dim ? [ev.start.d] : [];
      }
      return [...new Set(days)].sort((a, b) => a - b);
    };
    const monthAt = (i: number) => {
      const t = new Date(Date.UTC(ev.start.y, ev.start.mo - 1 + i * interval, 1));
      return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1 };
    };

    // Months before the window hold no kept occurrence: skip them, and
    // count what they emit only when a COUNT needs it.
    const months = keepDate.getUTCFullYear() * 12 + keepDate.getUTCMonth() - (ev.start.y * 12 + ev.start.mo - 1);
    const first = Math.max(0, Math.floor(months / interval));
    if (count !== Infinity) {
      for (let i = 0; i < first && emitted <= count; i++) {
        if (!step()) return out;
        const { y, mo } = monthAt(i);
        emitted += daysOf(y, mo).filter((d) => i > 0 || d >= ev.start.d).length;
      }
    }
    outer: for (let i = first; step(); i++) {
      const { y, mo } = monthAt(i);
      if (!(wallDayNumber({ ...ev.start, y, mo, d: 1 }) <= windowEndDay)) break;
      for (const d of daysOf(y, mo)) {
        if (!push({ ...ev.start, y, mo, d })) break outer;
      }
    }
  } else if (freq === "YEARLY") {
    const fits = (y: number) => ev.start.d <= daysInMonth(y, ev.start.mo);
    const first = Math.max(0, Math.floor((keepDate.getUTCFullYear() - ev.start.y) / interval));
    if (count !== Infinity) {
      for (let i = 0; i < first && emitted <= count; i++) {
        if (!step()) return out;
        if (fits(ev.start.y + i * interval)) emitted++;
      }
    }
    for (let i = first; step(); i++) {
      const y = ev.start.y + i * interval;
      if (!(wallDayNumber({ ...ev.start, y }) <= windowEndDay)) break;
      if (fits(y) && !push({ ...ev.start, y })) break;
    }
  } else {
    return [ev.start]; // unsupported FREQ: at least show the first instance
  }
  return out;
}

/** UTC instant → server-local calendar slot. */
function toLocalSlot(ts: number): { date: string; startMin: number } {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    startMin: d.getHours() * 60 + d.getMinutes(),
  };
}

const wallDateStr = (w: Wall) => `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;

export interface IcsExpansion {
  occurrences: IcsOccurrence[];
  /** The feed asked for more work than MAX_EXPAND_STEPS: some recurring events are missing. */
  truncated: boolean;
  /** Generator steps spent (what the budget counts). */
  steps: number;
}

/** Expand a parsed feed into occurrences within [from, to] (YYYY-MM-DD, inclusive). */
export function expandIcs(events: VEvent[], from: string, to: string): IcsOccurrence[] {
  return expandIcsReport(events, from, to).occurrences;
}

/** expandIcs, and whether the feed's budget ran out (`maxSteps`, for tests). */
export function expandIcsReport(events: VEvent[], from: string, to: string, maxSteps = MAX_EXPAND_STEPS): IcsExpansion {
  const fromMs = new Date(`${from}T00:00:00`).getTime();
  const toMs = new Date(`${to}T23:59:59`).getTime();
  const windowEndDay = Math.floor(Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) / DAY_MS) + 2;
  const windowStartDay = Math.floor(Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10)) / DAY_MS);
  const budget: Budget = { left: maxSteps, truncated: false };

  const overrides = new Map<string, VEvent[]>();
  for (const ev of events) {
    if (ev.recurrenceId !== null) {
      const list = overrides.get(ev.uid) ?? [];
      list.push(ev);
      overrides.set(ev.uid, list);
    }
  }

  /** Whether a start on wall date `w` can reach the window — by day number, before any timezone math. */
  const near = (ev: VEvent, w: Wall) => {
    const day = wallDayNumber(w);
    return day <= windowEndDay && day >= windowStartDay - 2 - Math.ceil(ev.durationMin / 1440);
  };

  const out: IcsOccurrence[] = [];
  const emit = (ev: VEvent, startWall: Wall, ts: number) => {
    if (ev.start.allDay) {
      // All-day: pure calendar dates, one chip per covered day.
      const days = Math.max(1, Math.round(ev.durationMin / 1440));
      for (let i = 0; i < days; i++) {
        const day = wallDateStr(addDays(startWall, i));
        if (day >= from && day <= to) out.push({ uid: ev.uid, title: ev.title, date: day, startMin: 0, durationMin: 1440, allDay: true, ...(ev.details && { details: ev.details }) });
      }
      return;
    }
    if (ts < fromMs - ev.durationMin * 60_000 || ts > toMs) return;
    const slot = toLocalSlot(ts);
    // One that began before the window and still runs into it is kept, under
    // its own start date: its time inside the window is busy (audit COR-010).
    if (slot.date > to) return;
    out.push({ uid: ev.uid, title: ev.title, date: slot.date, startMin: slot.startMin, durationMin: ev.durationMin, allDay: false, ...(ev.details && { details: ev.details }) });
  };

  for (const ev of events) {
    try {
      if (ev.recurrenceId !== null) {
        if (!ev.cancelled && near(ev, ev.start)) emit(ev, ev.start, wallToUtc(ev.start));
        continue;
      }
      if (ev.cancelled) continue;
      const skipped = new Set((overrides.get(ev.uid) ?? []).map((o) => o.recurrenceId));
      // By minute: a Set, not a scan of every EXDATE for every occurrence.
      const excluded = new Set(ev.exdates.map((x) => Math.round(x / 60_000)));
      for (const w of generateStarts(ev, windowStartDay, windowEndDay, budget)) {
        if (!near(ev, w)) continue;
        const ts = wallToUtc(w);
        if (excluded.has(Math.round(ts / 60_000)) || skipped.has(ts)) continue;
        emit(ev, w, ts);
      }
    } catch {
      // One event that cannot be expanded loses its own occurrences, never
      // the rest of the feed's (a RangeError here used to empty the layer).
    }
  }
  const occurrences = out.sort((a, b) => (a.date + String(a.startMin).padStart(4, "0")).localeCompare(b.date + String(b.startMin).padStart(4, "0")));
  return { occurrences, truncated: budget.truncated, steps: maxSteps - Math.max(budget.left, 0) };
}

/* ---------- outbound feed ---------- */

export interface IcsExportItem {
  uid: string;
  title: string;
  date: string; // YYYY-MM-DD, server-local
  startMin: number;
  durationMin: number;
}

/**
 * RFC 5545 TEXT. A CR (alone or in CRLF) is a line break too: left raw, a bare
 * CR inside SUMMARY ended the content line early in stricter clients and let
 * the rest of a title read as a property of its own.
 */
const escapeText = (s: string) =>
  s.replace(/\r\n?/g, "\n").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

/**
 * Fold a content line at 75 octets (RFC 5545 §3.1): CRLF + one space, never
 * inside a multi-byte character. Long titles were emitted on one line, which
 * Outlook and some phone clients truncate or reject.
 */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with the space
    if (bytes + n > limit) {
      parts.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function buildIcs(calendarName: string, items: IcsExportItem[]): string {
  const now = utcStamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Orrama//Orrama Calendar//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const it of items) {
    const [y, mo, d] = it.date.split("-").map(Number);
    // Server-local wall time → UTC instants (the grid is server-local by design).
    const start = new Date(y!, mo! - 1, d!, Math.floor(it.startMin / 60), it.startMin % 60);
    const end = new Date(start.getTime() + it.durationMin * 60_000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${it.uid}@basalt`,
      `DTSTAMP:${now}`,
      `DTSTART:${utcStamp(start)}`,
      `DTEND:${utcStamp(end)}`,
      `SUMMARY:${escapeText(it.title)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
