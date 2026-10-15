/**
 * The door inside the App: which screen shows, and that the shell stays out of it until you're in.
 * The screens are stubs (test/app-harness.tsx).
 */
import "../test/app-harness.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { at, serve } from "../test/app-harness.js";

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

  it("boots as Orr rising, named Orrama", async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal("fetch", async (url: string) =>
      url === "/api/me" ? new Promise<Response>((r) => (answer = r)) : new Response(JSON.stringify({ needsSetup: false }), { status: 200 }),
    );
    at("/today");
    render(<App />);
    expect(screen.getByRole("img", { name: "Orrama" }).querySelector(".boot-sun")).toBeTruthy();
    answer(new Response("{}", { status: 401 }));
  });
});
