/**
 * "Today" on the server, in a timezone that is not UTC.
 *
 * `new Date().toISOString().slice(0, 10)` reads as "today" and means "today in
 * UTC". In Amsterdam those differ from midnight until 01:00 or 02:00 — a
 * decision logged at 00:30 carried yesterday's date, and the auto-scheduler
 * paired a UTC `today` with a LOCAL `nowMin` and offered a workday that had
 * already ended (audit).
 *
 * These tests can only fail outside UTC, so they set the timezone themselves;
 * Node re-reads `process.env.TZ` on assignment. The clock is frozen at an
 * instant where the two answers disagree, which is the whole point.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

/**
 * Only `Date` is faked. Faking the timers too deadlocks Fastify's own
 * scheduling and every request hangs — which cost five minutes of wondering
 * why a one-line assertion timed out.
 */
const freezeClock = (at: Date) => vi.useFakeTimers({ toFake: ["Date"], now: at });

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "Europe/Amsterdam";
process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-dates-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
// The startup guard refuses placeholder secrets everywhere now, not just
// under NODE_ENV=production, so the suite has to carry a real-shaped one too.
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

/** 00:30 on 1 March, Amsterdam. In UTC it is still 23:30 on 28 February. */
const LOCAL_MIDNIGHT_ISH = new Date("2026-02-28T23:30:00Z");

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token: string;

const api = async (method: string, url: string, body?: unknown) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: signedIn(token),
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: res.json() };
};

beforeAll(async () => {
  await import("../src/seed.js");
  app = (await buildServer()).app;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "jules@orrama.dev", password: "orrama-demo" },
  });
  token = sessionOf(res);
});

afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
  process.env.TZ = ORIGINAL_TZ;
});

describe("the server's idea of today is the local one", () => {
  it("logs a decision under the day it was actually made", async () => {
    const created = await api("POST", "/api/projects", { name: "Timezone Probe", domain: "work" });
    expect(created.status).toBe(200);
    const slug = created.json.slug;

    freezeClock(LOCAL_MIDNIGHT_ISH);
    try {
      // Sanity: this instant really is two different dates in the two readings.
      expect(new Date().toISOString().slice(0, 10)).toBe("2026-02-28");
      await api("POST", `/api/projects/${slug}/decisions`, { text: "past midnight, still deciding" });
    } finally {
      vi.useRealTimers();
    }

    const w = await api("GET", `/api/projects/${slug}`);
    expect(w.json.decisions[0]).toContain("past midnight, still deciding");
    expect(w.json.decisions[0]).toContain("2026-03-01");
    expect(w.json.decisions[0]).not.toContain("2026-02-28");
  });

  it("does not drop tomorrow for someone working west of UTC", async () => {
    // New York, 20:00 on Monday 2 March 2026. In UTC that is already Tuesday
    // the 3rd, so a UTC `today` made the whole of Tuesday read as "today" and
    // then opened it at 20:00 — past WORK_END, so Tuesday was dropped in
    // silence. Monday is genuinely over either way; Tuesday is the tell.
    process.env.TZ = "America/New_York";
    freezeClock(new Date("2026-03-03T01:00:00Z"));
    try {
      expect(new Date().toISOString().slice(0, 10)).toBe("2026-03-03");
      const res = await api("POST", "/api/plan/auto", { from: "2026-03-02", to: "2026-03-06" });
      expect(res.status).toBe(200);
      const days: string[] = (res.json.proposals ?? []).map((p: { date: string }) => p.date);
      // Guard against a vacuous pass: an empty proposal list would satisfy any
      // "no bad day is present" assertion and hide the bug entirely.
      expect(days.length).toBeGreaterThan(0);
      expect(days).toContain("2026-03-03");
      // And Monday, which really has ended, is still not on offer.
      expect(days).not.toContain("2026-03-02");
    } finally {
      vi.useRealTimers();
      process.env.TZ = "Europe/Amsterdam";
    }
  });
});
