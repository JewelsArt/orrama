/**
 * The door inside the App: which screen shows, and that the shell stays out of it until you're in.
 * The screens are stubs (test/app-harness.tsx).
 */
import "../test/app-harness.js";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { api } from "../api.js";
import { at, ME, serve } from "../test/app-harness.js";

const signedOut = () => serve({ "GET /api/me": new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }) });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the door in the app", () => {
  it("at the lock, digits are the passcode: they never move the address", async () => {
    signedOut();
    localStorage.setItem("orrama-last-email", "ines@example.com");
    at("/today");
    render(<App />);
    expect((await screen.findByTestId("view")).dataset.view).toBe("lock");
    for (const key of ["2", "5", "8"]) fireEvent.keyDown(window, { key });
    expect(location.pathname).toBe("/today");
  });

  it("nor ⌘K, ⌘, or c on the sign-in", async () => {
    signedOut();
    at("/money");
    render(<App />);
    expect((await screen.findByTestId("view")).dataset.view).toBe("login");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.keyDown(window, { key: "c" });
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    fireEvent.keyDown(window, { key: "3" });
    expect(location.pathname).toBe("/money");
    expect(screen.queryByTestId("view")?.dataset.view).toBe("login");
  });

  it("a token kept from before the cookie is never sent: the cookie alone signs in (WEB-013)", async () => {
    const asked: string[] = [];
    serve();
    const served = fetch;
    vi.stubGlobal("fetch", async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      asked.push(`${init.method ?? "GET"} ${url} ${JSON.stringify(init.headers ?? {})}`);
      return served(url, init as RequestInit);
    });
    localStorage.setItem("orrama-token", "t-kept");
    at("/today");
    render(<App />);
    expect((await screen.findByTestId("view")).dataset.view).toBe("today");
    expect(asked.filter((a) => a.includes("t-kept") || a.includes("/api/auth/exchange"))).toEqual([]);
  });

  it("signed in by the cookie at boot, a 401 from any request later goes back to the door", async () => {
    serve();
    localStorage.setItem("orrama-last-email", "ines@example.com");
    at("/today");
    render(<App />);
    expect((await screen.findByTestId("view")).dataset.view).toBe("today");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "this session has ended — sign in again" }), { status: 401 }));
    await api("GET", "/api/vault/tree").catch(() => {});
    await waitFor(() => expect(screen.getByTestId("view").dataset.view).toBe("lock"));
  });

  it("a founder who never said where the notes are is asked again once signed in (first run, 1A)", async () => {
    serve({ "GET /api/auth/status": { needsSetup: false, chooseNotes: true, resetHere: false } });
    at("/today");
    render(<App />);
    // Setup is a stub here (test/app-harness.tsx); door.dom.test.tsx covers what it shows.
    expect((await screen.findByTestId("view")).dataset.view).toBe("setup");
  });

  it("…and only the founder: anyone else goes straight in", async () => {
    serve({ "GET /api/me": { ...ME, isOwner: false }, "GET /api/auth/status": { needsSetup: false, chooseNotes: true, resetHere: false } });
    at("/today");
    render(<App />);
    expect((await screen.findByTestId("view")).dataset.view).toBe("today");
  });

  it("boots as Orr rising, named Orrama", async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal("fetch", async (url: string) =>
      url === "/api/me" ? new Promise<Response>((r) => (answer = r)) : new Response(JSON.stringify({ needsSetup: false }), { status: 200 }),
    );
    at("/today");
    render(<App />);
    expect(screen.getByRole("img", { name: "Orrama" }).querySelector(".boot-sun")).toBeTruthy();
    // Asked once a stored token (none here) has been looked for: a moment after the first paint.
    await waitFor(() => expect(answer).toBeTypeOf("function"));
    answer(new Response("{}", { status: 401 }));
  });
});
