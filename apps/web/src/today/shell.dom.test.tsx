/**
 * What Today adds to the shell: the rail's Mail dot, which shows when Orr's drafts are waiting
 * (Jules, 11 October) and never for unread mail; and the phone's New beside Find on Today's top
 * bar, which opens Capture (structure.md §1.3).
 */
import "../test/app-harness.js";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { at, serve } from "../test/app-harness.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mailItem = () => {
  const rail = screen.getAllByRole("navigation", { name: "Places" })[0]!;
  return [...rail.querySelectorAll<HTMLElement>(".ri")].find((a) => a.textContent?.startsWith("Mail"))!;
};

describe("the rail's Mail dot", () => {
  it("shows when Orr's drafts are waiting", async () => {
    serve({ "GET /api/mail/drafts": [{ id: "d1" }, { id: "d2" }] });
    at("/today");
    render(<App />);
    await screen.findByTestId("view");
    await waitFor(() => expect(within(mailItem()).getByRole("img", { name: "2 drafts waiting" })).toBeTruthy());
  });

  it("does not show without drafts, however much mail is unread", async () => {
    serve({ "GET /api/mail/drafts": [], "GET /api/mail/inbox": { email: "x", messages: [{ uid: 1, seen: false }] } });
    at("/today");
    render(<App />);
    await screen.findByTestId("view");
    await new Promise((r) => setTimeout(r, 30));
    expect(mailItem().querySelector(".dot")).toBeNull();
  });

  it("asks again when you go somewhere: a draft sent from Mail takes the dot away", async () => {
    let drafts: { id: string }[] = [{ id: "d1" }];
    serve();
    const fetchFn = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
      url.startsWith("/api/mail/drafts") ? new Response(JSON.stringify(drafts)) : fetchFn(url, init as never),
    );
    const user = userEvent.setup();
    at("/today");
    render(<App />);
    await waitFor(() => expect(mailItem().querySelector(".dot")).toBeTruthy());
    drafts = [];
    await user.click(mailItem());
    await waitFor(() => expect(mailItem().querySelector(".dot")).toBeNull());
  });
});

describe("the phone's top bar on Today", () => {
  it("says the date, and New beside Find opens Capture", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 8, 10, 40));
    serve({ "GET /api/mail/drafts": [] });
    const user = userEvent.setup();
    at("/today");
    render(<App />);
    await screen.findByTestId("view");
    const top = document.querySelector<HTMLElement>(".ptop")!;
    expect(top.querySelector("h1")!.textContent).toBe("Thursday 8 October");
    await user.click(within(top).getByRole("button", { name: "New" }));
    expect(await screen.findByRole("dialog", { name: "Capture" })).toBeTruthy();
    vi.useRealTimers();
  });

  it("on the other places, New beside Find offers a task, a note, an event or a project (R12); none in Settings", async () => {
    serve({ "GET /api/mail/drafts": [] });
    at("/projects");
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("view");
    await user.click(within(document.querySelector<HTMLElement>(".ptop")!).getByRole("button", { name: "New" }));
    const menu = await screen.findByRole("menu", { name: "New" });
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Task", "Note", "Event", "Project"]);
    cleanup();
    at("/settings");
    render(<App />);
    await screen.findByTestId("view");
    expect(within(document.querySelector<HTMLElement>(".ptop")!).queryByRole("button", { name: "New" })).toBeNull();
  });
});
