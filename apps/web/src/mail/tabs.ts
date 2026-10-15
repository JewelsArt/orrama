/**
 * The list's tabs: All, then Gmail's categories in Gmail's order. All is ours (Gmail's tabs hide
 * mail, and this inbox was one flat list before) and is the default; Primary is always offered,
 * because its absence reads as breakage rather than "no personal mail today". The other
 * categories appear once mail has landed in them. What doesn't fit goes into More (§2.8), so a
 * tab never scrolls All out of view.
 */
import type { InboxItem, MailCategory } from "@orrama/schema/responses";

export type MailTab = MailCategory | "all";

export const TAB_LABEL: Record<MailTab, string> = {
  all: "All",
  primary: "Primary",
  promotions: "Promotions",
  social: "Social",
  updates: "Updates",
  forums: "Forums",
};

const ORDER: MailTab[] = ["all", "primary", "promotions", "social", "updates", "forums"];

/** How many tabs sit in the row, before the strip has been measured. */
export const TABS_SHOWN = 4;

export interface TabInfo {
  id: MailTab;
  label: string;
  /** Unread messages in it. */
  unread: number;
}

export const inTab = (m: InboxItem, tab: MailTab) => tab === "all" || m.category === tab;

/** The tabs to offer for this inbox, in order, with their unread counts. */
export function mailTabs(messages: InboxItem[]): TabInfo[] {
  return ORDER.filter((id) => id === "all" || id === "primary" || messages.some((m) => m.category === id)).map((id) => ({
    id,
    label: TAB_LABEL[id],
    unread: messages.filter((m) => inTab(m, id) && !m.seen).length,
  }));
}

/**
 * How many tabs fit in `room` px, given each tab's width and More's (which holds the rest), with
 * `gap` between them. All of them when they all fit; null when nothing has been laid out yet
 * (every width 0), for the caller's default. Never fewer than one: All stays in view.
 */
export function fitTabs(widths: number[], moreWidth: number, room: number, gap = 0): number | null {
  if (widths.length === 0 || widths.every((w) => w === 0)) return null;
  const total = widths.reduce((a, w) => a + w + gap, 0);
  if (total <= room) return widths.length;
  let used = moreWidth;
  let n = 0;
  while (n < widths.length && used + gap + widths[n]! <= room) used += gap + widths[n++]!;
  return Math.max(1, n);
}

/**
 * The first `shown` tabs in the row, the rest in More. The current tab is always in the row: one
 * picked from More takes the row's last place, and the tab it displaces goes into More.
 */
export function splitTabs(tabs: TabInfo[], shown = TABS_SHOWN, current?: MailTab): { row: TabInfo[]; more: TabInfo[] } {
  const row = tabs.slice(0, shown);
  const more = tabs.slice(shown);
  const i = more.findIndex((t) => t.id === current);
  if (i < 0 || row.length < 2) return { row, more };
  const picked = more[i]!;
  const displaced = row[row.length - 1]!;
  return { row: [...row.slice(0, -1), picked], more: tabs.filter((t) => t === displaced || (more.includes(t) && t !== picked)) };
}

/** The stored tab, if this inbox still offers it; All otherwise. */
export function validTab(stored: string | null, tabs: TabInfo[]): MailTab {
  return tabs.some((t) => t.id === stored) ? (stored as MailTab) : "all";
}
