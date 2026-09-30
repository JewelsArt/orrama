/**
 * Two reads that did work proportional to the whole vault on every request:
 * opening a note checked each outgoing link by filtering EVERY note through
 * the ACL (and re-reading the grants from the DB), and the tree sha256-hashed
 * every note. Counted here rather than timed.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-reads-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { app, store } = await buildServer();
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});
const token = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "mara@basalt.dev", password: "basalt-demo" } })).json().token;
const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

describe("vault reads", () => {
  it("opening a note with many links reads the grants once, and still locks what it should", async () => {
    // mara (marketing) can read Shared/ but not the #only/engineering runbook.
    const links = Array.from({ length: 40 }, (_, i) => `- [[Meeting Notes 2026-07-01]] ${i}`).join("\n");
    const put = await app.inject({
      method: "PUT",
      url: "/api/vault/note",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: "Shared/Many links.md", content: `# Many links\n\n${links}\n- [[Incident Runbook]]\n` },
    });
    expect(put.statusCode).toBe(200);
    const spy = vi.spyOn(store, "grants");
    const r = await get(`/api/vault/note/${put.json().id}`);
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(r.statusCode).toBe(200);
    expect(calls).toBeLessThanOrEqual(3);
    const out = r.json().links as { target: string; locked: boolean; targetId: string | null }[];
    expect(out.filter((l) => l.target === "Meeting Notes 2026-07-01").every((l) => !l.locked && l.targetId)).toBe(true);
    expect(out.find((l) => l.target === "Incident Runbook")).toMatchObject({ locked: true, targetId: null });
  });

  it("the tree hashes a note once per version, not once per request", async () => {
    await get("/api/vault/tree");
    const spy = vi.spyOn(crypto, "createHash");
    const r = await get("/api/vault/tree");
    const hashes = spy.mock.calls.filter(([alg]) => alg === "sha256").length;
    spy.mockRestore();
    expect(r.statusCode).toBe(200);
    expect(r.json().length).toBeGreaterThan(5);
    expect(hashes).toBe(0);

    // …and a new version gets a new hash: the one the save itself reported.
    const before = r.json().find((n: { path: string }) => n.path === "Shared/Many links.md");
    const saved = await app.inject({ method: "PUT", url: "/api/vault/note", headers: { authorization: `Bearer ${token}` }, payload: { path: "Shared/Many links.md", content: "# Many links\n\nrewritten\n" } });
    const after = (await get("/api/vault/tree")).json().find((n: { path: string }) => n.path === "Shared/Many links.md");
    expect(after.hash).not.toBe(before.hash);
    expect(after.hash).toBe(saved.json().hash);
  });
});
