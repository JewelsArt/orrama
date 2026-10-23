/** Zod schemas for every API payload — shared by server (validation) and clients (types). */
import { z } from "zod";

export const roleSchema = z.enum(["viewer", "editor", "admin"]);
export const taskStatusSchema = z.enum(["todo", "in-progress", "done", "blocked", "orphaned"]);

/** Settings → You: the password now, and the new one (sign-up's rule). */
export const passwordChangeSchema = z.object({
  current: z.string().min(1).max(256),
  next: z.string().min(8).max(256),
});

export const registerSchema = z.object({
  email: z.string().email(),
  // Must start alphanumeric: a username becomes a path segment under Personal/,
  // and ".." is otherwise a legal username.
  username: z.string().regex(/^[a-z0-9][\w.-]{1,31}$/i),
  displayName: z.string().min(1).max(80),
  password: z.string().min(8).max(256),
  inviteToken: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

/** Exactly four digits. A string, not a number, so "0042" survives the wire. */
export const passcodeSchema = z.object({
  passcode: z.string().regex(/^\d{4}$/, "passcode must be exactly 4 digits"),
});

/** Quick unlock. The email says which account; the passcode is checked
 *  server-side against an attempt counter, never in the browser. */
export const unlockSchema = z.object({
  email: z.string().email(),
  passcode: z.string().regex(/^\d{4}$/),
});

/**
 * How the app looks, stored on the account so a second device inherits it.
 *
 * Validated strictly rather than trusted as opaque JSON, because every one of
 * these colours is handed to `style.setProperty("--v-…", value)` on the client.
 * A custom property is a string until something reads it, and `background:
 * var(--v-pink)` would happily resolve a `url(…)` into a request. Six hex digits
 * is the whole grammar; nothing else needs to be expressible.
 */
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const visionProfileSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  name: z.string().min(1).max(60),
  colors: z.array(hexColor).length(7),
  /** Orrama's own colour. Optional: profiles predate the slot. */
  brand: hexColor.optional(),
});

export const appearanceSchema = z.object({
  theme: z.enum(["light", "paper", "command"]).optional(),
  /** The look (Settings → Appearance): Paper or Clay. Absent is Paper. Light or dark is `theme`. */
  look: z.enum(["paper", "clay"]).optional(),
  vision: z
    .string()
    .regex(/^(none|deuteranopia|protanopia|tritanopia|custom:[A-Za-z0-9_-]{1,40})$/)
    .optional(),
  profiles: z.array(visionProfileSchema).max(20).optional(),
});

export type Appearance = z.infer<typeof appearanceSchema>;

export const noteWriteSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(512)
    .regex(/^(?!\/)(?!.*\.\.)[^\0]+\.md$/, "vault-relative .md path, no traversal"),
  content: z.string().max(2_000_000),
  /**
   * Create only: when a note already sits at the path (in any spelling the
   * disk folds together), answer 409 and write nothing. Every "New …" flow
   * sends it; without it PUT is an upsert and replaces the note (audit WEB-001).
   */
  create: z.boolean().optional(),
  /** Hash of the text the client's buffer started from (as the server reported it). */
  baseHash: z.string().optional(),
  /**
   * That text itself. With it the server can merge a stale save instead of
   * guessing: base → content is the client's edit, base → current is everyone
   * else's, and both survive. Must hash to `baseHash` when both are sent.
   */
  baseContent: z.string().max(2_000_000).optional(),
});

export const noteMoveSchema = z.object({
  fromPath: z.string().regex(/^(?!\/)(?!.*\.\.).+\.md$/),
  toPath: z.string().regex(/^(?!\/)(?!.*\.\.).+\.md$/),
  /** Rewrite the exact `[[links]]` that name the note by what changes (linkRename.ts). */
  links: z.boolean().optional(),
});

/** A note to put in the trash. */
export const noteTrashSchema = z.object({
  path: z.string().max(512).regex(/^(?!\/)(?!.*\.\.)[^\0]+\.md$/),
});

/** A folder in the notes folder: vault-relative, no traversal (resolveFolder judges it). */
const folderPath = z.string().min(1).max(512).regex(/^(?!\/)(?!.*\.\.)[^\0]+$/, "vault-relative folder, no traversal");
export const folderSchema = z.object({ folder: folderPath });
export const folderMoveSchema = z.object({ from: folderPath, to: folderPath });

/** Something in the trash, by its path there (`.trash/…`). */
export const trashRestoreSchema = z.object({
  path: z.string().max(600).regex(/^\.trash\/(?!.*\.\.)[^\0]+$/i),
});

/**
 * Which task a mutation means (audit COR-001; `TaskLineRef` in core). A
 * promoted task is its `blockId`; any other task is its `text` — the line or
 * the display text the caller saw — with `line` as a hint between identical
 * tasks. A line alone is refused: the note may have moved under the caller.
 */
const taskRef = {
  noteId: z.string(),
  line: z.number().int().nonnegative().optional(),
  blockId: z.string().optional(),
  text: z.string().max(10_000).optional(),
};
const namesTheTask = (b: { blockId?: string; text?: string }) => !!b.blockId || (b.text ?? "").trim() !== "";
const NAME_THE_TASK = { message: "say which task: its blockId, or its text (with the line it is on as a hint)" };

export const checkTaskSchema = z.object({ ...taskRef, checked: z.boolean() }).refine(namesTheTask, NAME_THE_TASK);

export const promoteTaskSchema = z.object(taskRef).refine(namesTheTask, NAME_THE_TASK);

/** Set a task's status by block id or text: written into the checkbox,
 *  `[ ]` todo, `[/]` in progress, `[b]` blocked, `[x]` done. */
export const setTaskStatusSchema = z
  .object({ ...taskRef, status: z.enum(["todo", "in-progress", "done", "blocked"]) })
  .refine(namesTheTask, NAME_THE_TASK);

export const taskDatesSchema = z
  .object({
    ...taskRef,
    /** undefined = leave as-is, null = remove the token from the line. */
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .refine(namesTheTask, NAME_THE_TASK)
  .refine((b) => b.start !== undefined || b.due !== undefined, { message: "start or due required" })
  .refine((b) => !b.start || !b.due || b.start <= b.due, { message: "start must not be after due" });

/** A day that exists, as the line writes it: the shape alone lets 2026-02-30 through. */
const realDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d && d >= "1900-01-01";
  }, "not a real day");

/**
 * Change a step from its card (`POST /api/tasks/edit`): each part on its own, written into its
 * line as a person would type it (core `editTaskLine`). Absent = leave it; null = take it off.
 */
export const taskEditSchema = z
  .object({
    ...taskRef,
    words: z.string().trim().min(1).max(2000).regex(/^[^\r\n]*$/, "one line").optional(),
    due: realDay.nullable().optional(),
    start: realDay.nullable().optional(),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable().optional(),
    key: z.boolean().optional(),
    status: z.enum(["todo", "in-progress", "done", "blocked"]).optional(),
  })
  .refine(namesTheTask, NAME_THE_TASK);

/**
 * Move a step (`POST /api/tasks/move`): to a project's note, last under one of its `##`
 * sections ("Tasks" when none is named), or to your inbox.
 */
export const taskMoveSchema = z
  .object({
    ...taskRef,
    to: z.union([
      z.object({ project: z.string().min(1).max(64), section: z.string().trim().min(1).max(200).regex(/^[^\r\n#]*$/, "a heading's words").optional() }).strict(),
      z.object({ inbox: z.literal(true) }).strict(),
    ]),
  })
  .refine(namesTheTask, NAME_THE_TASK);

/** Which step a card opens on (`GET /api/tasks/card?noteId=…&blockId=…&text=…&line=…`). */
export const taskCardQuerySchema = z
  .object({ ...taskRef, line: z.coerce.number().int().nonnegative().optional() })
  .refine(namesTheTask, NAME_THE_TASK);

/** Delete a step's line (`POST /api/tasks/delete`). */
export const taskDeleteSchema = z.object(taskRef).refine(namesTheTask, NAME_THE_TASK);

/** A task booked onto a day (`/api/tasks/schedule`) or a calendar slot (`/api/tasks/blocks`). */
export const taskPlaceSchema = z.object(taskRef).refine(namesTheTask, NAME_THE_TASK);

export const updateTaskObjectSchema = z.object({
  status: taskStatusSchema.optional(),
  assigneeId: z.string().nullable().optional(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  description: z.string().max(10_000).optional(),
});

export const quickCaptureSchema = z.object({
  text: z.string().min(1).max(2000),
});

export const grantSchema = z.object({
  teamId: z.string(),
  folder: z.string(),
  role: roleSchema,
});

export const teamCreateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/),
  name: z.string().min(1).max(64),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  icon: z.string().max(8).optional(),
});

export const projectCreateSchema = z.object({
  kind: z.enum(["folder", "tag"]),
  key: z.string().min(1),
  name: z.string().min(1).max(64),
  teamId: z.string().nullable().optional(),
});

export const inviteCreateSchema = z.object({
  teamIds: z.array(z.string()).min(1),
  expiresInHours: z.number().int().positive().max(24 * 30).default(72),
});

export const aiConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai-compatible", "google", "chatgpt"]),
  /** Blank = keep the existing key (so provider/model can be changed without re-pasting it). */
  apiKey: z.string().min(10).optional().or(z.literal("")),
  model: z.string().min(1),
  /** Custom endpoint for the openai-compatible provider (e.g. a Gemini OpenAI-compat URL). */
  baseUrl: z.string().url().optional().or(z.literal("")),
});

/** The owner's custom agent instructions, appended to the built-in app guide. */
export const aiInstructionsSchema = z.object({
  instructions: z.string().max(8000),
});

/** Connect a personal mail account (Gmail app password over IMAP/SMTP; no OAuth). */
export const mailConnectSchema = z.object({
  email: z.string().email(),
  /** Gmail app password (16 chars, often shown grouped in fours). Spaces are stripped server-side. */
  appPassword: z.string().min(8),
  /** Override IMAP/SMTP hosts for non-Gmail providers; defaults to Gmail. */
  imapHost: z.string().min(1).optional(),
  imapPort: z.number().int().positive().optional(),
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.number().int().positive().optional(),
});

/** Send or reply to a message through the connected account. */
export const mailSendSchema = z.object({
  to: z.string().min(3),
  subject: z.string().max(500).default(""),
  body: z.string().default(""),
  /** RFC Message-IDs for threading a reply (from the message being replied to). */
  inReplyTo: z.string().optional(),
  references: z.string().optional(),
});

export const askVaultSchema = z.object({
  // AI SDK v5+ UIMessage shape: role + parts[]. Kept permissive (passthrough) so
  // convertToModelMessages on the server reads the full message; validated for role only.
  messages: z.array(z.object({ role: z.enum(["user", "assistant", "system"]) }).passthrough()).min(1),
  /** Current note id, if the panel is open on one — feeds link-graph retrieval. */
  contextNoteId: z.string().optional(),
});

export type NoteWrite = z.infer<typeof noteWriteSchema>;
export type CheckTask = z.infer<typeof checkTaskSchema>;
export type SetTaskStatus = z.infer<typeof setTaskStatusSchema>;
export type TaskEdit = z.infer<typeof taskEditSchema>;
export type TaskMove = z.infer<typeof taskMoveSchema>;
export type Grant = z.infer<typeof grantSchema>;

/** PUT /api/areas: the whole list, in order (routes/areas.ts, 1D). `was` is the id an area had, so a rename takes its projects. */
export const lifeAreasWriteSchema = z.object({
  areas: z
    .array(
      z.object({
        name: z.string().max(200),
        words: z.array(z.string().max(400)).max(200).default([]),
        catchAll: z.boolean().default(false),
        was: z.string().max(200).optional(),
      }),
    )
    .max(100),
  /** The areas note's hash as `GET /api/areas` sent it: a list changed since is a 409, never a write over it. */
  baseHash: z.string().max(200).optional(),
});
