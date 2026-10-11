/** Every address in structure.md §1.2 means what it says and is written back the same way. */
import { describe, expect, it } from "vitest";
import { isDeep, parseRoute, placeOf, routeHref, type Route } from "./router.js";

const parse = (href: string) => {
  const i = href.indexOf("?");
  return parseRoute(i < 0 ? href : href.slice(0, i), i < 0 ? "" : href.slice(i));
};

describe("addresses", () => {
  const ROUND_TRIPS: [string, Route][] = [
    ["/today", { kind: "today" }],
    ["/planning/week", { kind: "planning", scale: "week" }],
    ["/planning/week/2026-W41", { kind: "planning", scale: "week", at: "2026-W41" }],
    ["/planning/day/2026-10-08", { kind: "planning", scale: "day", at: "2026-10-08" }],
    ["/planning/month/2026-10", { kind: "planning", scale: "month", at: "2026-10" }],
    ["/notes", { kind: "notes" }],
    ["/notes/04-Projects/graduation-thesis/Graduation%20thesis", { kind: "notes", path: "04-Projects/graduation-thesis/Graduation thesis" }],
    ["/notes?id=n-abc123", { kind: "notes", id: "n-abc123" }],
    ["/notes/health", { kind: "notes-health" }],
    ["/orrery", { kind: "orrery" }],
    ["/orrery?center=ines-vermaat", { kind: "orrery", center: "ines-vermaat" }],
    ["/orrery?area=work", { kind: "orrery", area: "work" }],
    ["/orrery?topic=forecasting", { kind: "orrery", topic: "forecasting" }],
    ["/projects", { kind: "projects" }],
    ["/projects/graduation-thesis", { kind: "project", slug: "graduation-thesis" }],
    ["/projects/graduation-thesis/timeline", { kind: "project", slug: "graduation-thesis", tab: "timeline" }],
    ["/projects/graduation-thesis/documents", { kind: "project", slug: "graduation-thesis", tab: "documents" }],
    ["/projects/graduation-thesis/todo", { kind: "project", slug: "graduation-thesis", tab: "todo" }],
    ["/people", { kind: "people" }],
    ["/people?q=ines", { kind: "people", q: "ines" }],
    ["/people/ines-vermaat", { kind: "person", slug: "ines-vermaat" }],
    ["/companies/kade-social", { kind: "company", slug: "kade-social" }],
    ["/conversations/chat-about-the-board", { kind: "conversation", slug: "chat-about-the-board" }],
    ["/documents/04-Projects/thesis/files/brief.docx", { kind: "document", path: "04-Projects/thesis/files/brief.docx" }],
    ["/mail", { kind: "mail" }],
    ["/mail/abc-42", { kind: "mail", id: "abc-42" }],
    ["/mail/waiting", { kind: "mail", waiting: true }],
    ["/money", { kind: "money" }],
    ["/money?month=2026-10", { kind: "money", month: "2026-10" }],
    ["/money/spending", { kind: "money", page: "spending" }],
    ["/money/spending/Groceries", { kind: "money", page: "spending", category: "Groceries" }],
    ["/money/spending/Groceries/Albert%20Heijn", { kind: "money", page: "spending", category: "Groceries", merchant: "Albert Heijn" }],
    ["/money/spending/Shopping?month=2026-09", { kind: "money", page: "spending", category: "Shopping", month: "2026-09" }],
    ["/money?merchant=UNIQLO", { kind: "money", merchant: "UNIQLO" }],
    ["/money/documents", { kind: "money", page: "documents" }],
    ["/money/subscriptions", { kind: "money", page: "subscriptions" }],
    ["/money/income", { kind: "money", page: "income" }],
    ["/money/savings", { kind: "money", page: "savings" }],
    ["/settings", { kind: "settings" }],
    ["/settings/ai", { kind: "settings", section: "ai" }],
    ["/settings/you", { kind: "settings", section: "you" }],
  ];
  it.each(ROUND_TRIPS)("%s", (href, route) => {
    expect(parse(href)).toEqual(route);
    expect(routeHref(route)).toBe(href);
  });

  it("understands the short and old forms", () => {
    expect(parse("/")).toEqual({ kind: "today" });
    expect(parse("/planning")).toEqual({ kind: "planning", scale: "week" });
    expect(parse("/notes/map")).toEqual({ kind: "orrery" }); // the map left Notes
    expect(parse("/today/")).toEqual({ kind: "today" });
    expect(parse("/settings/nonsense")).toEqual({ kind: "settings" });
  });

  it("does not claim addresses it does not know", () => {
    expect(parse("/dashboard")).toBeNull();
    expect(parse("/conversations")).toBeNull();
  });

  it("puts every page under one of the eight places, Settings under none", () => {
    expect(placeOf({ kind: "project", slug: "x" })).toBe("projects");
    expect(placeOf({ kind: "company", slug: "x" })).toBe("people");
    expect(placeOf({ kind: "document", path: "x" })).toBe("notes");
    expect(placeOf({ kind: "settings" })).toBeNull();
  });

  it("knows a page deeper than its place's front page", () => {
    expect(isDeep({ kind: "today" })).toBe(false);
    expect(isDeep({ kind: "planning", scale: "week" })).toBe(false);
    expect(isDeep({ kind: "orrery", area: "work" })).toBe(false); // a filter, not a level
    expect(isDeep({ kind: "project", slug: "x" })).toBe(true);
    expect(isDeep({ kind: "money", page: "spending", category: "Groceries" })).toBe(true);
    expect(isDeep({ kind: "settings", section: "ai" })).toBe(true);
  });
});
