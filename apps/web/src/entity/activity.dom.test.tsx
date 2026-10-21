/**
 * A person's page lists the open steps that name them (entity/activity.tsx). A step's card
 * opens from its row, and the card's "from the note" opens that note (1B: it did nothing).
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const went = vi.hoisted(() => [] as unknown[]);
vi.mock("../ui/router.js", async (orig) => ({ ...(await orig<typeof import("../ui/router.js")>()), navigate: (to: unknown) => void went.push(to) }));
vi.mock("../api.js", async (orig) => ({
  ...(await orig<typeof import("../api.js")>()),
  api: async (method: string, url: string) => {
    if (method === "GET" && url === "/api/plan") return { assignees: [] };
    if (method === "GET" && url.startsWith("/api/tasks/card?"))
      return {
        task: { line: 3, checked: false, status: "todo", text: "Send Ines Vermaat the draft", raw: "- [ ] Send Ines Vermaat the draft", indent: 0, noteId: "n-thesis", notePath: "Thesis.md", noteTitle: "Thesis", words: "Send Ines Vermaat the draft" },
        canEdit: true, project: null, section: null, places: [], inInbox: false,
      };
    return {};
  },
}));

const { ActivityModule } = await import("./activity.js");

describe("a step on a person's page", () => {
  it("opens its card, and the card's note link opens the note", async () => {
    const task = { line: 3, checked: false, status: "todo", text: "Send Ines Vermaat the draft", raw: "- [ ] Send Ines Vermaat the draft", indent: 0, noteId: "n-thesis", notePath: "Thesis.md", noteTitle: "Thesis", project: null, object: null };
    const sources = { tasks: { state: "ok", data: [task] }, events: { state: "ok", data: [] }, inbox: { state: "loading" } } as never;
    render(<ActivityModule title="With Ines" sources={sources} who={{ names: ["Ines Vermaat"], addresses: [], domains: new Set() }} onChanged={() => {}} />);
    fireEvent.click(screen.getByText("Send Ines Vermaat the draft").closest("a")!);
    await act(async () => {});
    await act(async () => {});
    const dialog = await screen.findByRole("dialog", { name: "Send Ines Vermaat the draft" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Thesis" }));
    expect(went).toEqual([{ kind: "notes", id: "n-thesis" }]);
  });
});
