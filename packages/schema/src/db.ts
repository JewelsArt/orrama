/**
 * Drizzle table definitions (SQLite default self-host; Postgres option later).
 * The DB is an index + task-object store — the vault's Markdown files on disk
 * remain the source of truth for all content (spec §6: delete the DB, re-index,
 * and everything but task-object extras must rebuild).
 */
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  isOwner: integer("is_owner", { mode: "boolean" }).notNull().default(false),
  /** Chosen character id (see apps/web avatars) — a face, not a photo. */
  avatar: text("avatar").notNull().default("basalt"),
  /** Secret for the user's outbound ICS feed URL (null = feed disabled). */
  icsToken: text("ics_token"),
  createdAt: integer("created_at").notNull(),
});

export const workspace = sqliteTable("workspace", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // AI config (spec §9): BYO key, stored encrypted at rest on the admin's server.
  aiProvider: text("ai_provider"), // "anthropic" | "openai-compatible"
  aiKeyEncrypted: text("ai_key_encrypted"),
  aiModel: text("ai_model"),
  aiInstructions: text("ai_instructions"), // owner's custom "how to act" prompt, appended to the built-in app guide
});

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  /** URL/tag-safe slug — what #only/<team> and #share/<team> match. */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  color: text("color").notNull(),
  icon: text("icon").notNull().default("●"),
});

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    teamId: text("team_id").notNull(),
  },
  (t) => [uniqueIndex("membership_unique").on(t.userId, t.teamId)],
);

export const folderGrants = sqliteTable(
  "folder_grants",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    folder: text("folder").notNull(), // vault-relative, "" = root
    role: text("role", { enum: ["viewer", "editor", "admin"] }).notNull(),
  },
  (t) => [uniqueIndex("grant_unique").on(t.teamId, t.folder)],
);

/** Metadata mirror of vault files; content lives on disk + in the Y.Doc update log. */
export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(), // stable note id (front-matter)
  path: text("path").notNull().unique(),
  title: text("title").notNull(),
  contentHash: text("content_hash").notNull(),
  mtimeMs: integer("mtime_ms").notNull(),
  deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
});

/** Per-note CRDT update log → version history + live merge (spec §10). */
export const ydocUpdates = sqliteTable("ydoc_updates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  noteId: text("note_id").notNull(),
  update: text("update").notNull(), // base64 Yjs update
  authorId: text("author_id"),
  createdAt: integer("created_at").notNull(),
});

/** Promoted task objects (spec §7.2), keyed by (note id, block id). */
export const taskObjects = sqliteTable(
  "task_objects",
  {
    id: text("id").primaryKey(),
    noteId: text("note_id").notNull(),
    blockId: text("block_id").notNull(),
    status: text("status", { enum: ["todo", "in-progress", "done", "blocked", "orphaned"] })
      .notNull()
      .default("todo"),
    assigneeId: text("assignee_id"),
    due: text("due"),
    /** Day the assignee planned it onto their calendar (drag-drop in Planning). */
    plannedDate: text("planned_date"),
    description: text("description").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("task_object_unique").on(t.noteId, t.blockId)],
);

export const taskComments = sqliteTable("task_comments", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  authorId: text("author_id").notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
});

/**
 * Calendar blocks: a promoted task can occupy several time slots across the
 * week — drop 2h today, the remaining hours stay in the backlog for later.
 */
export const taskBlocks = sqliteTable("task_blocks", {
  id: text("id").primaryKey(),
  taskObjectId: text("task_object_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD
  startMin: integer("start_min").notNull(), // minutes from midnight
  durationMin: integer("duration_min").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** Calendar events (meetings etc.) — personal, created by clicking a slot. */
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  date: text("date").notNull(),
  startMin: integer("start_min").notNull(),
  durationMin: integer("duration_min").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const invites = sqliteTable("invites", {
  token: text("token").primaryKey(),
  teamIds: text("team_ids").notNull(), // JSON array of team ids
  createdBy: text("created_by").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedBy: text("used_by"),
});

/**
 * Subscribed external calendars (Google "secret address", Outlook, uni
 * timetables). The URL is a credential — encrypted at rest like the AI key.
 * Events are fetched on demand, never stored: the feed stays the source of truth.
 */
export const icsFeeds = sqliteTable("ics_feeds", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  label: text("label").notNull(),
  urlEncrypted: text("url_encrypted").notNull(),
  createdAt: integer("created_at").notNull(),
  lastSyncedAt: integer("last_synced_at"),
  lastError: text("last_error"),
});

/** Personal API tokens (`bslt_…`) — stored as a hash, shown once on creation. */
export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  label: text("label").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  /** First characters of the token, for recognizing it in the list. */
  prefix: text("prefix").notNull(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
});

/** Outgoing webhooks: HMAC-signed POSTs on vault activity the owner can read. */
export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  events: text("events").notNull(), // JSON array: "note.changed" | "task.completed"
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
  lastStatus: integer("last_status"),
  lastFiredAt: integer("last_fired_at"),
});

/** Projects: a folder or tag designated as the unit progress is computed against (spec §3). */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["folder", "tag"] }).notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  teamId: text("team_id"), // owning team for dashboard grouping (null = all teams)
  domain: text("domain"), // life-area for the Overview separation: personal | professional | academic
  hidden: integer("hidden"), // 1 = removed from the board; survives re-index (auto-sync respects it)
});
