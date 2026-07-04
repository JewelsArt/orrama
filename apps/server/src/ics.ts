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

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const MAX_OCCURRENCES = 3000;

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
}

/** One concrete occurrence, in server-local calendar coordinates. */
export interface IcsOccurrence {
  uid: string;
  title: string;
  date: string; // YYYY-MM-DD
  startMin: number;
  durationMin: number;
  allDay: boolean;
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

/** How far `tz` is ahead of UTC at instant `ts`, in ms. */
function tzOffsetMs(ts: number, tz: string): number {
  const parts: Record<string, string> = {};
  for (const p of dtf(tz).formatToParts(new Date(ts))) parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour! % 24, +parts.minute!, +parts.second!);
  return asUtc - ts;
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

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

export function parseIcs(text: string): VEvent[] {
  const lines = unfold(text);
  const events: VEvent[] = [];
  let cur: Partial<VEvent> & { start?: Wall; end?: Wall; durationRaw?: number } | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = { exdates: [], rrule: null, recurrenceId: null, cancelled: false, title: "(untitled)" };
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

/**
 * Generate occurrence start Walls for one master event, honoring COUNT/UNTIL.
 * Generation always starts at DTSTART (COUNT semantics), the window only filters.
 */
function generateStarts(ev: VEvent, windowEndDay: number): Wall[] {
  const rule = ev.rrule;
  if (!rule) return [ev.start];
  const freq = rule["FREQ"];
  const interval = Math.max(1, +(rule["INTERVAL"] ?? 1));
  const count = rule["COUNT"] ? +rule["COUNT"] : Infinity;
  let untilMs = Infinity;
  if (rule["UNTIL"]) {
    const w = parseDt(rule["UNTIL"], /Z$/.test(rule["UNTIL"]) ? {} : { TZID: ev.start.tz });
    if (w) untilMs = w.allDay ? wallToUtc({ ...w, h: 23, mi: 59 }) : wallToUtc(w);
  }
  const startDay = wallDayNumber(ev.start);
  const out: Wall[] = [];
  const push = (w: Wall): boolean => {
    if (wallDayNumber(w) < startDay) return true; // before DTSTART: not an occurrence
    if (wallToUtc(w) > untilMs) return false;
    out.push(w);
    return out.length < Math.min(count, MAX_OCCURRENCES);
  };

  if (freq === "DAILY") {
    for (let i = 0; ; i++) {
      const w = addDays(ev.start, i * interval);
      if (wallDayNumber(w) > windowEndDay && out.length >= Math.min(count, 1)) break;
      if (!push(w)) break;
      if (i > MAX_OCCURRENCES) break;
    }
  } else if (freq === "WEEKLY") {
    const bydays = (rule["BYDAY"]?.split(",") ?? [DOW[weekdayOf(ev.start)]!]).map((s) => DOW.indexOf(s.trim())).filter((n) => n >= 0);
    // Weeks start Monday (WKST default); walk week by week emitting each BYDAY.
    const dowStart = weekdayOf(ev.start);
    const weekMonday = addDays(ev.start, -((dowStart + 6) % 7));
    outer: for (let week = 0; ; week++) {
      const base = addDays(weekMonday, week * interval * 7);
      if (wallDayNumber(base) > windowEndDay + 7) break;
      for (const dow of [1, 2, 3, 4, 5, 6, 0]) {
        if (!bydays.includes(dow)) continue;
        const w = addDays(base, (dow + 6) % 7);
        if (!push(w)) break outer;
      }
      if (week > MAX_OCCURRENCES) break;
    }
  } else if (freq === "MONTHLY") {
    const bymonthday = rule["BYMONTHDAY"] ? +rule["BYMONTHDAY"] : null;
    const byday = rule["BYDAY"] ? /^(-?\d+)?([A-Z]{2})$/.exec(rule["BYDAY"]) : null;
    outer: for (let i = 0; ; i++) {
      const t = new Date(Date.UTC(ev.start.y, ev.start.mo - 1 + i * interval, 1));
      const y = t.getUTCFullYear();
      const mo = t.getUTCMonth() + 1;
      if (wallDayNumber({ ...ev.start, y, mo, d: 1 }) > windowEndDay) break;
      let day: number | null;
      if (byday) day = nthWeekday(y, mo, DOW.indexOf(byday[2]!), +(byday[1] ?? 1));
      else day = (bymonthday ?? ev.start.d) <= daysInMonth(y, mo) ? (bymonthday ?? ev.start.d) : null;
      if (day !== null && !push({ ...ev.start, y, mo, d: day })) break outer;
      if (i > MAX_OCCURRENCES) break;
    }
  } else if (freq === "YEARLY") {
    for (let i = 0; ; i++) {
      const y = ev.start.y + i * interval;
      if (wallDayNumber({ ...ev.start, y }) > windowEndDay) break;
      if (ev.start.d <= daysInMonth(y, ev.start.mo) && !push({ ...ev.start, y })) break;
      if (i > MAX_OCCURRENCES) break;
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

/** Expand a parsed feed into occurrences within [from, to] (YYYY-MM-DD, inclusive). */
export function expandIcs(events: VEvent[], from: string, to: string): IcsOccurrence[] {
  const fromMs = new Date(`${from}T00:00:00`).getTime();
  const toMs = new Date(`${to}T23:59:59`).getTime();
  const windowEndDay = Math.floor(Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) / 86_400_000) + 2;

  const overrides = new Map<string, VEvent[]>();
  for (const ev of events) {
    if (ev.recurrenceId !== null) {
      const list = overrides.get(ev.uid) ?? [];
      list.push(ev);
      overrides.set(ev.uid, list);
    }
  }

  const out: IcsOccurrence[] = [];
  const emit = (ev: VEvent, startWall: Wall) => {
    if (ev.start.allDay) {
      // All-day: pure calendar dates, one chip per covered day.
      const days = Math.max(1, Math.round(ev.durationMin / 1440));
      for (let i = 0; i < days; i++) {
        const day = wallDateStr(addDays(startWall, i));
        if (day >= from && day <= to) out.push({ uid: ev.uid, title: ev.title, date: day, startMin: 0, durationMin: 1440, allDay: true });
      }
      return;
    }
    const ts = wallToUtc(startWall);
    if (ts < fromMs - ev.durationMin * 60_000 || ts > toMs) return;
    const slot = toLocalSlot(ts);
    if (slot.date < from || slot.date > to) return;
    out.push({ uid: ev.uid, title: ev.title, date: slot.date, startMin: slot.startMin, durationMin: ev.durationMin, allDay: false });
  };

  for (const ev of events) {
    if (ev.recurrenceId !== null) {
      if (!ev.cancelled) emit(ev, ev.start);
      continue;
    }
    if (ev.cancelled) continue;
    const skipped = new Set((overrides.get(ev.uid) ?? []).map((o) => o.recurrenceId));
    for (const w of generateStarts(ev, windowEndDay)) {
      const ts = wallToUtc(w);
      if (ev.exdates.some((x) => Math.abs(x - ts) < 60_000) || skipped.has(ts)) continue;
      emit(ev, w);
    }
  }
  return out.sort((a, b) => (a.date + String(a.startMin).padStart(4, "0")).localeCompare(b.date + String(b.startMin).padStart(4, "0")));
}

/* ---------- outbound feed ---------- */

export interface IcsExportItem {
  uid: string;
  title: string;
  date: string; // YYYY-MM-DD, server-local
  startMin: number;
  durationMin: number;
}

const escapeText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function buildIcs(calendarName: string, items: IcsExportItem[]): string {
  const now = utcStamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Basalt//Basalt Calendar//EN",
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
  return lines.join("\r\n") + "\r\n";
}
