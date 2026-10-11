/**
 * The door inside the App.
 * The screens are stubs (test/app-harness.tsx).
 */
import "../test/app-harness.js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { at } from "../test/app-harness.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the door in the app", () => {
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
