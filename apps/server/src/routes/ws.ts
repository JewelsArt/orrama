/**
 * Live sync channel. Clients connect with their JWT and receive push events the
 * moment any note they can read changes — the "seconds-fast" half of spec §10.
 * Every outbound event is ACL-checked per recipient with the same core function
 * as everything else: an unreadable note's change is never even announced.
 */
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { canRead } from "@basalt/core";
import type { Db } from "../db.js";
import type { NoteChangedEvent, VaultStore } from "../vaultStore.js";

interface Client {
  userId: string;
  socket: WebSocket;
}

export async function wsRoutes(app: FastifyInstance, _db: Db, store: VaultStore) {
  const clients = new Set<Client>();

  const sendTo = (client: Client, payload: unknown) => {
    if (client.socket.readyState === 1) client.socket.send(JSON.stringify(payload));
  };

  store.events.on("note-changed", (ev: NoteChangedEvent) => {
    const note = store.index.get(ev.noteId);
    if (!note) return;
    const grants = store.grants();
    for (const client of clients) {
      const user = store.aclUser(client.userId);
      if (!canRead(user, note, grants)) continue;
      sendTo(client, { type: "note-changed", noteId: ev.noteId, path: ev.path, authorId: ev.authorId });
    }
  });

  app.get("/api/ws", { websocket: true }, (socket, req) => {
    let userId: string;
    try {
      const token = (req.query as { token?: string }).token ?? "";
      const payload = app.jwt.verify<{ sub: string }>(token);
      userId = payload.sub;
    } catch {
      socket.close(4001, "authentication required");
      return;
    }
    const client: Client = { userId, socket };
    clients.add(client);

    socket.on("message", (raw: Buffer) => {
      // Presence pings: {type:"editing", noteId}. Broadcast to other users who can
      // read that note; never to those who can't (presence must not leak, §5.4).
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; noteId?: string };
        if (msg.type !== "editing" || !msg.noteId) return;
        const note = store.index.get(msg.noteId);
        if (!note) return;
        const me = store.aclUser(userId);
        if (!canRead(me, note, store.grants())) return;
        const grants = store.grants();
        for (const other of clients) {
          if (other.userId === userId) continue;
          const user = store.aclUser(other.userId);
          if (!canRead(user, note, grants)) continue;
          sendTo(other, { type: "presence", userId, username: me.username, noteId: msg.noteId, at: Date.now() });
        }
      } catch {
        // ignore malformed frames
      }
    });

    socket.on("close", () => clients.delete(client));
  });
}
