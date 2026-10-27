import { describe, expect, it } from "vitest";
import { orramaApi } from "../src/http.js";

/** A fetch that records what it was asked and answers `status` with `body`. */
function fakeFetch(status = 200, body: unknown = { ok: true }) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { seen, f };
}

describe("orramaApi: the MCP server's HTTP client", () => {
  it("a request with no body says nothing about JSON (Fastify refuses a DELETE that does)", async () => {
    const { seen, f } = fakeFetch();
    await orramaApi("http://localhost:4623", "bslt_abc", f)("/api/events/ev-1", "DELETE");
    expect(seen[0]!.url).toBe("http://localhost:4623/api/events/ev-1");
    expect(seen[0]!.init).toMatchObject({ method: "DELETE", body: undefined });
    expect(seen[0]!.init.headers).toEqual({ Authorization: "Bearer bslt_abc" });
  });

  it("a body goes as JSON, with the header that says so", async () => {
    const { seen, f } = fakeFetch();
    await orramaApi("http://localhost:4623", "abc", f)("/api/events", "POST", { title: "x" });
    expect(seen[0]!.init).toMatchObject({ method: "POST", body: '{"title":"x"}', headers: { Authorization: "Bearer bslt_abc", "Content-Type": "application/json" } });
  });

  it("an error status throws with the server's words", async () => {
    const { f } = fakeFetch(403, { error: "only the owner can edit an event" });
    await expect(orramaApi("http://x", "abc", f)("/api/events/ev-1", "PATCH", {})).rejects.toThrow("Orrama API error (403): only the owner can edit an event");
  });
});
