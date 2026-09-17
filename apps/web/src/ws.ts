/** Live-sync client: one WebSocket, reconnecting, fan-out to interested views. */

export interface NoteChangedMsg {
  type: "note-changed";
  noteId: string;
  path: string;
  authorId: string | null;
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
let listeners = new Set<Listener>();
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let currentToken = "";

export function connectWs(token: string): void {
  currentToken = token;
  clearTimeout(reconnectTimer);
  // Detach the old socket BEFORE closing it. close() is asynchronous, so its
  // onclose fires after the replacement already exists — it then read a truthy
  // currentToken and scheduled a reconnect, which closed the healthy socket and
  // started again. Steady state was one disconnect every two seconds, forever,
  // and the trigger was something as ordinary as changing your display name.
  if (socket) {
    socket.onclose = null;
    socket.onmessage = null;
    socket.close();
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/api/ws?token=${encodeURIComponent(token)}`);
  socket.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data) as WsMsg;
      for (const l of listeners) l(msg);
    } catch {
      /* ignore */
    }
  };
  socket.onclose = () => {
    if (currentToken) reconnectTimer = setTimeout(() => connectWs(currentToken), 2000);
  };
}

export function disconnectWs(): void {
  currentToken = "";
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
