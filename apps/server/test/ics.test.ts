/**
 * ICS parse/expand/build unit tests. TZ pinned so occurrence→local-slot
 * conversion is deterministic regardless of the machine running the suite.
 */
process.env.TZ = "Europe/Amsterdam";

import { describe, expect, it } from "vitest";
import { buildIcs, expandIcs, parseIcs } from "../src/ics.js";

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

describe("buildIcs", () => {
  it("round-trips through parse+expand to the same local slot", () => {
    const ics = buildIcs("Basalt — Jules", [
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
  const ics = buildIcs("Basalt", [{ uid: "ev-1", title, date: "2026-10-05", startMin: 600, durationMin: 60 }]);

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
