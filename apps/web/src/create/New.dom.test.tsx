/** New: the menu and its four dialogs, each through the route that already makes its thing. */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Route } from "../ui/router.js";
import { New } from "./New.js";

type Sent = { url: string; method: string; body: any };
let sent: Sent[] = [];
const answers: Record<string, () => Response> = {};
beforeEach(() => {
  vi.unstubAllGlobals();
  sent = [];
  for (const k of Object.keys(answers)) delete answers[k];
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    sent.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    return answers[key]?.() ?? Response.json({ ok: true, id: "n-new", path: "x.md", slug: "lisbon-trip" });
  });
});

function Harness({ route, onDone = () => {} }: { route: Route; onDone?: () => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor}>New</button>
      <New anchor={anchor} route={route} onDone={onDone} />
    </>
  );
}

async function pick(route: Route, item: string) {
  const onDone = vi.fn();
  render(<Harness route={route} onDone={onDone} />);
  const menu = await screen.findByRole("menu", { name: "New" });
  await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: item })));
  return onDone;
}
const type = (label: string, value: string) => fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });
const submit = async (dialog: string) => act(async () => fireEvent.submit(screen.getByRole("dialog", { name: dialog }).querySelector("form")!));

describe("New", () => {
  it("offers a task, a note, an event and a project, and closing the menu ends it", async () => {
    const onDone = vi.fn();
    render(<Harness route={{ kind: "today" }} onDone={onDone} />);
    const menu = await screen.findByRole("menu", { name: "New" });
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Task", "Note", "Event", "Project"]);
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("a task goes to your inbox with its date, through Capture's route", async () => {
    const onDone = await pick({ kind: "planning", scale: "day", at: "2026-10-16" }, "Task");
    expect(screen.getByRole("textbox", { name: "Due (optional)" })).toHaveProperty("value", "Fri 16 Oct");
    type("The task", "Book the room");
    await submit("New task");
    expect(sent.filter((s) => s.method === "POST")).toEqual([{ url: "/api/capture", method: "POST", body: { text: "Book the room due:2026-10-16" } }]);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("on a project, the task is a step in it", async () => {
    await pick({ kind: "project", slug: "graduation-thesis" }, "Step in this project");
    type("The step", "Pilot interview");
    type("Due (optional)", "");
    await submit("New step");
    expect(sent.filter((s) => s.method === "POST")).toEqual([{ url: "/api/projects/graduation-thesis/capture", method: "POST", body: { text: "Pilot interview", task: true } }]);
  });

  it("a note on a project starts in its folder, carries its tag, is made create-only and opens", async () => {
    await pick({ kind: "project", slug: "graduation-thesis" }, "Note in this project");
    const path = screen.getByRole("textbox", { name: "Path" });
    expect(path).toHaveProperty("value", "04-Projects/graduation-thesis/");
    fireEvent.change(path, { target: { value: "04-Projects/graduation-thesis/Interview notes" } });
    await submit("New note");
    const put = sent.find((s) => s.method === "PUT")!;
    expect(put.url).toBe("/api/vault/note");
    expect(put.body).toEqual({ path: "04-Projects/graduation-thesis/Interview notes.md", content: '---\ntitle: "Interview notes"\ntags: [project/graduation-thesis]\n---\n\n', create: true });
    expect(window.location.pathname + window.location.search).toBe("/notes?id=n-new");
  });

  it("a note whose name is taken says so and stays open; nothing is replaced", async () => {
    answers["PUT /api/vault/note"] = () => Response.json({ error: "a note already exists at Ideas/Reading list.md" }, { status: 409 });
    const onDone = await pick({ kind: "today" }, "Note");
    type("Path", "Ideas/Reading list");
    await submit("New note");
    expect(await screen.findByText(/already exists/)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "New note" })).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("an event goes on your calendar on the day shown, at the time and for the length typed", async () => {
    await pick({ kind: "planning", scale: "day", at: "2026-10-16" }, "Event");
    type("What", "Dashboard review");
    type("Starts", "15:00");
    type("For", "90m");
    await submit("New event");
    expect(sent.filter((s) => s.method === "POST")).toEqual([{ url: "/api/events", method: "POST", body: { title: "Dashboard review", date: "2026-10-16", startMin: 900, durationMin: 90 } }]);
  });

  it("sends nothing while a field is not readable", async () => {
    await pick({ kind: "today" }, "Event");
    type("What", "Dashboard review");
    type("Starts", "half past");
    await submit("New event");
    expect(sent.filter((s) => s.method === "POST")).toEqual([]);
    expect(screen.getByText("A time, like 15:00")).toBeTruthy();
  });

  it("a project from the board filtered to School is academic, and opens", async () => {
    await pick({ kind: "projects", area: "school" }, "Project");
    type("What is it called?", "Lisbon trip");
    await submit("New project");
    expect(sent.filter((s) => s.method === "POST")).toEqual([{ url: "/api/projects", method: "POST", body: { name: "Lisbon trip", domain: "academic" } }]);
    expect(window.location.pathname).toBe("/projects/lisbon-trip");
  });
});
