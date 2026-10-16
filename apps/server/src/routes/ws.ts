/**
 * Live sync channel. A client opens the socket with its session cookie and receives push events
 * the moment any note it can read changes — the "seconds-fast" half of spec §10.
 * Every outbound event is ACL-checked per recipient with the same core function
 * as everything else: an unreadable note's change is never even announced.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { canRead } from "@orrama/core";
import type { Db } from "../db.js";
import { env } from "../env.js";
import { sessionUser } from "../sessions.js";
import type { NoteChangedEvent, VaultStore } from "../vaultStore.js";
import { fromOwnSite, sessionCookieOf } from "./auth.js";

interface Client {
  userId: string;
  sessionId: string;
  socket: WebSocket;
}

export async function wsRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const clients = new Set<Client>();

  // A revoked session loses its live feed now, not at its next reconnect —
  // an open socket kept receiving every note change it could read.
  store.events.on("session-revoked", ({ sessionId }: { sessionId?: string }) => {
    for (const client of clients) {
      if (client.sessionId !== sessionId) continue;
      clients.delete(client);
      client.socket.close(4001, "session ended");
    }
  });

  const sendTo = (client: Client, payload: unknown) => {
    if (client.socket.readyState === 1) client.socket.send(JSON.stringify(payload));
  };

  store.events.on("note-changed", (ev: NoteChangedEvent) => {
    const note = store.index.get(ev.noteId);
    if (!note) return;
    const grants = store.grants();
    for (const client of clients) {
      // An account deleted while its socket is open: close it, don't throw —
      // this listener runs inside store.write().
      const user = store.aclUserOrNull(client.userId);
      if (!user) {
        clients.delete(client);
        client.socket.close(4001, "account removed");
        continue;
      }
      if (!canRead(user, note, grants)) continue;
      sendTo(client, { type: "note-changed", noteId: ev.noteId, path: ev.path, authorId: ev.authorId });
    }
  });

  /**
   * The socket is signed in on the upgrade, before it opens, from the session cookie
   * (WEB-013). It used to open for anyone and wait up to five seconds for a token in its first
   * frame, parsed before anyone knew it was one (SEC-010); the token no longer exists in the
   * page to send. A cookie-authenticated socket from another site is the classic hijack, so
   * its `Origin` must be our own, as for any write the cookie carries (`fromOwnSite`).
   * Refused here, the handshake gets an HTTP status and no socket is ever made.
   */
  const signInSocket = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!fromOwnSite(req.headers, env.publicOrigins)) return reply.code(403).send({ error: "this request came from another site" });
    let payload: { sub?: unknown; sid?: unknown } | null = null;
    try {
      const token = sessionCookieOf(req.headers.cookie);
      payload = token ? app.jwt.verify(token) : null;
    } catch {
      payload = null;
    }
    // A signed-out or revoked session is no session; nor is one for an account since removed.
    const userId = payload ? sessionUser(db, payload) : null;
    if (!userId || !store.aclUserOrNull(userId)) return reply.code(401).send({ error: "authentication required" });
    req.userId = userId;
    req.sessionId = payload!.sid as string;
  };

  app.get("/api/ws", { websocket: true, preHandler: signInSocket }, (socket, req) => {
    const client: Client = { userId: req.userId, sessionId: req.sessionId!, socket };
    clients.add(client);
    sendTo(client, { type: "ready" });

    socket.on("message", (raw: Buffer) => {
      // Presence pings: {type:"editing", noteId}. Broadcast to other users who can read that
      // note; never to those who can't (presence must not leak, §5.4). Anything else — an
      // auth frame from an app open since before the cookie included — is ignored.
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; noteId?: string };
        if (msg.type !== "editing" || !msg.noteId) return;
        const note = store.index.get(msg.noteId);
        if (!note) return;
        const userId = client.userId;
        const me = store.aclUser(userId);
        const grants = store.grants();
        if (!canRead(me, note, grants)) return;
        for (const other of clients) {
          if (other.userId === userId) continue;
          const user = store.aclUserOrNull(other.userId);
          if (!user || !canRead(user, note, grants)) continue;
          sendTo(other, { type: "presence", userId, username: me.username, noteId: msg.noteId, at: Date.now() });
        }
      } catch {
        // ignore frames we cannot act on
      }
    });

    socket.on("close", () => clients.delete(client));
  });
}
