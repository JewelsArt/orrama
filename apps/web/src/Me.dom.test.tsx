/**
 * Your page (ME): a section the note doesn't have is not drawn, the story places bars by date,
 * anything clicked opens in the panel (chips walk a trail, Back walks it back, Esc closes),
 * pointing lights what a thing connects to, an answer is written through the server, what
 * couldn't be read is said, and with no note the page offers Generate (with what it needs) or a
 * blank one. The persona is the fictional sample core's tests read (persona-fixture.ts).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePersona } from "@orrama/core";
import type { PersonaData } from "@orrama/schema/responses";
import { SAMPLE_PERSONA } from "../../../packages/core/test/persona-fixture.js";
import type { Me as Account } from "./api.js";
import { Me } from "./Me.js";

const me = { id: "u1", username: "sam", email: "sam@example.com", displayName: "Sam", avatar: "orriginal" } as unknown as Account;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const withNote = (content: string): PersonaData =>
  ({
    note: { id: "n-p", path: "Me/persona.md", title: "Persona", mtimeMs: 0, hash: "h" },
    persona: parsePersona(content, "Sam"),
    others: [],
    ai: { configured: true, provider: "anthropic" },
    mail: true,
    sources: null,
  }) as PersonaData;
const noNote = (over: Partial<NonNullable<PersonaData["sources"]>> = {}, ai = true): PersonaData => ({
  note: null,
  persona: null,
  others: [],
  ai: { configured: ai, provider: ai ? "chatgpt" : null },
  mail: false,
  sources: { projects: 4, notes: 30, people: 2, chats: 0, mail: false, enough: true, home: "Me/persona.md", ...over },
});

interface Sent {
  method: string;
  url: string;
  body: unknown;
}
function stub(first: PersonaData, overrides: Record<string, (body: unknown) => Response> = {}) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ method, url, body });
      const path = url.replace(/\?.*$/, "");
      const own = overrides[`${method} ${path}`];
      if (own) return own(body);
      if (method === "GET" && path === "/api/persona") return json(first);
      if (method === "GET" && path === "/api/persona/generate") return json(null);
      if (method === "GET" && path === "/api/contacts") return json([{ id: "n-z", name: "Zora Quill", path: "Contacts/Zora Quill.md" }]);
      if (method === "GET" && path === "/api/vault/tree") return json([]);
      return json({ error: `no fixture for ${method} ${path}` }, 404);
    }),
  );
  return sent;
}

beforeEach(() => history.replaceState(null, "", "/me"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Overview", () => {
  it("draws every section the note has, from the note", async () => {
    stub(withNote(SAMPLE_PERSONA));
    render(<Me me={me} onAsk={() => {}} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Sam Rivera" })).toBeTruthy();
    for (const region of ["Story", "In short", "Proof points", "Check with you", "Skills", "Who vouches"]) expect(screen.getByRole("region", { name: region })).toBeTruthy();
    expect(screen.getByText(/^I'm Sam, a landscape student/)).toBeTruthy();
    // Answered questions are not asked again: they wait, folded, under Answered.
    const checks = screen.getByRole("region", { name: "Check with you" });
    const answered = within(checks).getByText(/^Answered \(\d+\)$/).closest("details")!;
    expect(within(answered).getByText("Portfolio")).toBeTruthy();
    expect([...checks.querySelectorAll(":scope > .me-chk")].some((b) => b.textContent?.includes("Portfolio"))).toBe(false);
    // The header's facts: the study and the role as chips opening their place.
    expect(screen.getByRole("button", { name: "Garden designer, Oakline Builders" })).toBeTruthy();
    // What couldn't be read is said.
    expect(screen.getByText(/Orr couldn't read \d+ lines of your note/)).toBeTruthy();
  });

  it("a section the note doesn't have is not drawn", async () => {
    stub(withNote("---\ntags: [persona]\n---\n# Persona — Sam\n\n## Experience\n\n| Period | Role | Organisation | Lane |\n|---|---|---|---|\n| 2024–now | Gardener | Oakline | Work |\n"));
    render(<Me me={me} onAsk={() => {}} />);
    await screen.findByRole("region", { name: "Story" });
    for (const region of ["In short", "Proof points", "Check with you", "Skills", "Who vouches"]) expect(screen.queryByRole("region", { name: region })).toBeNull();
    expect(screen.queryByText(/couldn't read/)).toBeNull();
  });

  it("the story places bars by date: in their lane, later further right, the place and role as their label", async () => {
    stub(withNote(SAMPLE_PERSONA));
    render(<Me me={me} onAsk={() => {}} />);
    const study = await screen.findByRole("group", { name: "Study" });
    const work = screen.getByRole("group", { name: "Work" });
    const left = (name: RegExp, lane: HTMLElement) => Number(within(lane).getByRole("button", { name }).dataset.left);
    expect(left(/^University of Porto/, study)).toBe(0);
    expect(left(/^Lisbon School of Design/, study)).toBeGreaterThan(0);
    expect(left(/^Verde Nursery/, work)).toBeLessThan(left(/^Oakline Builders · Intern/, work));
    expect(left(/^Oakline Builders · Intern/, work)).toBeLessThan(left(/^Oakline Builders · Garden designer/, work));
    const built = screen.getByRole("group", { name: "Built" });
    expect(within(built).getByRole("button", { name: /^Plotter · Builder/ }).className).toContain("open");
    // A January start sits on its year's tick: Verde Nursery (2022), Plotter (Jan 2026).
    const tick = (year: number) => parseFloat([...document.querySelectorAll<HTMLElement>(".me-yr")].find((y) => y.textContent === String(year))!.style.left);
    expect(left(/^Verde Nursery/, work)).toBeCloseTo(tick(2022), 1);
    expect(left(/^Plotter/, built)).toBeCloseTo(tick(2026), 1);
  });
});

describe("everything opens in the panel", () => {
  it("a bar opens its place; a chip opens the next thing; Back walks back; Esc closes", async () => {
    const user = userEvent.setup();
    stub(withNote(SAMPLE_PERSONA));
    render(<Me me={me} onAsk={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^Oakline Builders · Intern/ }));
    const panel = await screen.findByRole("dialog", { name: /^Work/ });
    expect(within(panel).getByRole("heading", { name: "Intern, garden studios" })).toBeTruthy();
    await user.click(within(panel).getByRole("button", { name: "Garden studio plans" }));
    expect(await screen.findByRole("heading", { name: "Garden studio plans" })).toBeTruthy();
    expect(screen.getByText("Yes.")).toBeTruthy(); // what can be said outside
    await user.click(screen.getByRole("button", { name: "Zora Quill" }));
    // A person with a #contact note opens their page.
    expect((await screen.findByRole("link", { name: "Open their page" })).getAttribute("href")).toBe("/people/zora-quill");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Garden studio plans" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Garden studio plans" })).toBeNull());
  });

  it("pointing at a thing lights what it connects to and fades the rest", async () => {
    stub(withNote(SAMPLE_PERSONA));
    render(<Me me={me} onAsk={() => {}} />);
    const tile = (await screen.findAllByRole("button", { name: /Courtyard survey grade/ }))[0]!;
    fireEvent.pointerEnter(tile);
    expect(tile.className).toContain("lit");
    // The survey's skill lights; an unrelated one fades.
    expect(screen.getByRole("button", { name: /^Site survey/ }).className).toContain("lit");
    expect(screen.getByRole("button", { name: /^CAD/ }).className).toContain("faded");
  });

  it("an open question is answered through the server, and the page reads the note again", async () => {
    const user = userEvent.setup();
    const sent = stub(withNote(SAMPLE_PERSONA), { "POST /api/persona/answer": () => json({ id: "n-p", path: "Me/persona.md" }) });
    render(<Me me={me} onAsk={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^Target role/ }));
    // An option is chosen, then saved: one click never writes the note.
    await user.click(await screen.findByRole("radio", { name: "landscape architect" }));
    expect(sent.some((s) => s.method === "POST")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent.find((s) => s.method === "POST")?.body).toEqual({ index: 0, raw: expect.stringMatching(/^Target role/), answer: "landscape architect" }));
    await waitFor(() => expect(sent.filter((s) => s.method === "GET" && s.url === "/api/persona")).toHaveLength(2));
  });
});

describe("with no persona note", () => {
  it("offers Generate when AI is set up and there is enough to read; a blank one makes the note", async () => {
    const user = userEvent.setup();
    const sent = stub(noNote(), { "POST /api/persona/blank": () => json({ id: "n-new", path: "Me/persona.md" }) });
    render(<Me me={me} onAsk={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Let Orr write your page" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByText("Enough to read: 4 projects and 30 notes")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Generate my persona" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Start from a blank one" }));
    await waitFor(() => expect(sent.some((s) => s.method === "POST" && s.url === "/api/persona/blank")).toBe(true));
  });

  it("says what's missing, with its fix, and Generate waits for both", async () => {
    stub(noNote({ projects: 1, notes: 4, enough: false }, false));
    render(<Me me={me} onAsk={() => {}} />);
    expect(await screen.findByRole("link", { name: "Connect AI in Settings" })).toBeTruthy();
    expect(screen.getByText(/Not much to read yet: 1 project and 4 notes\. Orr needs at least 3 projects or 20 notes\./)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Generate my persona" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("switching a source off counts it out", async () => {
    const user = userEvent.setup();
    stub(noNote({ projects: 1, notes: 25 }));
    render(<Me me={me} onAsk={() => {}} />);
    await user.click(await screen.findByRole("switch", { name: "Notes" }));
    expect((screen.getByRole("button", { name: "Generate my persona" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Generate starts the job with the sources switched on and shows its steps", async () => {
    const user = userEvent.setup();
    const running = { id: "j1", state: "running", steps: [{ id: "projects", label: "Reading 4 projects", state: "done", ms: 5 }, { id: "write", label: "Writing the draft", state: "running", ms: null }], error: null, persona: null, found: null };
    const sent = stub(noNote(), { "POST /api/persona/generate": () => json(running) });
    render(<Me me={me} onAsk={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Generate my persona" }));
    expect(await screen.findByText("Writing the draft")).toBeTruthy();
    expect(sent.find((s) => s.method === "POST")!.body).toEqual({ sources: { projects: true, notes: true, people: true, chats: false } });
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });
});

describe("the review's fixes (20 Nov)", () => {
  const NOTE = [
    "---",
    "tags: [persona]",
    "sources: the vault and the CV",
    "---",
    "# Persona — Sam",
    "",
    "## In short",
    "",
    "### One line",
    "",
    "- **EN:** I plant gardens.",
    "",
    "## Now",
    "",
    "| | |",
    "|---|---|",
    "| Role | Gardener, Oakline |",
    "| Looking for | A design studio in Lisbon |",
    "",
    "## Proof points",
    "",
    "| Number | What |",
    "|---|---|",
    ...Array.from({ length: 8 }, (_, i) => `| ${i + 11} | Proof ${i + 1} |`),
    "",
    "Words from others: Zora called my plans the clearest she had seen.",
    "",
    "## People",
    "",
    "| Person | Role | How we work together |",
    "|---|---|---|",
    "| Zora Quill | Studio lead, Oakline | My supervisor, a reference |",
    "| Ana Lee | Neighbour | Lends tools |",
    "",
    "## Interests",
    "",
    "Drawing and seed swaps.",
  ].join("\n");

  it("shows what the note had and the page didn't: Now, every proof point, what others said, everyone", async () => {
    const user = userEvent.setup();
    stub({ ...withNote(NOTE), others: [{ path: "Projects/persona.md", title: "Persona project" }] });
    render(<Me me={me} onAsk={() => {}} />);
    const now = await screen.findByRole("region", { name: "Now" });
    expect(within(now).getByText("A design studio in Lisbon")).toBeTruthy();
    const proof = screen.getByRole("region", { name: "Proof points" });
    expect(within(proof).queryByText("Proof 8")).toBeNull();
    await user.click(within(proof).getByRole("button", { name: "Show all 8" }));
    expect(within(proof).getByText("Proof 8")).toBeTruthy();
    expect(screen.getByRole("region", { name: "What others said" }).textContent).toContain("clearest she had seen");
    expect(screen.getByRole("region", { name: "Outside work" }).textContent).toContain("seed swaps");
    const who = screen.getByRole("region", { name: "Who vouches" });
    expect(within(who).queryByText("Ana Lee")).toBeNull();
    await user.click(within(who).getByRole("button", { name: /Everyone you work with/ }));
    expect(within(who).getByText("Ana Lee")).toBeTruthy();
    // The note, what it was learned from, and the other tagged note, said at the foot, not on top.
    const foot = document.querySelector(".me-foot")!;
    expect(foot.textContent).toContain("Learned from the vault and the CV.");
    expect(foot.textContent).toContain("Persona project");
  });

  it("without a mailbox, the pitch is copied for an email, never sent to a Mail that would drop it", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    stub({ ...withNote(NOTE), mail: false });
    render(<Me me={me} onAsk={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Copy for an email" }));
    expect(writeText).toHaveBeenCalledWith("I plant gardens.");
    expect(location.pathname).toBe("/me");
  });

  it("what the panel shows is in the address, so coming back opens it again", async () => {
    const user = userEvent.setup();
    stub(withNote(NOTE));
    const { unmount } = render(<Me me={me} onAsk={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^Zora Quill/ }));
    await waitFor(() => expect(new URLSearchParams(location.search).get("open")).toBe("person:zora-quill"));
    unmount();
    render(<Me me={me} onAsk={() => {}} />);
    expect(await screen.findByRole("heading", { level: 2, name: "Zora Quill" })).toBeTruthy();
  });
});

describe("layout: one gap, no sibling margins (Jules, 20 Nov: the Voice cards didn't line up)", () => {
  // happy-dom draws nothing, so offsetTop is always 0; what it does compute is the cascade. The
  // page's own stylesheet is loaded and the margins every card would get are read back.
  it("every register card on Voice gets the same top margin (none), and the tab is one stack with a gap", async () => {
    // Read from disk: the test setup turns CSS imports (even ?raw) into empty strings.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = readFileSync(join(process.cwd(), "src/styles/me.css"), "utf8");
    expect(css).toContain(".me-stack");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    try {
      stub(withNote(SAMPLE_PERSONA));
      render(<Me me={me} tab="voice" onAsk={() => {}} />);
      const grid = (await screen.findByRole("heading", { name: "English, work" })).closest(".me-vc")!;
      const cards = [...grid.children] as HTMLElement[];
      expect(cards.length).toBeGreaterThan(1);
      // The bug: ".me-page .mod + .mod { margin-top: 12px }" reached the 2nd+ cards in the grid.
      expect(new Set(cards.map((c) => getComputedStyle(c).marginTop))).toEqual(new Set(["0px"]));
      // And no card spaces itself: the tab is a flex column whose gap does it, its children unmargined.
      const stack = grid.parentElement!;
      expect(stack.className).toContain("me-stack");
      expect(getComputedStyle(stack).display).toBe("flex");
      expect(getComputedStyle(stack).flexDirection).toBe("column");
      expect(getComputedStyle(stack).rowGap || getComputedStyle(stack).gap).toMatch(/^12px/);
      for (const child of [...stack.children] as HTMLElement[]) if (!child.classList.contains("me-vh")) expect(getComputedStyle(child).marginTop).toBe("0px");
    } finally {
      style.remove();
    }
  });
});
