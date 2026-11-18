import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { connectionApi, NOT_CONNECTED, NOT_OPEN, orramaApi, TURNED_OFF } from "../src/http.js";

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

describe("connectionApi: the desktop app's connection file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-mcp-conn-"));
  const file = path.join(dir, "connection.json");
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const SECRET = "bslt_0123456789abcdef0123456789abcdef0123456789abcdef";

  it("reads the address and token at every call, so a new port or token needs nothing in Claude", async () => {
    const { seen, f } = fakeFetch();
    const api = connectionApi(file, f);
    fs.writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:4623", token: SECRET, tokenId: "tok-1", userId: "u-1" }));
    await api("/api/home");
    fs.writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:4901", token: "bslt_other", tokenId: "tok-2", userId: "u-1" }));
    await api("/api/events", "POST", { title: "x" });
    expect(seen.map((s) => s.url)).toEqual(["http://127.0.0.1:4623/api/home", "http://127.0.0.1:4901/api/events"]);
    expect(seen.map((s) => (s.init.headers as Record<string, string>).Authorization)).toEqual([`Bearer ${SECRET}`, "Bearer bslt_other"]);
  });

  it("says what to do, never the token: not connected, Orrama closed, the connection turned off", async () => {
    fs.rmSync(file, { force: true });
    await expect(connectionApi(file, fakeFetch().f)("/api/home")).rejects.toThrow(NOT_CONNECTED);
    fs.writeFileSync(file, "{ half written");
    await expect(connectionApi(file, fakeFetch().f)("/api/home")).rejects.toThrow(NOT_CONNECTED);
    fs.writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:4623", token: SECRET }));
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const closed = connectionApi(file, refused)("/api/home");
    await expect(closed).rejects.toThrow(NOT_OPEN);
    await expect(closed).rejects.not.toThrow(SECRET);
    await expect(connectionApi(file, fakeFetch(401, { error: "invalid API token" }).f)("/api/home")).rejects.toThrow(TURNED_OFF);
    // Any other refusal keeps the server's words (the ACL said no, a note changed since).
    await expect(connectionApi(file, fakeFetch(403, { error: "not allowed" }).f)("/api/home")).rejects.toThrow("Orrama API error (403): not allowed");
  });
});
