/**
 * ICS parse/expand/build unit tests. TZ pinned so occurrence→local-slot
 * conversion is deterministic regardless of the machine running the suite.
 */
process.env.TZ = "Europe/Amsterdam";

import { describe, expect, it } from "vitest";
import { buildIcs, expandIcs, expandIcsReport, MAX_EXPAND_STEPS, parseIcs } from "../src/ics.js";

const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;

describe("parseIcs", () => {
  it("parses a plain TZID event with folded lines and escaped text", () => {
    const events = parseIcs(
      wrap(
        [
          "BEGIN:VEVENT",
          "UID:a1",
          "DTSTART;TZID=Europe/Amsterdam:20260706T090000",
          "DTEND;TZID=Europe/Amsterdam:20260706T103000",
          "SUMMARY:Lecture\\, room B2",
          "  (folded continuation)", // fold marker eats exactly one leading space (RFC 5545 §3.1)
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe("Lecture, room B2 (folded continuation)");
    expect(events[0]!.durationMin).toBe(90);
  });

  it("takes DURATION when DTEND is absent and defaults to 60min with neither", () => {
    const events = parseIcs(
      wrap(
        "BEGIN:VEVENT\r\nUID:a2\r\nDTSTART:20260706T070000Z\r\nDURATION:PT2H\r\nEND:VEVENT\r\n" +
          "BEGIN:VEVENT\r\nUID:a3\r\nDTSTART:20260706T070000Z\r\nEND:VEVENT",
      ),
    );
    expect(events.map((e) => e.durationMin)).toEqual([120, 60]);
  });
});

describe("expandIcs", () => {
  it("converts UTC to server-local slots (07:00Z = 09:00 Amsterdam in July)", () => {
    const occ = expandIcs(
      parseIcs(wrap("BEGIN:VEVENT\r\nUID:b1\r\nDTSTART:20260706T070000Z\r\nDTEND:20260706T080000Z\r\nSUMMARY:Standup\r\nEND:VEVENT")),
      "2026-07-06",
      "2026-07-12",
    );
    expect(occ).toEqual([{ uid: "b1", title: "Standup", date: "2026-07-06", startMin: 540, durationMin: 60, allDay: false }]);
  });

  it("expands WEEKLY;BYDAY with EXDATE, keeping wall time across the window", () => {
    const occ = expandIcs(
      parseIcs(
        wrap(
          [
            "BEGIN:VEVENT",
            "UID:c1",
            "DTSTART;TZID=Europe/Amsterdam:20260706T090000",
            "DTEND;TZID=Europe/Amsterdam:20260706T110000",
            "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
            "EXDATE;TZID=Europe/Amsterdam:20260708T090000",
            "SUMMARY:TCL lecture",
            "END:VEVENT",
          ].join("\r\n"),
        ),
      ),
      "2026-07-06",
      "2026-07-19",
    );
    // Mon 6, (Wed 8 excluded), Mon 13, Wed 15 — all at 09:00 local
    expect(occ.map((o) => o.date)).toEqual(["2026-07-06", "2026-07-13", "2026-07-15"]);
    expect(new Set(occ.map((o) => o.startMin))).toEqual(new Set([540]));
  });

  it("honors COUNT from DTSTART, not from the query window", () => {
    const occ = expandIcs(
      parseIcs(
        wrap("BEGIN:VEVENT\r\nUID:d1\r\nDTSTART;TZID=Europe/Amsterdam:20260601T100000\r\nRRULE:FREQ=WEEKLY;COUNT=6\r\nSUMMARY:Six\r\nEND:VEVENT"),
      ),
      "2026-06-29",
      "2026-07-31",
    );
    // Occurrences 1-4 (Jun 1..22) fall before the window; only Jun 29 + Jul 6 remain.
    expect(occ.map((o) => o.date)).toEqual(["2026-06-29", "2026-07-06"]);
  });

  it("stops at UNTIL", () => {
    const occ = expandIcs(
      parseIcs(
        wrap("BEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20260701T100000Z\r\nRRULE:FREQ=DAILY;UNTIL=20260703T100000Z\r\nSUMMARY:Daily\r\nEND:VEVENT"),
      ),
      "2026-07-01",
      "2026-07-10",
    );
    expect(occ.map((o) => o.date)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
  });

  it("applies RECURRENCE-ID overrides and drops cancelled instances", () => {
    const occ = expandIcs(
      parseIcs(
        wrap(
          [
            "BEGIN:VEVENT",
            "UID:f1",
            "DTSTART;TZID=Europe/Amsterdam:20260706T090000",
            "RRULE:FREQ=DAILY;COUNT=3",
            "SUMMARY:Sync",
            "END:VEVENT",
            // Tuesday's instance moved to 14:00
            "BEGIN:VEVENT",
            "UID:f1",
            "RECURRENCE-ID;TZID=Europe/Amsterdam:20260707T090000",
            "DTSTART;TZID=Europe/Amsterdam:20260707T140000",
            "SUMMARY:Sync (moved)",
            "END:VEVENT",
            // Wednesday's instance cancelled
            "BEGIN:VEVENT",
            "UID:f1",
            "RECURRENCE-ID;TZID=Europe/Amsterdam:20260708T090000",
            "DTSTART;TZID=Europe/Amsterdam:20260708T090000",
            "STATUS:CANCELLED",
            "SUMMARY:Sync",
            "END:VEVENT",
          ].join("\r\n"),
        ),
      ),
      "2026-07-06",
      "2026-07-12",
    );
    expect(occ.map((o) => [o.date, o.startMin, o.title])).toEqual([
      ["2026-07-06", 540, "Sync"],
      ["2026-07-07", 840, "Sync (moved)"],
    ]);
  });

  it("emits an all-day chip per covered day", () => {
    const occ = expandIcs(
      parseIcs(wrap("BEGIN:VEVENT\r\nUID:g1\r\nDTSTART;VALUE=DATE:20260706\r\nDTEND;VALUE=DATE:20260708\r\nSUMMARY:Resit week\r\nEND:VEVENT")),
      "2026-07-01",
      "2026-07-31",
    );
    expect(occ.map((o) => [o.date, o.allDay])).toEqual([
      ["2026-07-06", true],
      ["2026-07-07", true],
    ]);
  });

  it("supports MONTHLY nth-weekday (2nd Tuesday)", () => {
    const occ = expandIcs(
      parseIcs(
        wrap("BEGIN:VEVENT\r\nUID:h1\r\nDTSTART;TZID=Europe/Amsterdam:20260714T190000\r\nRRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3\r\nSUMMARY:Meetup\r\nEND:VEVENT"),
      ),
      "2026-07-01",
      "2026-10-01",
    );
    expect(occ.map((o) => o.date)).toEqual(["2026-07-14", "2026-08-11", "2026-09-08"]);
  });
});

/**
 * RRULE forms that produced wrong dates, or none at all (audit).
 *
 * Every case here is a rule Google Calendar emits without asking: "last day of
 * the month", a semi-monthly payday, a class on Monday and Wednesday. The
 * expander answered the first with the literal string "2026-03--1", the second
 * with silence, and the third with whatever day of the month DTSTART happened
 * to fall on.
 */
describe("expandIcs: the RRULE forms that were wrong", () => {
  const monthly = (rule: string, uid = "r1") =>
    wrap(
      [
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTART;TZID=Europe/Amsterdam:20260115T090000",
        "DTEND;TZID=Europe/Amsterdam:20260115T100000",
        "SUMMARY:Rule",
        `RRULE:${rule}`,
        "END:VEVENT",
      ].join("\r\n"),
    );

  it("BYMONTHDAY=-1 is the last day of each month, not a negative day number", () => {
    const occ = expandIcs(parseIcs(monthly("FREQ=MONTHLY;BYMONTHDAY=-1")), "2026-01-01", "2026-04-30");
    // January is skipped: the 31st is after DTSTART on the 15th, so it counts.
    expect(occ.map((o) => o.date)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    // Nothing may carry a malformed date, and nothing may precede DTSTART.
    for (const o of occ) {
      expect(o.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.date >= "2026-01-15").toBe(true);
    }
  });

  it("BYMONTHDAY=-1 on an ALL-DAY event does not emit a malformed date string", () => {
    // An all-day occurrence is rendered straight from the Wall's own fields,
    // with no instant in between to normalise them — which is where the audit
    // found the literal "2026-03--1" on the wire.
    const occ = expandIcs(
      parseIcs(
        wrap(
          [
            "BEGIN:VEVENT",
            "UID:allday",
            "DTSTART;VALUE=DATE:20260115",
            "DTEND;VALUE=DATE:20260116",
            "SUMMARY:Rent",
            "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1",
            "END:VEVENT",
          ].join("\r\n"),
        ),
      ),
      "2026-01-01",
      "2026-03-31",
    );
    expect(occ.map((o) => o.date)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    for (const o of occ) expect(o.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("BYMONTHDAY=-2 is the day before that", () => {
    const occ = expandIcs(parseIcs(monthly("FREQ=MONTHLY;BYMONTHDAY=-2")), "2026-01-01", "2026-03-31");
    expect(occ.map((o) => o.date)).toEqual(["2026-01-30", "2026-02-27", "2026-03-30"]);
  });

  it("BYMONTHDAY=1,15 is a semi-monthly payday, not silence", () => {
    const occ = expandIcs(parseIcs(monthly("FREQ=MONTHLY;BYMONTHDAY=1,15")), "2026-01-01", "2026-03-31");
    expect(occ.map((o) => o.date)).toEqual([
      "2026-01-15", // the 1st is before DTSTART
      "2026-02-01",
      "2026-02-15",
      "2026-03-01",
      "2026-03-15",
    ]);
  });

  it("BYMONTHDAY skips a month that is too short rather than rolling over", () => {
    const occ = expandIcs(parseIcs(monthly("FREQ=MONTHLY;BYMONTHDAY=30")), "2026-01-01", "2026-04-30");
    expect(occ.map((o) => o.date)).toEqual(["2026-01-30", "2026-03-30", "2026-04-30"]);
  });

  it("MONTHLY;BYDAY=1MO,3MO takes both, not the day DTSTART fell on", () => {
    const occ = expandIcs(parseIcs(monthly("FREQ=MONTHLY;BYDAY=1MO,3MO")), "2026-01-01", "2026-02-28");
    // Jan 2026: Mondays are 5, 12, 19, 26 → 1st = 5 (before DTSTART), 3rd = 19.
    // Feb 2026: Mondays are 2, 9, 16, 23 → 1st = 2, 3rd = 16.
    expect(occ.map((o) => o.date)).toEqual(["2026-01-19", "2026-02-02", "2026-02-16"]);
  });

  it("MONTHLY;BYDAY=MO with no ordinal is every Monday of the month", () => {
    const occ = expandIcs(parseIcs(monthly("FREQ=MONTHLY;BYDAY=MO")), "2026-02-01", "2026-02-28");
    expect(occ.map((o) => o.date)).toEqual(["2026-02-02", "2026-02-09", "2026-02-16", "2026-02-23"]);
  });

  it("MONTHLY;BYDAY=-1FR is the last Friday", () => {
    const occ = expandIcs(parseIcs(monthly("FREQ=MONTHLY;BYDAY=-1FR")), "2026-01-01", "2026-03-31");
    expect(occ.map((o) => o.date)).toEqual(["2026-01-30", "2026-02-27", "2026-03-27"]);
  });

  it("a daily event with an old DTSTART is still visible today", () => {
    // Eight years of dailies is ~2,900 occurrences and the cap is 3,000, so
    // this used to fall off the end: generation began at DTSTART and the
    // earliest occurrences were the ones kept.
    const occ = expandIcs(
      parseIcs(
        wrap(
          [
            "BEGIN:VEVENT",
            "UID:old",
            "DTSTART;TZID=Europe/Amsterdam:20120102T080000",
            "DTEND;TZID=Europe/Amsterdam:20120102T081500",
            "SUMMARY:Pills",
            "RRULE:FREQ=DAILY",
            "END:VEVENT",
          ].join("\r\n"),
        ),
      ),
      "2026-09-14",
      "2026-09-20",
    );
    expect(occ.map((o) => o.date)).toEqual([
      "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20",
    ]);
  });

  it("COUNT still counts from DTSTART, not from the window", () => {
    const occ = expandIcs(
      parseIcs(
        wrap(
          [
            "BEGIN:VEVENT",
            "UID:cnt",
            "DTSTART;TZID=Europe/Amsterdam:20260105T080000",
            "DTEND;TZID=Europe/Amsterdam:20260105T090000",
            "SUMMARY:Five only",
            "RRULE:FREQ=DAILY;COUNT=5",
            "END:VEVENT",
          ].join("\r\n"),
        ),
      ),
      "2026-01-07",
      "2026-12-31",
    );
    // Five occurrences exist: Jan 5-9. The window starts on the 7th, so three.
    expect(occ.map((o) => o.date)).toEqual(["2026-01-07", "2026-01-08", "2026-01-09"]);
  });
});

/**
 * A feed is untrusted input, expanded on the event loop for every calendar
 * page (audit INP-002). Every rule used to be walked from DTSTART to the
 * window, up to 40,000 steps per event with a timezone conversion each: ten
 * daily events begun in 1900 took 5 s to show one week, 500 took 5 minutes,
 * and nothing else was served meanwhile.
 */
describe("expandIcs on a long-lived or hostile feed", () => {
  const masters = (n: number, rule: string, dtstart = "19000101T090000Z") =>
    wrap(Array.from({ length: n }, (_, i) => `BEGIN:VEVENT\r\nUID:e${i}\r\nDTSTART:${dtstart}\r\nRRULE:${rule}\r\nSUMMARY:x${i}\r\nEND:VEVENT`).join("\r\n"));

  it("500 daily events begun in 1900 expand one week in a few steps each, all of them shown", { timeout: 30_000 }, () => {
    const events = parseIcs(masters(500, "FREQ=DAILY"));
    const t = performance.now();
    const r = expandIcsReport(events, "2026-10-05", "2026-10-11");
    const ms = performance.now() - t;
    expect(r.truncated).toBe(false);
    expect(r.occurrences).toHaveLength(500 * 7);
    // The window is 7 days plus a little slack either side: a handful of steps
    // per event, not the 46,000 days since 1900.
    expect(r.steps).toBeLessThan(500 * 20);
    expect(ms).toBeLessThan(3000); // ~20 ms here; minutes before (the step count above is the real pin)
  });

  it("weekly and monthly rules begun in 1900 jump to the window too", { timeout: 30_000 }, () => {
    const weekly = expandIcsReport(parseIcs(masters(200, "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU")), "2026-10-05", "2026-10-11");
    expect(weekly.occurrences).toHaveLength(200 * 7);
    expect(weekly.steps).toBeLessThan(200 * 10);
    const monthly = expandIcsReport(parseIcs(masters(200, "FREQ=MONTHLY;BYMONTHDAY=7")), "2026-10-05", "2026-10-11");
    expect(monthly.occurrences).toHaveLength(200);
    expect(monthly.steps).toBeLessThan(200 * 10);
    const yearly = expandIcsReport(parseIcs(masters(200, "FREQ=YEARLY", "19001007T090000Z")), "2026-10-05", "2026-10-11");
    expect(yearly.occurrences).toHaveLength(200);
    expect(yearly.steps).toBeLessThan(200 * 10);
  });

  it("COUNT is still counted from DTSTART when the weeks before the window are skipped", () => {
    // Mondays and Thursdays from Thu 1 Jan 2026: the first week holds only the
    // Thursday, then two a week, so the 60th is the Monday of week 30, 27 Jul.
    const occ = expandIcs(parseIcs(masters(1, "FREQ=WEEKLY;BYDAY=MO,TH;COUNT=60", "20260101T090000Z")), "2026-07-13", "2026-08-09");
    expect(occ.map((o) => o.date)).toEqual(["2026-07-13", "2026-07-16", "2026-07-20", "2026-07-23", "2026-07-27"]);
    // Monthly on the 1st and 15th from Jan 2025: COUNT=40 ends on 15 Aug 2026.
    const semi = expandIcs(parseIcs(masters(1, "FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=40", "20250101T090000Z")), "2026-07-01", "2026-09-30");
    expect(semi.map((o) => o.date)).toEqual(["2026-07-01", "2026-07-15", "2026-08-01", "2026-08-15"]);
  });

  it("a rule whose INTERVAL or COUNT is not a number is the master's own occurrence, and the feed survives", () => {
    for (const rule of ["FREQ=DAILY;INTERVAL=X", "FREQ=WEEKLY;INTERVAL=two", "FREQ=DAILY;INTERVAL=1e400", "FREQ=YEARLY;INTERVAL=-1", "FREQ=DAILY;COUNT=many"]) {
      const feed = wrap(
        [
          `BEGIN:VEVENT\r\nUID:odd\r\nDTSTART:20261006T090000Z\r\nDTEND:20261006T100000Z\r\nRRULE:${rule}\r\nSUMMARY:odd\r\nEND:VEVENT`,
          "BEGIN:VEVENT\r\nUID:ok\r\nDTSTART:20261007T090000Z\r\nDTEND:20261007T100000Z\r\nSUMMARY:normal\r\nEND:VEVENT",
        ].join("\r\n"),
      );
      const occ = expandIcs(parseIcs(feed), "2026-10-05", "2026-10-11");
      expect(occ.map((o) => `${o.uid} ${o.date}`), rule).toEqual(["odd 2026-10-06", "ok 2026-10-07"]);
    }
  });

  it("a huge INTERVAL past what a Date can hold ends the rule instead of throwing", () => {
    const occ = expandIcs(parseIcs(masters(1, "FREQ=YEARLY;INTERVAL=999999999", "20261006T090000Z")), "2026-10-05", "2026-10-11");
    expect(occ.map((o) => o.date)).toEqual(["2026-10-06"]);
  });

  it("a pathological feed stops at the budget and says it was cut short", { timeout: 30_000 }, () => {
    // COUNT forces the months before the window to be counted, and a DTSTART
    // in the year 100 makes that 23,000 months per event.
    const events = parseIcs(masters(400, "FREQ=MONTHLY;BYDAY=MO;COUNT=999999999", "01000101T090000Z"));
    const t = performance.now();
    const r = expandIcsReport(events, "2026-10-05", "2026-10-11");
    const ms = performance.now() - t;
    expect(r.truncated).toBe(true);
    expect(r.steps).toBe(MAX_EXPAND_STEPS);
    expect(ms).toBeLessThan(15_000); // ~0.3 s here; unbounded before (the step count is the real pin)
    // A smaller budget stops sooner, and the events it reached are still shown.
    const small = expandIcsReport(events, "2026-10-05", "2026-10-11", 100_000);
    expect(small.truncated).toBe(true);
    expect(small.occurrences.length).toBeGreaterThan(0);
  });

  it("the timezone offsets it remembers per day are exact on the day the clocks change", () => {
    // Amsterdam goes from +1 to +2 at 01:00Z on 29 Mar 2026 and back at 01:00Z on 25 Oct.
    const at = (dt: string) =>
      expandIcs(parseIcs(wrap(`BEGIN:VEVENT\r\nUID:d\r\nDTSTART;TZID=Europe/Amsterdam:${dt}\r\nDTEND;TZID=Europe/Amsterdam:${dt}\r\nSUMMARY:x\r\nEND:VEVENT`)), "2026-01-01", "2026-12-31").map((o) => [o.date, o.startMin]);
    expect(at("20260329T000000")).toEqual([["2026-03-29", 0]]);
    expect(at("20260329T090000")).toEqual([["2026-03-29", 540]]);
    expect(at("20261025T090000")).toEqual([["2026-10-25", 540]]);
    expect(at("20261025T230000")).toEqual([["2026-10-25", 1380]]);
  });

  it("an event the expander chokes on loses its own occurrences, never the feed's", () => {
    const [good] = parseIcs(wrap("BEGIN:VEVENT\r\nUID:ok\r\nDTSTART:20261007T090000Z\r\nSUMMARY:ok\r\nEND:VEVENT"));
    const broken = { ...good!, uid: "bad", rrule: { FREQ: "DAILY" }, exdates: null as unknown as number[] };
    expect(expandIcs([broken, good!], "2026-10-05", "2026-10-11").map((o) => o.uid)).toEqual(["ok"]);
  });

  it("thousands of EXDATEs are a lookup per occurrence, not a scan", { timeout: 30_000 }, () => {
    const exdates = Array.from({ length: 50_000 }, (_, i) => new Date(Date.UTC(2020, 0, 1 + i, 9)).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")).join(",");
    const feed = wrap(`BEGIN:VEVENT\r\nUID:x\r\nDTSTART:20000101T090000Z\r\nRRULE:FREQ=DAILY\r\nEXDATE:${exdates}\r\nSUMMARY:x\r\nEND:VEVENT`);
    const occ = expandIcs(parseIcs(feed), "2026-10-05", "2026-10-11");
    // Every day from 2020 for 50,000 days is excluded: nothing left this week.
    expect(occ).toEqual([]);
    const kept = expandIcs(parseIcs(feed), "2019-12-25", "2019-12-31");
    expect(kept).toHaveLength(7);
  });
});

describe("buildIcs", () => {
  it("round-trips through parse+expand to the same local slot", () => {
    const ics = buildIcs("Orrama — Jules", [
      { uid: "blk-1", title: "permission test suite; deep work", date: "2026-07-07", startMin: 600, durationMin: 120 },
    ]);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("SUMMARY:permission test suite\\; deep work");
    const occ = expandIcs(parseIcs(ics), "2026-07-01", "2026-07-31");
    expect(occ).toEqual([
      { uid: "blk-1@basalt", title: "permission test suite; deep work", date: "2026-07-07", startMin: 600, durationMin: 120, allDay: false },
    ]);
  });
});

describe("buildIcs, long and awkward titles", () => {
  const title = "Réunion de soutenance 🎓 — chapitre 3; méthodes, résultats & discussion\r\nsecond line\rthird \\ line " + "é".repeat(60);
  const ics = buildIcs("Orrama", [{ uid: "ev-1", title, date: "2026-10-05", startMin: 600, durationMin: 60 }]);

  it("folds every content line to at most 75 octets, and never splits a character", () => {
    const physical = ics.split("\r\n").slice(0, -1);
    for (const line of physical) expect(Buffer.byteLength(line), line).toBeLessThanOrEqual(75);
    expect(physical.some((l) => l.startsWith(" "))).toBe(true); // it did fold
    expect(ics).not.toContain("�");
  });

  it("has no bare CR or LF, only CRLF line ends", () => {
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("round-trips through the parser to the same title, breaks as \\n", () => {
    const [ev] = parseIcs(ics);
    expect(ev!.title).toBe(title.replace(/\r\n?/g, "\n"));
  });
});
