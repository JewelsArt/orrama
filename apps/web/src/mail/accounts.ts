/**
 * More than one mail account (N1). A message is known by its account and its uid (a uid is only
 * a place in one mailbox: uid 7 is a different message in each). Its address says both:
 * `/mail/<account>.<uid>`, where `<account>` is the account's id without its `mail-`; a bare
 * `/mail/<uid>` is the default account's, as every address was when there was one account, so
 * old links and the first account read as before.
 *
 * How the inbox reads is the person's choice on this device (Jules, 24 Nov: "both available at
 * choice"): one list for every account, each row saying its account, with a filter to one
 * (`merged`, the default); or one account at a time (`single`).
 */
import type { MailAccountRow } from "@orrama/schema/responses";
import { readKey, writeKey } from "../storage.js";

export interface MessageRef {
  account: string;
  uid: number;
}

const short = (id: string) => id.replace(/^mail-/, "");

/** The part of a message's address after /mail/, for a message whose account is known. */
export const messageKey = (m: { uid: number; account?: string | null }, defaultId?: string): string =>
  !m.account || m.account === defaultId ? String(m.uid) : `${short(m.account)}.${m.uid}`;

/** Which message an address names, among these accounts; null when it names none of them. */
export function messageOf(key: string | undefined, accounts: { id: string }[], defaultId: string | undefined): MessageRef | null {
  if (!key) return null;
  if (/^\d+$/.test(key)) return defaultId ? { account: defaultId, uid: Number(key) } : null;
  const m = /^(.+)\.(\d+)$/.exec(key);
  if (!m) return null;
  const a = accounts.find((x) => x.id === m[1] || short(x.id) === m[1]);
  return a && Number(m[2]) > 0 ? { account: a.id, uid: Number(m[2]) } : null;
}

export const sameMessage = (a: MessageRef | null, b: { uid: number; account: string } | null) => !!a && !!b && a.uid === b.uid && a.account === b.account;

/** The default account's id in an inbox answer: whose messages keep the short /mail/<uid>. */
export const inboxDefault = (r: { accounts?: { id: string; isDefault: boolean }[] } | null | undefined): string | undefined => r?.accounts?.find((a) => a.isDefault)?.id;

/** The account new mail goes from. */
export const defaultAccount = (accounts: MailAccountRow[]): MailAccountRow | undefined => accounts.find((a) => a.isDefault) ?? accounts[0];

/* ---- how the inbox reads, on this device ------------------------------------------------- */

export type InboxView = "merged" | "single";
export const VIEW_KEY = "orrama-mail-inbox";
export const FILTER_KEY = "orrama-mail-account";

export const readView = (): InboxView => (readKey(VIEW_KEY) === "single" ? "single" : "merged");
export const writeView = (v: InboxView) => writeKey(VIEW_KEY, v);

/**
 * The account the list shows: an account id, or "all". One account at a time never shows "all";
 * an account that's gone falls back to all (merged) or the default (single).
 */
export function shownAccount(stored: string | null, accounts: MailAccountRow[], view: InboxView): string {
  const known = stored && accounts.some((a) => a.id === stored) ? stored : null;
  if (view === "merged") return accounts.length > 1 && known ? known : "all";
  return known ?? defaultAccount(accounts)?.id ?? "all";
}

/** Whether rows say their account: only when several accounts are shown together. */
export const rowsSayAccount = (shown: string, accounts: MailAccountRow[]) => shown === "all" && accounts.length > 1;
