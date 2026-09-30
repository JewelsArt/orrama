/**
 * The workspace's configured model, for every server-side AI call.
 *
 * One place decides which provider answers — Anthropic, Google, or anything
 * OpenAI-compatible at a base URL — so a feature cannot quietly hard-wire one.
 * The Planning estimate did: it POSTed to api.anthropic.com itself, and on a
 * workspace configured for Gemini it simply never ran.
 */
import type { LanguageModel } from "ai";
import { tables, type Db } from "./db.js";
import { decryptSecret } from "./secrets.js";

export interface AiConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string | null;
}

/** The configured provider, or null when AI is not set up. */
export function aiConfig(db: Db): AiConfig | null {
  const ws = db.select().from(tables.workspace).all()[0];
  if (!ws?.aiProvider || !ws.aiKeyEncrypted || !ws.aiModel) return null;
  return { provider: ws.aiProvider, apiKey: decryptSecret(ws.aiKeyEncrypted), model: ws.aiModel, baseUrl: ws.aiBaseUrl ?? null };
}

export async function resolveModel(c: AiConfig): Promise<LanguageModel> {
  if (c.provider === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({ apiKey: c.apiKey })(c.model);
  }
  if (c.provider === "google") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    return createGoogleGenerativeAI({ apiKey: c.apiKey })(c.model);
  }
  // openai-compatible: custom baseUrl (e.g. Gemini's OpenAI-compat endpoint), else env, else OpenAI.
  const { createOpenAI } = await import("@ai-sdk/openai");
  return createOpenAI({ apiKey: c.apiKey, baseURL: c.baseUrl || process.env.BASALT_OPENAI_BASE_URL })(c.model);
}
