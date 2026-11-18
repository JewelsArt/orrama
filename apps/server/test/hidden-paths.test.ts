/**
 * Nothing under a dot name is a note (2L, from Z-wave1's small list). The boot walk and the
 * watcher skip every name that starts with a dot, but a write, a move or a folder move into
 * one (`.notes/x.md`, `Ideas/.drafts/x.md`) was indexed until the next restart: searchable
 * and in the tree, then gone. They are refused now, in words, and an agent's instruction
 * file (`.claude/`) still meets the agent's own refusal first.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-hidden-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.ORRAMA_VAULT_DIR;
const { buildServer } = await import("../src/main.js");
let b: Awaited<ReturnType<typeof buildServer>>;
let token = "";
const call = async (method: string, url: string, payload?: object) => {
  const r = await b.app.inject({ method: method as "GET", url, headers: signedIn(token), ...(payload && { payload }) });
  return { status: r.statusCode, json: r.body ? r.json() : null };
};
const indexed = () => b.store.index.all().map((n) => n.path);
const HIDDEN = /starts? with a dot/;

beforeAll(async () => {
  fs.mkdirSync(VAULT, { recursive: true });
  await import("../src/seed.js");
  b = await buildServer();
  token = sessionOf(await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("a dot name is never a note", () => {
  it("a new note in a hidden folder, or with a hidden name, is refused and nothing is written", async () => {
    for (const p of [".notes/x.md", "Ideas/.drafts/y.md", "Ideas/.z.md"]) {
      const r = await call("PUT", "/api/vault/note", { path: p, content: "# Hidden\n", create: true });
      expect(r.status, p).toBe(400);
      expect(r.json.error).toMatch(HIDDEN);
      expect(fs.existsSync(path.join(VAULT, p))).toBe(false);
    }
    expect(indexed().filter((p) => p.split("/").some((s) => s.startsWith(".")))).toEqual([]);
  });

  it("a note moved into one is refused, and stays where it was", async () => {
    expect((await call("PUT", "/api/vault/note", { path: "Ideas/Plain.md", content: "# Plain\n", create: true })).status).toBe(200);
    const r = await call("POST", "/api/vault/move", { fromPath: "Ideas/Plain.md", toPath: "Ideas/.archive/Plain.md" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(HIDDEN);
    expect(indexed()).toContain("Ideas/Plain.md");
    expect(fs.existsSync(path.join(VAULT, "Ideas/Plain.md"))).toBe(true);
  });

  it("a folder moved to a dot name is refused, its notes kept", async () => {
    const r = await call("POST", "/api/vault/folder/move", { from: "Ideas", to: ".Ideas" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(HIDDEN);
    expect(indexed()).toContain("Ideas/Plain.md");
  });

  it("the agent's own rule still answers first for its instruction files", async () => {
    const jules = b.store.aclUser(b.db.select().from((await import("../src/db.js")).tables.users).all().find((u) => u.username === "jules")!.id);
    const { agentWriter } = await import("../src/agentWrites.js");
    expect(() => b.store.write(jules, "Docs/.claude/rules.md", "INJECTED", undefined, undefined, { create: true, guard: agentWriter })).toThrow(/standing instructions/);
  });
});
