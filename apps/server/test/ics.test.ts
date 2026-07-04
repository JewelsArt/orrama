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
