/**
 * Settings → Connections → Connect to Claude (2M). The desktop app carries Orrama's MCP server
 * (`mcp.mjs` beside `server.mjs`, run by the app's own Node); connecting lets Claude Desktop and
 * Claude Code start it, so Claude can work with your notes in a couple of clicks.
 *
 * The token lives in a file only you can read in Orrama's data folder,
 * `<data>/claude/connection.json` (Jules, 18 Nov 2026), with the address of this server. Claude's
 * settings and the Claude Code command name that file and never hold the token, so the command
 * is safe to copy and a changed port needs nothing rewritten in Claude: the MCP server reads the
 * file at each call. The token is scoped to the MCP tools' routes (`mcpScope.ts`) and is listed
 * and revoked here, not among the API tokens.
 *
 * Disconnect revokes the token, deletes the file and takes Orrama's entry out of Claude
 * Desktop's settings (only an entry that names this file: an `orrama` someone wrote by hand
 * stays). Claude Code keeps its line until `claude mcp remove orrama --scope user`; without the
 * file it only says Orrama isn't connected.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { tables, type Db } from "./db.js";
import { bundled } from "./build.js";
import { env } from "./env.js";
import { changeDesktopConfig, ClaudeConfigError, desktopConfigPath, ENTRY, readDesktopEntry, withEntry, withoutEntry } from "./claudeConfig.js";
import { hashToken } from "./routes/integrations.js";
import { HttpError } from "./vaultStore.js";

export interface ClaudeHost {
  /** Orrama's data folder: the connection file goes in `claude/` inside it. */
  dataDir: string;
  /** This server's own address, as the MCP server on this computer reaches it. */
  url: string;
  /** How Claude starts Orrama's MCP server: the app's Node and `mcp.mjs`. Null when this server isn't the desktop app. */
  launch: { command: string; args: string[] } | null;
  /** Claude Desktop's settings file (`claudeConfig.ts` `desktopConfigPath`). */
  desktopConfig: string;
  platform: NodeJS.Platform;
}

/** The desktop app's own: its Node runs this server, and `mcp.mjs` is beside the bundle. */
export function appHost(): ClaudeHost {
  return {
    dataDir: env.dataDir,
    url: `http://127.0.0.1:${env.port}`,
    launch: env.packaged && bundled ? { command: process.execPath, args: [path.join(import.meta.dirname, "mcp.mjs")] } : null,
    desktopConfig: desktopConfigPath(),
    platform: process.platform,
  };
}

export const connectionFile = (dataDir: string) => path.join(dataDir, "claude", "connection.json");

interface Connection {
  url: string;
  token: string;
  tokenId: string;
  userId: string;
}

function readConnection(dataDir: string): Connection | null {
  try {
    const c = JSON.parse(fs.readFileSync(connectionFile(dataDir), "utf8")) as Partial<Connection>;
    return typeof c.url === "string" && typeof c.token === "string" && typeof c.tokenId === "string" && typeof c.userId === "string" ? (c as Connection) : null;
  } catch {
    return null;
  }
}

/** Written whole to a temporary file and moved into place, owner-only (600 in a 700 folder). */
function writeConnection(dataDir: string, c: Connection): void {
  const file = connectionFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(path.dirname(file), 0o700);
  const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** What Claude Desktop's settings say for Orrama: the app's Node, `mcp.mjs`, and where the connection is. */
export function entryFor(host: ClaudeHost): { command: string; args: string[]; env: { ORRAMA_CONNECTION: string } } | null {
  if (!host.launch) return null;
  return { command: host.launch.command, args: [...host.launch.args], env: { ORRAMA_CONNECTION: connectionFile(host.dataDir) } };
}

const samePath = (a: string, b: string, platform: NodeJS.Platform) =>
  platform === "win32" || platform === "darwin" ? path.resolve(a).normalize("NFC").toLowerCase() === path.resolve(b).normalize("NFC").toLowerCase() : path.resolve(a) === path.resolve(b);

/** An entry that names this data folder's connection file: Orrama wrote it, and it may change or remove it. */
const isOurs = (host: ClaudeHost) => (value: unknown) => {
  const file = (value as { env?: { ORRAMA_CONNECTION?: unknown } } | null)?.env?.ORRAMA_CONNECTION;
  return typeof file === "string" && samePath(file, connectionFile(host.dataDir), host.platform);
};

const sameEntry = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The one command Claude Code needs: the token is not in it, only where the connection file is. */
export function claudeCodeCommand(host: ClaudeHost): string | null {
  if (!host.launch) return null;
  const q = host.platform === "win32" ? (s: string) => `"${s}"` : (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  return `claude mcp add ${ENTRY} --scope user --env ORRAMA_CONNECTION=${q(connectionFile(host.dataDir))} -- ${[host.launch.command, ...host.launch.args].map(q).join(" ")}`;
}

/** Why Connect can't be used here, in words; null when it can. */
function unavailable(host: ClaudeHost): string | null {
  if (!host.launch) return "Connect to Claude works in the Orrama app on your computer.";
  // macOS runs an app opened where it was downloaded from a random, read-only copy that goes
  // away (App Translocation), and the disk image goes away too: Claude would be told a path that
  // stops existing.
  if (host.platform === "darwin" && (host.launch.command.includes("/AppTranslocation/") || host.launch.command.startsWith("/Volumes/"))) {
    return "Move Orrama to your Applications folder and open it from there, then connect.";
  }
  return null;
}

export type DesktopState = "absent" | "added" | "missing" | "broken";

export interface ClaudeStatus {
  available: boolean;
  /** Why Connect can't be used here (`available: false`). */
  why: string | null;
  /** Your connection: when it was made and last used. */
  connected: { since: number; lastUsedAt: number | null } | null;
  /** Another account on this computer is connected; connecting replaces theirs. */
  otherAccount: boolean;
  /** Claude Desktop: not on this computer, Orrama's entry there, not there, or its file unreadable. */
  desktop: DesktopState;
  /** What is wrong with Claude Desktop's file, when `desktop` is "broken". */
  desktopProblem: string | null;
  /** Claude Code's command, while connected. */
  command: string | null;
}

function tokenRow(db: Db, id: string, userId: string) {
  return db
    .select()
    .from(tables.apiTokens)
    .where(and(eq(tables.apiTokens.id, id), eq(tables.apiTokens.userId, userId), eq(tables.apiTokens.scope, "mcp")))
    .get();
}

export function claudeStatus(db: Db, host: ClaudeHost, userId: string): ClaudeStatus {
  const why = unavailable(host);
  const c = readConnection(host.dataDir);
  const row = c && c.userId === userId ? tokenRow(db, c.tokenId, userId) : undefined;
  const connected = row ? { since: row.createdAt, lastUsedAt: row.lastUsedAt } : null;
  const otherAccount = !!c && c.userId !== userId && !!db.select().from(tables.apiTokens).where(eq(tables.apiTokens.id, c.tokenId)).get();
  const read = readDesktopEntry(host.desktopConfig);
  const want = entryFor(host);
  const desktop: DesktopState = read.state === "absent" || read.state === "broken" ? read.state : connected && want && sameEntry(read.entry, want) ? "added" : "missing";
  return {
    available: why === null,
    why,
    connected,
    otherAccount,
    desktop,
    desktopProblem: read.state === "broken" ? read.words : null,
    command: connected && why === null ? claudeCodeCommand(host) : null,
  };
}

/**
 * Connect: a Claude-only token (kept when yours still works, else a new one; another account's
 * is revoked, since the file has room for one), the connection file, and Orrama's entry in
 * Claude Desktop's settings when Claude Desktop is here. A broken Claude file is left alone and
 * said; the connection is still made, for Claude Code.
 */
export function connectClaude(db: Db, host: ClaudeHost, userId: string): ClaudeStatus {
  const why = unavailable(host);
  if (why) throw new HttpError(409, why);
  const old = readConnection(host.dataDir);
  if (!old || old.userId !== userId || !tokenRow(db, old.tokenId, userId)) {
    if (old) db.delete(tables.apiTokens).where(and(eq(tables.apiTokens.id, old.tokenId), eq(tables.apiTokens.scope, "mcp"))).run();
    const token = `bslt_${crypto.randomBytes(24).toString("hex")}`;
    const id = `tok-${crypto.randomUUID().slice(0, 8)}`;
    db.insert(tables.apiTokens)
      .values({ id, userId, label: "Claude", tokenHash: hashToken(token), prefix: token.slice(0, 10), createdAt: Date.now(), lastUsedAt: null, scope: "mcp" })
      .run();
    writeConnection(host.dataDir, { url: host.url, token, tokenId: id, userId });
  } else if (old.url !== host.url) {
    writeConnection(host.dataDir, { ...old, url: host.url });
  }
  const entry = entryFor(host)!;
  try {
    changeDesktopConfig(host.desktopConfig, (text) => withEntry(text, entry));
  } catch (err) {
    if (!(err instanceof ClaudeConfigError)) throw err;
  }
  return claudeStatus(db, host, userId);
}

/** Disconnect: your Claude-only tokens revoked, the file deleted, Orrama's entry out of Claude Desktop. */
export function disconnectClaude(db: Db, host: ClaudeHost, userId: string): ClaudeStatus {
  db.delete(tables.apiTokens).where(and(eq(tables.apiTokens.userId, userId), eq(tables.apiTokens.scope, "mcp"))).run();
  const c = readConnection(host.dataDir);
  const mine = !c || c.userId === userId;
  if (mine) {
    fs.rmSync(connectionFile(host.dataDir), { force: true });
    try {
      changeDesktopConfig(host.desktopConfig, (text) => withoutEntry(text, isOurs(host)).text);
    } catch (err) {
      if (!(err instanceof ClaudeConfigError)) throw err;
    }
  }
  return claudeStatus(db, host, userId);
}

/**
 * At start: the connection names this server's address (the port can change between launches),
 * and Claude Desktop's entry the app where it is now (an app moved to another folder). Only
 * Orrama's own entry, only when it differs. Never stops the server: a problem is one log line.
 */
export function refreshClaude(host: ClaudeHost, log: (line: string) => void): void {
  if (!host.launch || unavailable(host)) return;
  try {
    const c = readConnection(host.dataDir);
    if (!c) return;
    if (c.url !== host.url) writeConnection(host.dataDir, { ...c, url: host.url });
    const read = readDesktopEntry(host.desktopConfig);
    const want = entryFor(host)!;
    if (read.state === "read" && read.entry !== undefined && isOurs(host)(read.entry) && !sameEntry(read.entry, want)) {
      changeDesktopConfig(host.desktopConfig, (text) => withEntry(text, want));
      log("[claude] Claude Desktop's entry for Orrama now names where the app is");
    }
  } catch (err) {
    log(`[claude] couldn't refresh the connection to Claude: ${err instanceof ClaudeConfigError ? err.words : (err as Error).message}`);
  }
}
