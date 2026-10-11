/** Tiny typed fetch client. The server is the permission gate — the UI just renders. */

// What the server sends is typed once, in packages/schema/src/responses.ts, and
// checked against the real server by apps/server/test/contract.test.ts.
// Type-only: no zod reaches the bundle.
export type {
  Appearance,
  DashboardData,
  DashboardTask,
  Me,
  NoteDetail,
  NoteLink,
  SessionInfo,
  TaskLine,
  TaskObject,
  Team,
  TreeNote,
} from "@basalt/schema/responses";
import type { Me } from "@basalt/schema/responses";
import { readKey, removeKey, writeKey } from "./storage.js";

const TOKEN_KEY = "basalt-token";

/**
 * The session token, read on first use rather than when this module loads: a module-level read
 * ran before anything could catch it, so a browser that refuses storage (iOS Safari with "Block
 * All Cookies") failed the import and left a blank page instead of the sign-in screen (WEB-025).
 */
let token: string | undefined;
export const getToken = (): string => (token ??= readKey(TOKEN_KEY) ?? "");

export function setToken(t: string) {
  token = t;
  writeKey(TOKEN_KEY, t);
}

export function clearToken() {
  token = "";
  removeKey(TOKEN_KEY);
}

/**
 * The last address that signed in on this device. Only a convenience: it decides
 * whether launch shows the quick-unlock screen or the full sign-in form, and it
 * pre-fills the field. Never a credential.
 */
const LAST_EMAIL_KEY = "basalt-last-email";
export const lastEmail = () => readKey(LAST_EMAIL_KEY) ?? "";
export const rememberEmail = (email: string) => writeKey(LAST_EMAIL_KEY, email);

/** Does this device have a biometric/platform authenticator at all? */
export async function touchIdAvailable(): Promise<boolean> {
  if (typeof PublicKeyCredential === "undefined") return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// WebAuthn speaks ArrayBuffers; JSON does not. These two convert at the boundary
// so the rest of the app only ever handles base64url strings.
const b64urlToBytes = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const bytesToB64url = (b: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Enrol this device's authenticator (Touch ID) against the signed-in account. */
export async function enrolTouchId(label: string): Promise<void> {
  const { challengeId, options } = await api<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
    "POST",
    "/api/auth/webauthn/register/options",
  );
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: b64urlToBytes(options.challenge),
      user: { ...options.user, id: b64urlToBytes(options.user.id) },
      excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({ ...c, id: b64urlToBytes(c.id) })),
    } as unknown as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("no credential created");
  const res = credential.response as AuthenticatorAttestationResponse;
  await api("POST", "/api/auth/webauthn/register/verify", {
    challengeId,
    label,
    response: {
      id: credential.id,
      rawId: bytesToB64url(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: bytesToB64url(res.clientDataJSON),
        attestationObject: bytesToB64url(res.attestationObject),
        transports: res.getTransports?.() ?? [],
      },
    },
  });
}

/** Unlock with Touch ID. Returns the same {token, user} shape as a password login. */
export async function unlockWithTouchId(email: string): Promise<{ token: string; user: Me }> {
  const { challengeId, options } = await api<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
    "POST",
    "/api/auth/webauthn/login/options",
    { email },
  );
  const credential = (await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: b64urlToBytes(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map((c) => ({ ...c, id: b64urlToBytes(c.id) })),
    } as unknown as PublicKeyCredentialRequestOptions,
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("no assertion");
  const res = credential.response as AuthenticatorAssertionResponse;
  return api("POST", "/api/auth/webauthn/login/verify", {
    challengeId,
    response: {
      id: credential.id,
      rawId: bytesToB64url(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: bytesToB64url(res.clientDataJSON),
        authenticatorData: bytesToB64url(res.authenticatorData),
        signature: bytesToB64url(res.signature),
        ...(res.userHandle ? { userHandle: bytesToB64url(res.userHandle) } : {}),
      },
    },
  });
}

/** Shapes the server sends; the browser types want buffers, so these are the JSON twins. */
interface PublicKeyCredentialCreationOptionsJSON {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: { id: string; type?: string; transports?: string[] }[];
  [k: string]: unknown;
}
interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  allowCredentials?: { id: string; type?: string; transports?: string[] }[];
  [k: string]: unknown;
}

/**
 * `signal` cancels the request. A reply that lands after its request was
 * cancelled is never returned — it rejects with an AbortError (isAbort) — so
 * a slow answer to an older question cannot overwrite a newer one.
 */
export async function api<T>(method: string, url: string, body?: unknown, opts: { signal?: AbortSignal } = {}): Promise<T> {
  const { signal } = opts;
  const token = getToken();
  const res = await fetch(url, {
    method,
    signal,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    // A session ended elsewhere (signed out from another device, revoked in
    // Settings): back to the sign-in screen instead of a page of failures.
    if (res.status === 401 && token && !url.startsWith("/api/auth/")) window.dispatchEvent(new Event(SESSION_ENDED));
    throw new ApiError(res.status, data.error ?? res.statusText);
  }
  const data = (await res.json()) as T;
  if (signal?.aborted) throw abortError();
  return data;
}

const abortError = () => new DOMException("superseded by a newer request", "AbortError");

/** A request cancelled by its signal — expected, never an error to show. */
export const isAbort = (e: unknown): boolean => (e as { name?: unknown } | null)?.name === "AbortError";

/** For `.catch()`: swallow a cancellation, let anything else through as before. */
export const unlessAborted = (e: unknown): void => {
  if (!isAbort(e)) throw e;
};

/**
 * One request of a kind in flight: each call cancels the previous one and
 * returns the signal for the next. For loaders a click or a keystroke can
 * start again before the last answer is back — open a note, flip a week.
 */
export function latestOnly(): () => AbortSignal {
  let ctrl: AbortController | undefined;
  return () => {
    ctrl?.abort();
    ctrl = new AbortController();
    return ctrl.signal;
  };
}

/** Fired when the server stops accepting this browser's session. */
export const SESSION_ENDED = "basalt:session-ended";


/** Sign out on the server too — the token stops working everywhere it was copied. */
export async function signOut(): Promise<void> {
  try {
    await api("POST", "/api/auth/logout");
  } catch {
    // Already ended, or offline: forgetting it locally is still right.
  }
  clearToken();
}

/** Same auth as api(), but for bytes: project documents are behind the bearer
 *  token, so a plain <a href> would 401. */
export async function apiBlob(url: string, opts: { signal?: AbortSignal } = {}): Promise<Blob> {
  const token = getToken();
  const res = await fetch(url, { signal: opts.signal, headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  const blob = await res.blob();
  if (opts.signal?.aborted) throw abortError();
  return blob;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
