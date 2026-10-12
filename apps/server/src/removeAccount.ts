/**
 * Remove one account and everything that is its alone, in one transaction —
 * the writing half of `pnpm --dir apps/server remove-user` (remove-user.ts
 * says what happens to each kind of reference). The vault is not touched,
 * and the username is retired (usernames.ts): `Personal/<username>/` stays on
 * disk and is permissioned by that name, so nobody may sign up as it again.
 */
import { eq } from "drizzle-orm";
import { tables, type Db } from "./db.js";
import { retireUsername } from "./usernames.js";

export function removeAccount(db: Db, user: { id: string; username: string }): void {
  // One transaction: a half-removed account is worse than either outcome.
  db.transaction((tx) => {
    tx.update(tables.taskObjects).set({ assigneeId: null }).where(eq(tables.taskObjects.assigneeId, user.id)).run();
    tx.update(tables.ydocUpdates).set({ authorId: null }).where(eq(tables.ydocUpdates.authorId, user.id)).run();
    tx.delete(tables.memberships).where(eq(tables.memberships.userId, user.id)).run();
    tx.delete(tables.apiTokens).where(eq(tables.apiTokens.userId, user.id)).run();
    tx.delete(tables.webauthnCredentials).where(eq(tables.webauthnCredentials.userId, user.id)).run();
    tx.delete(tables.sessions).where(eq(tables.sessions.userId, user.id)).run();
    tx.delete(tables.webauthnChallenges).where(eq(tables.webauthnChallenges.userId, user.id)).run();
    tx.delete(tables.icsFeeds).where(eq(tables.icsFeeds.ownerId, user.id)).run();
    tx.delete(tables.webhooks).where(eq(tables.webhooks.ownerId, user.id)).run();
    tx.delete(tables.events).where(eq(tables.events.ownerId, user.id)).run();
    tx.delete(tables.mailAccounts).where(eq(tables.mailAccounts.userId, user.id)).run();
    tx.delete(tables.mailDrafts).where(eq(tables.mailDrafts.userId, user.id)).run();
    tx.delete(tables.invites).where(eq(tables.invites.createdBy, user.id)).run();
    tx.delete(tables.taskComments).where(eq(tables.taskComments.authorId, user.id)).run();
    tx.delete(tables.users).where(eq(tables.users.id, user.id)).run();
    retireUsername(tx, user.username);
  });
}
