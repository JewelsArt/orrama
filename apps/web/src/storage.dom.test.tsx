/**
 * Storage that refuses (WEB-025). iOS Safari with "Block All Cookies" makes the localStorage
 * getter itself throw; a full quota makes setItem throw. Neither may blank the app.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
const refuseStorage = () =>
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });

beforeEach(() => vi.resetModules());
afterEach(() => {
  cleanup(); // before the stubs go: a late request from the page must not reach happy-dom's real fetch
  Object.defineProperty(globalThis, "localStorage", real);
  vi.unstubAllGlobals();
});

describe("storage.ts", () => {
  it("reads and writes through a getter that throws, keeping values in memory", async () => {
    refuseStorage();
    const { readKey, writeKey, removeKey, readJson } = await import("./storage.js");
    expect(readKey("orrama-theme")).toBeNull();
    writeKey("orrama-theme", "dark");
    expect(readKey("orrama-theme")).toBe("dark");
    writeKey("orrama-list", "[1,2]");
    expect(readJson("orrama-list", [])).toEqual([1, 2]);
    removeKey("orrama-theme");
    expect(readKey("orrama-theme")).toBeNull();
  });

  it("never reads back a stale value when a write is refused", async () => {
    localStorage.setItem("orrama-theme", "light");
    const { readKey, writeKey } = await import("./storage.js");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    writeKey("orrama-theme", "dark");
    expect(readKey("orrama-theme")).toBe("dark");
    vi.restoreAllMocks();
  });

  it("guardStorage gives the page a working localStorage when the real one is refused", async () => {
    refuseStorage();
    const { guardStorage } = await import("./storage.js");
    expect(guardStorage(window)).toBe(true);
    localStorage.setItem("dh-order", "[]");
    expect(localStorage.getItem("dh-order")).toBe("[]");
    expect(guardStorage(window)).toBe(false); // once is enough
  });
});

describe("with storage refused", () => {
  it("api.ts still imports, with no address", async () => {
    refuseStorage();
    const api = await import("./api.js");
    expect(api.lastEmail()).toBe("");
  });

  it("the app boots to the sign-in screen", async () => {
    refuseStorage();
    vi.stubGlobal("fetch", async (url: string) =>
      url === "/api/auth/status"
        ? new Response(JSON.stringify({ needsSetup: false }), { status: 200 })
        : new Response(JSON.stringify({ error: "not signed in" }), { status: 401 }),
    );
    const { App } = await import("./App.js");
    render(<App />);
    expect(await screen.findByLabelText(/password/i)).toBeTruthy();
    // A cold import of the whole app (resetModules above): 5–6 s while every package's
    // suite runs at once, as in verify.sh and pnpm ship. The bound is the import, not the app.
  }, 30_000);
});
