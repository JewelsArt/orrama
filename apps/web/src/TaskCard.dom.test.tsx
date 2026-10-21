/**
 * The task card (structure.md §6 #17): a step planned by keyboard, a day with or without a
 * time, people as rings and companies as squares, and nothing sent the server can't read.
 * Since stage 1 (1B) it is also the one place a step is changed: its words, due and start,
 * priority, key deadline and status, moved to another project's section or the inbox, deleted.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { TaskCardData } from "@orrama/schema/responses";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { task } from "./test/planning-fixtures.js";

const server = vi.hoisted(() => ({
  calls: [] as { method: string; url: string; body: unknown }[],
  fail: false,
  conflict: false,
  card: null as unknown as TaskCardData,
  reads: 0,
}));

vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  return {
    ...real,
    api: async (method: string, url: string, body?: unknown) => {
      if (method === "GET" && url.startsWith("/api/tasks/card?")) {
        server.reads++;
        return server.card;
      }
      if (method === "GET" && url === "/api/projects/graduation-thesis")
        return {
          status: "on track",
          deadline: "2026-10-19",
          people: [
            { id: "n-ines", title: "Ines Vermaat", kind: "contact", role: "Supervisor", company: "", linkedin: "", path: "Contacts/Ines Vermaat.md" },
            { id: "n-kade", title: "Kade Social", kind: "company", role: "", company: "", linkedin: "", path: "Contacts/Companies/Kade Social.md" },
          ],
        };
      if (method === "GET" && url.startsWith("/api/projects/")) return { status: "", deadline: "", people: [] };
      server.calls.push({ method, url, body });
      if (server.fail) throw new Error("500");
      if (server.conflict) throw new real.ApiError(409, "that task is not in the note as it is now");
      if (url === "/api/tasks/edit") {
        const { words, due, start, priority, key, status } = body as Record<string, unknown>;
        const t = { ...server.card.task };
        if (words !== undefined) Object.assign(t, { words, text: words });
        if (due !== undefined) Object.assign(t, { due: due ?? undefined });
        if (start !== undefined) Object.assign(t, { start: start ?? undefined });
        if (priority !== undefined) Object.assign(t, { priority: priority ?? undefined });
        if (key !== undefined) Object.assign(t, { key });
        if (status !== undefined) Object.assign(t, { status, checked: status === "done" });
        server.card = { ...server.card, task: t };
        return server.card;
      }
      if (url === "/api/tasks/move") return { ...server.card, project: { slug: "kitchen", name: "Kitchen" }, section: "Paint", task: { ...server.card.task, noteId: "n-kitchen", noteTitle: "Kitchen" } };
      return {};
    },
  };
});

const { TaskCard } = await import("./TaskCard.js");
const { tickStep } = await import("./steps.js");

const cardData = (over: Partial<TaskCardData["task"]> = {}, rest: Partial<TaskCardData> = {}): TaskCardData => ({
  task: {
    line: 5, checked: false, status: "todo", text: "Summarise MASE vs MAPE", raw: "- [ ] Summarise MASE vs MAPE due:2026-10-09 !p1", indent: 0,
    due: "2026-10-09", priority: 1, noteId: "n-thesis", notePath: "04-Projects/graduation-thesis.md", noteTitle: "Forecast accuracy metrics", words: "Summarise MASE vs MAPE",
    ...over,
  },
  canEdit: true,
  project: { slug: "graduation-thesis", name: "Graduation thesis" },
  section: "Chapter 3",
  places: [
    { slug: "graduation-thesis", name: "Graduation thesis", sections: ["Chapter 3", "Tasks"] },
    { slug: "kitchen", name: "Kitchen", sections: ["Paint", "Tasks"] },
  ],
  inInbox: false,
  ...rest,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 8, 10, 40));
  server.calls = [];
  server.fail = false;
  server.conflict = false;
  server.reads = 0;
  server.card = cardData();
});
afterEach(() => vi.useRealTimers());

async function card(over: Parameters<typeof task>[0] = { text: "Summarise MASE vs MAPE" }) {
  const onScheduled = vi.fn();
  const onClose = vi.fn();
  const onOpenNote = vi.fn();
  server.card = { ...server.card, task: { ...server.card.task, text: over.text, words: server.card.task.words === "Summarise MASE vs MAPE" ? over.text : server.card.task.words } };
  render(<TaskCard task={task({ due: "2026-10-09", estimateHours: 2.5, remainingHours: 2.5, noteTitle: "Forecast accuracy metrics", ...over })} onClose={onClose} onOpenNote={onOpenNote} onScheduled={onScheduled} />);
  await act(async () => {});
  await act(async () => {});
  const dialog = screen.getByRole("dialog", { name: over.text });
  const day = within(dialog).getByRole("textbox", { name: "Day" });
  return { dialog, day, onScheduled, onClose, onOpenNote };
}

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const settle = () => act(async () => {});
const options = (el: HTMLElement | undefined) => [...el!.querySelectorAll("option")].map((o) => o.textContent);
const edits = () => server.calls.filter((c) => c.url === "/api/tasks/edit").map((c) => c.body);

describe("the task card", () => {
  it("shows the step, its project and the people: a person is a ring, a company a square", async () => {
    const { dialog } = await card();
    expect(within(dialog).getByRole("heading", { name: "Summarise MASE vs MAPE" })).toBeTruthy();
    expect(dialog.textContent).toContain("Fri 9 Oct"); // due, never 10/09/2026
    expect(dialog.textContent).toContain("Key deadline Mon 19 Oct");
    expect(dialog.textContent).toContain("In Graduation thesis · Chapter 3");
    expect(within(dialog).getByRole("button", { name: /Ines Vermaat/ }).querySelector(".ring")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Kade Social/ }).querySelector(".sq")).toBeTruthy();
    expect((within(dialog).getByRole("textbox", { name: "Day" }) as HTMLInputElement).value).toBe("Thu 8 Oct");
  });

  it("a day alone makes it the step's due date, in its line, naming it without a block id it doesn't have", async () => {
    const { day, onScheduled } = await card({ text: "Ask Thijs to sign", blockId: null });
    type(day, "sat");
    fireEvent.submit(day.closest("form")!);
    await settle();
    expect(server.calls).toEqual([{ method: "POST", url: "/api/tasks/edit", body: { noteId: "n-thesis", line: 5, text: "Ask Thijs to sign", due: "2026-10-10" } }]);
    // `blockId: null` is a 400 from the server's schema: the card used to send it. And no
    // planned_date: /api/tasks/schedule wrote a day nothing showed.
    expect(JSON.stringify(server.calls[0]!.body)).not.toContain("blockId");
    expect(onScheduled).toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Due Sat 10 Oct.");
  });

  it("'sat 11:00' and Enter books it at that time, for the length in the card", async () => {
    server.card = cardData({ blockId: "t-abc123" });
    const { dialog, day } = await card({ text: "Summarise MASE vs MAPE", blockId: "t-abc123" });
    type(day, "sat 11:00");
    fireEvent.submit(day.closest("form")!);
    await settle();
    expect(server.calls).toEqual([
      { method: "POST", url: "/api/tasks/blocks", body: { noteId: "n-thesis", line: 5, blockId: "t-abc123", text: "Summarise MASE vs MAPE", date: "2026-10-10", startMin: 660, durationMin: 150, estimateHours: 2.5 } },
    ]);
    expect(screen.getByRole("status").textContent).toBe("Booked Sat 10 Oct, 11:00–13:30.");
    expect((within(dialog).getByRole("textbox", { name: "Time" }) as HTMLInputElement).value).toBe("11:00");
  });

  it("the time and length fields work too", async () => {
    const { dialog, day } = await card();
    type(day, "fri 9 oct");
    type(within(dialog).getByRole("textbox", { name: "Time" }), "14:30");
    type(within(dialog).getByRole("textbox", { name: "Length" }), "90m");
    fireEvent.submit(day.closest("form")!);
    await settle();
    expect(server.calls[0]!.body).toMatchObject({ date: "2026-10-09", startMin: 870, durationMin: 90 });
  });

  it("says what it couldn't read, and sends nothing", async () => {
    const { dialog, day } = await card();
    type(day, "someday");
    fireEvent.submit(day.closest("form")!);
    await settle();
    expect(screen.getByRole("alert").textContent).toMatch(/^Say a day/);
    type(day, "sat");
    type(within(dialog).getByRole("textbox", { name: "Time" }), "noon");
    fireEvent.submit(day.closest("form")!);
    await settle();
    expect(screen.getByRole("alert").textContent).toMatch(/^Say a time/);
    expect(server.calls).toEqual([]);
  });

  it("a booking that fails says so, in plain words", async () => {
    server.fail = true;
    const { day, onScheduled } = await card();
    type(day, "sat 10:00");
    fireEvent.submit(day.closest("form")!);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("That didn't save. Your note is as it was; try again.");
    expect(onScheduled).not.toHaveBeenCalled();
  });

  it("is in the overlay stack: Escape closes it", async () => {
    const { onClose } = await card();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("the card changes the step", () => {
  it("its words: click the title, type, Enter; the words come back as typed, Markdown and all", async () => {
    server.card = cardData({ text: "Ask Thijs about the data", words: "Ask **Thijs** about the data" });
    const { dialog } = await card({ text: "Ask Thijs about the data" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Ask Thijs about the data" }));
    const field = within(dialog).getByRole("textbox", { name: "The step" }) as HTMLInputElement;
    expect(field.value).toBe("Ask **Thijs** about the data");
    type(field, "Ask **Thijs** for the data");
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();
    expect(edits()).toEqual([{ noteId: "n-thesis", line: 5, text: "Ask Thijs about the data", words: "Ask **Thijs** for the data" }]);
    expect(within(dialog).getByRole("heading").textContent).toBe("Ask **Thijs** for the data");
  });

  it("Escape in the words closes the card, as Escape always does, and writes nothing", async () => {
    const { dialog, onClose } = await card();
    fireEvent.click(within(dialog).getByRole("button", { name: "Summarise MASE vs MAPE" }));
    const field = within(dialog).getByRole("textbox", { name: "The step" });
    type(field, "Something else");
    fireEvent.keyDown(field, { key: "Escape" });
    await settle();
    expect(onClose).toHaveBeenCalled();
    expect(edits()).toEqual([]);
  });

  it("due and start are typed, day before month, and written when the field is left; empty clears; not a date sends nothing", async () => {
    const { dialog } = await card();
    const due = within(dialog).getByRole("textbox", { name: "Due" });
    expect((due as HTMLInputElement).value).toBe("Fri 9 Oct");
    fireEvent.focus(due);
    type(due, "3/11");
    expect(dialog.textContent).toContain("Tue 3 Nov"); // what it would write, said first
    expect(edits()).toEqual([]); // never while typing
    fireEvent.blur(due);
    await settle();
    const start = within(dialog).getByRole("textbox", { name: "Start" });
    fireEvent.focus(start);
    type(start, "someday");
    expect(dialog.textContent).toContain("Not a date yet");
    fireEvent.blur(start);
    await settle();
    fireEvent.focus(due);
    type(due, "");
    fireEvent.keyDown(due, { key: "Enter" });
    await settle();
    expect(edits()).toEqual([
      { noteId: "n-thesis", line: 5, text: "Summarise MASE vs MAPE", due: "2026-11-03" },
      { noteId: "n-thesis", line: 5, text: "Summarise MASE vs MAPE", due: null },
    ]);
  });

  it("priority in words, None taking the token off", async () => {
    const { dialog } = await card();
    const prio = within(dialog).getByRole("radiogroup", { name: "Priority" });
    expect(within(prio).getByRole("radio", { checked: true }).textContent).toBe("High"); // !p1
    fireEvent.click(within(prio).getByRole("radio", { name: "Low" }));
    await settle();
    fireEvent.click(within(prio).getByRole("radio", { name: "None" }));
    await settle();
    expect(edits().map((b) => (b as { priority: unknown }).priority)).toEqual([3, null]);
  });

  it("the key-deadline switch writes the tag and draws the red chip", async () => {
    const { dialog } = await card();
    fireEvent.click(within(dialog).getByRole("switch", { name: "Key deadline" }));
    await settle();
    expect(edits()).toEqual([{ noteId: "n-thesis", line: 5, text: "Summarise MASE vs MAPE", key: true }]);
    expect(dialog.querySelector(".tc-key .chip-dl")?.textContent).toBe("Key deadline Fri 9 Oct");
  });

  it("status from the same four the To-do's menu offers", async () => {
    const { dialog } = await card();
    fireEvent.click(within(dialog).getByRole("button", { name: "Status: To do" }));
    expect(screen.getAllByRole("menuitemcheckbox").map((b) => b.textContent)).toEqual(["To do", "In progress", "Blocked", "Done"]);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Blocked" }));
    await settle();
    expect(edits()).toEqual([{ noteId: "n-thesis", line: 5, text: "Summarise MASE vs MAPE", status: "blocked" }]);
    expect(within(dialog).getByRole("button", { name: "Status: Blocked" })).toBeTruthy();
  });

  it("moves to another project's section, or the inbox, from the card", async () => {
    const { dialog, onScheduled } = await card();
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to…" }));
    const [to, under] = dialog.querySelectorAll("select");
    expect(options(to)).toEqual(["Graduation thesis", "Kitchen", "Your inbox"]);
    expect(under!.value).toBe("Chapter 3"); // where it is now
    fireEvent.change(to!, { target: { value: "kitchen" } });
    expect(options(dialog.querySelectorAll("select")[1])).toEqual(["Paint", "Tasks"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Move it" }));
    await settle();
    expect(server.calls.at(-1)).toEqual({ method: "POST", url: "/api/tasks/move", body: { noteId: "n-thesis", line: 5, text: "Summarise MASE vs MAPE", to: { project: "kitchen", section: "Paint" } } });
    expect(onScheduled).toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Moved to Kitchen, under Paint.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Move to…" }));
    fireEvent.change(dialog.querySelector("select")!, { target: { value: "\u0000inbox" } });
    expect(dialog.querySelectorAll("select")).toHaveLength(1); // no sections in the inbox
    fireEvent.click(within(dialog).getByRole("button", { name: "Move it" }));
    await settle();
    expect((server.calls.at(-1)!.body as { to: unknown }).to).toEqual({ inbox: true });
  });

  it("deletes only after a confirm that names the step; Keep it sends nothing", async () => {
    const { dialog, onClose } = await card();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(dialog.textContent).toContain("“Summarise MASE vs MAPE” is taken out of Forecast accuracy metrics.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(server.calls).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete the step" }));
    await settle();
    expect(server.calls).toEqual([{ method: "POST", url: "/api/tasks/delete", body: { noteId: "n-thesis", line: 5, text: "Summarise MASE vs MAPE" } }]);
    expect(onClose).toHaveBeenCalled();
  });

  it("a step changed in its note since the card opened is read again and said, never edited blind", async () => {
    const { dialog } = await card();
    const reads = server.reads;
    server.conflict = true;
    fireEvent.click(within(dialog).getByRole("switch", { name: "Key deadline" }));
    await settle();
    expect(server.reads).toBe(reads + 1);
    expect(screen.getByRole("alert").textContent).toBe("This step changed in its note since the card opened. Here it is as it is now.");
  });

  it("a step you can only read: no fields to change, no Move or Delete", async () => {
    server.card = cardData({}, { canEdit: false });
    const { dialog } = await card();
    expect((within(dialog).getByRole("textbox", { name: "Due" }) as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByRole("switch", { name: "Key deadline" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).queryByRole("button", { name: "Move to…" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Summarise MASE vs MAPE" })).toBeNull(); // the title is not a button
  });
});

describe("tickStep, for lists that show open steps only (Today, a person's page)", () => {
  const said = { notTicked: "The step wasn't ticked.", moved: "That step changed.", changed: vi.fn() };
  const step = { noteId: "n-thesis", line: 5, blockId: null, text: "Call the bank" };

  it("ticks an open step and offers Undo, which unticks it", async () => {
    const { Toaster } = await import("./ui/overlays.js");
    render(<Toaster />);
    await act(async () => void (await tickStep({ ...step, status: "blocked" }, said)));
    const undo = screen.getAllByRole("button", { name: "Undo" }).at(-1)!;
    await act(async () => void fireEvent.click(undo));
    await settle();
    expect(server.calls.map((c) => c.body)).toEqual([
      { noteId: "n-thesis", line: 5, text: "Call the bank", checked: true },
      { noteId: "n-thesis", line: 5, text: "Call the bank", checked: false },
    ]);
    expect(said.changed).toHaveBeenCalledTimes(2);
  });

  it("unticks a step that is done", async () => {
    await act(async () => void (await tickStep({ ...step, checked: true, status: "done" }, said)));
    expect(server.calls.map((c) => (c.body as { checked: boolean }).checked)).toEqual([false]);
  });
});
