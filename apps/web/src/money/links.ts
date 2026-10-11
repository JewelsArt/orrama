/**
 * Money's addresses (structure.md §1.2), and links to them. Everything you can see is a link to
 * where it leads (§1.7): a real href, so ⌘-click and "copy link" work, and a plain click that the
 * app handles without a reload.
 *
 *   /money                              the overview, this month (?month=2026-09 another)
 *   /money/spending                     all spending, every month (?month= one month in full)
 *   /money/spending/<category>          a category (?month= the month open below its chart)
 *   /money/spending/<category>/<shop>   a shop, reached from that category
 *   /money/spending?merchant=<shop>     a shop, reached from anywhere else
 *   /money/subscriptions, /income       the ledgers (?month= the calendar's month)
 *   /money/savings, /money/documents
 */
import type { MouseEvent } from "react";
import { navigate, routeHref, type Route } from "../ui/router.js";

export type MoneyRoute = Extract<Route, { kind: "money" }>;

export const to = {
  overview: (month?: string): MoneyRoute => (month ? { kind: "money", month } : { kind: "money" }),
  spending: (month?: string): MoneyRoute => (month ? { kind: "money", page: "spending", month } : { kind: "money", page: "spending" }),
  category: (category: string, month?: string): MoneyRoute => (month ? { kind: "money", page: "spending", category, month } : { kind: "money", page: "spending", category }),
  merchant: (merchant: string, category?: string): MoneyRoute => (category ? { kind: "money", page: "spending", category, merchant } : { kind: "money", page: "spending", merchant }),
  page: (page: "subscriptions" | "income" | "savings" | "documents", month?: string): MoneyRoute => (month ? { kind: "money", page, month } : { kind: "money", page }),
};

const plain = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** Props for an <a> that goes to a route: `<a {...link(r)}>`. */
export const link = (r: Route) => ({
  href: routeHref(r),
  onClick: (e: MouseEvent) => {
    if (!plain(e)) return;
    e.preventDefault();
    navigate(r);
  },
});
