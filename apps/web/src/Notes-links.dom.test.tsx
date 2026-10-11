/**
 * The Notes screen opens what a cmd-clicked link names (WEB-007): the server's resolution of the
 * link, not a title search for its label.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRoute } from "./ui/router.js";

const gets = vi.hoisted(() => [] as string[]);
vi.mock("./ws.js", () => ({ onWs: () => () => {}, sendEditing: () => {} }));
vi.mock("./FileTree.js", () => ({ FileTree: () => null }));
vi.mock("./Editor.js", () => ({
  Editor: ({ onFollowLink }: { onFollowLink: (t: string) => void }) => (
    <>
      <button onClick={() => onFollowLink("Graduation Thesis")}>follow aliased</button>
      <button onClick={() => onFollowLink("02-Areas/finance/Budget")}>follow path</button>
    </>
  ),
}));
vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  const tree = [
    // Same file name in another folder, listed first: only the server knows which one the link means.
    { id: "decoy", path: "Inbox/Graduation Thesis.md", folder: "Inbox", title: "Graduation Thesis (old)", tags: [], openTasks: 0, category: "other", hash: "", mtimeMs: 0 },
    { id: "src", path: "Notes/src.md", folder: "Notes", title: "Source", tags: [], openTasks: 0, category: "other", hash: "", mtimeMs: 0 },
    { id: "thesis", path: "04-Projects/Graduation Thesis.md", folder: "04-Projects", title: "Graduation Thesis", tags: [], openTasks: 0, category: "other", hash: "", mtimeMs: 0 },
    { id: "budget", path: "02-Areas/finance/Budget.md", folder: "02-Areas/finance", title: "Monthly budget", tags: [], openTasks: 0, category: "other", hash: "", mtimeMs: 0 },
  ];
  return {
    ...real,
    api: async (method: string, url: string) => {
      if (url === "/api/vault/tree") return tree;
      const m = /^\/api\/vault\/note\/([^/]+)$/.exec(url);
      if (method === "GET" && m) {
        gets.push(m[1]!);
        const links = m[1] === "src" ? [{ target: "Graduation Thesis", alias: "thesis", raw: "[[Graduation Thesis|thesis]]", line: 3, targetId: "thesis", locked: false }] : [];
        return { id: m[1], path: tree.find((t) => t.id === m[1])!.path, title: m[1], content: "", hash: "h", tags: [], tasks: [], links, backlinks: [], canEdit: false };
      }
      return [];
    },
  };
});

const { Notes } = await import("./Notes.js");
const me = { id: "u-1", username: "jules", displayName: "Jules" } as never;
const flush = () => act(async () => {});
/** What App does: the address decides the note, and following a link goes to its address. */
function Routed() {
  const r = useRoute();
  const n = r?.kind === "notes" ? r : null;
  return <Notes me={me} noteId={n?.id} notePath={n?.path} />;
}

describe("following a link from the editor (WEB-007)", () => {
  it("opens the note the server resolved for an aliased link, and the note at a path", async () => {
    history.replaceState(null, "", "/notes?id=src");
    const { unmount } = render(<Routed />);
    await flush();
    fireEvent.click(screen.getByText("follow aliased"));
    await flush();
    expect(gets.at(-1)).toBe("thesis");
    unmount();
    history.replaceState(null, "", "/notes?id=src");
    render(<Routed />);
    await flush();
    fireEvent.click(screen.getByText("follow path"));
    await flush();
    expect(gets.at(-1)).toBe("budget");
  });
});
