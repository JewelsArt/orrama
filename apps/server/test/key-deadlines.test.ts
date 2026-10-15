/**
 * `#deadline` tasks reach the calendar and the dashboard flagged, and an
 * upcoming one outranks older overdue work on the Deadlines card — which shows
 * six rows, so on a vault with forty late tasks it would otherwise never appear.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, isoLocal } from "@orrama/core";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-keydl-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const today = isoLocal();
const soon = addDays(today, 3);
const lines = [
  "---\ntitle: Block\ntags: [project/block]\n---\n",
  // Seven overdue tasks, more than the card shows.
  ...Array.from({ length: 7 }, (_, i) => `- [ ] late ${i} @jules due:${addDays(today, -30 + i)}`),
  `- [ ] Submit the plan, 09:00 #deadline @jules !p1 due:${soon}`,
  `- [ ] ordinary @jules due:${soon}`,
];

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token = "";
const get = async (url: string) => (await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } })).json();

beforeAll(async () => {
  fs.mkdirSync(path.join(process.env.BASALT_VAULT_DIR!, "04-Projects"), { recursive: true });
  fs.writeFileSync(path.join(process.env.BASALT_VAULT_DIR!, "04-Projects", "block.md"), lines.join("\n"));
  await import("../src/seed.js");
  app = (await buildServer()).app;
  token = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })).json().token;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("key deadlines", () => {
  it("are flagged on the calendar markers, and nothing else is", async () => {
    const marks = (await get(`/api/calendar/markers?from=${today}&to=${addDays(today, 7)}`)) as { title: string; key: boolean }[];
    expect(marks.find((m) => m.title === "Submit the plan, 09:00")?.key).toBe(true);
    expect(marks.find((m) => m.title === "ordinary")?.key).toBe(false);
  });

  it("lead the Deadlines card, and come first in their day on the agenda", async () => {
    const home = await get("/api/home");
    expect(home.deadlines[0]).toMatchObject({ text: "Submit the plan, 09:00", key: true });
    const day = home.agenda.filter((a: { date: string }) => a.date === soon);
    expect(day[0]).toMatchObject({ title: "Submit the plan, 09:00", key: true });
  });
});
