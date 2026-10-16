/**
 * The rename to Orrama (R13) renamed every key this browser keeps, basalt-… to orrama-…. The
 * first load of the renamed app moves them before anything reads one, so nobody is signed out
 * and nothing remembered is lost: the session token (then traded for the cookie, WEB-013), the
 * theme, the remembered tabs, the unsaved drafts.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});
afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", real);
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the move from basalt-… keys", () => {
  it("moves every key to its orrama- name and leaves nothing under the old one", async () => {
    localStorage.setItem("basalt-token", "t-live");
    localStorage.setItem("basalt-theme", "command");
    localStorage.setItem("basalt-draft:n-1", '{"content":"typed"}');
    localStorage.setItem("basalt-ask-history", "[]");
    localStorage.setItem("dh-order", "[]"); // someone else's key: untouched
    const { migrateLegacyKeys } = await import("./storage.js");
    expect(migrateLegacyKeys()).toBe(4);
    expect(localStorage.getItem("orrama-token")).toBe("t-live");
    expect(localStorage.getItem("orrama-theme")).toBe("command");
    expect(localStorage.getItem("orrama-draft:n-1")).toBe('{"content":"typed"}');
    expect(localStorage.getItem("orrama-ask-history")).toBe("[]");
    expect(localStorage.getItem("dh-order")).toBe("[]");
    expect(Object.keys(localStorage).filter((k) => k.startsWith("basalt-"))).toEqual([]);
    // Nothing left to move: a second load does nothing, and a draft discarded since stays gone.
    localStorage.removeItem("orrama-draft:n-1");
    expect(migrateLegacyKeys()).toBe(0);
    expect(localStorage.getItem("orrama-draft:n-1")).toBeNull();
  });

  it("the moved token is the one the app trades for the session cookie (WEB-013)", async () => {
    localStorage.setItem("basalt-token", "t-live");
    localStorage.setItem("basalt-last-email", "ines@example.com");
    (await import("./storage.js")).migrateLegacyKeys();
    const fetched = vi.fn(async () => new Response(JSON.stringify({ user: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetched);
    const api = await import("./api.js");
    await api.adoptStoredSession();
    expect(fetched).toHaveBeenCalledWith("/api/auth/exchange", { method: "POST", headers: { authorization: "Bearer t-live" } });
    expect(localStorage.getItem("orrama-token")).toBeNull();
    expect(api.lastEmail()).toBe("ines@example.com");
  });

  it("a value already under the new name wins", async () => {
    localStorage.setItem("orrama-theme", "light");
    localStorage.setItem("basalt-theme", "command");
    (await import("./storage.js")).migrateLegacyKeys();
    expect(localStorage.getItem("orrama-theme")).toBe("light");
    expect(localStorage.getItem("basalt-theme")).toBeNull();
  });

  it("a key that cannot be written stays under its old name, to be tried again", async () => {
    localStorage.setItem("basalt-token", "t-live");
    const { migrateLegacyKeys } = await import("./storage.js");
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(migrateLegacyKeys()).toBe(0);
    expect(localStorage.getItem("basalt-token")).toBe("t-live");
    setItem.mockRestore();
    expect(migrateLegacyKeys()).toBe(1);
    expect(localStorage.getItem("orrama-token")).toBe("t-live");
  });

  it("storage that refuses outright is not an error", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    const { migrateLegacyKeys } = await import("./storage.js");
    expect(migrateLegacyKeys()).toBe(0);
  });

  it("main.tsx moves the keys before it renders or installs anything that reads one", () => {
    const main = fs.readFileSync(path.join(import.meta.dirname, "main.tsx"), "utf8");
    const at = (call: string) => main.indexOf(`\n${call}`);
    expect(at("migrateLegacyKeys();")).toBeGreaterThan(0);
    for (const later of ["guardStorage();", "installLeaveGuard();", "const root = createRoot("]) expect(at("migrateLegacyKeys();"), later).toBeLessThan(at(later));
  });
});
