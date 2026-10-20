/** A subscribed event's card: the call, the place and the description, links http(s) only. */
import { describe, expect, it } from "vitest";
import { event } from "../test/planning-fixtures.js";
import { cardDetails, joinLabel, mapsLink, webLink } from "./details.js";

const fd = (details: NonNullable<Parameters<typeof event>[0]["details"]>) =>
  event({ id: "ics-1", date: "2026-10-21", title: "Weekly sync", source: "ics", readonly: true, mine: true, feedLabel: "Jules Work", details });

describe("cardDetails", () => {
  it("a Google Meet event: the join button by its service, the address on the map, the words with their links", () => {
    const d = cardDetails(
      fd({
        conference: "https://meet.google.com/abc-defg-hij",
        location: "Scooperz, Keizersgracht 123, Amsterdam",
        description: "Agenda: https://docs.google.com/document/d/abc\n\nBring the numbers.",
      }),
    )!;
    expect(d.join).toEqual({ href: "https://meet.google.com/abc-defg-hij", label: "Join Google Meet" });
    expect(d.place).toEqual({ kind: "map", text: "Scooperz, Keizersgracht 123, Amsterdam", href: mapsLink("Scooperz, Keizersgracht 123, Amsterdam") });
    expect(d.place?.kind === "map" && d.place.href).toBe("https://www.google.com/maps/search/?api=1&query=Scooperz%2C%20Keizersgracht%20123%2C%20Amsterdam");
    expect(d.lines).toEqual([["Agenda: ", { href: "https://docs.google.com/document/d/abc", label: "docs.google.com" }], [], ["Bring the numbers."]]);
  });

  it("never makes a link of anything but http(s), even if the server let one through", () => {
    const d = cardDetails(fd({ conference: "javascript:alert(1)", url: "data:text/html,<b>x</b>", description: "javascript:alert(1) and data:text/html,x" }))!;
    expect(d.join).toBeNull();
    expect(d.page).toBeNull();
    expect(d.lines).toEqual([["javascript:alert(1) and data:text/html,x"]]);
  });

  it("a location that is an address of a call is a link to it, and says nothing when it is the call itself", () => {
    expect(cardDetails(fd({ location: "Zoom: https://acme.zoom.us/j/1" }))!.place).toEqual({ kind: "text", parts: ["Zoom: ", { href: "https://acme.zoom.us/j/1", label: "acme.zoom.us" }] });
    expect(cardDetails(fd({ location: "https://meet.google.com/abc-defg-hij", conference: "https://meet.google.com/abc-defg-hij" }))!.place).toBeNull();
  });

  it("a location that names a call rather than a place is not put on the map", () => {
    expect(cardDetails(fd({ location: "Microsoft Teams Meeting" }))!.place).toEqual({ kind: "text", parts: ["Microsoft Teams Meeting"] });
  });

  it("names the join button by the service it opens", () => {
    expect(joinLabel("https://teams.microsoft.com/l/meetup-join/x")).toBe("Join Teams meeting");
    expect(joinLabel("https://acme.zoom.us/j/1")).toBe("Join Zoom meeting");
    expect(joinLabel("https://whereby.com/room")).toBe("Join meeting");
  });

  it("an event without details has none", () => {
    expect(cardDetails(event({ id: "e1", date: "2026-10-21", title: "Dentist" }))).toBeNull();
    expect(webLink("ftp://x")).toBeNull();
  });
});
