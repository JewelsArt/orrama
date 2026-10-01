/**
 * Sign in with ChatGPT: the agent runs on the owner's ChatGPT plan (Plus or
 * Pro) instead of an API key. OpenAI offers this to open-source and personal
 * apps that run locally — which Basalt is: the server on this Mac makes every
 * call (developers.openai.com/siwc, "ChatGPT plan usage for open-source and
 * locally hosted apps"). Usage comes out of the plan's weekly allowance; the
 * owner caps it per app in ChatGPT's settings.
 *
 * Implemented from the documented protocol, not OpenAI's DevKit (that code is
 * under a noncommercial licence; Basalt is Apache-2.0):
 *
 *   1. start   — a PKCE authorization-code request to auth.openai.com, with
 *                `client_id=dynamic_agent_client` the first time (OpenAI
 *                registers this install and returns an issued client id on
 *                the callback) and a stable `ext_agent_host_id` per install.
 *                The redirect must be http://127.0.0.1:<port>/callback, so
 *                sign-in happens in a browser on this Mac.
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
  appName: "Basalt",
  /** Where a user caps or checks what Basalt uses of their plan. */
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
    return null; // e.g. BASALT_SECRET_KEY rotated: sign in again
  }
}

function saveCredentials(db: Db, c: ChatGptCredentials): void {
  writeMeta(db, CREDS, encryptSecret(JSON.stringify(c)));
}

/** A stable id for this Basalt install, as the protocol asks: `urn:uuid:…`. */
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
  returnTo: string;
  at: number;
}
const pending = new Map<string, Pending>();
const b64url = (b: Buffer) => b.toString("base64url");

/**
 * The URL that starts sign-in. `port` is the one this server listens on;
 * `returnTo` is the app origin to send the browser back to afterwards.
 */
export function startSignIn(db: Db, port: number, returnTo: string, now = Date.now()): string {
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
export async function finishSignIn(db: Db, query: Record<string, string | undefined>, now = Date.now()): Promise<{ returnTo: string; email: string | null }> {
  const state = query.state ?? "";
  const p = pending.get(state);
  pending.delete(state); // single use, whatever happens next
  if (!p || now - p.at > PENDING_MS) throw new HttpError(400, "This sign-in link has expired. Start again from Settings → AI.");
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

/** Forget the connection. The workspace stops using ChatGPT; another provider's stored key is untouched. */
export function disconnect(db: Db): void {
  db.delete(tables.meta).where(eq(tables.meta.key, CREDS)).run();
  const ws = db.select().from(tables.workspace).all()[0];
  if (ws?.aiProvider === "chatgpt") db.update(tables.workspace).set({ aiProvider: null, aiModel: null }).where(eq(tables.workspace.id, ws.id)).run();
}
