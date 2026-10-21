/**
 * CLAUDE.md's "Still DB-only" list names everything a deleted database loses
 * (audit STO-009, REG-012 #13).
 *
 * It said comments, descriptions, assignees, planned dates, hidden flags and
 * "accounts/settings" — not note history, the only copy of overwritten text,
 * nor staged mail drafts. A reset or a "just rebuild it" shortcut written from
 * that list would have thrown both away. Every table db.ts creates is either
 * rebuilt from the vault or named in the list; a new table fails here until it
 * is one or the other.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const tables = [...fs.readFileSync(path.join(root, "apps/server/src/db.ts"), "utf8").matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);
const guide = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
const dbOnly = guide.split("**Still DB-only**")[1]!.split("`pnpm --dir apps/server export`")[0]!.replace(/\s+/g, " ");

/** Rebuilt from the vault on boot: an index of the files. */
const REBUILT = ["notes", "task_blocks", "events", "projects"];
/** Short-lived, nothing to lose. */
const EPHEMERAL = ["webauthn_challenges"];
/** What the list must say for each table only the database holds. */
const SAID: Record<string, RegExp> = {
  users: /accounts/,
  workspace: /AI settings and\s+key/,
  teams: /teams/,
  memberships: /memberships/,
  folder_grants: /folder grants/,
  ydoc_updates: /note history.*ydoc_updates/,
  task_objects: /descriptions.*assignee.*planned_date/,
  task_comments: /task comments/,
  webauthn_credentials: /passkeys/,
  invites: /invites/,
  ics_feeds: /calendar feeds/,
  mail_accounts: /mail account/,
  mail_drafts: /staged mail drafts/,
  api_tokens: /API tokens/,
  sessions: /sessions/,
  meta: /ChatGPT sign-in \(`meta`\)/,
  webhooks: /webhooks/,
};

describe("the DB-only list in CLAUDE.md", () => {
  it("accounts for every table", () => {
    expect(tables.length).toBeGreaterThan(15);
    expect(tables.filter((t) => !REBUILT.includes(t) && !EPHEMERAL.includes(t) && !SAID[t])).toEqual([]);
  });

  it("names what each DB-only table holds, history and drafts included", () => {
    for (const [table, words] of Object.entries(SAID)) expect(dbOnly, table).toMatch(words);
    expect(dbOnly).toMatch(/project's hidden flag/); // projects: rebuilt, except this
  });

  it("says plainly where history is seen (the note's History, 1C) and how to read it over the API", () => {
    expect(dbOnly).toMatch(/note's ⋯ →\s+History/);
    expect(dbOnly).toMatch(/\/api\/vault\/note\/:id\/history/);
  });
});
