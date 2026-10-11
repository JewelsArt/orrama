/**
 * The task card (structure.md §6 #17): a step planned by keyboard, a day with or without a
 * time, people as rings and companies as squares, and nothing sent the server can't read.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { task } from "./test/planning-fixtures.js";

const server = vi.hoisted(() => ({ calls: [] as { method: string; url: string; body: unknown }[], fail: false }));

vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  return {
    ...real,
    api: async (method: string, url: string, body?: unknown) => {
      if (method === "GET" && url === "/api/projects") return [{ slug: "graduation-thesis", name: "Graduation thesis" }];
      if (method === "GET" && url === "/api/projects/graduation-thesis")
        return {
          status: "on track",
          deadline: "2026-10-19",
          people: [
            { id: "n-ines", title: "Ines Vermaat", kind: "contact", role: "Supervisor", company: "", linkedin: "", path: "Contacts/Ines Vermaat.md" },
            { id: "n-kade", title: "Kade Social", kind: "company", role: "", company: "", linkedin: "", path: "Contacts/Companies/Kade Social.md" },
          ],
        };
      server.calls.push({ method, url, body });
      if (server.fail) throw new Error("500");
      return {};
    },
  };
});

const { TaskCard } = await import("./TaskCard.js");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 8, 10, 40));
  server.calls = [];
  server.fail = false;
});
afterEach(() => vi.useRealTimers());

async function card(over: Parameters<typeof task>[0] = { text: "Summarise MASE vs MAPE" }) {
  const onScheduled = vi.fn();
  const onClose = vi.fn();
  const onOpenNote = vi.fn();
  render(<TaskCard task={task({ due: "2026-10-09", estimateHours: 2.5, remainingHours: 2.5, noteTitle: "Forecast accuracy metrics", ...over })} onClose={onClose} onOpenNote={onOpenNote} onScheduled={onScheduled} />);
  await act(async () => {});
  await act(async () => {});
  const dialog = screen.getByRole("dialog", { name: over.text });
  const day = within(dialog).getByRole("textbox", { name: "Day" });
  return { dialog, day, onScheduled, onClose, onOpenNote };
}

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe("the task card", () => {
  it("shows the step, its project and the people: a person is a ring, a company a square", async () => {
    const { dialog } = await card();
    expect(within(dialog).getByRole("heading", { name: "Summarise MASE vs MAPE" })).toBeTruthy();
    expect(dialog.textContent).toContain("Fri 9 Oct"); // due, never 10/09/2026
    expect(dialog.textContent).toContain("Key deadline Mon 19 Oct");
    expect(within(dialog).getByRole("button", { name: /Ines Vermaat/ }).querySelector(".ring")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Kade Social/ }).querySelector(".sq")).toBeTruthy();
    expect((within(dialog).getByRole("textbox", { name: "Day" }) as HTMLInputElement).value).toBe("Thu 8 Oct");
  });

  it("a day alone plans the step for that day, naming it without a block id it doesn't have", async () => {
    const { day, onScheduled } = await card({ text: "Ask Thijs to sign", blockId: null });
    type(day, "sat");
    fireEvent.submit(day.closest("form")!);
    await act(async () => {});
    expect(server.calls).toEqual([{ method: "POST", url: "/api/tasks/schedule", body: { noteId: "n-thesis", line: 5, blockId: undefined, text: "Ask Thijs to sign", date: "2026-10-10" } }]);
    // `blockId: null` is a 400 from the server's schema: the card used to send it.
    expect(JSON.stringify(server.calls[0]!.body)).not.toContain("blockId");
    expect(onScheduled).toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Planned for Sat 10 Oct.");
  });

  it("'sat 11:00' and Enter books it at that time, for the length in the card", async () => {
    const { dialog, day } = await card({ text: "Summarise MASE vs MAPE", blockId: "t-abc123" });
    type(day, "sat 11:00");
    fireEvent.submit(day.closest("form")!);
    await act(async () => {});
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
    await act(async () => {});
    expect(server.calls[0]!.body).toMatchObject({ date: "2026-10-09", startMin: 870, durationMin: 90 });
  });

  it("says what it couldn't read, and sends nothing", async () => {
    const { dialog, day } = await card();
    type(day, "someday");
    fireEvent.submit(day.closest("form")!);
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toMatch(/^Say a day/);
    type(day, "sat");
    type(within(dialog).getByRole("textbox", { name: "Time" }), "noon");
    fireEvent.submit(day.closest("form")!);
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toMatch(/^Say a time/);
    expect(server.calls).toEqual([]);
  });

  it("a save that fails says so, in plain words", async () => {
    server.fail = true;
    const { day, onScheduled } = await card();
    type(day, "sat");
    fireEvent.submit(day.closest("form")!);
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toBe("That didn't save. Your note is as it was; try again.");
    expect(onScheduled).not.toHaveBeenCalled();
  });

  it("is in the overlay stack: Escape closes it", async () => {
    const { onClose } = await card();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
