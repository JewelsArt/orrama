/** Live-sync client: one WebSocket, reconnecting with backoff, fan-out to interested views. */
import { useEffect } from "react";
import { api, SESSION_ENDED } from "./api.js";

export interface NoteChangedMsg {
  type: "note-changed";
  noteId: string;
  path: string;
  authorId: string | null;
  /**
   * Set on the one message sent after the socket comes back. Anything may have changed while
   * it was down (every `pnpm ship` restarts the server), so a view treats it as a change to
   * whatever it shows, whatever `noteId` says.
   */
  resync?: true;
}
export interface PresenceMsg {
  type: "presence";
  userId: string;
  username: string;
  noteId: string;
  at: number;
}
export type WsMsg = NoteChangedMsg | PresenceMsg;

type Listener = (msg: WsMsg) => void;

let socket: WebSocket | null = null;
const listeners = new Set<Listener>();
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
/** Should a socket be open? Set while someone is signed in; a close then means reconnect. */
let wanted = false;
/** Failed attempts since the last good connection: how long the next wait is. */
let attempt = 0;
/** Has this session's socket been ready before? The next `ready` is then a reconnect. */
let wasReady = false;

const BACKOFF_FIRST_MS = 2000;
const BACKOFF_MAX_MS = 30_000;
/** The server closes with this when the session is over (revoked, signed out, account gone). */
const SESSION_OVER = 4001;

/**
 * How long to wait before reconnect attempt `n` (0-based): doubling from 2 s to at most 30 s,
 * then a random point in its upper half, so a restarted server is not met by every open tab in
 * the same instant.
 */
export function reconnectDelay(n: number, random: () => number = Math.random): number {
  const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** n);
  return Math.round(cap / 2 + (random() * cap) / 2);
}

const emit = (msg: WsMsg) => {
  for (const l of listeners) l(msg);
};

export function connectWs(): void {
  wanted = true;
  clearTimeout(reconnectTimer);
  // Detach the old socket BEFORE closing it. close() is asynchronous, so its
  // onclose fires after the replacement already exists — it then saw a socket
  // still wanted and scheduled a reconnect, which closed the healthy socket and
  // started again. Steady state was one disconnect every two seconds, forever,
  // and the trigger was something as ordinary as changing your display name.
  if (socket) {
    socket.onclose = null;
    socket.onmessage = null;
    socket.close();
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // The session cookie goes with the handshake, and the server signs the socket in
  // from it before it opens (WEB-013, apps/server/src/routes/ws.ts): nothing to send.
  const s = new WebSocket(`${proto}://${location.host}/api/ws`);
  let opened = false;
  s.onopen = () => void (opened = true);
  socket = s;
  socket.onmessage = (e) => {
    let msg: WsMsg | { type: "ready" };
    try {
      msg = JSON.parse(e.data) as WsMsg | { type: "ready" };
    } catch {
      return;
    }
    if (msg.type === "ready") {
      attempt = 0;
      // Back after a gap: say so once, so open views reload what they show (WEB-015).
      if (wasReady) emit({ type: "note-changed", noteId: "", path: "", authorId: null, resync: true });
      wasReady = true;
      return;
    }
    emit(msg);
  };
  socket.onclose = (e) => {
    if (!wanted) return;
    if (e.code === SESSION_OVER) {
      // The server ended this session. Reconnecting would never work; hand over to the app,
      // which signs out and shows the sign-in screen.
      wanted = false;
      window.dispatchEvent(new Event(SESSION_ENDED));
      return;
    }
    // Refused before it opened: the server is down or restarting, or it would not sign this
    // socket in. A browser cannot see the handshake's status, so ask the server whether the
    // session is still good: a 401 there ends it in the app (api.ts), anything else retries.
    if (!opened) void api("GET", "/api/me").catch(() => {});
    reconnectTimer = setTimeout(() => wanted && connectWs(), reconnectDelay(attempt++));
  };
}

export function disconnectWs(): void {
  wanted = false;
  attempt = 0;
  wasReady = false;
  clearTimeout(reconnectTimer);
  if (socket) {
    socket.onclose = null;
    socket.onmessage = null;
    socket.close();
  }
  socket = null;
}

export function onWs(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let lastEditingSent = 0;
/** Throttled presence ping while typing. */
export function sendEditing(noteId: string): void {
  const now = Date.now();
  if (now - lastEditingSent < 2000) return;
  lastEditingSent = now;
  if (socket?.readyState === 1) socket.send(JSON.stringify({ type: "editing", noteId }));
}

/**
 * Keep the live-sync socket open while someone is signed in. Keyed on the user's id, never on
 * the user object: saving a display name or an avatar hands App a new object for the same
 * person, and tearing the socket down for that lost whatever changed in the gap (WEB-015).
 */
export function useLiveSync(userId: string | undefined): void {
  useEffect(() => {
    if (!userId) return;
    connectWs();
    return () => disconnectWs();
  }, [userId]);
}
