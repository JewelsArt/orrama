/**
 * Signed in the way the browser is (WEB-013): a session is the `orrama_session`
 * cookie the sign-in set, and a write it carries comes from one of our own
 * pages (`fromOwnSite`, routes/auth.ts). An API token (`bslt_…`) is still sent
 * as Bearer, the way scripts and the MCP server send it.
 */

/**
 * routes/auth.ts's SESSION_COOKIE, spelled out: importing the server here would load
 * env.ts before a test file has set its ORRAMA_* variables (session-cookie.test.ts
 * checks the two agree).
 */
export const SESSION_COOKIE = "orrama_session";

/** The address light-my-request's requests are sent to (`Host: localhost:80`). */
export const OWN_ORIGIN = "http://localhost";

type SignInResponse =
  | { cookies: { name: string; value: string }[] }
  | { headers: { getSetCookie(): string[] } }
  | { headers: Record<string, unknown> };

/** The session a sign-in answered with: its cookie's value ("" when it set none). */
export function sessionOf(res: SignInResponse): string {
  if ("cookies" in res) return res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "";
  const h = res.headers as { getSetCookie?: () => string[] } & Record<string, unknown>;
  const raw = typeof h.getSetCookie === "function" ? h.getSetCookie() : ([] as unknown[]).concat(h["set-cookie"] ?? []).map(String);
  const line = raw.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return line ? line.slice(SESSION_COOKIE.length + 1).split(";")[0]! : "";
}

/**
 * The headers that send `credential` as its kind is sent: a session as the
 * cookie, from `origin` (our own page by default); an API token as Bearer.
 */
export function signedIn(credential: string | undefined, origin = OWN_ORIGIN): Record<string, string> {
  if (String(credential).startsWith("bslt_")) return { authorization: `Bearer ${credential}` };
  return { cookie: `${SESSION_COOKIE}=${credential}`, origin };
}

/** What `liveSocket` hands back: the socket, every message it got, and how it ended. */
export interface LiveSocket {
  ws: import("ws").WebSocket;
  got: { type?: string; [k: string]: unknown }[];
  closed: Promise<number>;
  /** True once the server said `ready` (within two seconds). */
  ready(): Promise<boolean>;
}

/**
 * Open the live-sync socket the way the browser does: the session's cookie and our own
 * Origin on the handshake (routes/ws.ts signs it in there). Rejects with
 * "Unexpected server response: <status>" when the server refuses the upgrade.
 */
export async function liveSocket(
  app: {
    injectWS(path: string, ctx?: { headers?: Record<string, string> }, opts?: { onInit?: (ws: import("ws").WebSocket) => void }): Promise<import("ws").WebSocket>;
  },
  session: string | undefined,
  { origin = OWN_ORIGIN, host = "localhost" }: { origin?: string; host?: string } = {},
): Promise<LiveSocket> {
  const headers: Record<string, string> = { host, origin };
  if (session) headers["cookie"] = `${SESSION_COOKIE}=${session}`;
  const got: LiveSocket["got"] = [];
  let closed!: Promise<number>;
  // Listening from before the socket opens: the server says `ready` the moment it does.
  const ws = await app.injectWS("/api/ws", { headers }, {
    onInit: (socket) => {
      closed = new Promise<number>((resolve) => socket.on("close", (code: number) => resolve(code)));
      socket.on("message", (data: Buffer) => got.push(JSON.parse(data.toString())));
    },
  });
  const ready = async () => {
    for (let i = 0; i < 100 && !got.some((m) => m.type === "ready"); i++) await new Promise((r) => setTimeout(r, 20));
    return got.some((m) => m.type === "ready");
  };
  return { ws, got, closed, ready };
}

/** The HTTP status a refused upgrade got (0 when it opened). */
export async function refusedWith(open: Promise<unknown>): Promise<number> {
  try {
    const s = (await open) as LiveSocket;
    s.ws.close();
    return 0;
  } catch (e) {
    return Number(/(\d{3})/.exec(String(e))?.[1] ?? -1);
  }
}
