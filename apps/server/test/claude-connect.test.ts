/**
 * Settings → Connections → Connect to Claude (claudeConnect.ts, routes/claude.ts), against a
 * home and a data folder of the test's own: never a real Claude settings file.
 *
 * Connect makes a Claude-only token (scope "mcp": the MCP tools' routes, nothing else), keeps
 * it in an owner-only file in Orrama's data folder, and adds Orrama to Claude Desktop's settings
 * without touching the rest; the token is never in an answer, Claude's settings or the Claude
 * Code command. Disconnect revokes it, deletes the file and takes the entry out. A missing or
 * broken Claude file is said in words, and the connection still works for Claude Code.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-claude-"));
process.env.ORRAMA_DATA_DIR = path.join(tmp, "data");
process.env.ORRAMA_VAULT_DIR = path.join(tmp, "data", "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { connectionFile, refreshClaude, claudeCodeCommand } = await import("../src/claudeConnect.js");
const { backupPath } = await import("../src/claudeConfig.js");
import type { ClaudeHost } from "../src/claudeConnect.js";

const home = path.join(tmp, "home");
const claudeDir = path.join(home, "Library", "Application Support", "Claude");
const app = path.join(tmp, "Applications", "Orrama.app");
const host: ClaudeHost = {
  dataDir: process.env.ORRAMA_DATA_DIR,
  url: "http://127.0.0.1:4877",
  launch: { command: path.join(app, "Contents", "MacOS", "node"), args: [path.join(app, "Contents", "Resources", "server", "mcp.mjs")] },
  desktopConfig: path.join(claudeDir, "claude_desktop_config.json"),
  platform: "darwin",
};
const OTHERS = '{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "server-filesystem", "/Users/sam"] }\n  },\n  "preferences": { "menuBarEnabled": false }\n}\n';

const b = await buildServer({ claude: host });
afterAll(async () => {
  await b.app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const login = async (who: string) => sessionOf(await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@orrama.dev`, password: "orrama-demo" } }));
const jules = await login("jules");
const erin = await login("erin");
const call = async (who: string, method: "GET" | "POST", url: string) => {
  const r = await b.app.inject({ method, url, headers: signedIn(who) });
  return { status: r.statusCode, body: r.body, json: r.body ? r.json() : null };
};
const asToken = async (token: string, method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
  (await b.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) })).statusCode;
const conn = () => JSON.parse(fs.readFileSync(connectionFile(host.dataDir), "utf8")) as { url: string; token: string; tokenId: string; userId: string };
const desktop = () => fs.readFileSync(host.desktopConfig, "utf8");
const claudeTokens = () => b.db.select().from(tables.apiTokens).all().filter((t) => t.scope === "mcp");

beforeEach(async () => {
  for (const who of [jules, erin]) await call(who, "POST", "/api/claude/disconnect");
  fs.rmSync(claudeDir, { recursive: true, force: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(host.desktopConfig, OTHERS);
});

describe("connecting", () => {
  it("adds Orrama to Claude Desktop, keeping every other entry, with a backup beside it", async () => {
    const r = await call(jules, "POST", "/api/claude/connect");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ available: true, desktop: "added", connected: { since: expect.any(Number), lastUsedAt: null } });
    const text = desktop();
    expect(text).toContain('"filesystem": { "command": "npx", "args": ["-y", "server-filesystem", "/Users/sam"] }');
    expect(text).toContain('"preferences": { "menuBarEnabled": false }');
    expect(JSON.parse(text).mcpServers.orrama).toEqual({ command: host.launch!.command, args: host.launch!.args, env: { ORRAMA_CONNECTION: connectionFile(host.dataDir) } });
    expect(fs.readFileSync(backupPath(host.desktopConfig), "utf8")).toBe(OTHERS);
  });

  it("keeps the token in an owner-only file, and nowhere else: not an answer, Claude's file or the command", async () => {
    const r = await call(jules, "POST", "/api/claude/connect");
    const c = conn();
    expect(c).toMatchObject({ url: host.url, token: expect.stringMatching(/^bslt_[0-9a-f]{48}$/) });
    if (process.platform !== "win32") {
      expect(fs.statSync(connectionFile(host.dataDir)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(connectionFile(host.dataDir))).mode & 0o777).toBe(0o700);
    }
    const secret = c.token.slice(5);
    expect(r.body).not.toContain(secret);
    expect((await call(jules, "GET", "/api/claude")).body).not.toContain(secret);
    expect(desktop()).not.toContain(secret);
    expect(r.json.command).toBe(claudeCodeCommand(host));
    expect(r.json.command).toContain(`--env ORRAMA_CONNECTION='${connectionFile(host.dataDir)}'`);
    expect(r.json.command).not.toContain(secret);
    expect(fs.readdirSync(path.dirname(connectionFile(host.dataDir)))).toEqual(["connection.json"]);
  });

  it("makes a token good for Orrama's tools in Claude and nothing else, listed here and not among the API tokens", async () => {
    await call(jules, "POST", "/api/claude/connect");
    const { token } = conn();
    expect(await asToken(token, "GET", "/api/home")).toBe(200);
    expect(await asToken(token, "GET", "/api/vault/tree")).toBe(200);
    const note = b.store.index.all()[0]!;
    expect(await asToken(token, "GET", `/api/vault/note/${note.id}`)).toBe(200);
    // History, export, the trash's listing, the Orrery's graph: no tool needs them, so the token can't.
    expect(await asToken(token, "GET", `/api/vault/note/${note.id}/history`)).toBe(403);
    expect(await asToken(token, "GET", "/api/vault/trash")).toBe(403);
    expect(await asToken(token, "GET", "/api/vault/graph")).toBe(403);
    expect(await asToken(token, "GET", "/api/me")).toBe(403);
    expect(await asToken(token, "GET", "/api/tokens")).toBe(403);
    expect(await asToken(token, "POST", "/api/claude/connect")).toBe(403);
    const listed = (await call(jules, "GET", "/api/tokens")).json as { label: string }[];
    expect(listed.map((t) => t.label)).not.toContain("Claude");
    expect(claudeTokens()).toHaveLength(1);
    expect(((await call(jules, "GET", "/api/claude")).json as { connected: { lastUsedAt: number | null } }).connected.lastUsedAt).toEqual(expect.any(Number));
  });

  it("connecting again keeps the same token and puts the entry back", async () => {
    await call(jules, "POST", "/api/claude/connect");
    const first = conn();
    fs.writeFileSync(host.desktopConfig, OTHERS);
    expect((await call(jules, "GET", "/api/claude")).json).toMatchObject({ desktop: "missing", connected: expect.any(Object) });
    expect((await call(jules, "POST", "/api/claude/connect")).json).toMatchObject({ desktop: "added" });
    expect(conn()).toEqual(first);
    expect(claudeTokens()).toHaveLength(1);
  });

  it("works without Claude Desktop: nothing is made, and Claude Code's command is there", async () => {
    fs.rmSync(claudeDir, { recursive: true, force: true });
    const r = await call(jules, "POST", "/api/claude/connect");
    expect(r.json).toMatchObject({ desktop: "absent", connected: expect.any(Object), command: expect.stringContaining("claude mcp add orrama --scope user") });
    expect(fs.existsSync(claudeDir)).toBe(false);
  });

  it("leaves a broken Claude file alone and says so in words; the connection still stands", async () => {
    const broken = '{\n  "mcpServers": {\n    "filesystem": { "command": "npx", }\n  }\n}\n';
    fs.writeFileSync(host.desktopConfig, broken);
    const r = await call(jules, "POST", "/api/claude/connect");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ desktop: "broken", desktopProblem: "Claude's settings file has a mistake in it (line 3), so Orrama left it alone.", connected: expect.any(Object) });
    expect(desktop()).toBe(broken);
    expect(fs.existsSync(backupPath(host.desktopConfig))).toBe(false);
    expect(await asToken(conn().token, "GET", "/api/home")).toBe(200);
  });

  it("another account connecting replaces the first one's connection and revokes its token", async () => {
    await call(jules, "POST", "/api/claude/connect");
    const julesToken = conn().token;
    expect((await call(erin, "GET", "/api/claude")).json).toMatchObject({ connected: null, otherAccount: true });
    await call(erin, "POST", "/api/claude/connect");
    expect(await asToken(julesToken, "GET", "/api/home")).toBe(401);
    expect((await call(jules, "GET", "/api/claude")).json).toMatchObject({ connected: null, otherAccount: true });
    expect(claudeTokens()).toHaveLength(1);
  });
});

describe("disconnecting", () => {
  it("revokes the token, deletes the file and takes only Orrama's entry out of Claude Desktop", async () => {
    await call(jules, "POST", "/api/claude/connect");
    const { token } = conn();
    const r = await call(jules, "POST", "/api/claude/disconnect");
    expect(r.json).toMatchObject({ connected: null, desktop: "missing", command: null });
    expect(await asToken(token, "GET", "/api/home")).toBe(401);
    expect(fs.existsSync(connectionFile(host.dataDir))).toBe(false);
    expect(desktop()).toBe(OTHERS);
    expect(claudeTokens()).toHaveLength(0);
  });

  it("leaves an `orrama` entry Orrama didn't write, and still revokes when Claude's file is broken", async () => {
    await call(jules, "POST", "/api/claude/connect");
    const theirs = OTHERS.replace('"filesystem"', '"orrama": { "command": "node", "args": ["my-own.js"] },\n    "filesystem"');
    fs.writeFileSync(host.desktopConfig, theirs);
    await call(jules, "POST", "/api/claude/disconnect");
    expect(desktop()).toBe(theirs);

    await call(jules, "POST", "/api/claude/connect");
    const { token } = conn();
    fs.writeFileSync(host.desktopConfig, "{ not json");
    const r = await call(jules, "POST", "/api/claude/disconnect");
    expect(r.json).toMatchObject({ connected: null, desktop: "broken" });
    expect(await asToken(token, "GET", "/api/home")).toBe(401);
    expect(fs.existsSync(connectionFile(host.dataDir))).toBe(false);
  });

  it("a password change or Sign out everywhere ends the connection too", async () => {
    await call(jules, "POST", "/api/claude/connect");
    const { token } = conn();
    const r = await b.app.inject({ method: "POST", url: "/api/auth/password", headers: signedIn(jules), payload: { current: "orrama-demo", next: "orrama-demo" } });
    expect(r.statusCode).toBe(200);
    expect(await asToken(token, "GET", "/api/home")).toBe(401);
    expect((await call(jules, "GET", "/api/claude")).json).toMatchObject({ connected: null });
  });
});

describe("where Connect can't be used", () => {
  it("a server that isn't the desktop app says so and makes nothing", async () => {
    const other = await buildServer({ claude: { ...host, launch: null } });
    const s = sessionOf(await other.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "erin@orrama.dev", password: "orrama-demo" } }));
    const get = await other.app.inject({ method: "GET", url: "/api/claude", headers: signedIn(s) });
    expect(get.json()).toMatchObject({ available: false, why: "Connect to Claude works in the Orrama app on your computer.", command: null });
    const r = await other.app.inject({ method: "POST", url: "/api/claude/connect", headers: signedIn(s) });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("Connect to Claude works in the Orrama app on your computer.");
    expect(fs.existsSync(connectionFile(host.dataDir))).toBe(false);
    expect(desktop()).toBe(OTHERS);
    await other.app.close();
  });

  it("an app opened where it was downloaded asks to be moved first", async () => {
    const moved = { ...host, launch: { command: "/private/var/folders/x/AppTranslocation/ABC/d/Orrama.app/Contents/MacOS/node", args: ["/x/mcp.mjs"] } };
    const other = await buildServer({ claude: moved });
    const s = sessionOf(await other.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "erin@orrama.dev", password: "orrama-demo" } }));
    const r = await other.app.inject({ method: "POST", url: "/api/claude/connect", headers: signedIn(s) });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/^Move Orrama to your Applications folder/);
    await other.app.close();
  });
});

describe("at start", () => {
  it("names this launch's port in the connection and the app's new place in Claude's entry", async () => {
    await call(jules, "POST", "/api/claude/connect");
    const before = conn();
    const elsewhere = path.join(tmp, "Elsewhere", "Orrama.app");
    const next: ClaudeHost = {
      ...host,
      url: "http://127.0.0.1:4901",
      launch: { command: path.join(elsewhere, "Contents", "MacOS", "node"), args: [path.join(elsewhere, "Contents", "Resources", "server", "mcp.mjs")] },
    };
    const lines: string[] = [];
    refreshClaude(next, (l) => lines.push(l));
    expect(conn()).toEqual({ ...before, url: "http://127.0.0.1:4901" });
    const entry = JSON.parse(desktop()).mcpServers.orrama;
    expect(entry.command).toBe(next.launch!.command);
    expect(entry.args).toEqual(next.launch!.args);
    expect(desktop()).toContain('"filesystem": { "command": "npx", "args": ["-y", "server-filesystem", "/Users/sam"] }');
    expect(lines).toEqual(["[claude] Claude Desktop's entry for Orrama now names where the app is"]);
    // Nothing to do: nothing written, nothing said.
    const text = desktop();
    refreshClaude(next, (l) => lines.push(l));
    expect(desktop()).toBe(text);
    expect(lines).toHaveLength(1);
  });

  it("never touches an entry Orrama didn't write, and never fails the start", async () => {
    await call(jules, "POST", "/api/claude/connect");
    const theirs = OTHERS.replace('"filesystem"', '"orrama": { "command": "node", "args": ["my-own.js"] },\n    "filesystem"');
    fs.writeFileSync(host.desktopConfig, theirs);
    const lines: string[] = [];
    refreshClaude({ ...host, launch: { command: "/elsewhere/node", args: ["/elsewhere/mcp.mjs"] } }, (l) => lines.push(l));
    expect(desktop()).toBe(theirs);
    fs.writeFileSync(host.desktopConfig, "{ broken");
    refreshClaude(host, (l) => lines.push(l));
    expect(lines).toEqual([]);
  });
});
