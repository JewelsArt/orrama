/**
 * Saving, as the Notes screen shows it (WEB-002): a failing save is said against the note it
 * belongs to, with the server's reason, and typing an earlier page never saved is offered back.
 * The real noteSync runs here; only the server and the editor are stand-ins.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  down: false as false | "network" | 403,
  files: new Map<string, string>(),
  puts: [] as { path: string; content: string }[],
}));

vi.mock("./ws.js", () => ({ onWs: () => () => {}, sendEditing: () => {} }));
vi.mock("./FileTree.js", () => ({ FileTree: () => null }));
vi.mock("./Editor.js", () => ({
  Editor: ({ noteId, content, onChange }: { noteId: string; content: string; onChange: (s: string) => void }) => (
    <textarea aria-label={`editor ${noteId}`} defaultValue={content} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  return {
    ...real,
    api: async (method: string, url: string, body?: { path: string; content: string }) => {
      if (method === "PUT" && body) {
        if (server.down === "network") throw new TypeError("Failed to fetch");
        if (server.down === 403) throw new real.ApiError(403, "you can't make this note unreadable to yourself");
        server.puts.push(body);
        server.files.set(body.path, body.content);
        return { content: body.content, hash: `h:${body.content}`, path: body.path };
      }
      const m = /^\/api\/vault\/note\/([^/]+)$/.exec(url);
      if (method === "GET" && m) {
        const id = m[1]!;
        const content = server.files.get(`${id}.md`) ?? "";
        return { id, path: `${id}.md`, title: id.toUpperCase(), content, hash: `h:${content}`, tags: [], tasks: [], links: [], backlinks: [], canEdit: true };
      }
      return [];
    },
  };
});

const { Architecture } = await import("./Architecture.js");
const { resetNoteSyncs } = await import("./noteSync.js");
const me = { id: "u-1", username: "jules", displayName: "Jules" } as never;
const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetNoteSyncs();
  localStorage.clear();
  server.down = false;
  server.puts = [];
  server.files = new Map([
    ["a.md", "alpha\n"],
    ["b.md", "beta\n"],
  ]);
});
afterEach(() => vi.useRealTimers());

describe("saving, on the Notes screen (WEB-002)", () => {
  it("a failing save is said on its own note, with the reason, and not on the next one", async () => {
    const { rerender } = render(<Architecture me={me} noteId="a" />);
    await settle();
    server.down = 403;
    fireEvent.change(screen.getByLabelText("editor a"), { target: { value: "alpha\n#only/finance\n" } });
    await settle(700);
    expect(screen.getByText("not saved")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("you can't make this note unreadable to yourself");

    rerender(<Architecture me={me} noteId="b" />);
    await settle(3000);
    expect(screen.getByLabelText("editor b")).toBeTruthy();
    expect(screen.queryByText("not saved")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("saved")).toBeTruthy();
  });

  it("typing a closed page never saved is offered back, and Restore saves it", async () => {
    localStorage.setItem("basalt-draft:a", JSON.stringify({ content: "alpha\nlost line\n", base: "alpha\n", at: Date.now() - 60_000 }));
    render(<Architecture me={me} noteId="a" />);
    await settle();
    expect(screen.getByText(/wasn't saved\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await settle(700);
    expect(server.files.get("a.md")).toBe("alpha\nlost line\n");
    expect((screen.getByLabelText("editor a") as HTMLTextAreaElement).value).toBe("alpha\nlost line\n");
    expect(localStorage.getItem("basalt-draft:a")).toBeNull();
  });

  it("a draft the note already holds is dropped without asking", async () => {
    localStorage.setItem("basalt-draft:a", JSON.stringify({ content: "alpha\n", base: "", at: Date.now() }));
    render(<Architecture me={me} noteId="a" />);
    await settle();
    expect(screen.queryByText(/wasn't saved\./)).toBeNull();
    expect(localStorage.getItem("basalt-draft:a")).toBeNull();
  });
});
