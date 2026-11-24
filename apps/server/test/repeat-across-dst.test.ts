/**
 * What Planning's next three weeks and Today's Coming up read (2L follow-up, N2): a weekly
 * event of yours, expanded by `/api/events`, keeps its day of the week and its hour across the
 * night the clocks go back (Europe, Sun 25 Oct 2026) and across the end of the month, one row
 * per day, each naming its series.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "Europe/Amsterdam";
process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-repeat-dst-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { closeDb } = await import("./helpers/db.js");

let built: Awaited<ReturnType<typeof buildServer>>;
let token = "";
const call = async (method: string, url: string, body?: unknown) => {
  const res = await built.app.inject({ method: method as "GET", url, headers: signedIn(token), ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}) });
  return { status: res.statusCode, json: res.json() };
};

beforeAll(async () => {
  built = await buildServer();
  token = sessionOf(await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
});
afterAll(async () => {
  await built.app.close();
  closeDb(built.db);
  process.env.TZ = ORIGINAL_TZ;
});

describe("a weekly event across the clocks going back and the month's end", () => {
  it("falls on every Wednesday at 18:00, each day of the series named as such", async () => {
    const made = await call("POST", "/api/events", { title: "Choir", date: "2026-10-14", startMin: 18 * 60, durationMin: 90, repeat: { every: "week", interval: 1, until: null } });
    expect(made.status).toBe(200);
    const days = ((await call("GET", "/api/events?from=2026-10-19&to=2026-11-08")).json as { id: string; title: string; date: string; startMin: number; durationMin: number; seriesId?: string }[]).filter((e) => e.title === "Choir");
    expect(days.map((e) => [e.date, e.startMin, e.durationMin])).toEqual([
      ["2026-10-21", 1080, 90],
      ["2026-10-28", 1080, 90],
      ["2026-11-04", 1080, 90],
    ]);
    expect(days.every((e) => e.seriesId === made.json.id && e.id === `${made.json.id}@${e.date}`)).toBe(true);
  });
});
