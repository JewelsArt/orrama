/**
 * The Orrery page: the panel for the whole vault, an area and one thing; its addresses (Steps,
 * an area, Back one level); Find; Open; the reviews switch; empty, loading and error.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetLayouts } from "./engine.js";
import { fixture, type Fixture } from "./fixture.js";

let data: Fixture | "fail" = fixture();
const calls: string[] = [];
vi.mock("../api.js", () => ({
  api: vi.fn(async (_m: string, url: string) => {
    calls.push(url);
    if (data === "fail") throw new Error("down");
    if (url === "/api/vault/graph") return data.graph;
    if (url === "/api/vault/tree") return data.tree;
    if (url === "/api/projects") return data.projects;
    if (url === "/api/graph/schema") return { relations: [] };
    throw new Error(url);
  }),
}));

const listeners = new Set<(m: unknown) => void>();
vi.mock("../ws.js", () => ({
  onWs: (l: (m: unknown) => void) => (listeners.add(l), () => listeners.delete(l)),
}));
const emitNoteChanged = () => listeners.forEach((l) => l({ type: "note-changed", noteId: "n-call", path: "", authorId: null }));

const { Orrery } = await import("./Orrery.js");
const { useRoute } = await import("../ui/router.js");

/** The Orrery as App mounts it: the route from the address. */
function Page({ onAsk = () => {} }: { onAsk?: () => void }) {
  const r = useRoute();
  return r?.kind === "orrery" ? <Orrery route={r} onAsk={onAsk} /> : <div data-testid="elsewhere">{location.pathname}</div>;
}
const at = (href: string) => history.replaceState({ depth: 0 }, "", href);
const path = () => location.pathname + location.search;
const panel = () => screen.getByRole("complementary");

beforeEach(() => {
  data = fixture();
  calls.length = 0;
  forgetLayouts();
  at("/orrery");
});

describe("the whole vault", () => {
  it("reads the notes, then shows the vault with its life areas and what is in it", async () => {
    render(<Page />);
    expect(within(panel()).getByText("Reading your notes")).toBeTruthy();
    expect(await within(panel()).findByText("16 files")).toBeTruthy();
    expect(screen.getByText(/^16 files · 11 links · \d+ topics$/)).toBeTruthy();
    for (const a of ["School", "Work", "Claude & tools", "Personal", "Knowledge"]) expect(within(panel()).getByRole("button", { name: new RegExp(`^${a}`) })).toBeTruthy();
    expect(calls.sort()).toEqual(["/api/graph/schema", "/api/projects", "/api/vault/graph", "/api/vault/tree"]);
  });

  it("the reviews switch is remembered on this device", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await within(panel()).findByText("16 files");
    const sw = within(panel()).getByRole("switch", { name: "Show reviews and templates" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await user.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("orrama-orrery-rest")).toBe("1");
  });

  it("an area's row goes to the area's address; its panel lists its topics and projects", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await within(panel()).findByText("16 files");
    await user.click(within(panel()).getByRole("button", { name: /^Work/ }));
    expect(path()).toBe("/orrery?area=work");
    expect(await within(panel()).findByRole("heading", { name: "Work" })).toBeTruthy();
    expect(within(panel()).getAllByRole("button", { name: /Kade Social report/ })).toHaveLength(2); // its topic and the project
    // the path at the top of the map steps back out
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(path()).toBe("/orrery"));
  });
});

describe("one thing", () => {
  it("Steps from the address: its relations in words, Open, Back to Orr", async () => {
    const user = userEvent.setup();
    at("/orrery?center=kade-social-report");
    render(<Page />);
    expect(await within(panel()).findByRole("heading", { name: "Kade Social report" })).toBeTruthy();
    expect(within(panel()).getByText("on track")).toBeTruthy();
    expect(within(panel()).getByText("The monthly social report for Kade.")).toBeTruthy();
    expect(within(panel()).getByText("its notes")).toBeTruthy();
    expect(within(panel()).getByRole("link", { name: "Campaign brief" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Steps" }).getAttribute("aria-checked")).toBe("true");
    await user.click(within(panel()).getByRole("button", { name: /Back to Orr/ }));
    await waitFor(() => expect(path()).toBe("/orrery"));
  });

  it("Esc steps out of Steps", async () => {
    const user = userEvent.setup();
    at("/orrery?center=ines-vermaat");
    render(<Page />);
    await within(panel()).findByRole("heading", { name: "Ines Vermaat" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(path()).toBe("/orrery"));
  });

  it("Open goes to the project's page, or to the note", async () => {
    const user = userEvent.setup();
    at("/orrery?center=kade-social-report");
    render(<Page />);
    await within(panel()).findByRole("heading", { name: "Kade Social report" });
    await user.click(within(panel()).getByRole("button", { name: "Open" }));
    expect(path()).toBe("/projects/kade-social-report");
    at("/orrery?center=campaign-brief");
    render(<Page />);
    await screen.findAllByRole("heading", { name: "Campaign brief" });
    await user.click(screen.getAllByRole("button", { name: "Open" }).at(-1)!);
    expect(path()).toBe("/notes/Work/Kade%20Social/Campaign%20brief");
  });

  it("Ask Orr opens Orr's panel", async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn();
    at("/orrery?center=ines-vermaat");
    render(<Page onAsk={onAsk} />);
    await within(panel()).findByRole("heading", { name: "Ines Vermaat" });
    await user.click(within(panel()).getByRole("button", { name: "Ask Orr" }));
    expect(onAsk).toHaveBeenCalled();
  });
});

describe("Find", () => {
  it("finds names, best first, and picking one selects it", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await within(panel()).findByText("16 files");
    await user.type(screen.getByRole("combobox", { name: "Find in the orrery" }), "kade");
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options[0]).toMatch(/^Kade Social/);
    expect(options.length).toBe(2);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(await within(panel()).findByRole("heading", { name: /^Kade Social/ })).toBeTruthy();
  });
  it("says so when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await within(panel()).findByText("16 files");
    await user.type(screen.getByRole("combobox", { name: "Find in the orrery" }), "zzz");
    expect(screen.getByText("Nothing by that name.")).toBeTruthy();
  });
});

describe("empty and error", () => {
  it("empty: Orr asks for the notes folder", async () => {
    data = { graph: { nodes: [], edges: [] }, tree: [], projects: [] };
    render(<Page />);
    expect(await screen.findByText("Your files will gather around me")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Point me at your notes folder" })).toBeTruthy();
  });
  it("error: plain words, Try again reads the notes again", async () => {
    const user = userEvent.setup();
    data = "fail";
    render(<Page />);
    expect(await screen.findByText("Can't read your notes folder")).toBeTruthy();
    data = fixture();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await within(panel()).findByText("16 files")).toBeTruthy();
  });
  it("a note changed elsewhere (live sync) reads the vault again, quietly", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Page />);
    await within(panel()).findByText("16 files");
    calls.length = 0;
    act(() => emitNoteChanged());
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    await waitFor(() => expect(calls).toContain("/api/vault/graph"));
    expect(within(panel()).queryByText("Reading your notes")).toBeNull();
    vi.useRealTimers();
  });
});
