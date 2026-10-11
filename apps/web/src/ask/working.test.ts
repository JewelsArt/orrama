import { describe, expect, it } from "vitest";
import { FOUND_MAX, stepOf } from "./working.js";

describe("How I found this: each tool call in Orr's words", () => {
  it("says a graph question in words, with what it found as names", () => {
    const step = stepOf(
      "find_entities",
      "output-available",
      { type: "project", status: "at-risk" },
      { total: 2, entities: [{ id: "n-1", title: "Graduation thesis", type: "project" }, { id: "n-2", title: "Move to Oost", type: "project" }] },
    );
    expect(step).toEqual({
      text: "Asked the graph for at risk projects",
      found: [
        { label: "Graduation thesis", to: { kind: "note", id: "n-1" } },
        { label: "Move to Oost", to: { kind: "note", id: "n-2" } },
      ],
      more: 0,
      state: "done",
    });
  });

  it("names a relation question by its words, not its id", () => {
    expect(stepOf("find_entities", "output-available", { type: "person", relation: "works_at", to: "Kade Social" }, { total: 0, entities: [] }).text).toBe(
      "Asked the graph for people that work at Kade Social: none",
    );
  });

  it("shows a few names and counts the rest, from the graph's total", () => {
    const entities = Array.from({ length: 9 }, (_, i) => ({ id: `n-${i}`, title: `Note ${i}` }));
    const step = stepOf("find_entities", "output-available", {}, { total: 30, entities });
    expect(step.found).toHaveLength(FOUND_MAX);
    expect(step.more).toBe(30 - FOUND_MAX);
  });

  it("says a search and the notes it found, or that nothing came up", () => {
    const step = stepOf("search_vault", "output-available", { query: "data agreement" }, [{ id: "n-3", title: "Research plan", path: "04-Projects/x.md", excerpt: "…" }]);
    expect(step.text).toBe("Searched your notes for “data agreement”");
    expect(step.found).toEqual([{ label: "Research plan", to: { kind: "note", id: "n-3" } }]);
    expect(stepOf("search_vault", "output-available", { query: "zebra" }, []).text).toBe("Searched your notes for “zebra”: nothing came up");
  });

  it("says what is happening while a tool runs, and finds nothing yet", () => {
    const step = stepOf("search_vault", "input-available", { query: "Thijs" }, undefined);
    expect(step).toEqual({ text: "Searching your notes for “Thijs”", found: [], more: 0, state: "running" });
    expect(stepOf("read_note", "input-streaming", {}, undefined).text).toBe("Reading one note");
  });

  it("marks a refused write as failed and says nothing was changed", () => {
    const step = stepOf("write_note", "output-available", { path: "Shared/Plan.md" }, { success: false, error: "409" });
    expect(step.state).toBe("failed");
    expect(step.text).toBe("Tried to write Plan; it wasn't changed");
    expect(stepOf("read_note", "output-error", { note: "Secret" }, undefined)).toMatchObject({ state: "failed", text: "Couldn't read “Secret”" });
  });

  it("leads mail to its message, drafts to Waiting for you, and calendar work to the day", () => {
    expect(stepOf("read_email", "output-available", { uid: 42 }, { success: true, fromName: "Thijs Brouwer", subject: "TikTok API key" })).toMatchObject({
      text: "Read a mail from Thijs Brouwer",
      found: [{ label: "TikTok API key", to: { kind: "mail", uid: 42 } }],
    });
    expect(stepOf("draft_email", "output-available", { to: "ines@example.org", subject: "Friday" }, { success: true, to: "ines@example.org", subject: "Friday" })).toMatchObject({
      text: "Drafted a mail to ines@example.org. It waits for you in Mail; I never send",
      found: [{ label: "Friday", to: { kind: "waiting" } }],
    });
    expect(stepOf("create_event", "output-available", { title: "Dashboard review", date: "2026-10-16", startMin: 900 }, { success: true })).toMatchObject({
      text: "Put “Dashboard review” on Fri 16 Oct at 15:00",
      found: [{ label: "Fri 16 Oct", to: { kind: "day", date: "2026-10-16" } }],
    });
  });

  it("leads a new project to its page by its tag", () => {
    expect(stepOf("create_project", "output-available", { name: "Lisbon trip" }, { success: true, key: "project/lisbon-trip", noteId: "n-9" }).found).toEqual([
      { label: "Lisbon trip", to: { kind: "project", slug: "lisbon-trip" } },
    ]);
  });

  it("names the people a relation lookup found once each", () => {
    const step = stepOf(
      "get_relations",
      "output-available",
      { entity: "Thijs" },
      {
        entity: { id: "p", title: "Thijs Brouwer" },
        relations: [
          { relation: "works_at", to: [{ id: "c", title: "Kade Social" }] },
          { relation: "involved_in", to: [{ id: "t", title: "Graduation thesis" }, { id: "c", title: "Kade Social" }] },
        ],
      },
    );
    expect(step.text).toBe("Looked up everything connected to Thijs Brouwer");
    expect(step.found.map((f) => f.label)).toEqual(["Kade Social", "Graduation thesis"]);
  });
});
