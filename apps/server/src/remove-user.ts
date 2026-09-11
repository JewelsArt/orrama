/**
 * remove-user.ts - delete an account and everything attached to it.
 *
 *   pnpm --dir apps/server remove-user
 *
 * Written for the demo accounts. `seed` creates jules/erin/mara @basalt.dev with
 * the password "basalt-demo", which is printed in this repo; anyone who seeded to
 * look around and then kept the install is running with public credentials on
 * their own notes. Deleting the row by hand is not enough - fifteen columns
 * across the schema hold a user id, and a bare DELETE leaves every one dangling.
 *
 * What happens to each kind of reference:
 *
 *   deleted   memberships, api tokens, WebAuthn credentials, ICS feeds,
 *             webhooks, mail account + drafts, owned events, invites they
 *             created, comments they wrote - all of it is theirs alone
 *   unlinked  task assignments (the task stays, it just becomes unassigned) and
 *             Y.Doc edit authorship (the history stays, anonymised)
 *   untouched THE VAULT. Personal/<username>/ is reported and left alone. Those
 *             are real Markdown files, possibly in a shared Obsidian vault, and
 *             deleting notes is not what "remove an account" should mean.
 */
import { eq } from "drizzle-orm";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { createDb, tables } from "./db.js";
import { vaultDir } from "./env.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

function bail(message: string): never {
  console.error(message);
  rl.close();
  process.exit(1);
}

async function main(): Promise<void> {
  const db = createDb();
  const users = db.select().from(tables.users).all();
  if (users.length === 0) bail("No accounts in this database.");
  if (users.length === 1) bail("Only one account exists. Removing it would lock you out of your own vault.");

  console.log("\nAccounts:\n");
  users.forEach((u, i) => {
    console.log(`  ${i + 1}. ${u.email}  (${u.displayName}${u.isOwner ? ", owner" : ""})`);
  });

  const pick = await ask(`\nRemove which account? [1-${users.length}] `);
  const user = users[Number(pick) - 1];
  if (!user) bail("No such account.");

  // An owner-less workspace has nobody who can grant folder access again.
  if (user.isOwner && users.filter((u) => u.isOwner).length === 1) {
    bail(`\n${user.email} is the only owner. Make another account an owner first, or this workspace becomes ungovernable.`);
  }

  const count = (rows: unknown[]) => rows.length;
  const owned = {
    memberships: count(db.select().from(tables.memberships).where(eq(tables.memberships.userId, user.id)).all()),
    apiTokens: count(db.select().from(tables.apiTokens).where(eq(tables.apiTokens.userId, user.id)).all()),
    passkeys: count(
      db.select().from(tables.webauthnCredentials).where(eq(tables.webauthnCredentials.userId, user.id)).all(),
    ),
    icsFeeds: count(db.select().from(tables.icsFeeds).where(eq(tables.icsFeeds.ownerId, user.id)).all()),
    webhooks: count(db.select().from(tables.webhooks).where(eq(tables.webhooks.ownerId, user.id)).all()),
    events: count(db.select().from(tables.events).where(eq(tables.events.ownerId, user.id)).all()),
    mailAccounts: count(db.select().from(tables.mailAccounts).where(eq(tables.mailAccounts.userId, user.id)).all()),
    mailDrafts: count(db.select().from(tables.mailDrafts).where(eq(tables.mailDrafts.userId, user.id)).all()),
    invites: count(db.select().from(tables.invites).where(eq(tables.invites.createdBy, user.id)).all()),
    comments: count(db.select().from(tables.taskComments).where(eq(tables.taskComments.authorId, user.id)).all()),
  };
  const assigned = count(db.select().from(tables.taskObjects).where(eq(tables.taskObjects.assigneeId, user.id)).all());

  console.log(`\nRemoving ${user.email} will DELETE:\n`);
  let anything = false;
  for (const [label, n] of Object.entries(owned)) {
    if (n > 0) {
      console.log(`  ${String(n).padStart(4)}  ${label}`);
      anything = true;
    }
  }
  if (!anything) console.log("     -  nothing but the account row itself");

  if (assigned > 0) console.log(`\n  ${assigned} task(s) assigned to them will be UNASSIGNED, not deleted.`);

  // The vault is files on disk, very possibly the same folder Obsidian has open.
  const personal = path.join(vaultDir(), "Personal", user.username);
  if (fs.existsSync(personal)) {
    const notes = fs.readdirSync(personal, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".md"));
    console.log(`\n  Their personal vault folder is LEFT ALONE:`);
    console.log(`    ${personal}  (${notes.length} note${notes.length === 1 ? "" : "s"})`);
    console.log(`    Delete it yourself if you want it gone - these are real files.`);
  }

  const confirm = await ask(`\nType the email to confirm: `);
  if (confirm.trim().toLowerCase() !== user.email.toLowerCase()) {
    bail("Did not match. Nothing was changed.");
  }

  // One transaction: a half-removed account is worse than either outcome.
  db.transaction((tx) => {
    tx.update(tables.taskObjects).set({ assigneeId: null }).where(eq(tables.taskObjects.assigneeId, user.id)).run();
    tx.update(tables.ydocUpdates).set({ authorId: null }).where(eq(tables.ydocUpdates.authorId, user.id)).run();
    tx.delete(tables.memberships).where(eq(tables.memberships.userId, user.id)).run();
    tx.delete(tables.apiTokens).where(eq(tables.apiTokens.userId, user.id)).run();
    tx.delete(tables.webauthnCredentials).where(eq(tables.webauthnCredentials.userId, user.id)).run();
    tx.delete(tables.webauthnChallenges).where(eq(tables.webauthnChallenges.userId, user.id)).run();
    tx.delete(tables.icsFeeds).where(eq(tables.icsFeeds.ownerId, user.id)).run();
    tx.delete(tables.webhooks).where(eq(tables.webhooks.ownerId, user.id)).run();
    tx.delete(tables.events).where(eq(tables.events.ownerId, user.id)).run();
    tx.delete(tables.mailAccounts).where(eq(tables.mailAccounts.userId, user.id)).run();
    tx.delete(tables.mailDrafts).where(eq(tables.mailDrafts.userId, user.id)).run();
    tx.delete(tables.invites).where(eq(tables.invites.createdBy, user.id)).run();
    tx.delete(tables.taskComments).where(eq(tables.taskComments.authorId, user.id)).run();
    tx.delete(tables.users).where(eq(tables.users.id, user.id)).run();
  });

  console.log(`\nRemoved ${user.email}.`);
  console.log("Any session token they still hold stops working on its next request.\n");
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
