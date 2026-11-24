import { describe, expect, it } from "vitest";
import type { MailAccountRow } from "@orrama/schema/responses";
import { messageKey, messageOf, rowsSayAccount, shownAccount } from "./accounts.js";

const acct = (id: string, isDefault = false): MailAccountRow => ({ id, email: `${id}@example.com`, label: id, isDefault, imapHost: "imap.example.com", lastCheckedAt: null, lastError: null });
const ACCOUNTS = [acct("mail-1a2b", true), acct("mail-9f8e"), acct("ma-1")];

describe("a message's address", () => {
  it("the default account's messages keep /mail/<uid>; another's say their account", () => {
    expect(messageKey({ uid: 42, account: "mail-1a2b" }, "mail-1a2b")).toBe("42");
    expect(messageKey({ uid: 42, account: "mail-9f8e" }, "mail-1a2b")).toBe("9f8e.42");
    expect(messageKey({ uid: 42, account: "ma-1" }, "mail-1a2b")).toBe("ma-1.42");
    expect(messageKey({ uid: 42 })).toBe("42");
  });

  it("reads back to the account and the uid, and names nothing it doesn't know", () => {
    expect(messageOf("42", ACCOUNTS, "mail-1a2b")).toEqual({ account: "mail-1a2b", uid: 42 });
    expect(messageOf("9f8e.42", ACCOUNTS, "mail-1a2b")).toEqual({ account: "mail-9f8e", uid: 42 });
    expect(messageOf("mail-9f8e.42", ACCOUNTS, "mail-1a2b")).toEqual({ account: "mail-9f8e", uid: 42 });
    expect(messageOf("ma-1.7", ACCOUNTS, "mail-1a2b")).toEqual({ account: "ma-1", uid: 7 });
    expect(messageOf("gone.42", ACCOUNTS, "mail-1a2b")).toBe(null);
    expect(messageOf("9f8e.0", ACCOUNTS, "mail-1a2b")).toBe(null);
    expect(messageOf("waiting", ACCOUNTS, "mail-1a2b")).toBe(null);
    expect(messageOf(undefined, ACCOUNTS, "mail-1a2b")).toBe(null);
    for (const m of [{ uid: 5, account: "mail-1a2b" }, { uid: 5, account: "mail-9f8e" }, { uid: 5, account: "ma-1" }]) expect(messageOf(messageKey(m, "mail-1a2b"), ACCOUNTS, "mail-1a2b")).toEqual(m);
  });
});

describe("which account the list shows", () => {
  it("one list: all, or the one picked while it still exists", () => {
    expect(shownAccount(null, ACCOUNTS, "merged")).toBe("all");
    expect(shownAccount("mail-9f8e", ACCOUNTS, "merged")).toBe("mail-9f8e");
    expect(shownAccount("mail-gone", ACCOUNTS, "merged")).toBe("all");
    expect(shownAccount("mail-1a2b", ACCOUNTS.slice(0, 1), "merged")).toBe("all");
  });

  it("one at a time: never all; the default when nothing (or something gone) was picked", () => {
    expect(shownAccount(null, ACCOUNTS, "single")).toBe("mail-1a2b");
    expect(shownAccount("all", ACCOUNTS, "single")).toBe("mail-1a2b");
    expect(shownAccount("mail-gone", ACCOUNTS, "single")).toBe("mail-1a2b");
    expect(shownAccount("ma-1", ACCOUNTS, "single")).toBe("ma-1");
  });

  it("rows say their account only when several are shown together", () => {
    expect(rowsSayAccount("all", ACCOUNTS)).toBe(true);
    expect(rowsSayAccount("ma-1", ACCOUNTS)).toBe(false);
    expect(rowsSayAccount("all", ACCOUNTS.slice(0, 1))).toBe(false);
  });
});
