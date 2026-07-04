/**
 * Outgoing webhooks: the "connect anything" layer. Subscribers get an
 * HMAC-signed POST when something they're allowed to see changes — the ACL
 * check runs per webhook owner, so a hook never learns about notes its owner
 * can't read (same leak rule as every other surface, spec §5.4).
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { canRead } from "@basalt/core";
import { tables, type Db } from "./db.js";
import type { NoteChangedEvent, VaultStore } from "./vaultStore.js";

export const WEBHOOK_EVENTS = ["note.changed", "task.completed"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface TaskCompletedEvent extends NoteChangedEvent {
  blockId: string | null;
  text: string;
}

const DELIVER_TIMEOUT_MS = 5_000;
// note.changed is chatty while someone types; coalesce per (hook, note).
const DEBOUNCE_MS = Number(process.env.BASALT_WEBHOOK_DEBOUNCE_MS ?? 1500);

type HookRow = typeof tables.webhooks.$inferSelect;

export function signPayload(secret: string, body: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** POST one payload to one hook; records delivery status, never throws. */
export async function deliver(db: Db, hook: HookRow, payload: Record<string, unknown>): Promise<number | null> {
  const body = JSON.stringify(payload);
  let status: number | null = null;
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "basalt-webhook/1.0",
        "x-basalt-event": String(payload["event"]),
        "x-basalt-signature": signPayload(hook.secret, body),
      },
      body,
      signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
    });
    status = res.status;
  } catch {
    status = null; // unreachable endpoint — recorded as such, retried on next event
  }
  db.update(tables.webhooks).set({ lastStatus: status, lastFiredAt: Date.now() }).where(eq(tables.webhooks.id, hook.id)).run();
  return status;
}

export function initWebhooks(db: Db, store: VaultStore) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const hooksFor = (event: WebhookEvent, noteId: string): HookRow[] => {
    const note = store.index.get(noteId);
    if (!note) return [];
    const grants = store.grants();
    return db
      .select()
      .from(tables.webhooks)
      .where(eq(tables.webhooks.active, true))
      .all()
      .filter((h) => (JSON.parse(h.events) as string[]).includes(event))
      .filter((h) => canRead(store.aclUser(h.ownerId), note, grants));
  };

  const username = (id: string | null) =>
    id ? (db.select().from(tables.users).where(eq(tables.users.id, id)).get()?.username ?? null) : null;

  const notePayload = (noteId: string) => {
    const note = store.index.get(noteId);
    return note ? { id: note.id, path: note.path, title: note.title } : null;
  };

  store.events.on("note-changed", (e: NoteChangedEvent) => {
    for (const hook of hooksFor("note.changed", e.noteId)) {
      const key = `${hook.id}:${e.noteId}`;
      clearTimeout(pending.get(key));
      pending.set(
        key,
        setTimeout(() => {
          pending.delete(key);
          void deliver(db, hook, {
            event: "note.changed",
            at: new Date().toISOString(),
            note: notePayload(e.noteId),
            author: username(e.authorId),
          });
        }, DEBOUNCE_MS),
      );
    }
  });

  store.events.on("task-completed", (e: TaskCompletedEvent) => {
    for (const hook of hooksFor("task.completed", e.noteId)) {
      void deliver(db, hook, {
        event: "task.completed",
        at: new Date().toISOString(),
        note: notePayload(e.noteId),
        task: { blockId: e.blockId, text: e.text },
        author: username(e.authorId),
      });
    }
  });
}
