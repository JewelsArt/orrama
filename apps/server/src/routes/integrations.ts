/**
 * Personal API tokens + outgoing webhooks.
 *
 * Tokens are `bslt_<hex>`, accepted by the same `authenticate` gate as JWTs —
 * an Apple Shortcut or n8n flow hits any endpoint with the caller's normal
 * permissions. Only the SHA-256 hash is stored; the token is shown once.
 * Managing tokens/webhooks requires a real session so a leaked token can't
 * mint itself siblings or redirect webhooks.
 */
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tables, type Db } from "../db.js";
import { HttpError, type VaultStore } from "../vaultStore.js";
import { deliver, sealWebhookSecret, WEBHOOK_EVENTS, WEBHOOK_SECRET_PREFIX, type WebhookEvent } from "../webhooks.js";
import { sessionOnly } from "./auth.js";

export const hashToken = (raw: string) => crypto.createHash("sha256").update(raw).digest("hex");

export async function integrationRoutes(app: FastifyInstance, db: Db, _store: VaultStore) {
  /** Token/webhook management is session-only — see module doc. */
  const auth = { preHandler: [app.authenticate], config: sessionOnly("manage tokens and webhooks from a signed-in session") };

  // ---- API tokens ----------------------------------------------------------

  app.get("/api/tokens", auth, async (req) => {
    return db
      .select()
      .from(tables.apiTokens)
      .where(eq(tables.apiTokens.userId, req.userId))
      .all()
      .map((t) => ({ id: t.id, label: t.label, prefix: t.prefix, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }));
  });

  app.post("/api/tokens", auth, async (req) => {
    const body = (req.body ?? {}) as { label?: string };
    const label = body.label?.trim();
    if (!label || label.length > 60) throw new HttpError(400, "label required (max 60)");
    const token = `bslt_${crypto.randomBytes(24).toString("hex")}`;
    const row = {
      id: `tok-${crypto.randomUUID().slice(0, 8)}`,
      userId: req.userId,
      label,
      tokenHash: hashToken(token),
      prefix: token.slice(0, 10),
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    db.insert(tables.apiTokens).values(row).run();
    // The only time the full token ever leaves the server.
    return { id: row.id, label: row.label, prefix: row.prefix, createdAt: row.createdAt, token };
  });

  app.delete<{ Params: { id: string } }>("/api/tokens/:id", auth, async (req) => {
    const res = db
      .delete(tables.apiTokens)
      .where(and(eq(tables.apiTokens.id, req.params.id), eq(tables.apiTokens.userId, req.userId)))
      .run();
    if (res.changes === 0) throw new HttpError(404, "token not found");
    return { ok: true };
  });

  // ---- webhooks ------------------------------------------------------------

  const hookPublic = (h: typeof tables.webhooks.$inferSelect) => ({
    id: h.id,
    url: h.url,
    events: JSON.parse(h.events) as string[],
    active: h.active,
    createdAt: h.createdAt,
    lastStatus: h.lastStatus,
    lastFiredAt: h.lastFiredAt,
  });

  app.get("/api/webhooks", auth, async (req) => {
    return db.select().from(tables.webhooks).where(eq(tables.webhooks.ownerId, req.userId)).all().map(hookPublic);
  });

  app.post("/api/webhooks", auth, async (req) => {
    const body = (req.body ?? {}) as { url?: string; events?: string[] };
    let url: URL;
    try {
      url = new URL(body.url ?? "");
    } catch {
      throw new HttpError(400, "invalid URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "URL must be http(s)");
    const events = (body.events ?? []).filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e));
    if (events.length === 0) throw new HttpError(400, `events required: ${WEBHOOK_EVENTS.join(", ")}`);
    const secret = `${WEBHOOK_SECRET_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
    const hook = {
      id: `wh-${crypto.randomUUID().slice(0, 8)}`,
      ownerId: req.userId,
      url: url.href,
      secret: sealWebhookSecret(secret), // encrypted at rest (webhooks.ts)
      events: JSON.stringify(events),
      active: true,
      createdAt: Date.now(),
      lastStatus: null,
      lastFiredAt: null,
    };
    db.insert(tables.webhooks).values(hook).run();
    // Secret shown once — it's what verifies our signature on the receiving end.
    return { ...hookPublic(hook), secret };
  });

  app.delete<{ Params: { id: string } }>("/api/webhooks/:id", auth, async (req) => {
    const res = db
      .delete(tables.webhooks)
      .where(and(eq(tables.webhooks.id, req.params.id), eq(tables.webhooks.ownerId, req.userId)))
      .run();
    if (res.changes === 0) throw new HttpError(404, "webhook not found");
    return { ok: true };
  });

  /** Fire a ping now and report the response status — debugging without waiting for real activity. */
  app.post<{ Params: { id: string } }>("/api/webhooks/:id/test", auth, async (req) => {
    const hook = db.select().from(tables.webhooks).where(eq(tables.webhooks.id, req.params.id)).get();
    if (!hook || hook.ownerId !== req.userId) throw new HttpError(404, "webhook not found");
    const status = await deliver(db, hook, { event: "ping", at: new Date().toISOString() });
    return { status };
  });
}
