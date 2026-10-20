/**
 * A subscribed calendar's card (feeds are untrusted input): the call, the place and the
 * description show, every link opens outside the app without an opener, and nothing in the
 * feed's text is ever markup.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { event } from "../test/planning-fixtures.js";
import { ItemPopover, type PopActions } from "./ItemPopover.js";
import type { Item } from "./model.js";

const actions: PopActions = {
  patch: async () => true,
  remove: async () => true,
  create: async () => true,
  openStep: () => {},
  openNote: () => {},
};

function open(details: NonNullable<Parameters<typeof event>[0]["details"]>) {
  const ev = event({ id: "ics-feed-1-0", date: "2026-10-21", title: "Weekly sync", source: "ics", readonly: true, feedLabel: "Jules Work", details });
  const item: Item = { id: `e:${ev.id}`, kind: "fd", date: ev.date, startMin: 600, durationMin: 60, title: ev.title, late: false, lane: "calendar", project: "Jules Work", allDay: false, event: ev };
  const anchor = document.createElement("button");
  document.body.append(anchor);
  render(<ItemPopover pop={{ kind: "item", item, anchor }} onClose={() => {}} actions={actions} />);
}

describe("a subscribed calendar's card", () => {
  it("shows the join button, the place and the description, every link opening outside", async () => {
    open({
      conference: "https://meet.google.com/abc-defg-hij",
      location: "Keizersgracht 123, Amsterdam",
      description: "Agenda: https://docs.google.com/document/d/abc\nBring the numbers.",
    });
    const join = await screen.findByRole("link", { name: "Join Google Meet" });
    expect(join.getAttribute("href")).toBe("https://meet.google.com/abc-defg-hij");
    const place = screen.getByRole("link", { name: "Keizersgracht 123, Amsterdam" });
    expect(place.getAttribute("href")).toMatch(/^https:\/\/www\.google\.com\/maps\/search\//);
    expect(screen.getByRole("link", { name: "docs.google.com" }).getAttribute("href")).toBe("https://docs.google.com/document/d/abc");
    expect(screen.getByText("Bring the numbers.")).toBeTruthy();
    for (const a of screen.getAllByRole("link")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("shows markup in the description as the text it is, and links nothing that is not http(s)", async () => {
    open({ description: '<img src=x onerror="window.pwned=1"> <a href="javascript:alert(1)">click</a> javascript:alert(1)', conference: "javascript:alert(1)" });
    const desc = await screen.findByText(/onerror/);
    expect(desc.textContent).toContain('<img src=x onerror="window.pwned=1">');
    expect(document.querySelector(".plan-pop img")).toBeNull();
    expect(screen.queryAllByRole("link")).toEqual([]);
  });
});
