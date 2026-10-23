/**
 * Orr noticed (structure.md §2.15), `/notes/health`: each warning a sentence about its note with
 * one fix, nothing written until a fix is clicked, and the graph at a glance. Plain on a vault
 * without an ontology. Fictional notes only.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ calls: [] as { method: string; url: string; body: unknown }[], typed: true }));

vi.mock("../ws.js", () => ({ onWs: () => () => {}, sendEditing: () => {} }));

const note = (id: string, title: string, type: string, path: string) => ({ id, title, type, path });
const WARNINGS = [
  { code: "unresolved-object", message: "m", note: note("n-pieter", "Pieter Bakker", "person", "Contacts/Pieter Bakker.md"), relation: "works_at", target: "Bakker & Zn" },
  { code: "person-without-company", message: "m", note: note("n-pieter", "Pieter Bakker", "person", "Contacts/Pieter Bakker.md") },
  { code: "project-status-conflict", message: "m", note: note("n-oost", "Move to Oost", "project", "04-Projects/move-to-oost.md"), field: "at-risk", tags: ["paused"] },
  { code: "project-without-status", message: "m", note: note("n-inbox", "Inbox agent", "project", "04-Projects/inbox-agent.md") },
  { code: "document-orphan", message: "m", note: note("n-pitch", "Old pitch", "document", "Shared/Old pitch.md"), tag: "project/pitch-deck" },
];

vi.mock("../api.js", async (orig) => {
  const real = await orig<typeof import("../api.js")>();
  return {
    ...real,
    api: async (method: string, url: string, body?: unknown) => {
      server.calls.push({ method, url, body });
      if (method !== "GET") return { ok: true };
      switch (url) {
        case "/api/graph/warnings":
          return { typed: server.typed, ontology: server.typed ? { id: "n-ont", title: "Vault ontology", path: "00-Meta/Vault ontology.md" } : null, warnings: server.typed ? WARNINGS : [] };
        case "/api/graph/schema":
          return server.typed
            ? {
                notes: 60,
                types: [
                  { id: "person", count: 20, description: "someone Jules knows" },
                  { id: "project", count: 9, description: "the note that is a project" },
                  { id: "area", count: 0, description: "an area" },
                ],
                relations: [{ id: "works_at", domain: ["person"], range: ["company"], inverse: "employs", count: 16, description: "where someone works" }],
                derived: [],
                statuses: [{ id: "on-track", count: 2 }],
                mostConnected: [],
                warnings: [],
              }
            : { notes: 60, types: [{ id: "note", count: 61, description: "any other note" }], relations: [], derived: [], statuses: [], mostConnected: [], warnings: [] }; // as the server sends it
        case "/api/notes/overview":
          return { pinned: [], notes: 60, conversations: 2, openTasks: 43, doneTasks: 19 };
        case "/api/contacts":
          return [{ id: "n-pieter", name: "Pieter Bakker", path: "Contacts/Pieter Bakker.md", sector: "", role: "", company: "", companyId: null, email: "", phone: "", linkedin: "", personal: false }];
        case "/api/companies":
          return [];
        case "/api/projects":
          return [
            { slug: "move-to-oost", noteId: "n-oost", name: "Move to Oost" },
            { slug: "inbox-agent", noteId: "n-inbox", name: "Inbox agent" },
          ];
        case "/api/vault/graph":
          return { nodes: [], edges: [] };
        case "/api/vault/tree":
          return [];
      }
      return [];
    },
  };
});

const { Noticed } = await import("./Noticed.js");
const me = { id: "u-1", username: "jules", email: "jules@orrama.dev", displayName: "Jules", isOwner: true } as never;
const writes = () => server.calls.filter((c) => c.method !== "GET");
const list = () => screen.getByRole("list", { name: "What needs a look" });
const item = (text: RegExp) => within(list()).getAllByRole("listitem").find((li) => text.test(li.textContent ?? ""))!;

beforeEach(() => {
  server.calls = [];
  server.typed = true;
});
afterEach(cleanup);

const show = async () => {
  render(<Noticed me={me} />);
  await screen.findByRole("heading", { level: 1, name: "Orr noticed" });
  // The page has loaded when its placeholders are gone: the warnings and the schema have answered
  // and rendered. Their effects can run late on a loaded machine, so this waits, never a fixed
  // number of ticks.
  await waitFor(() => expect(screen.queryAllByRole("status", { name: "Loading" })).toEqual([]));
};

describe("Orr noticed", () => {
  it("says each warning as a sentence about its note, once per problem", async () => {
    await show();
    const said = within(list()).getAllByRole("listitem").map((li) => li.querySelector("p")!.textContent);
    expect(said).toEqual([
      "Pieter Bakker works at Bakker & Zn, which has no note.",
      "Move to Oost is tagged paused but its status says at risk.",
      "Inbox agent has no status.",
      "Old pitch is tagged project/pitch-deck, but there's no project note for it.",
    ]);
    expect(within(item(/Pieter/)).getByRole("link", { name: "Pieter Bakker" }).getAttribute("href")).toBe("/people/pieter-bakker");
    expect(within(item(/Oost/)).getByRole("link", { name: "Move to Oost" }).getAttribute("href")).toBe("/projects/move-to-oost");
    expect(writes()).toEqual([]);
  });

  it("Use paused writes the project's status through its own PATCH", async () => {
    await show();
    await act(async () => {
      fireEvent.click(within(item(/Oost/)).getByRole("button", { name: "Use paused" }));
    });
    expect(writes()).toEqual([{ method: "PATCH", url: "/api/projects/move-to-oost", body: { status: "paused" } }]);
  });

  it("a project with no status picks one of the seven words", async () => {
    await show();
    fireEvent.click(within(item(/Inbox agent/)).getByRole("button", { name: /Status: no status/ }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /On track/ }));
    });
    expect(writes()).toEqual([{ method: "PATCH", url: "/api/projects/inbox-agent", body: { status: "on-track" } }]);
  });

  it("a tag naming a project with no note creates that project", async () => {
    await show();
    await act(async () => {
      fireEvent.click(within(item(/Old pitch/)).getByRole("button", { name: "Create the project" }));
    });
    expect(writes()).toEqual([{ method: "POST", url: "/api/projects", body: { name: "Pitch deck" } }]);
  });

  it("a company with no note opens New company with its name, and writes nothing yet", async () => {
    await show();
    fireEvent.click(within(item(/Pieter/)).getByRole("button", { name: "Create the note" }));
    const dialog = await screen.findByRole("dialog", { name: "New company" });
    expect((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Bakker & Zn");
    expect(writes()).toEqual([]);
  });

  it("shows the graph at a glance: counts, types that have notes, relations, statuses, the ontology note", async () => {
    await show();
    const glance = screen.getByRole("region", { name: "Your notes at a glance" });
    expect(glance.textContent).toContain("Notes60");
    expect(within(glance).getByRole("link", { name: "20 people" }).getAttribute("href")).toBe("/people");
    expect(glance.textContent).not.toContain("0 areas");
    expect(glance.textContent).toContain("works at 16");
    expect(within(glance).getByRole("link", { name: "Vault ontology" }).getAttribute("href")).toBe("/notes/00-Meta/Vault%20ontology");
  });

  it("on a vault without an ontology says there is nothing to check, plainly", async () => {
    server.typed = false;
    await show();
    expect(screen.getByText(/Orr doesn't know yet what kinds of things your notes are/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "What needs a look" })).toBeNull();
    const glance = screen.getByRole("region", { name: "Your notes at a glance" }).textContent;
    expect(glance).not.toContain("Types");
    expect(glance).not.toContain("Relations");
    expect(glance).not.toContain("other notes");
  });
});
