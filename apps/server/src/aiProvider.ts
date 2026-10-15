/**
 * The workspace's configured model, for every server-side AI call.
 *
 * One place decides which provider answers — Anthropic, Google, or anything
 * OpenAI-compatible at a base URL — so a feature cannot quietly hard-wire one.
 * The Planning estimate did: it POSTed to api.anthropic.com itself, and on a
 * workspace configured for Gemini it simply never ran.
 */
import { generateText, streamText, type LanguageModel } from "ai";
import { chatgptAccessToken, chatgptCredentials } from "./chatgpt.js";
import { tables, type Db } from "./db.js";
import { decryptSecret } from "./secrets.js";

export interface AiConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string | null;
  /** ChatGPT plan only: a current OAuth access token (chatgpt.ts), refreshed as needed. */
  accessToken?: () => Promise<string>;
}

/** The configured provider, or null when AI is not set up. */
export function aiConfig(db: Db): AiConfig | null {
  const ws = db.select().from(tables.workspace).all()[0];
  if (!ws?.aiProvider || !ws.aiModel) return null;
  if (ws.aiProvider === "chatgpt") {
    if (!chatgptCredentials(db)) return null;
    return { provider: "chatgpt", apiKey: "", model: ws.aiModel, baseUrl: null, accessToken: () => chatgptAccessToken(db) };
  }
  if (!ws.aiKeyEncrypted) return null;
  let apiKey: string;
  try {
    apiKey = decryptSecret(ws.aiKeyEncrypted);
  } catch {
    // Sealed under another ORRAMA_SECRET_KEY (changed without the rotation
    // script) or a damaged row. AI is off, as with no key, rather than every
    // caller failing: it took Planning and /api/ai/status down with a bare
    // 500 (audit AI-010). Said once per stored value, not on every page load.
    if (unreadableKeyWarned !== ws.aiKeyEncrypted) {
      unreadableKeyWarned = ws.aiKeyEncrypted;
      console.error("[ai] the stored AI key cannot be decrypted (ORRAMA_SECRET_KEY changed?) - AI is off until it is entered again in Settings -> Orr & AI, or the old secret is rotated with `pnpm --dir apps/server rotate-secret-key`");
    }
    return null;
  }
  return { provider: ws.aiProvider, apiKey, model: ws.aiModel, baseUrl: ws.aiBaseUrl ?? null };
}
let unreadableKeyWarned: string | null = null;

/**
 * Per-provider request options. The ChatGPT plan requires `store: false`;
 * with nothing stored server-side, reasoning from one tool step has to travel
 * to the next in the request itself, encrypted.
 */
export function callOptions(c: AiConfig) {
  return c.provider === "chatgpt" ? { openai: { store: false, include: ["reasoning.encrypted_content"] } } : undefined;
}

/**
 * One prompt in, the whole answer out. The ChatGPT plan only answers streamed
 * requests, so for it the stream is collected to the end — without a token
 * cap, which its requests may not carry. Every other provider is asked as it
 * always was, in one non-streaming call.
 */
export async function completeText(
  c: AiConfig,
  args: { system?: string; prompt: string; abortSignal?: AbortSignal; maxOutputTokens?: number; maxRetries?: number },
): Promise<string> {
  const model = await resolveModel(c);
  if (c.provider !== "chatgpt") return (await generateText({ model, ...args })).text;
  const { maxOutputTokens: _cap, ...rest } = args;
  return await streamText({ model, ...rest, providerOptions: callOptions(c) }).text;
}

export async function resolveModel(c: AiConfig): Promise<LanguageModel> {
  if (c.provider === "chatgpt") {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return createOpenAI({ apiKey: await c.accessToken!() }).responses(c.model);
  }
  if (c.provider === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({ apiKey: c.apiKey })(c.model);
  }
  if (c.provider === "google") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    return createGoogleGenerativeAI({ apiKey: c.apiKey })(c.model);
  }
  // openai-compatible: custom baseUrl (e.g. Gemini's OpenAI-compat endpoint),
  // else env, else OpenAI. Chat Completions, always: it is the API every
  // "compatible" server implements (Gemini's compat URL, Ollama, LM Studio,
  // vLLM, Groq), and OpenAI serves it too. Calling the provider function
  // directly gives a Responses model (`POST /responses`), which those servers
  // answer with 404 (audit AI-004).
  const { createOpenAI } = await import("@ai-sdk/openai");
  return createOpenAI({ apiKey: c.apiKey, baseURL: c.baseUrl || process.env.ORRAMA_OPENAI_BASE_URL }).chat(c.model);
}
