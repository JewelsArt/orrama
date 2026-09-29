/** Tiny typed fetch client. The server is the permission gate — the UI just renders. */

export interface Team {
  id: string;
  slug: string;
  name: string;
  color: string;
  icon: string;
  total?: number;
  done?: number;
}

/** Theme + palette, stored on the account so every device shows the same app. */
export interface Appearance {
  theme?: string;
  vision?: string;
  profiles?: { id: string; name: string; colors: string[] }[];
}

export interface Me {
  id: string;
  email: string;
  username: string;
  displayName: string;
  isOwner: boolean;
  avatar: string;
  appearance: Appearance | null;
  teams: Team[];
}

export interface TreeNote {
  id: string;
  path: string;
  folder: string;
  title: string;
  hash: string;
  mtimeMs?: number;
  tags: string[];
  openTasks: number;
}

export interface NoteLink {
  target: string;
  heading?: string;
  alias?: string;
  raw: string;
  line: number;
  targetId: string | null;
  locked: boolean;
}

export interface NoteDetail {
  id: string;
  path: string;
  title: string;
  content: string;
  hash: string;
  tags: { tag: string; line: number }[];
  tasks: TaskLine[];
  links: NoteLink[];
  backlinks: { fromId: string; fromTitle: string; fromPath: string; line: number; context: string }[];
  canEdit: boolean;
}

export interface TaskLine {
  line: number;
  checked: boolean;
  text: string;
  raw: string;
  assignee?: string;
  start?: string;
  due?: string;
  priority?: number;
  /** A `#deadline` task (core ParsedTask.key). */
  key?: boolean;
  blockId?: string;
  indent: number;
}

export interface TaskObject {
  id: string;
  noteId: string;
  blockId: string;
  status: "todo" | "in-progress" | "done" | "blocked" | "orphaned";
  assigneeId: string | null;
  due: string | null;
  description: string;
}

export interface DashboardTask extends TaskLine {
  noteId: string;
  notePath: string;
  noteTitle: string;
  project: string | null;
  object: TaskObject | null;
}

export interface DashboardData {
  team: Team;
  projects: {
    project: string;
    projectId: string | null;
    slug: string | null;
    /** Front-matter lifecycle: "", planning, on-track, at-risk, blocked, sleeping, cancelled, done. */
    status: string;
    total: number;
    done: number;
    assignees: string[];
    lastActivityMs?: number;
    domain: "personal" | "professional" | "academic" | null;
    tasks: DashboardTask[];
  }[];
  members: {
    id: string;
    username: string;
    displayName: string;
    avatar: string;
    openTasks: number;
    inProgress: { text: string; noteId: string; project: string | null }[];
    assigned: { text: string; noteId: string; due?: string; priority?: number }[];
    lastEdit: { id: string; title: string; at: number } | null;
  }[];
  orphaned: { id: string; noteId: string; blockId: string; updatedAt: number }[];
}

let token = localStorage.getItem("basalt-token") ?? "";

export function setToken(t: string) {
  token = t;
  localStorage.setItem("basalt-token", t);
}

export function clearToken() {
  token = "";
  localStorage.removeItem("basalt-token");
}

/**
 * The last address that signed in on this device. Only a convenience: it decides
 * whether launch shows the quick-unlock screen or the full sign-in form, and it
 * pre-fills the field. Never a credential.
 */
const LAST_EMAIL_KEY = "basalt-last-email";
export const lastEmail = () => localStorage.getItem(LAST_EMAIL_KEY) ?? "";
export const rememberEmail = (email: string) => localStorage.setItem(LAST_EMAIL_KEY, email);

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

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

/** Same auth as api(), but for bytes: project documents are behind the bearer
 *  token, so a plain <a href> would 401. */
export async function apiBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.blob();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
