/**
 * A session can be ended (sessions.ts, audit B7). A session used to be a bare
 * 30-day JWT the server kept no record of: "Sign out" forgot it in one browser,
 * and a copied token stayed good for a month.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveSocket, refusedWith, sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-sessions-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { sessionLabel } = await import("../src/sessions.js");

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const signIn = async (who = "jules", ua = MAC) =>
  sessionOf(await built.app.inject({ method: "POST", url: "/api/auth/login", headers: { "user-agent": ua }, payload: { email: `${who}@orrama.dev`, password: "orrama-demo" } })) as string;
const call = async (token: string, method: "GET" | "POST" | "DELETE", url: string) => {
  const r = await built.app.inject({ method, url, headers: signedIn(token) });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return null; } })() };
};
const me = async (token: string) => (await call(token, "GET", "/api/me")).status;

beforeAll(async () => {
  built = await buildServer();
});
afterAll(async () => {
  await built.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("sessions", () => {
  it("signing out ends the session on the server, not just in the browser", async () => {
    const token = await signIn();
    expect(await me(token)).toBe(200);
    expect((await call(token, "POST", "/api/auth/logout")).status).toBe(200);
    expect(await me(token)).toBe(401); // the same token, replayed
  });

  it("lists where you are signed in, and ends one without touching the others", async () => {
    const mac = await signIn("jules", MAC);
    const phone = await signIn("jules", PHONE);
    const list = (await call(mac, "GET", "/api/auth/sessions")).body as { id: string; label: string; current: boolean }[];
    expect(list.map((s) => s.label)).toEqual(expect.arrayContaining(["Mac · Safari", "iPhone · Safari"]));
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.find((s) => s.current)?.label).toBe("Mac · Safari");

    const phoneId = list.find((s) => s.label === "iPhone · Safari" && !s.current)!.id;
    expect((await call(mac, "DELETE", `/api/auth/sessions/${phoneId}`)).status).toBe(200);
    expect(await me(phone)).toBe(401);
    expect(await me(mac)).toBe(200);
    expect(((await call(mac, "GET", "/api/auth/sessions")).body as { id: string }[]).some((s) => s.id === phoneId)).toBe(false);
  });

  it("you cannot end, or see, someone else's session", async () => {
    const jules = await signIn("jules");
    const erin = await signIn("erin");
    const erinSessions = (await call(erin, "GET", "/api/auth/sessions")).body as { id: string }[];
    expect(((await call(jules, "GET", "/api/auth/sessions")).body as { id: string }[]).some((s) => erinSessions.some((e) => e.id === s.id))).toBe(false);
    expect((await call(jules, "DELETE", `/api/auth/sessions/${erinSessions[0]!.id}`)).status).toBe(404);
    expect(await me(erin)).toBe(200);
  });

  it("a token with no session — from before sessions, or forged — is refused", async () => {
    const jules = built.db.select().from(tables.users).all().find((u) => u.username === "jules")!;
    expect(await me(built.app.jwt.sign({ sub: jules.id }))).toBe(401);
    expect(await me(built.app.jwt.sign({ sub: jules.id, sid: "s-made-up" }))).toBe(401);
  });

  it("a session id only speaks for the user it was opened for", async () => {
    const erin = await signIn("erin");
    const { sid } = built.app.jwt.decode<{ sid: string }>(erin)!;
    const jules = built.db.select().from(tables.users).all().find((u) => u.username === "jules")!;
    expect(await me(built.app.jwt.sign({ sub: jules.id, sid }))).toBe(401);
  });
});

describe("live sync", () => {
  it("revoking a session closes its open socket", async () => {
    const token = await signIn();
    const s = await liveSocket(built.app, token);
    expect(await s.ready()).toBe(true);
    expect((await call(token, "POST", "/api/auth/logout")).status).toBe(200);
    expect(await s.closed).toBe(4001);
  });

  it("a signed-out session cannot open one", async () => {
    const token = await signIn();
    await call(token, "POST", "/api/auth/logout");
    expect(await refusedWith(liveSocket(built.app, token))).toBe(401);
  });
});

describe("sessionLabel", () => {
  it("names the device and browser", () => {
    expect(sessionLabel(MAC)).toBe("Mac · Safari");
    expect(sessionLabel(PHONE)).toBe("iPhone · Safari");
    expect(sessionLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe("Mac · Desktop app");
    expect(sessionLabel(undefined)).toBe("Unknown device");
  });
});
