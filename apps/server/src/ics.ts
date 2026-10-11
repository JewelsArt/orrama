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
/**
 * How many steps the generator may take before giving up. Separate from
 * MAX_OCCURRENCES, which caps what is KEPT: a daily event that started in 2012
 * has to be walked past before the current week is reached, and capping the
 * walk at the same 3,000 made every such event invisible (audit).
 */
const MAX_STEPS = 40_000;

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
function generateStarts(ev: VEvent, windowStartDay: number, windowEndDay: number): Wall[] {
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
  // Occurrences are COUNTED from DTSTART and KEPT from the window. Keeping
  // them all is what made a long-running daily event vanish: the cap filled up
  // with occurrences from years ago and the loop stopped before today. The
  // slack is for an all-day event that began before the window and still
  // covers part of it.
  const keepFrom = windowStartDay - 2 - Math.ceil(ev.durationMin / 1440);
  const out: Wall[] = [];
  let emitted = 0;
  const push = (w: Wall): boolean => {
    if (wallDayNumber(w) < startDay) return true; // before DTSTART: not an occurrence
    if (wallToUtc(w) > untilMs) return false;
    emitted++;
    if (emitted > count) return false;
    if (wallDayNumber(w) >= keepFrom) out.push(w);
    return out.length < MAX_OCCURRENCES;
  };

  if (freq === "DAILY") {
    for (let i = 0; ; i++) {
      const w = addDays(ev.start, i * interval);
      if (wallDayNumber(w) > windowEndDay) break;
      if (!push(w)) break;
      if (i > MAX_STEPS) break;
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
      if (week > MAX_STEPS) break;
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

    outer: for (let i = 0; ; i++) {
      const t = new Date(Date.UTC(ev.start.y, ev.start.mo - 1 + i * interval, 1));
      const y = t.getUTCFullYear();
      const mo = t.getUTCMonth() + 1;
      if (wallDayNumber({ ...ev.start, y, mo, d: 1 }) > windowEndDay) break;
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

      for (const d of [...new Set(days)].sort((a, b) => a - b)) {
        if (!push({ ...ev.start, y, mo, d })) break outer;
      }
      if (i > MAX_STEPS) break;
    }
  } else if (freq === "YEARLY") {
    for (let i = 0; ; i++) {
      const y = ev.start.y + i * interval;
      if (wallDayNumber({ ...ev.start, y }) > windowEndDay) break;
      if (ev.start.d <= daysInMonth(y, ev.start.mo) && !push({ ...ev.start, y })) break;
      if (i > MAX_STEPS) break;
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
  const windowStartDay = Math.floor(Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10)) / 86_400_000);

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
    // One that began before the window and still runs into it is kept, under
    // its own start date: its time inside the window is busy (audit COR-010).
    if (slot.date > to) return;
    out.push({ uid: ev.uid, title: ev.title, date: slot.date, startMin: slot.startMin, durationMin: ev.durationMin, allDay: false });
  };

  for (const ev of events) {
    if (ev.recurrenceId !== null) {
      if (!ev.cancelled) emit(ev, ev.start);
      continue;
    }
    if (ev.cancelled) continue;
    const skipped = new Set((overrides.get(ev.uid) ?? []).map((o) => o.recurrenceId));
    for (const w of generateStarts(ev, windowStartDay, windowEndDay)) {
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
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
