/**
 * `basalt export` (export.ts, audit B10): what lives only in the database —
 * task descriptions and comments, AI settings, tokens, webhooks — comes out
 * in a snapshot that restores and a JSON a person can read, and no secret
 * reaches the JSON.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-export-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";
process.env.BASALT_FETCH_ALLOW = "127.0.0.1";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { exportBasalt } = await import("../src/export.js");
const { tables } = await import("../src/db.js");

const DATA = process.env.BASALT_DATA_DIR;
const VAULT = process.env.BASALT_VAULT_DIR;
const OUT = path.join(DATA, "out");
type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let token = "";
const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => {
  const r = await built.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
};

const SECRETS: Record<string, string> = {};
let taskId = "";
let exported = "";

beforeAll(async () => {
  built = await buildServer();
  token = (await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })).json().token;

  const roadmap = built.store.index.getByPath("Engineering/Atlas Roadmap.md")!;
  const { line, raw: text } = roadmap.tasks.find((t) => t.text.startsWith("dashboard API"))!;
  const promoted = await call("POST", "/api/tasks/promote", { noteId: roadmap.id, line, text });
  expect(promoted.status).toBe(200);
  taskId = promoted.json.id;
  expect((await call("PATCH", `/api/tasks/${taskId}`, { description: "Exported description: the spec lives in the thesis note." })).status).toBe(200);
  expect((await call("POST", `/api/tasks/${taskId}/comments`, { body: "Exported comment: ask Erin about pagination." })).status).toBe(200);

  const tok = await call("POST", "/api/tokens", { label: "Shortcuts" });
  SECRETS.apiToken = tok.json.token;
  const hook = await call("POST", "/api/webhooks", { url: "http://127.0.0.1:9/hook", events: ["note.changed"] });
  SECRETS.webhookSecret = hook.json.secret;
  SECRETS.aiKey = "g-secret-ai-key-0123456789";
  expect((await call("POST", "/api/admin/ai", { provider: "google", model: "gemini-2.5-flash", apiKey: SECRETS.aiKey })).status).toBe(200);
  expect((await call("POST", "/api/admin/ai/instructions", { instructions: "Exported instructions: be direct." })).status).toBe(200);
  for (const u of built.db.select().from(tables.users).all()) SECRETS[`hash:${u.username}`] = u.passwordHash;
  SECRETS.aiKeyEncrypted = built.db.select().from(tables.workspace).all()[0]!.aiKeyEncrypted!;
  SECRETS.tokenHash = built.db.select().from(tables.apiTokens).all()[0]!.tokenHash;

  // While the server is running, as the CLI would be.
  exported = (await exportBasalt({ into: OUT })).dir;
});

afterAll(async () => {
  await built.app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

describe("basalt export", () => {
  it("writes a snapshot, a readable JSON and a README, owner-only", () => {
    expect(fs.readdirSync(exported).sort()).toEqual(["README.txt", "basalt.db", "export.json"]);
    expect(fs.statSync(exported).mode & 0o777).toBe(0o700);
    for (const f of fs.readdirSync(exported)) expect(fs.statSync(path.join(exported, f)).mode & 0o777).toBe(0o600);
  });

  it("the JSON holds what only the database had", () => {
    const data = JSON.parse(fs.readFileSync(path.join(exported, "export.json"), "utf8"));
    expect(data.format).toBe("basalt-export");
    const task = data.tasks.find((t: { note: string; description: string }) => t.description.startsWith("Exported description"));
    expect(task.note).toBe("Engineering/Atlas Roadmap.md");
    expect(task.comments.map((c: { author: string; body: string }) => `${c.author}: ${c.body}`)).toEqual(["jules: Exported comment: ask Erin about pagination."]);
    expect(data.workspace.ai).toMatchObject({ provider: "google", model: "gemini-2.5-flash", keyStored: true, instructions: "Exported instructions: be direct." });
    expect(data.apiTokens.map((t: { label: string }) => t.label)).toEqual(["Shortcuts"]);
    expect(data.webhooks.map((h: { url: string }) => h.url)).toEqual(["http://127.0.0.1:9/hook"]);
    expect(data.accounts.map((a: { username: string }) => a.username).sort()).toEqual(["erin", "jules", "mara"]);
  });

  it("no secret reaches the JSON or the README", () => {
    const text = fs.readFileSync(path.join(exported, "export.json"), "utf8") + fs.readFileSync(path.join(exported, "README.txt"), "utf8");
    for (const [name, secret] of Object.entries(SECRETS)) expect(text.includes(secret), name).toBe(false);
    expect(text).not.toMatch(/passwordHash|tokenHash|Encrypted|"secret"/);
  });

  it("the snapshot restores: a server booted on it has the comment, the description and the AI settings", async () => {
    const restored = path.join(DATA, "restored");
    fs.mkdirSync(restored);
    fs.copyFileSync(path.join(exported, "basalt.db"), path.join(restored, "basalt.db"));
    await built.app.close();
    process.env.BASALT_DATA_DIR = restored;
    const { env } = await import("../src/env.js");
    const before = env.dataDir;
    (env as { dataDir: string }).dataDir = restored;
    try {
      built = await buildServer();
      token = (await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })).json().token;
      expect((await call("GET", `/api/tasks/${taskId}/comments`)).json.map((c: { body: string }) => c.body)).toEqual(["Exported comment: ask Erin about pagination."]);
      expect(built.db.select().from(tables.taskObjects).all().find((t) => t.id === taskId)?.description).toMatch(/^Exported description/);
      expect((await call("GET", "/api/admin/ai")).json).toMatchObject({ provider: "google", configured: true, instructions: "Exported instructions: be direct." });
    } finally {
      (env as { dataDir: string }).dataDir = before;
    }
  });

  it("refuses to write into the vault", async () => {
    await expect(exportBasalt({ into: path.join(VAULT, "Backups") })).rejects.toThrow(/into the vault/);
    expect(fs.existsSync(path.join(VAULT, "Backups"))).toBe(false);
  });
});
