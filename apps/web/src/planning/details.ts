/**
 * What a subscribed calendar's card shows besides the time: the call to join, the place and the
 * description, from `details` on the occurrence (`apps/server/src/ics.ts` reads them off the feed).
 *
 * The feed is untrusted input. The server already sends text only and drops links that are not
 * http(s); this checks again, because a link is the one thing here a click acts on: only an
 * http(s) address becomes an anchor, and the description is text with its addresses linked,
 * never markup.
 */
import type { CalEvent } from "@orrama/schema/responses";
import { plainLines, type PlainLine } from "../mail/plainText.js";

/** The address as given when it is http(s), else null (javascript:, data:, anything else). */
export function webLink(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}

/** The join button's words: the service when it is one we know. */
export function joinLabel(url: string): string {
  const host = new URL(url).hostname;
  if (host === "meet.google.com") return "Join Google Meet";
  if (/(^|\.)teams\.(microsoft|live)\.com$/.test(host)) return "Join Teams meeting";
  if (/(^|\.)zoom\.us$/.test(host)) return "Join Zoom meeting";
  return "Join meeting";
}

/** A place on the map. A location that names a call rather than a place is not one. */
const NOT_A_PLACE = /^(microsoft teams( meeting)?|teams|google meet|zoom( meeting)?|online|virtual|phone call)$/i;
export const mapsLink = (place: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;

export type Place = { kind: "map"; text: string; href: string } | { kind: "text"; parts: PlainLine };

export interface CardDetails {
  join: { href: string; label: string } | null;
  place: Place | null;
  /** The description's lines, its http(s) addresses as links (shown by their host). */
  lines: PlainLine[];
  /** The event's own page, when the feed gives one. */
  page: { href: string; label: string } | null;
}

const hostOf = (url: string) => new URL(url).host.replace(/^www\./, "");

export function cardDetails(ev: CalEvent | undefined): CardDetails | null {
  const d = ev?.details;
  if (!d) return null;
  const conference = webLink(d.conference);
  let place: Place | null = null;
  if (d.location) {
    const parts = plainLines(d.location)[0] ?? [];
    const links = parts.filter((p) => typeof p !== "string");
    if (links.length > 0) {
      // A location that is only the call's own address says nothing the button does not.
      const words = parts.filter((p) => typeof p === "string" && p.trim()).length;
      if (!(words === 0 && links.length === 1 && links[0]!.href === conference)) place = { kind: "text", parts };
    } else {
      place = NOT_A_PLACE.test(d.location.trim()) ? { kind: "text", parts: [d.location] } : { kind: "map", text: d.location, href: mapsLink(d.location) };
    }
  }
  const url = webLink(d.url);
  return {
    join: conference ? { href: conference, label: joinLabel(conference) } : null,
    place,
    lines: d.description ? plainLines(d.description) : [],
    page: url && url !== conference ? { href: url, label: hostOf(url) } : null,
  };
}
