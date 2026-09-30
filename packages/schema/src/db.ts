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
  /** JSON: theme, colour-vision mode and hand-built palettes (appearanceSchema).
   *  On the account rather than in localStorage so a phone inherits the desk. */
  appearance: text("appearance"),
  /** Argon2 hash of the 4-digit quick-unlock passcode (null = not set up).
   *  A passcode is a convenience over an existing account, never a replacement
   *  for the password: four digits is 10k combinations, so what makes it safe
   *  is the server-side attempt counter below, not the secret itself. */
  passcodeHash: text("passcode_hash"),
  /** Consecutive failed unlock attempts. Reset on success or password login. */
  passcodeFails: integer("passcode_fails").notNull().default(0),
  /** Epoch ms until which unlock is refused after too many failures. */
  passcodeLockedUntil: integer("passcode_locked_until"),
  createdAt: integer("created_at").notNull(),
});

/**
 * WebAuthn credentials — Touch ID on a Mac, and any other platform
 * authenticator the browser exposes. One row per enrolled device: the same
 * account can be unlocked by a laptop's fingerprint reader and a phone.
 *
 * Stores only the PUBLIC key. The private key never leaves the secure enclave,
 * which is the whole point: a stolen database cannot produce a valid assertion.
 */
export const webauthnCredentials = sqliteTable("webauthn_credentials", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** Base64url credential id as returned by the authenticator. */
  credentialId: text("credential_id").notNull().unique(),
  publicKey: text("public_key").notNull(),
  /** Signature counter, for cloned-authenticator detection. */
  counter: integer("counter").notNull().default(0),
  /** JSON array of transports ("internal", "hybrid", ...) to hint the browser. */
  transports: text("transports"),
  /** What the user sees in Settings when deciding what to revoke. */
  label: text("label").notNull(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
});

/** Short-lived WebAuthn challenges, keyed by the id handed to the client. */
export const webauthnChallenges = sqliteTable("webauthn_challenges", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  challenge: text("challenge").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const workspace = sqliteTable("workspace", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // AI config (spec §9): BYO key, stored encrypted at rest on the admin's server.
  aiProvider: text("ai_provider"), // "anthropic" | "openai-compatible" | "google"
  aiKeyEncrypted: text("ai_key_encrypted"),
  aiModel: text("ai_model"),
  aiBaseUrl: text("ai_base_url"), // custom endpoint for the openai-compatible provider (e.g. Gemini's OpenAI-compat URL)
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
  /** The calendar note this row was read from; the note is the truth (apps/server/src/calendarNotes.ts). */
  calNoteId: text("cal_note_id"),
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
  /** The calendar note this row was read from; the note is the truth. */
  calNoteId: text("cal_note_id"),
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

/** Sign-in sessions: a JWT is good only while its row here is (apps/server/src/sessions.ts). */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  label: text("label").notNull(),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at"),
  revokedAt: integer("revoked_at"),
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

/**
 * Personal mail account (spec: in-app email, no OAuth). One row per user, keyed
 * unique on user_id — these are the user's own IMAP/SMTP credentials (a Gmail
 * app password), so the account is always self-scoped. The password is a
 * credential: AES-GCM encrypted at rest exactly like the AI key and ICS feed URL.
 * Messages are never stored — IMAP stays the source of truth, fetched on demand.
 */
export const mailAccounts = sqliteTable("mail_accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  /** The address, also the IMAP/SMTP login. */
  email: text("email").notNull(),
  imapHost: text("imap_host").notNull(),
  imapPort: integer("imap_port").notNull(),
  smtpHost: text("smtp_host").notNull(),
  smtpPort: integer("smtp_port").notNull(),
  /** Gmail app password (or provider password), AES-GCM encrypted. */
  passwordEncrypted: text("password_encrypted").notNull(),
  createdAt: integer("created_at").notNull(),
  lastCheckedAt: integer("last_checked_at"),
  lastError: text("last_error"),
});

/**
 * Outbound mail staged by a non-human caller (the in-app agent, or an MCP client
 * on an API token). Nothing here is sent until the account owner presses Send in
 * a signed-in session.
 *
 * The agent reads untrusted text — inbox messages, notes anyone on the team can
 * write — and also holds the vault's contents, so an instruction hidden in that
 * text could otherwise address mail to itself. A prompt telling the model to
 * confirm first is not a control; this table is. `createdBy` records which
 * surface staged it so the confirmation UI can say so.
 */
export const mailDrafts = sqliteTable("mail_drafts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  to: text("to").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  /** RFC Message-IDs, set when the draft is a reply. */
  inReplyTo: text("in_reply_to"),
  references: text("references"),
  /** "agent" = the in-app Ask panel, "token" = an MCP/API-token client. */
  createdBy: text("created_by", { enum: ["agent", "token"] }).notNull(),
  createdAt: integer("created_at").notNull(),
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

/** One-shot data migrations that must not run twice, by name (apps/server/src/migrations.ts). */
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
