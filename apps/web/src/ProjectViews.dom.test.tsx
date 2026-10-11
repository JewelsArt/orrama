/**
 * The Documents board saves 400 ms after the last change. Leaving it inside
 * that window — renaming a box and clicking the Overview tab, which blurs the
 * name (commit) and unmounts the board — used to cancel the save (WEB-014).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ puts: [] as { url: string; body: { nodes: { id: string; label?: string }[] } }[] }));

vi.mock("./DocViewer.js", () => ({ DocViewer: () => null }));
vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  return {
    ...real,
    api: async (method: string, url: string, body?: unknown) => {
      if (method === "GET" && url === "/api/projects/thesis/board")
        return { nodes: [{ id: "g-1", type: "group", label: "Sources", x: 0, y: 0, width: 480, height: 220 }], edges: [], canEdit: true };
      if (method === "PUT") server.puts.push({ url, body: body as never });
      return {};
    },
  };
});

const { ProjectBoard } = await import("./ProjectViews.js");
const w = { slug: "thesis", files: [] } as never;

beforeEach(() => {
  server.puts = [];
});

describe("the Documents board (WEB-014)", () => {
  it("a rename finished by leaving the board is still saved", async () => {
    const { unmount } = render(<ProjectBoard w={w} onUpload={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByLabelText("Rename Sources"));
    const input = screen.getByLabelText("Box name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Primary sources" } });
    fireEvent.blur(input);
    // The tab switch, at once — well inside the 400 ms debounce.
    unmount();
    await act(async () => {});
    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]!.url).toBe("/api/projects/thesis/board");
    expect(server.puts[0]!.body.nodes.find((n) => n.id === "g-1")!.label).toBe("Primary sources");
  });

  it("a change left alone is saved once, after the pause, not again on leaving", async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<ProjectBoard w={w} onUpload={() => {}} />);
      await act(async () => {});
      fireEvent.click(screen.getByLabelText("Rename Sources"));
      const input = screen.getByLabelText("Box name") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Later" } });
      fireEvent.blur(input);
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(server.puts).toHaveLength(1);
      unmount();
      expect(server.puts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
