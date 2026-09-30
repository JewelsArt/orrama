import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { tables } from "@basalt/schema";
import { dbPath, env } from "./env.js";

export type Db = ReturnType<typeof createDb>;

/**
 * Plain SQL bootstrap instead of drizzle-kit migrations: the schema is small and a
 * single-container self-host must come up from an empty volume with zero steps.
 */
const BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  ai_provider TEXT, ai_key_encrypted TEXT, ai_model TEXT, ai_instructions TEXT, ai_base_url TEXT
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  color TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '●'
);
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, team_id TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS membership_unique ON memberships (user_id, team_id);
CREATE TABLE IF NOT EXISTS folder_grants (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, folder TEXT NOT NULL, role TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS grant_unique ON folder_grants (team_id, folder);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  content_hash TEXT NOT NULL, mtime_ms INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ydoc_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL, "update" TEXT NOT NULL,
  author_id TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ydoc_updates_note ON ydoc_updates (note_id);
CREATE TABLE IF NOT EXISTS task_objects (
  id TEXT PRIMARY KEY, note_id TEXT NOT NULL, block_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo', assignee_id TEXT, due TEXT,
  description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS task_object_unique ON task_objects (note_id, block_id);
CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author_id TEXT NOT NULL,
  body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT,
  label TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY, user_id TEXT, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY, team_ids TEXT NOT NULL, created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL, used_by TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, team_id TEXT, domain TEXT, hidden INTEGER
);
CREATE TABLE IF NOT EXISTS task_blocks (
  id TEXT PRIMARY KEY, task_object_id TEXT NOT NULL, date TEXT NOT NULL,
  start_min INTEGER NOT NULL, duration_min INTEGER NOT NULL, created_at INTEGER NOT NULL,
  cal_note_id TEXT
);
CREATE INDEX IF NOT EXISTS task_blocks_date ON task_blocks (date);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, date TEXT NOT NULL,
  start_min INTEGER NOT NULL, duration_min INTEGER NOT NULL, created_at INTEGER NOT NULL,
  cal_note_id TEXT
);
CREATE INDEX IF NOT EXISTS events_date ON events (date);
CREATE TABLE IF NOT EXISTS ics_feeds (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, label TEXT NOT NULL, url_encrypted TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_synced_at INTEGER, last_error TEXT
);
CREATE TABLE IF NOT EXISTS mail_accounts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
  imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL,
  smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL,
  password_encrypted TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_checked_at INTEGER, last_error TEXT
);
CREATE TABLE IF NOT EXISTS mail_drafts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, "to" TEXT NOT NULL,
  subject TEXT NOT NULL, body TEXT NOT NULL,
  in_reply_to TEXT, "references" TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_drafts_user ON mail_drafts (user_id);
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_used_at INTEGER
);
-- One-shot data migrations that must not run twice (see migrations.ts).
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
  events TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, last_status INTEGER, last_fired_at INTEGER
);
`;

/**
 * Bumped whenever BOOTSTRAP or the ALTERs below change the schema; stored in
 * PRAGMA user_version. A database from a NEWER build refuses to open, so a
 * rollback cannot quietly run over columns it has never heard of.
 *   1  — cal_note_id on task_blocks/events, the meta table (Sep 2026).
 */
export const SCHEMA_VERSION = 1;

export function createDb(file = dbPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  // Wait for a lock instead of failing at once: the server, a `pnpm account`
  // script and a backup can all hold this file. better-sqlite3 already
  // defaults to 5 s (its `timeout` option); stated here so it is not lost if
  // the driver or its options ever change. (Plain SQLite's default is 0.)
  sqlite.pragma("busy_timeout = 5000");
  const onDisk = Number(sqlite.pragma("user_version", { simple: true }));
  if (onDisk > SCHEMA_VERSION) {
    sqlite.close();
    throw new Error(
      `${file} was written by a newer Basalt (schema ${onDisk}; this build knows ${SCHEMA_VERSION}). ` +
        "Running older code over it could drop what it does not know — update Basalt, or restore a backup.",
    );
  }
  sqlite.exec(BOOTSTRAP);
  // Additive migrations for existing volumes; ALTER is a no-op error when present.
  try {
    sqlite.exec(`ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT 'basalt'`);
  } catch {
    /* column exists */
  }
  try {
    sqlite.exec(`ALTER TABLE task_objects ADD COLUMN planned_date TEXT`);
  } catch {
    /* column exists */
  }
  try {
    sqlite.exec(`ALTER TABLE users ADD COLUMN ics_token TEXT`);
  } catch {
    /* column exists */
  }
  try {
    sqlite.exec(`ALTER TABLE users ADD COLUMN appearance TEXT`);
  } catch {
    /* column exists */
  }
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN domain TEXT`);
  } catch {
    /* column exists */
  }
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN hidden INTEGER`);
  } catch {
    /* column exists */
  }
  try {
    sqlite.exec(`ALTER TABLE workspace ADD COLUMN ai_instructions TEXT`);
  } catch {
    /* column exists */
  }
  try {
    sqlite.exec(`ALTER TABLE workspace ADD COLUMN ai_base_url TEXT`);
  } catch {
    /* column exists */
  }
  for (const sql of [
    // The calendar note a block/event row was read from (calendarNotes.ts).
    `ALTER TABLE task_blocks ADD COLUMN cal_note_id TEXT`,
    `ALTER TABLE events ADD COLUMN cal_note_id TEXT`,
    `ALTER TABLE users ADD COLUMN passcode_hash TEXT`,
    `ALTER TABLE users ADD COLUMN passcode_fails INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN passcode_locked_until INTEGER`,
  ]) {
    try {
      sqlite.exec(sql);
    } catch {
      /* column exists */
    }
  }
  sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
  return drizzle(sqlite, { schema: tables });
}

export { tables };
export function dataDirs(): void {
  fs.mkdirSync(path.join(env.dataDir, "vault"), { recursive: true });
}
