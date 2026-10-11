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
import { outcomeOf, safeFetch, type Outcome } from "./safeFetch.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
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

/** How a signing secret begins when it is made (integrations.ts) — and so how a row still in the clear looks. */
export const WEBHOOK_SECRET_PREFIX = "whsec_";

/**
 * The signing secret is stored like every other credential: encrypted with
 * BASALT_SECRET_KEY (secrets.ts). It was the one written in the clear, so a
 * copy of basalt.db — a backup, the `export` snapshot — could forge signed
 * deliveries to every receiver (audit SEC-015). Decrypted only to sign.
 */
export const sealWebhookSecret = (plain: string) => encryptSecret(plain);

/**
 * Once per boot: encrypt rows an older build wrote in the clear. An
 * encrypted value is base64 and never starts with the prefix, so a second
 * run finds nothing. Returns how many it sealed.
 */
export function sealPlainWebhookSecrets(db: Db): number {
  const plain = db.select().from(tables.webhooks).all().filter((h) => h.secret.startsWith(WEBHOOK_SECRET_PREFIX));
  db.transaction((tx) => {
    for (const h of plain) tx.update(tables.webhooks).set({ secret: sealWebhookSecret(h.secret) }).where(eq(tables.webhooks.id, h.id)).run();
  });
  return plain.length;
}

/**
 * The status a hook records: the CLASS of the answer (200 delivered, 400
 * refused, 500 server error) or null for unreachable/blocked — never the far
 * end's exact code, which made the hook list a port-and-service scanner.
 */
const STATUS: Record<Outcome, number | null> = { delivered: 200, rejected: 400, "server-error": 500, unreachable: null, blocked: null };

/** POST one payload to one hook; records delivery status, never throws. */
export async function deliver(db: Db, hook: HookRow, payload: Record<string, unknown>): Promise<number | null> {
  const body = JSON.stringify(payload);
  let status: number | null = null;
  try {
    // safeFetch: public addresses only (or BASALT_FETCH_ALLOW), no redirects for a POST.
    const res = await safeFetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "basalt-webhook/1.0",
        "x-basalt-event": String(payload["event"]),
        "x-basalt-signature": signPayload(decryptSecret(hook.secret), body),
      },
      body,
      timeoutMs: DELIVER_TIMEOUT_MS,
      maxBytes: 64 * 1024,
    });
    status = STATUS[outcomeOf(res)];
  } catch (err) {
    status = STATUS[outcomeOf(err instanceof Error ? err : new Error(String(err)))]; // retried on next event
  }
  db.update(tables.webhooks).set({ lastStatus: status, lastFiredAt: Date.now() }).where(eq(tables.webhooks.id, hook.id)).run();
  return status;
}

export function initWebhooks(db: Db, store: VaultStore) {
  sealPlainWebhookSecrets(db);
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
      .filter((h) => {
        // A hook whose owner no longer exists delivers nothing (and must not
        // throw: this runs inside store.write's event).
        const owner = store.aclUserOrNull(h.ownerId);
        return owner !== null && canRead(owner, note, grants);
      });
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

  // A note saved just before shutdown left its debounce timer running; it
  // fired after the database closed and threw out of the timer (an uncaught
  // "database connection is not open"). The delivery is dropped, not rushed
  // out during shutdown.
  store.events.once("closed", () => {
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
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
