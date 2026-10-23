/**
 * Settings → Notes → Life areas (1D): the person's areas in order, each changed from its ⋯ menu.
 * Every change sends the whole list, each area with the id it had, so a rename takes its
 * projects; removing one asks first and says where its notes and projects go.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { holds, removalWords } from "./LifeAreas.js";

const server = vi.hoisted(() => ({
  puts: [] as Record<string, unknown>[],
  areas: [] as { id: string; name: string; words: string[]; catchAll: boolean; notes: number; projects: number }[],
  note: null as { id: string; path: string; hash: string } | null,
  canEdit: true,
  refuse: null as string | null,
}));
vi.mock("../api.js", async (orig) => {
  const real = await orig<typeof import("../api.js")>();
  return {
    ...real,
    api: async (method: string, url: string, body?: Record<string, unknown>) => {
      if (method === "GET" && url === "/api/areas") return { areas: server.areas, note: server.note, canEdit: server.canEdit };
      if (method === "PUT" && url === "/api/areas") {
        if (server.refuse) throw new real.ApiError(400, server.refuse);
        server.puts.push(body!);
        return { ok: true, projects: 1, unmoved: 0, rest: "home" };
      }
      throw new Error(`${method} ${url}`);
    },
  };
});
const { LifeAreasSection } = await import("./LifeAreas.js");
const { Toaster } = await import("../ui/overlays.js");

beforeEach(() => {
  server.puts = [];
  server.refuse = null;
  server.canEdit = true;
  server.note = { id: "n-a", path: "Orrama/Life areas.md", hash: "h1" };
  server.areas = [
    { id: "work", name: "Work", words: ["meeting notes"], catchAll: false, notes: 4, projects: 1 },
    { id: "personal", name: "Personal", words: [], catchAll: true, notes: 9, projects: 0 },
    { id: "running", name: "Running", words: [], catchAll: false, notes: 3, projects: 1 },
  ];
});

const show = async () => {
  render(
    <>
      <LifeAreasSection />
      <Toaster />
    </>,
  );
  await act(async () => {});
};
const rows = () => within(screen.getByRole("list", { name: "Life areas" })).getAllByRole("listitem");
const menu = async (area: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Change ${area}` }));
  await act(async () => {});
  return screen.getByRole("menu", { name: area });
};
const pick = async (area: string, item: string | RegExp) => {
  fireEvent.click(within(await menu(area)).getByRole("menuitem", { name: item }));
  await act(async () => {});
};
const submit = async () => {
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
  await act(async () => {});
};
const typeInto = (label: string, text: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
const sent = () => (server.puts.at(-1)!["areas"] as { name: string; was?: string; catchAll: boolean; words: string[] }[]).map((a) => [a.name, a.was ?? null, a.catchAll]);

describe("the list", () => {
  it("shows each area in order with its colour, what it holds and its words; no tag or table is taught", async () => {
    await show();
    expect(rows().map((r) => r.textContent)).toEqual(["Work · 3 notes · 1 project · Also notes with meeting notes", "Personal · 9 notes · Everything no other area takes", "Running · 2 notes · 1 project"]);
    expect(rows().map((r) => (r.querySelector(".ui-dot") as HTMLElement).style.background)).toEqual(["var(--c1)", "var(--c2)", "var(--c3)"]);
    expect(document.body.textContent).not.toMatch(/#vault|table|PARA|Markdown/);
    expect(screen.getByRole("link", { name: "Open the note" }).getAttribute("href")).toBe("/notes/Orrama/Life%20areas");
  });

  it("someone who can't change them sees them, with nothing to change", async () => {
    server.canEdit = false;
    await show();
    expect(rows()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /Change|Add an area/ })).toBeNull();
  });
});

describe("changing them", () => {
  it("adds an area above the catch-all when it closes the list, else at the end", async () => {
    server.areas = [server.areas[0]!, server.areas[2]!, server.areas[1]!];
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Add an area" }));
    typeInto("What is the area called?", "Family");
    await submit();
    expect(sent()).toEqual([
      ["Work", "work", false],
      ["Running", "running", false],
      ["Family", null, false],
      ["Personal", "personal", true],
    ]);
    expect(server.puts[0]!["baseHash"]).toBe("h1");
  });

  it("renames the catch-all, keeping the id it had", async () => {
    await show();
    await pick("Personal", "Rename…");
    expect((screen.getByLabelText("What is the area called?") as HTMLInputElement).value).toBe("Personal");
    typeInto("What is the area called?", "Home");
    await submit();
    expect(sent()[1]).toEqual(["Home", "personal", true]);
  });

  it("the server's refusal stays in the dialog", async () => {
    server.refuse = "There are two areas called Work.";
    await show();
    await pick("Running", "Rename…");
    typeInto("What is the area called?", "Work");
    await submit();
    expect(screen.getByRole("dialog").textContent).toContain("There are two areas called Work.");
  });

  it("moves an area up; the first can't move up", async () => {
    await show();
    await pick("Running", "Move up");
    expect(sent().map((a) => a[0])).toEqual(["Work", "Running", "Personal"]);
    const m = await menu("Work");
    expect((within(m).getByRole("menuitem", { name: "Move up" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("edits an area's words as a list", async () => {
    await show();
    await pick("Work", "Words…");
    fireEvent.click(screen.getByRole("button", { name: "Remove meeting notes" }));
    typeInto("Add a word", "clients");
    fireEvent.keyDown(screen.getByLabelText("Add a word"), { key: "Enter" });
    typeInto("Add a word", "invoices");
    await submit();
    expect((server.puts[0]!["areas"] as { words: string[] }[])[0]!.words).toEqual(["clients", "invoices"]);
  });

  it("removing asks first, says where its notes and projects go, and does nothing on Keep it", async () => {
    await show();
    await pick("Running", "Remove Running…");
    const ask = screen.getByRole("alertdialog");
    expect(ask.textContent).toContain("Its 2 notes and 1 project go to Personal. Nothing is deleted.");
    fireEvent.click(within(ask).getByRole("button", { name: "Keep it" }));
    await act(async () => {});
    expect(server.puts).toEqual([]);
    await pick("Running", "Remove Running…");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove Running" }));
    await act(async () => {});
    expect(sent().map((a) => a[0])).toEqual(["Work", "Personal"]);
    expect(await screen.findByText("Running is gone. Its project is in Personal now.")).toBeTruthy();
  });

  it("the catch-all can't be removed and has no words", async () => {
    await show();
    const m = await menu("Personal");
    expect(within(m).queryByRole("menuitem", { name: /Remove/ })).toBeNull();
    expect(within(m).queryByRole("menuitem", { name: "Words…" })).toBeNull();
  });
});

describe("the words", () => {
  it("say what an area holds and what removing it does", () => {
    expect(holds({ notes: 0, projects: 0 })).toBe("Nothing yet");
    expect(holds({ notes: 1, projects: 1 })).toBe("1 project");
    expect(removalWords({ name: "Chess", notes: 0, projects: 0 }, "Home")).toBe("Nothing is in Chess yet.");
    expect(removalWords({ name: "Running", notes: 1, projects: 1 }, "Home")).toBe("Its 1 project goes to Home. Nothing is deleted.");
  });
});
