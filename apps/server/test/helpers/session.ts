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
