/**
 * A slow answer to an older request must not overwrite a newer one. Nothing
 * in the client could cancel a request, and 14 loaders set state from
 * whichever reply came back last: open note A then B, and A's reply landing
 * second opened A while B was selected (audit: "zero AbortControllers").
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", { getItem: () => "t-abc", setItem: () => {}, removeItem: () => {} });
vi.stubGlobal("window", new EventTarget());

/** fetch whose replies the test releases by hand, in any order. Like a
 *  reply already on the wire, it ignores the signal — the worst case. */
const pending = new Map<string, (body: unknown) => void>();
const seen: { url: string; signal?: AbortSignal }[] = [];
vi.stubGlobal("fetch", (url: string, init: { signal?: AbortSignal }) => {
  seen.push({ url, signal: init.signal });
  return new Promise<Response>((resolve) => pending.set(url, (body) => resolve(new Response(JSON.stringify(body)))));
});
const reply = async (url: string, body: unknown) => {
  pending.get(url)!(body);
  await new Promise((r) => setTimeout(r, 0));
};

let mod: typeof import("./api.js");
beforeAll(async () => {
  mod = await import("./api.js");
});

describe("cancelling a request", () => {
  it("hands the signal to fetch", async () => {
    const ac = new AbortController();
    const p = mod.api("GET", "/api/one", undefined, { signal: ac.signal });
    expect(seen.find((s) => s.url === "/api/one")?.signal).toBe(ac.signal);
    await reply("/api/one", { ok: 1 });
    await expect(p).resolves.toEqual({ ok: 1 });
  });

  it("a reply that lands after the cancel is never returned", async () => {
    const ac = new AbortController();
    const p = mod.api("GET", "/api/late", undefined, { signal: ac.signal }).catch((e: unknown) => e);
    ac.abort();
    await reply("/api/late", { stale: true });
    expect(mod.isAbort(await p)).toBe(true);
  });

  it("the same for bytes (apiBlob)", async () => {
    const ac = new AbortController();
    const p = mod.apiBlob("/api/file", { signal: ac.signal }).catch((e: unknown) => e);
    ac.abort();
    await reply("/api/file", "bytes");
    expect(mod.isAbort(await p)).toBe(true);
  });
});

describe("latestOnly", () => {
  it("the older of two overlapping loads never lands; the newer does", async () => {
    const next = mod.latestOnly();
    const shown: string[] = [];
    const open = (id: string) =>
      mod.api<{ id: string }>("GET", `/api/note/${id}`, undefined, { signal: next() }).then((n) => shown.push(n.id), mod.unlessAborted);
    const a = open("A");
    const b = open("B");
    await reply("/api/note/B", { id: "B" });
    await reply("/api/note/A", { id: "A" }); // the slow one, last
    await Promise.all([a, b]);
    expect(shown).toEqual(["B"]);
  });
});

describe("unlessAborted", () => {
  it("swallows a cancellation and passes any other error on", () => {
    expect(() => mod.unlessAborted(new DOMException("x", "AbortError"))).not.toThrow();
    expect(() => mod.unlessAborted(new Error("boom"))).toThrow("boom");
  });
});
