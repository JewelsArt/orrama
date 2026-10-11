/**
 * The tree while you type (WEB-009). Each autosave used to fetch the whole vault tree twice
 * (the save's own hook, then its live-sync echo) with no cancelling, so an older reply landing
 * last could put old titles and counts back.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Msg = { type: string; noteId?: string; authorId?: string };
const ws = vi.hoisted(() => ({ listeners: new Set<(m: Msg) => void>() }));
const net = vi.hoisted(() => ({
  log: [] as string[],
  /** Tree replies the test holds, released by hand in any order. */
  held: [] as { titles: string[]; resolve: () => void; signal?: AbortSignal }[],
  hold: false,
  version: 0,
  canEdit: false,
}));

vi.mock("./ws.js", () => ({
  onWs: (l: (m: Msg) => void) => (ws.listeners.add(l), () => ws.listeners.delete(l)),
  sendEditing: () => {},
}));
vi.mock("./Editor.js", () => ({
  Editor: ({ content, onChange }: { content: string; onChange: (s: string) => void }) => (
    <textarea aria-label="editor" defaultValue={content} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock("./FileTree.js", () => ({ FileTree: ({ notes }: { notes: { title: string }[] }) => <ul aria-label="tree">{notes.map((n) => <li key={n.title}>{n.title}</li>)}</ul> }));
vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  const treeOf = (titles: string[]) => titles.map((t, i) => ({ id: `n${i}`, path: `${t}.md`, folder: "", title: t, tags: [], openTasks: 0, category: "other", hash: "", mtimeMs: 0 }));
  return {
    ...real,
    api: async (method: string, url: string, _body?: unknown, opts: { signal?: AbortSignal } = {}) => {
      net.log.push(`${method} ${url}`);
      if (url === "/api/vault/tree") {
        const titles = [`Note v${++net.version}`];
        if (net.hold) {
          await new Promise<void>((resolve) => net.held.push({ titles, resolve, signal: opts.signal }));
        }
        // What the real api() does with a reply to a cancelled request: never return it.
        if (opts.signal?.aborted) throw new DOMException("superseded", "AbortError");
        return treeOf(titles);
      }
      if (method === "PUT") return { content: (_body as { content: string }).content, hash: "h2", path: "a.md" };
      if (/^\/api\/vault\/note\/[^/]+$/.test(url)) return { id: "n0", path: "a.md", title: "A", content: "", hash: "h", tags: [], tasks: [], links: [], backlinks: [], canEdit: net.canEdit };
      return [];
    },
  };
});

const { Architecture, TREE_RELOAD_MS } = await import("./Architecture.js");
const { resetNoteSyncs } = await import("./noteSync.js");
const me = { id: "u-1", username: "jules", displayName: "Jules" } as never;
const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const changed = () => act(async () => ws.listeners.forEach((l) => l({ type: "note-changed", noteId: "n0", authorId: "u-1" })));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  ws.listeners.clear();
  net.log = [];
  net.held = [];
  net.hold = false;
  net.version = 0;
  net.canEdit = false;
  resetNoteSyncs();
});
afterEach(() => vi.useRealTimers());

describe("the tree while you type (WEB-009)", () => {
  it("a burst of saves and their echoes reloads the tree once, and never asks for the graph", async () => {
    render(<Architecture me={me} noteId="n0" />);
    await settle();
    net.log = [];
    await changed(); // your autosave comes back
    await settle(200);
    await changed(); // and the next one
    await changed();
    await settle(TREE_RELOAD_MS + 50);
    expect(net.log.filter((l) => l === "GET /api/vault/tree")).toHaveLength(1);
    expect(net.log.some((l) => l.includes("/api/vault/graph"))).toBe(false);
  });

  it("one autosave, with its echo, is one tree request", async () => {
    net.canEdit = true;
    render(<Architecture me={me} noteId="n0" />);
    await settle();
    net.log = [];
    fireEvent.change(screen.getByLabelText("editor"), { target: { value: "typed\n" } });
    await settle(700); // the debounce fires, the PUT lands
    expect(net.log).toContain("PUT /api/vault/note");
    await changed(); // the server tells every view, this one included
    await settle(TREE_RELOAD_MS + 50);
    expect(net.log.filter((l) => l === "GET /api/vault/tree")).toHaveLength(1);
  });

  it("an older tree reply landing last is never shown", async () => {
    net.hold = true;
    render(<Architecture me={me} noteId="n0" />);
    await settle();
    await changed();
    await settle(TREE_RELOAD_MS + 50);
    expect(net.held).toHaveLength(2);
    net.held[1]!.resolve(); // the newer reply first
    await settle();
    expect(screen.getByText("Note v2")).toBeTruthy();
    net.held[0]!.resolve(); // then the older one
    await settle();
    expect(screen.queryByText("Note v1")).toBeNull();
    expect(screen.getByText("Note v2")).toBeTruthy();
  });
});
