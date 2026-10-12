/**
 * A username, once an account has had it, is never another account's.
 *
 * `Personal/<username>/` is permissioned by path (core acl.ts, rule 3), and a
 * calendar note names its owner by username (`calendar:`). Removing an
 * account leaves those files where they are — they are real Markdown, maybe
 * in a vault Obsidian has open — so the next person to sign up as `erin` read
 * and edited the former Erin's inbox, drafts and calendar (audit ACL-010).
 * The name is retired instead: removing an account (removeAccount.ts) or
 * renaming one (account.ts) records it in `meta`, and sign-up and renames
 * refuse a retired name. DB-only, like accounts themselves.
 */
import { eq } from "drizzle-orm";
import { tables, type Db } from "./db.js";

type Tx = Pick<Db, "select" | "insert">;
const key = (username: string) => `retired-username:${username.toLowerCase()}`;

export function retireUsername(db: Tx, username: string): void {
  db.insert(tables.meta).values({ key: key(username), value: new Date().toISOString() }).onConflictDoNothing().run();
}

export function usernameRetired(db: Pick<Db, "select">, username: string): boolean {
  return !!db.select().from(tables.meta).where(eq(tables.meta.key, key(username))).get();
}

/** What sign-up and the account script say about a retired name. */
export const RETIRED_USERNAME = "That username belonged to an account that was removed or renamed, and its personal notes still answer to it. Choose another.";
