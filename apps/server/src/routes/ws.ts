/**
 * Live sync channel. Clients connect, send their JWT as the first frame, and receive push events the
 * moment any note they can read changes — the "seconds-fast" half of spec §10.
 * Every outbound event is ACL-checked per recipient with the same core function
 * as everything else: an unreadable note's change is never even announced.
 */
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { canRead } from "@basalt/core";
import type { Db } from "../db.js";
import type { NoteChangedEvent, VaultStore } from "../vaultStore.js";

/** How long a new socket has to send its auth frame before it is closed. */
export const AUTH_TIMEOUT_MS = 5000;

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

  app.get("/api/ws", { websocket: true }, (socket) => {
    // The token arrives as the FIRST MESSAGE, never in the URL. In `?token=` it
    // was written to the request log on every connect — and the client
    // reconnects every two seconds while offline — so the log filled with
    // 30-day session tokens (audit B7). Until a valid auth frame arrives this
    // socket receives nothing and may send nothing but that frame.
    let client: Client | null = null;
    const refuse = () => socket.close(4001, "authentication required");
    const deadline = setTimeout(() => {
      if (!client) refuse();
    }, AUTH_TIMEOUT_MS);

    socket.on("message", (raw: Buffer) => {
      let msg: { type?: string; token?: string; noteId?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        if (!client) refuse();
        return; // ignore malformed frames once authenticated
      }

      if (!client) {
        if (msg.type !== "auth" || typeof msg.token !== "string") return refuse();
        try {
          const { sub } = app.jwt.verify<{ sub: string }>(msg.token);
          store.aclUser(sub); // a token for an account that no longer exists is no token
          client = { userId: sub, socket };
        } catch {
          return refuse();
        }
        clearTimeout(deadline);
        clients.add(client);
        sendTo(client, { type: "ready" });
        return;
      }

      // Presence pings: {type:"editing", noteId}. Broadcast to other users who can
      // read that note; never to those who can't (presence must not leak, §5.4).
      try {
        if (msg.type !== "editing" || !msg.noteId) return;
        const note = store.index.get(msg.noteId);
        if (!note) return;
        const userId = client.userId;
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
        // ignore frames we cannot act on
      }
    });

    socket.on("close", () => {
      clearTimeout(deadline);
      if (client) clients.delete(client);
    });
  });
}
