/**
 * A session the server ended sends the app back to sign-in (api.ts). Before
 * sessions could be revoked there was no such thing; now a revoked device
 * would otherwise sit on a page of failing requests. And since WEB-013 the
 * session is a cookie the page never holds: what is left here is whether the
 * page counts itself signed in.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
const win = new EventTarget();
vi.stubGlobal("window", win);

let status = 401;
const calls: { url: string; method: string; headers: Headers; credentials?: string }[] = [];
vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
  calls.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), credentials: init.credentials });
  return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: "this session has ended" }), { status });
});

let mod: typeof import("./api.js");
beforeAll(async () => {
  mod = await import("./api.js");
});
beforeEach(() => {
  store.clear();
  calls.length = 0;
  mod.sessionStarted();
});

const ended = async (run: () => Promise<unknown>) => {
  let fired = 0;
  const on = () => fired++;
  win.addEventListener(mod.SESSION_ENDED, on);
  await run().catch(() => {});
  win.removeEventListener(mod.SESSION_ENDED, on);
  return fired;
};

describe("a 401 from the server", () => {
  it("ends the session in the app", async () => {
    status = 401;
    expect(await ended(() => mod.api("GET", "/api/vault/tree"))).toBe(1);
  });

  it("a wrong password is not an ended session", async () => {
    status = 401;
    expect(await ended(() => mod.api("POST", "/api/auth/login", { email: "a", password: "b" }))).toBe(0);
  });

  it("other failures are not either", async () => {
    status = 403;
    expect(await ended(() => mod.api("GET", "/api/vault/tree"))).toBe(0);
  });

  it("before anyone is signed in, it is only an answer (the boot asking /api/me)", async () => {
    mod.sessionOver();
    status = 401;
    expect(await ended(() => mod.api("GET", "/api/me"))).toBe(0);
  });
});

describe("a request carries the session as the cookie, and nothing else", () => {
  it("same-origin credentials, no Authorization header", async () => {
    status = 200;
    await mod.api("GET", "/api/vault/tree");
    await mod.apiBlob("/api/projects/p/files/a.pdf");
    await mod.sessionFetch("/api/ai/ask", { method: "POST" });
    expect(calls.map((c) => c.credentials)).toEqual(["same-origin", "same-origin", "same-origin"]);
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual([null, null, null]);
  });
});

describe("signOut", () => {
  it("tells the server, then counts itself signed out", async () => {
    status = 200;
    await mod.signOut();
    expect(calls.map((c) => [c.url, c.method])).toEqual([["/api/auth/logout", "POST"]]);
    status = 401;
    expect(await ended(() => mod.api("GET", "/api/vault/tree"))).toBe(0);
  });
});
