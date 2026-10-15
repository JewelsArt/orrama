/**
 * "Plan my week" books nothing over a subscribed-calendar event, whatever its
 * shape (audit COR-010; CLAUDE.md: "Nothing lands over an existing block,
 * event or subscribed-calendar occurrence"). An ICS occurrence used to be busy
 * on its start date only, and only when that date was inside the range: a
 * timed event from Wednesday 08:00 to Thursday 18:00 left Thursday free, and
 * an overnight one that began on Sunday evening was dropped from a Monday plan
 * altogether, so proposals landed inside both.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { isoLocal } from "@orrama/core";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-plan-ics-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";
process.env.ORRAMA_FETCH_ALLOW = "127.0.0.1"; // the local calendar feed below

/** The Monday after next, so the whole week is in the future whatever today is. */
const monday = (() => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7) + 7);
  return d;
})();
const day = (offset: number) => isoLocal(new Date(monday.getTime() + offset * 86_400_000));
const ics = (d: string, hm: string) => `${d.replace(/-/g, "")}T${hm}00`; // floating: the server's local time

const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:conference@test",
  `DTSTART:${ics(day(2), "0800")}`,
  `DTEND:${ics(day(3), "1800")}`,
  "SUMMARY:Conference",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:train@test",
  `DTSTART:${ics(day(-1), "2000")}`,
  `DTEND:${ics(day(0), "1130")}`,
  "SUMMARY:Night train",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:late-shift@test",
  `DTSTART:${ics(isoLocal(new Date(Date.now() - 86_400_000)), "2000")}`,
  `DTEND:${ics(isoLocal(new Date()), "0130")}`,
  "SUMMARY:Late shift",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const VAULT = process.env.ORRAMA_VAULT_DIR;
fs.mkdirSync(path.join(VAULT, "Shared"), { recursive: true });
fs.writeFileSync(
  path.join(VAULT, "Shared/Backlog.md"),
  `# Backlog\n\n${Array.from({ length: 16 }, (_, i) => `- [ ] carefully draft and review the full section number ${i} !p1`).join("\n")}\n`,
);
await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

let b: Awaited<ReturnType<typeof buildServer>>;
let token = "";
let feed: http.Server;
const call = async (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) => {
  const res = await b.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: res.json() };
};

beforeAll(async () => {
  feed = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/calendar" });
    res.end(FEED);
  });
  await new Promise<void>((r) => feed.listen(0, "127.0.0.1", r));
  b = await buildServer();
  token = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } })).json().token;
  const { port } = feed.address() as AddressInfo;
  expect((await call("POST", "/api/calendar/feeds", { label: "Work", url: `http://127.0.0.1:${port}/cal.ics` })).status).toBe(200);
});
afterAll(async () => {
  await b.app.close();
  await new Promise<void>((r) => feed.close(() => r()));
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

type Proposal = { date: string; startMin: number; durationMin: number };
/** Busy spans as [date, startMin, endMin] per day they cover. */
const BUSY: [string, number, number][] = [
  [day(0), 0, 11 * 60 + 30], // the night train, Monday morning
  [day(2), 8 * 60, 24 * 60], // the conference, Wednesday
  [day(3), 0, 18 * 60], //      and Thursday
];
const overlaps = (p: Proposal) => BUSY.filter(([d, s, e]) => p.date === d && p.startMin < e && p.startMin + p.durationMin > s);

it("no proposal lands inside a multi-day or an overnight subscribed event", async () => {
  const res = await call("POST", "/api/plan/auto", { from: day(0), to: day(4) });
  expect(res.status).toBe(200);
  const proposals = res.body.proposals as Proposal[];
  // The week is full: there is more work than free time, so every free slot is used.
  expect(proposals.length).toBeGreaterThan(5);
  expect(proposals.filter((p) => overlaps(p).length > 0)).toEqual([]);
  // What is left of Monday after the train is still used.
  expect(proposals.some((p) => p.date === day(0) && p.startMin >= 11 * 60 + 30)).toBe(true);
});

it("an event that began before the range blocks the time it covers in it", async () => {
  const thursday = (await call("POST", "/api/plan/auto", { from: day(3), to: day(3) })).body.proposals as Proposal[];
  expect(thursday.filter((p) => overlaps(p).length > 0)).toEqual([]);
  const monday = (await call("POST", "/api/plan/auto", { from: day(0), to: day(0) })).body.proposals as Proposal[];
  expect(monday.length).toBeGreaterThan(0);
  expect(monday.filter((p) => overlaps(p).length > 0)).toEqual([]);
});

it("the expansion returns an event still running from yesterday; the agenda lists from today", async () => {
  const today = isoLocal(new Date());
  const events = (await call("GET", `/api/events?from=${today}&to=${today}`)).body as { title: string; date: string }[];
  expect(events.filter((e) => e.title === "Late shift").map((e) => e.date)).toEqual([isoLocal(new Date(Date.now() - 86_400_000))]);
  const home = (await call("GET", "/api/home")).body as { agenda: { title: string; date: string }[] };
  expect(home.agenda.filter((r) => r.date < today)).toEqual([]);
});
