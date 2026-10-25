/**
 * Is this key good for this model? Asked before a key is saved (first run's Use a key and
 * Settings → Orr & AI, `POST /api/admin/ai/check`), so a mistyped key is said at once instead
 * of at the first question to Orr. One GET of the model at the provider's own fixed host:
 * nothing is generated and nothing is spent. The key goes in a header, never in the URL.
 *
 * Answers the problem in words, or null when the key and the model are good.
 */
export type KeyProvider = "anthropic" | "google";

const NAME: Record<KeyProvider, string> = { anthropic: "Anthropic", google: "Google" };
const HOSTS: Record<KeyProvider, string> = { anthropic: "https://api.anthropic.com", google: "https://generativelanguage.googleapis.com" };
let hosts = HOSTS;
/** Tests point the check at a fake provider. */
export function setKeyCheckHostsForTests(h: Partial<Record<KeyProvider, string>> | null): void {
  hosts = h ? { ...HOSTS, ...h } : HOSTS;
}

const TIMEOUT_MS = 15_000;

function request(provider: KeyProvider, model: string, key: string): { url: string; headers: Record<string, string> } {
  if (provider === "anthropic") {
    return { url: `${hosts.anthropic}/v1/models/${encodeURIComponent(model)}`, headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } };
  }
  const name = model.replace(/^models\//, "");
  return { url: `${hosts.google}/v1beta/models/${encodeURIComponent(name)}`, headers: { "x-goog-api-key": key } };
}

export async function checkKey(provider: KeyProvider, model: string, key: string): Promise<string | null> {
  const who = NAME[provider];
  const { url, headers } = request(provider, model.trim(), key.trim());
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  } catch {
    return `Orrama couldn't reach ${who} to check the key. Check the connection and try again.`;
  }
  if (res.ok) return null;
  // Google answers a key it doesn't know with a 400 that says API_KEY_INVALID.
  const text = res.status === 400 ? await res.text().catch(() => "") : "";
  if (res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid/i.test(text)) {
    return `${who} didn't accept that key. Check that you copied all of it.`;
  }
  if (res.status === 404) return `${who} has no model called ${model.trim()} for this key. Check the model's name.`;
  if (res.status === 429) return `${who} is turning requests away for now. Try again in a minute.`;
  return `${who} didn't answer the check (${res.status}). Try again in a moment.`;
}
