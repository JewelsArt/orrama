/**
 * A session the server ended sends the app back to sign-in (api.ts). Before
 * sessions could be revoked there was no such thing; now a revoked device
 * would otherwise sit on a page of failing requests.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>([["orrama-token", "t-abc"]]);
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
const win = new EventTarget();
vi.stubGlobal("window", win);

let status = 401;
const calls: { url: string; method: string }[] = [];
vi.stubGlobal("fetch", async (url: string, init: { method: string }) => {
  calls.push({ url, method: init.method });
  return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: "this session has ended" }), { status });
});

let mod: typeof import("./api.js");
beforeAll(async () => {
  mod = await import("./api.js");
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
});

describe("signOut", () => {
  it("tells the server, then forgets the token", async () => {
    status = 200;
    calls.length = 0;
    await mod.signOut();
    expect(calls).toEqual([{ url: "/api/auth/logout", method: "POST" }]);
    expect(store.has("orrama-token")).toBe(false);
  });
});
