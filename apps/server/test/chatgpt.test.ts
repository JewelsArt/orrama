/**
 * Sign in with ChatGPT (chatgpt.ts), against a fake OpenAI: the documented
 * authorize URL, the callback's checks (one-time state, ID token signature,
 * issuer, audience, nonce), refresh with rotating refresh tokens, and the
 * request the plan requires (`store: false`, streamed, bearer = access token).
 */
import type { webcrypto } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-chatgpt-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";
// The tailnet name is a host this server answers to, as in the real plist —
// so the "not from this machine" refusal below is the route's, not the Host check's.
process.env.ORRAMA_PUBLIC_ORIGINS = "http://localhost:4623,https://juless-macbook-pro.tail790a29.ts.net";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const chatgpt = await import("../src/chatgpt.js");
const { aiConfig, completeText } = await import("../src/aiProvider.js");

const ISSUED = "client-issued-123";
const GEMINI_KEY = "g-gemini-key-0123456789";
type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
const tokens: Record<string, string> = {};
// Node 22's types (the runtime this targets) have no global CryptoKey.
type CryptoKey = webcrypto.CryptoKey;
let signer: CryptoKey;
let stranger: CryptoKey;

// ---- a fake OpenAI ---------------------------------------------------------
const calls: { url: string; body: string; auth: string | null }[] = [];
let refreshCount = 0;
let nextNonce = "";
let idClaims: Record<string, unknown> = {};
let signWith: () => CryptoKey = () => signer;

const idToken = async (aud: string) => {
  const { aud: forcedAud, ...claims } = idClaims;
  return new SignJWT({ nonce: nextNonce, email: "jules@example.com", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://auth.openai.com")
    .setAudience(typeof forcedAud === "string" ? forcedAud : aud)
    .setSubject("user-abc")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signWith());
};

const sse = (events: object[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

const realFetch = globalThis.fetch;
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const body = typeof init?.body === "string" ? init.body : "";
  if (!url.startsWith("https://auth.openai.com") && !url.startsWith("https://api.openai.com")) return realFetch(input, init);
  calls.push({ url, body, auth: headers.get("authorization") });
  if (url === chatgpt.SIWC.token) {
    const form = new URLSearchParams(body);
    if (form.get("grant_type") === "authorization_code") {
      return Response.json({ access_token: "access-1", refresh_token: "refresh-1", id_token: await idToken(form.get("client_id")!), expires_in: 3600, token_type: "Bearer" });
    }
    refreshCount++;
    await new Promise((r) => setTimeout(r, 30)); // concurrent callers arrive meanwhile
    return Response.json({ access_token: `access-r${refreshCount}`, refresh_token: `refresh-r${refreshCount}`, expires_in: 3600, token_type: "Bearer" });
  }
  if (url === `${chatgpt.SIWC.resource}/models`) {
    return Response.json({ models: [{ slug: "gpt-hidden", display_name: "Hidden", visibility: "hide" }, { slug: "gpt-plan-best", display_name: "GPT Plan Best", visibility: "list" }] });
  }
  if (url === `${chatgpt.SIWC.resource}/responses`) {
    const msg = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello from the plan", annotations: [] }] };
    return sse([
      { type: "response.created", response: { id: "resp_1", created_at: 0, model: "gpt-plan-best", service_tier: null } },
      { type: "response.output_item.added", output_index: 0, item: { ...msg, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hello from the plan", logprobs: [] },
      { type: "response.output_item.done", output_index: 0, item: msg },
      { type: "response.completed", response: { id: "resp_1", created_at: 0, model: "gpt-plan-best", status: "completed", incomplete_details: null, usage: { input_tokens: 3, output_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    ]);
  }
  return new Response("not found", { status: 404 });
};

const call = async (who: string, method: "GET" | "POST", url: string, opts: { payload?: object; headers?: Record<string, string> } = {}) => {
  const r = await built.app.inject({ method, url, headers: { ...signedIn(tokens[who]), ...opts.headers }, ...(opts.payload ? { payload: opts.payload } : {}) });
  return { status: r.statusCode, body: r.body, headers: r.headers, json: (() => { try { return r.json(); } catch { return null; } })() };
};
const start = async () => new URL((await call("jules", "POST", "/api/admin/ai/chatgpt/start", { headers: { origin: "http://localhost:4623" } })).json.url as string);
const callback = (q: Record<string, string>) => built.app.inject({ method: "GET", url: `/callback?${new URLSearchParams(q)}` });
const creds = () => built.db.select().from(tables.meta).where(eq(tables.meta.key, "chatgpt_credentials")).get()?.value;
const ws = () => built.db.select().from(tables.workspace).all()[0]!;

beforeAll(async () => {
  vi.stubGlobal("fetch", fakeFetch);
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  signer = privateKey;
  stranger = (await generateKeyPair("RS256")).privateKey;
  chatgpt.setKeySetForTests(createLocalJWKSet({ keys: [{ ...((await exportJWK(publicKey)) as JWK), kid: "k1", alg: "RS256" }] }));
  built = await buildServer();
  for (const who of ["jules", "erin"]) {
    tokens[who] = sessionOf(await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@orrama.dev`, password: "orrama-demo" } }));
  }
  // Gemini configured first: connecting ChatGPT must not lose its key.
  expect((await call("jules", "POST", "/api/admin/ai", { payload: { provider: "google", model: "gemini-2.5-flash", apiKey: GEMINI_KEY } })).status).toBe(200);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  chatgpt.setKeySetForTests(null);
  await built.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("starting sign-in", () => {
  it("sends the documented authorize request, with a host id that stays the same", async () => {
    const a = await start();
    const b = await start();
    expect(a.origin + a.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    const q = Object.fromEntries(a.searchParams);
    expect(q).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Orrama",
      response_type: "code",
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      code_challenge_method: "S256",
    });
    expect(q.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(q.ext_agent_host_id).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(b.searchParams.get("ext_agent_host_id")).toBe(q.ext_agent_host_id);
    expect(b.searchParams.get("state")).not.toBe(q.state);
    expect(q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is for the owner, from this machine", async () => {
    expect((await call("erin", "POST", "/api/admin/ai/chatgpt/start")).status).toBe(403);
    const phone = await built.app.inject({ method: "POST", url: "/api/admin/ai/chatgpt/start", headers: { ...signedIn(tokens.jules, "https://juless-macbook-pro.tail790a29.ts.net"), host: "juless-macbook-pro.tail790a29.ts.net" } });
    expect(phone.statusCode).toBe(400);
  });
});

describe("the callback", () => {
  it("rejects an unknown state, and an ID token that is not OpenAI's, or not for this request", async () => {
    expect((await callback({ state: "made-up", code: "c" })).statusCode).toBe(400);

    for (const forge of [
      () => { signWith = () => stranger; },                   // signed by someone else
      () => { idClaims = { aud: "another-client" }; },        // for another app
      () => { nextNonce = "replayed-nonce"; },                // for another sign-in
    ]) {
      const u = await start();
      nextNonce = u.searchParams.get("nonce")!;
      signWith = () => signer;
      idClaims = {};
      forge();
      const res = await callback({ state: u.searchParams.get("state")!, code: "code-1", client_id: ISSUED });
      expect(res.statusCode, String(forge)).toBe(502);
      expect(creds()).toBeUndefined();
    }
    signWith = () => signer;
    idClaims = {};
  });

  it("signs in: verifies, stores encrypted, switches the agent to the plan, returns to the app", async () => {
    const u = await start();
    nextNonce = u.searchParams.get("nonce")!;
    const res = await callback({ state: u.searchParams.get("state")!, code: "code-1", client_id: ISSUED });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("http://localhost:4623/?ai=chatgpt-connected");

    const exchange = calls.find((c) => c.url === chatgpt.SIWC.token)!;
    expect(Object.fromEntries(new URLSearchParams(exchange.body))).toMatchObject({ grant_type: "authorization_code", code: "code-1", client_id: ISSUED, resource: "https://api.openai.com/v1" });

    expect(creds()).toBeDefined();
    expect(creds()).not.toContain("refresh-1"); // encrypted
    expect(ws()).toMatchObject({ aiProvider: "chatgpt", aiModel: "gpt-plan-best" });
    const ai = await call("jules", "GET", "/api/admin/ai");
    expect(ai.json).toMatchObject({ provider: "chatgpt", model: "gpt-plan-best", configured: true, chatgpt: { connected: true, email: "jules@example.com" } });
    expect(ai.body).not.toMatch(/access-1|refresh-1|eyJ/);
  });

  it("started by the app, it lands in the system browser and tells it to close; the page that waits sees it", async () => {
    const r = await call("jules", "POST", "/api/admin/ai/chatgpt/start", { payload: { wait: true }, headers: { origin: "http://localhost:4623" } });
    const u = new URL(r.json.url as string);
    nextNonce = u.searchParams.get("nonce")!;
    const res = await callback({ state: u.searchParams.get("state")!, code: "code-3", client_id: ISSUED });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.body).toContain("Signed in.");
    expect(res.body).toContain("You can close this tab and go back to Orrama.");
    expect(res.headers.location).toBeUndefined();
    expect((await call("jules", "GET", "/api/admin/ai")).json).toMatchObject({ chatgpt: { connected: true } });
  });

  it("a state works once", async () => {
    const u = await start();
    nextNonce = u.searchParams.get("nonce")!;
    const q = { state: u.searchParams.get("state")!, code: "code-2", client_id: ISSUED };
    expect((await callback(q)).statusCode).toBe(302);
    expect((await callback(q)).statusCode).toBe(400);
  });

  it("signing in again reuses the issued client id", async () => {
    const u = await start();
    expect(u.searchParams.get("client_id")).toBe(ISSUED);
    expect(u.searchParams.get("id_token_hint")).toMatch(/^eyJ/);
    expect(u.searchParams.has("agent_name_hint")).toBe(false);
  });
});

describe("using the plan", () => {
  it("lists only the models meant to be listed", async () => {
    expect((await call("jules", "GET", "/api/admin/ai/chatgpt/models")).json).toEqual([{ slug: "gpt-plan-best", name: "GPT Plan Best" }]);
  });

  it("a request is streamed, not stored, carries the access token — and no token cap", async () => {
    calls.length = 0;
    const text = await completeText(aiConfig(built.db)!, { system: "Be brief.", prompt: "hi", maxOutputTokens: 50 });
    expect(text).toBe("hello from the plan");
    const req = calls.find((c) => c.url.endsWith("/responses"))!;
    expect(req.auth).toMatch(/^Bearer access-/);
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({ model: "gpt-plan-best", store: false, stream: true, include: ["reasoning.encrypted_content"] });
    expect(body.max_output_tokens).toBeUndefined();
  });

  it("an expired token is refreshed once, however many ask, and the new refresh token is kept", async () => {
    calls.length = 0;
    const later = () => Date.now() + 2 * 3_600_000;
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => chatgpt.chatgptAccessToken(built.db, later)));
    expect(new Set([a, b, c]).size).toBe(1);
    const refreshes = calls.filter((x) => x.url === chatgpt.SIWC.token);
    expect(refreshes).toHaveLength(1);
    expect(new URLSearchParams(refreshes[0]!.body).get("grant_type")).toBe("refresh_token");
    expect(chatgpt.chatgptCredentials(built.db)?.refreshToken).toBe(`refresh-r${refreshCount}`);
    // and the next call uses it without refreshing
    expect(await chatgpt.chatgptAccessToken(built.db)).toBe(a);
    expect(calls.filter((x) => x.url === chatgpt.SIWC.token)).toHaveLength(1);
  });

  it("changing the model needs no key", async () => {
    expect((await call("jules", "POST", "/api/admin/ai", { payload: { provider: "chatgpt", model: "gpt-other" } })).status).toBe(200);
    expect(ws().aiModel).toBe("gpt-other");
  });
});

describe("disconnecting", () => {
  it("forgets the plan and leaves the Gemini key where it was", async () => {
    const before = ws().aiKeyEncrypted;
    expect((await call("jules", "POST", "/api/admin/ai/chatgpt/disconnect")).status).toBe(200);
    expect(creds()).toBeUndefined();
    expect(ws()).toMatchObject({ aiProvider: null, aiModel: null, aiKeyEncrypted: before });
    // back to Gemini without re-pasting the key
    expect((await call("jules", "POST", "/api/admin/ai", { payload: { provider: "google", model: "gemini-2.5-flash", apiKey: "" } })).status).toBe(200);
    expect(aiConfig(built.db)?.apiKey).toBe(GEMINI_KEY);
  });
});

