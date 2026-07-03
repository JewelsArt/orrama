/** Zod schemas for every API payload — shared by server (validation) and clients (types). */
import { z } from "zod";

export const roleSchema = z.enum(["viewer", "editor", "admin"]);
export const taskStatusSchema = z.enum(["todo", "in-progress", "done", "blocked", "orphaned"]);

export const registerSchema = z.object({
  email: z.string().email(),
  username: z.string().regex(/^[\w.-]{2,32}$/),
  displayName: z.string().min(1).max(80),
  password: z.string().min(8).max(256),
  inviteToken: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const noteWriteSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(512)
    .regex(/^(?!\/)(?!.*\.\.)[^\0]+\.md$/, "vault-relative .md path, no traversal"),
  content: z.string().max(2_000_000),
  /** Base revision hash the client edited from; server merges via CRDT when stale. */
  baseHash: z.string().optional(),
});

export const noteMoveSchema = z.object({
  fromPath: z.string(),
  toPath: z.string().regex(/^(?!\/)(?!.*\.\.).+\.md$/),
});

export const checkTaskSchema = z.object({
  noteId: z.string(),
  line: z.number().int().nonnegative().optional(),
  blockId: z.string().optional(),
  checked: z.boolean(),
});

export const promoteTaskSchema = z.object({
  noteId: z.string(),
  line: z.number().int().nonnegative(),
});

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
  provider: z.enum(["anthropic", "openai-compatible"]),
  apiKey: z.string().min(10),
  model: z.string().min(1),
});

export const askVaultSchema = z.object({
  question: z.string().min(1).max(4000),
  /** Current note id, if the panel is open on one — feeds link-graph retrieval. */
  contextNoteId: z.string().optional(),
});

export type NoteWrite = z.infer<typeof noteWriteSchema>;
export type CheckTask = z.infer<typeof checkTaskSchema>;
export type Grant = z.infer<typeof grantSchema>;
