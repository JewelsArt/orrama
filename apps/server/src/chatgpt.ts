/**
 * Sign in with ChatGPT: the agent runs on the owner's ChatGPT plan (Plus or
 * Pro) instead of an API key. The server on this computer makes every call.
 * Usage comes out of the plan's weekly allowance; the owner caps it per app in
 * ChatGPT's settings.
 *
 * Who may use it: OpenAI offers ChatGPT plan usage to open-source projects,
 * personal projects that run locally, and selected private apps
 * (developers.openai.com/siwc, and the cookbook's "Sign in with ChatGPT"); a
 * paid or proprietary app needs OpenAI's OK first, through the interest form
 * (openai.com/form/sign-in-with-chatgpt-interest/). Orrama is free software
 * under the AGPL since 21 October 2026 and runs on each person's own computer,
 * so it is offered to everyone, in first run and in Settings (Jules, plan of
 * 21 Oct). That rests on the source being public by the friends' release
 * (stage 2, 2G): until then the repository is private and only Jules's own
 * copy is covered.
 *
 * Implemented from the documented protocol, not OpenAI's DevKit (that code is
 * under a noncommercial licence, which the AGPL cannot carry, so none of it is
 * used):
 *
 *   1. start   — a PKCE authorization-code request to auth.openai.com, with
 *                `client_id=dynamic_agent_client` the first time (OpenAI
 *                registers this install and returns an issued client id on
 *                the callback) and a stable `ext_agent_host_id` per install.
 *                The redirect must be http://127.0.0.1:<port>/callback, so
 *                sign-in happens in a browser on this computer: in the desktop
 *                app, the system browser (Google refuses to sign in inside an
 *                app's window), while the app's page waits for it to land.
 *   2. finish  — /callback checks the one-time state, exchanges the code, and
 *                verifies the ID token against OpenAI's JWKS (issuer, audience
 *                = the issued client id, expiry, nonce).
 *   3. use     — Responses API at api.openai.com/v1 with the access token as
 *                the bearer; `store: false`, always streamed.
 *   4. refresh — access tokens last an hour; each refresh returns a NEW
 *                refresh token and spends the old one, so refreshes are
 *                serialised and the new one is saved before anything else.
 *
 * Credentials (refresh token, issued client id, the account's email) live
 * encrypted in `meta` under chatgpt_credentials, apart from the API key the
 * other providers use, so switching back to Gemini still finds its key.
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { tables, type Db } from "./db.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { HttpError } from "./vaultStore.js";

export const SIWC = {
  issuer: "https://auth.openai.com",
  authorize: "https://auth.openai.com/api/accounts/authorize",
  token: "https://auth.openai.com/api/accounts/oauth/token",
  jwks: "https://auth.openai.com/.well-known/jwks.json",
  resource: "https://api.openai.com/v1",
  scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  dynamicClient: "dynamic_agent_client",
  appName: "Orrama",
  /** Where a user caps or checks what Orrama uses of their plan. */
  manageUsage: "https://chatgpt.com/#settings",
} as const;

const CREDS = "chatgpt_credentials";
const HOST = "chatgpt_host_id";
const PENDING_MS = 10 * 60_000;
/** Refresh this long before the hour is up, so a long agent run does not cross it. */
const REFRESH_EARLY_MS = 2 * 60_000;

export interface ChatGptCredentials {
  clientId: string;
  refreshToken: string;
  accessToken: string;
  /** epoch ms */
  expiresAt: number;
  idToken: string;
  email: string | null;
  sub: string;
}

const readMeta = (db: Db, key: string) => db.select().from(tables.meta).where(eq(tables.meta.key, key)).get()?.value ?? null;
const writeMeta = (db: Db, key: string, value: string) =>
  db.insert(tables.meta).values({ key, value }).onConflictDoUpdate({ target: tables.meta.key, set: { value } }).run();

export function chatgptCredentials(db: Db): ChatGptCredentials | null {
  const raw = readMeta(db, CREDS);
  if (!raw) return null;
  try {
    return JSON.parse(decryptSecret(raw)) as ChatGptCredentials;
  } catch {
    return null; // e.g. ORRAMA_SECRET_KEY rotated: sign in again
  }
}

function saveCredentials(db: Db, c: ChatGptCredentials): void {
  writeMeta(db, CREDS, encryptSecret(JSON.stringify(c)));
}

/** A stable id for this Orrama install, as the protocol asks: `urn:uuid:…`. */
export function hostId(db: Db): string {
  const found = readMeta(db, HOST);
  if (found) return found;
  const id = `urn:uuid:${crypto.randomUUID()}`;
  writeMeta(db, HOST, id);
  return id;
}

interface Pending {
  verifier: string;
  nonce: string;
  redirectUri: string;
  /** The app origin to send the browser back to; null when the page that started it waits. */
  returnTo: string | null;
  at: number;
}
const pending = new Map<string, Pending>();
const b64url = (b: Buffer) => b.toString("base64url");

/**
 * The URL that starts sign-in. `port` is the one this server listens on;
 * `returnTo` is the app origin to send the browser back to afterwards, or null
 * when the page that started it stays where it is and waits (the desktop app:
 * the sign-in runs in the system browser, which is then told it can close).
 */
export function startSignIn(db: Db, port: number, returnTo: string | null, now = Date.now()): string {
  for (const [k, p] of pending) if (now - p.at > PENDING_MS) pending.delete(k);
  const creds = chatgptCredentials(db);
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  pending.set(state, { verifier, nonce, redirectUri, returnTo, at: now });
  const q = new URLSearchParams({
    client_id: creds?.clientId ?? SIWC.dynamicClient,
    ext_agent_host_id: hostId(db),
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SIWC.scope,
    resource: SIWC.resource,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
  });
  if (!creds) q.set("agent_name_hint", SIWC.appName);
  else q.set("id_token_hint", creds.idToken);
  return `${SIWC.authorize}?${q.toString()}`;
}

let jwks: JWTVerifyGetKey | null = null;
const keySet = () => (jwks ??= createRemoteJWKSet(new URL(SIWC.jwks)));
/** Tests swap in their own key set. */
export function setKeySetForTests(k: JWTVerifyGetKey | null): void {
  jwks = k;
}

async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; id_token?: string; expires_in: number }> {
  const res = await fetch(SIWC.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new HttpError(502, `ChatGPT sign-in failed (${res.status})`);
  return (await res.json()) as { access_token: string; refresh_token?: string; id_token?: string; expires_in: number };
}

/** The callback: one-time state, code exchange, ID-token checks. Returns where to send the browser. */
export async function finishSignIn(db: Db, query: Record<string, string | undefined>, now = Date.now()): Promise<{ returnTo: string | null; email: string | null }> {
  const state = query.state ?? "";
  const p = pending.get(state);
  pending.delete(state); // single use, whatever happens next
  if (!p || now - p.at > PENDING_MS) throw new HttpError(400, "This sign-in has expired. Start it again in Orrama.");
  if (query.error) throw new HttpError(400, `ChatGPT sign-in was not completed (${query.error}).`);
  if (!query.code) throw new HttpError(400, "ChatGPT sign-in returned no code.");
  const previous = chatgptCredentials(db);
  const clientId = query.client_id ?? previous?.clientId;
  if (!clientId) throw new HttpError(400, "ChatGPT sign-in returned no client id.");

  const t = await tokenRequest({
    grant_type: "authorization_code",
    code: query.code,
    client_id: clientId,
    code_verifier: p.verifier,
    redirect_uri: p.redirectUri,
    resource: SIWC.resource,
  });
  if (!t.id_token || !t.refresh_token) throw new HttpError(502, "ChatGPT sign-in returned no ID or refresh token.");
  const { payload } = await jwtVerify(t.id_token, keySet(), { issuer: SIWC.issuer, audience: clientId }).catch(() => {
    throw new HttpError(502, "ChatGPT sign-in returned an ID token that does not verify.");
  });
  if (payload.nonce !== p.nonce || typeof payload.sub !== "string") throw new HttpError(502, "ChatGPT sign-in returned an ID token for another request.");

  const email = typeof payload.email === "string" ? payload.email : null;
  saveCredentials(db, {
    clientId,
    refreshToken: t.refresh_token,
    accessToken: t.access_token,
    expiresAt: now + t.expires_in * 1000,
    idToken: t.id_token,
    email,
    sub: payload.sub,
  });

  // Switch the workspace to it, on a model the plan offers.
  const ws = db.select().from(tables.workspace).all()[0];
  if (ws) {
    let model = ws.aiProvider === "chatgpt" ? ws.aiModel : null;
    if (!model) model = (await listModels(db).catch(() => []))[0]?.slug ?? null;
    db.update(tables.workspace).set({ aiProvider: "chatgpt", aiModel: model }).where(eq(tables.workspace.id, ws.id)).run();
  }
  return { returnTo: p.returnTo, email };
}

let refreshing: Promise<ChatGptCredentials> | null = null;

/** A current access token, refreshing it (once, however many callers) when it is about to expire. */
export async function chatgptAccessToken(db: Db, now = () => Date.now()): Promise<string> {
  const c = chatgptCredentials(db);
  if (!c) throw new HttpError(400, "ChatGPT is not connected — sign in under Settings → AI.");
  if (c.expiresAt - REFRESH_EARLY_MS > now()) return c.accessToken;
  refreshing ??= (async () => {
    try {
      const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: c.clientId, resource: SIWC.resource });
      const next: ChatGptCredentials = {
        ...c,
        accessToken: t.access_token,
        refreshToken: t.refresh_token ?? c.refreshToken,
        expiresAt: now() + t.expires_in * 1000,
        ...(t.id_token ? { idToken: t.id_token } : {}),
      };
      saveCredentials(db, next); // before anyone uses it: the old refresh token is spent
      return next;
    } finally {
      refreshing = null;
    }
  })();
  return (await refreshing).accessToken;
}

export interface ChatGptModel {
  slug: string;
  name: string;
}

/** The models this plan offers, for the picker. */
export async function listModels(db: Db): Promise<ChatGptModel[]> {
  const token = await chatgptAccessToken(db);
  const res = await fetch(`${SIWC.resource}/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new HttpError(502, `could not list ChatGPT models (${res.status})`);
  const body = (await res.json()) as { models?: { slug: string; display_name?: string; visibility?: string }[] };
  return (body.models ?? []).filter((m) => m.visibility === "list").map((m) => ({ slug: m.slug, name: m.display_name ?? m.slug }));
}

/** What the browser shows once a sign-in the app waits for has landed. */
export const SIGNED_IN_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signed in · Orrama</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f1e7;color:#1d1b18}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:0;color:#5b5650}@media (prefers-color-scheme:dark){body{background:#0f1626;color:#e9edf5}p{color:#a9b1c2}}</style>
<main><h1>Signed in.</h1><p>You can close this tab and go back to Orrama.</p></main></html>`;

/** Forget the connection. The workspace stops using ChatGPT; another provider's stored key is untouched. */
export function disconnect(db: Db): void {
  db.delete(tables.meta).where(eq(tables.meta.key, CREDS)).run();
  const ws = db.select().from(tables.workspace).all()[0];
  if (ws?.aiProvider === "chatgpt") db.update(tables.workspace).set({ aiProvider: null, aiModel: null }).where(eq(tables.workspace.id, ws.id)).run();
}
