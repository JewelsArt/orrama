import { describe, expect, it } from "vitest";
import { newContext } from "./context.js";

const THU = new Date(2026, 9, 8, 10); // Thursday 8 October 2026

describe("New, prefilled for the page you are on", () => {
  it("on a project: a step in it, and a note in its folder that joins it", () => {
    expect(newContext({ kind: "project", slug: "graduation-thesis", tab: "todo" }, THU)).toMatchObject({
      task: { project: "graduation-thesis" },
      note: { folder: "04-Projects/graduation-thesis/", project: "graduation-thesis" },
    });
  });

  it("in Planning: the day shown, or today when the week or month shown holds it, else its first day", () => {
    expect(newContext({ kind: "planning", scale: "day", at: "2026-10-16" }, THU)).toMatchObject({ task: { due: "2026-10-16" }, event: { date: "2026-10-16" } });
    expect(newContext({ kind: "planning", scale: "week" }, THU).event.date).toBe("2026-10-08");
    expect(newContext({ kind: "planning", scale: "week", at: "2026-10-12" }, THU).event.date).toBe("2026-10-12");
    expect(newContext({ kind: "planning", scale: "week", at: "2026-W43" }, THU).event.date).toBe("2026-10-19");
    expect(newContext({ kind: "planning", scale: "month", at: "2026-10" }, THU).event.date).toBe("2026-10-08");
    expect(newContext({ kind: "planning", scale: "month", at: "2026-12" }, THU).event.date).toBe("2026-12-01");
  });

  it("in Notes: the open note's folder", () => {
    expect(newContext({ kind: "notes", path: "Shared/Meetings/Weekly meetings" }, THU).note).toEqual({ folder: "Shared/Meetings/" });
    expect(newContext({ kind: "notes", path: "Welcome" }, THU).note).toEqual({ folder: "" });
    expect(newContext({ kind: "notes" }, THU).note).toEqual({ folder: "" });
  });

  it("on the board filtered to an area: that area's domain for a project", () => {
    expect(newContext({ kind: "projects", area: "school" }, THU).project).toEqual({ domain: "academic" });
    expect(newContext({ kind: "projects" }, THU).project).toEqual({ domain: undefined });
  });

  it("elsewhere: a task to the inbox, an event today", () => {
    expect(newContext({ kind: "mail" }, THU)).toEqual({ task: {}, note: { folder: "" }, event: { date: "2026-10-08" }, project: {} });
  });
});
