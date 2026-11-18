#!/usr/bin/env node
// The installed app's server starts and stops the way the shell runs it, without a screen.
//
//   node scripts/install-check.mjs --app <Orrama.app | install folder>
//   node scripts/install-check.mjs --installer <Orrama_<v>_x64-setup.exe>      (Windows)
//
// With --installer: installs silently (/S) into a temp folder, checks that folder as below,
// puts stand-ins for the app's data folder and its Credential Manager entry in place, uninstalls
// silently with "Delete the application data" ticked (/DELETEAPPDATA, windows/hooks.nsh), and
// checks the data folder and the entry are gone and the notes folder and its note are still there. With --app: checks a built
// .app (macOS) or an install folder (Windows) as it is.
//
// The check: the app carries Node beside its executable and server/ in its resources, with the
// licence and every notices file; that Node runs server/server.mjs with the contract's environment
// (~/orrama-next/build/2-COMMON.md) on an empty data folder and a notes folder of its own, in a
// home of its own; /api/health answers with this launch's id and the desktop notices are served;
// Connect to Claude adds Orrama to a Claude settings file in that home, and the command it names
// (the app's Node and server/mcp.mjs) answers an MCP handshake, lists the tools and answers one;
// closing its stdin stops it with exit 0 and no SQLite WAL left behind. Nothing outside temp
// folders is read or written, and no window opens.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { arg, fail, mainBinaryName } from "./bundle-common.mjs";
import { credentialExists, deleteCredential, writeCredential } from "./windows-credential.mjs";

const NOTICES = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES_SERVER.txt", "THIRD_PARTY_NOTICES_DESKTOP.txt"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => console.log(`  ${line}`);
const MAIN = mainBinaryName();

/** Where the app's executable, Node and the server are inside an installed app. */
function layout(app) {
  if (app.endsWith(".app")) {
    const bin = path.join(app, "Contents", "MacOS");
    return { main: path.join(bin, MAIN), node: path.join(bin, "node"), server: path.join(app, "Contents", "Resources", "server") };
  }
  return { main: path.join(app, `${MAIN}.exe`), node: path.join(app, "node.exe"), server: path.join(app, "server") };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(what, ms, check, before = () => {}) {
  const until = Date.now() + ms;
  for (;;) {
    const result = await check().catch(() => null);
    if (result) return result;
    if (Date.now() > until) {
      before();
      fail(`${what} did not happen within ${ms / 1000} s`);
    }
    await sleep(500);
  }
}

/** What is in each folder the app could have gone to, and where Windows says it went: a red run says why. */
function showInstallPlaces(dir) {
  const local = process.env.LOCALAPPDATA;
  const places = [dir, ...(local ? [path.join(local, "Orrama"), path.join(local, "Programs", "Orrama")] : [])];
  for (const place of places) {
    if (!fs.existsSync(place)) {
      console.log(`  ${place}: not there`);
      continue;
    }
    const entries = fs.readdirSync(place, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}${path.sep}` : e.name));
    console.log(`  ${place}: ${entries.length ? entries.join(", ") : "empty"}`);
  }
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Orrama";
  const reg = spawnSync("reg", ["query", key], { encoding: "utf8", windowsHide: true });
  console.log(reg.status === 0 ? reg.stdout.trim() : `  ${key}: not there`);
}

async function checkApp(app, scratch) {
  const { main, node, server } = layout(app);
  for (const f of [main, node, path.join(server, "server.mjs"), path.join(server, "mcp.mjs"), path.join(server, "web", "index.html"), ...NOTICES.map((n) => path.join(server, n))]) {
    if (!fs.existsSync(f)) fail(`${path.relative(app, f)} is not in ${app}`);
  }
  if (!fs.readFileSync(path.join(server, "LICENSE"), "utf8").includes("GNU AFFERO GENERAL PUBLIC LICENSE")) fail("server/LICENSE is not the AGPL");
  say(`${path.basename(main)}, Node, the server and ${NOTICES.length} licence and notices files are in place`);

  const data = path.join(scratch, "data");
  const notes = path.join(scratch, "notes");
  const home = path.join(scratch, "home");
  for (const d of [data, notes, home]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(notes, "Kept.md"), "# Kept\n\nA note the install check leaves here.\n");
  const port = await freePort();
  const launch = crypto.randomBytes(16).toString("hex");
  // The shell passes the system basics and the contract's variables, nothing else of the user's.
  const basics = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP", "LANG"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const env = {
    ...basics,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    ORRAMA_PACKAGED: "1",
    ORRAMA_DATA_DIR: data,
    ORRAMA_DEFAULT_NOTES_DIR: notes,
    ORRAMA_WEB_DIST: path.join(server, "web"),
    PORT: String(port),
    HOST: "127.0.0.1",
    ORRAMA_PUBLIC_ORIGINS: `http://localhost:${port}`,
    ORRAMA_JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    ORRAMA_SECRET_KEY: crypto.randomBytes(32).toString("hex"),
    ORRAMA_LAUNCH_ID: launch,
  };
  const log = path.join(scratch, "server.log");
  const out = fs.openSync(log, "a");
  const child = spawn(node, [path.join(server, "server.mjs")], { env, stdio: ["pipe", out, out], windowsHide: true });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let gone = null;
  exited.then((r) => (gone = r));
  const showLog = () => console.log(fs.readFileSync(log, "utf8").split("\n").slice(-40).join("\n"));
  try {
    const health = await waitFor("/api/health with this launch's id", 90_000, async () => {
      if (gone) {
        showLog();
        fail(`the server exited before it answered (${JSON.stringify(gone)})`);
      }
      const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      return h.ok && h.launch === launch ? h : null;
    });
    say(`/api/health answered on 127.0.0.1:${port} with this launch's id (build ${health.build})`);
    const notices = await fetch(`http://127.0.0.1:${port}/THIRD_PARTY_NOTICES_DESKTOP.txt`);
    const text = await notices.text();
    // A missing file is answered with the app's page (200), so the text is what tells.
    if (!notices.ok || !text.startsWith("Orrama's desktop app includes")) fail(`/THIRD_PARTY_NOTICES_DESKTOP.txt is not served (${notices.status}, ${notices.headers.get("content-type")})`);
    say("the desktop notices are served");
    await checkClaude(port, home, basics);
  } catch (e) {
    child.kill();
    throw e;
  }
  child.stdin.end();
  const timer = setTimeout(() => {
    showLog();
    child.kill();
    fail("the server was still running 20 s after its stdin closed");
  }, 20_000);
  const { code, signal } = await exited;
  clearTimeout(timer);
  fs.closeSync(out);
  if (code !== 0) {
    showLog();
    fail(`the server exited with ${code ?? signal} after its stdin closed, not 0`);
  }
  const wal = fs.readdirSync(data).filter((f) => /-(wal|shm)$/.test(f));
  if (wal.length) fail(`the database was left open: ${wal.join(", ")}`);
  say("closing its stdin stopped it: exit 0, no WAL left");
  return notes;
}

/** Where Claude Desktop keeps its settings in `home` (apps/server/src/claudeConfig.ts `desktopConfigPath`). */
const claudeConfigIn = (home) =>
  process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");

/** One MCP request over stdio, the way Claude sends it: a JSON-RPC line in, its answer's line out. */
function mcpOver(child) {
  let buf = "";
  const waiting = new Map();
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        const msg = JSON.parse(line);
        waiting.get(msg.id)?.(msg);
      }
    }
  });
  let id = 0;
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method} in 30 s`)), 30_000);
      waiting.set(n, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
}

/**
 * Connect to Claude on the installed app (2M): an account, Connect, Orrama's entry in the Claude
 * settings file of this home (Claude's other entry kept), then what Claude does with the entry:
 * start it, shake hands, list the tools, call one. Then Disconnect takes the entry out again.
 */
async function checkClaude(port, home, basics) {
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { origin: base, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const set = r.headers.getSetCookie().find((c) => c.startsWith(`orrama_session_${port}=`));
    if (set) cookie = set.split(";")[0];
    if (!r.ok) fail(`${method} ${p} answered ${r.status}: ${await r.text()}`);
    return r.json();
  };
  const config = claudeConfigIn(home);
  const OTHER = '{\n  "mcpServers": {\n    "weather": { "command": "uvx", "args": ["weather-mcp"] }\n  }\n}\n';
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, OTHER);
  await call("POST", "/api/auth/register", { email: "check@example.test", username: "check", displayName: "Check", password: "install check password" });
  const connected = await call("POST", "/api/claude/connect");
  if (!connected.available || connected.desktop !== "added") fail(`Connect to Claude answered ${JSON.stringify({ ...connected, command: undefined })}`);
  const text = fs.readFileSync(config, "utf8");
  if (!text.includes('"weather": { "command": "uvx", "args": ["weather-mcp"] }')) fail("Connect to Claude changed Claude's other entry");
  const entry = JSON.parse(text).mcpServers.orrama;
  say(`Connect to Claude added Orrama to Claude's settings: ${path.basename(entry.command)} ${entry.args.map((a) => path.basename(a)).join(" ")}`);

  const child = spawn(entry.command, entry.args, { env: { ...basics, HOME: home, USERPROFILE: home, ...entry.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
  const ask = mcpOver(child);
  try {
    const init = await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "install-check", version: "0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const { tools } = await ask("tools/list");
    const answer = await ask("tools/call", { name: "list_projects", arguments: {} });
    if (init.serverInfo?.name !== "orrama-mcp" || tools.length < 20 || answer.isError) fail(`the MCP server answered ${JSON.stringify({ init, tools: tools.length, answer })}`);
    say(`the MCP server shook hands over stdio, listed ${tools.length} tools and answered list_projects`);
  } catch (e) {
    console.log(stderr);
    throw e;
  } finally {
    child.stdin.end();
    child.kill();
  }
  await call("POST", "/api/claude/disconnect");
  if (fs.readFileSync(config, "utf8") !== OTHER) fail("Disconnect didn't leave Claude's settings as they were");
  say("Disconnect took Orrama out of Claude's settings again");
}

async function installAndCheck(installer, scratch) {
  if (process.platform !== "win32") fail("--installer runs the Windows installer: use --app on a Mac");
  const dir = path.join(scratch, "Orrama");
  // NSIS: /S is silent, /D= the folder (last, unquoted, even with spaces).
  const r = spawnSync(installer, ["/S", `/D=${dir}`], { stdio: "inherit", windowsHide: true });
  if (r.status !== 0) fail(`the installer exited with ${r.status}`);
  const main = layout(dir).main;
  await waitFor(`${path.basename(main)} in the install folder`, 60_000, async () => fs.existsSync(main), () => showInstallPlaces(dir));
  say(`installed into ${dir}`);
  const notes = await checkApp(dir, path.join(scratch, "run"));
  const uninstaller = path.join(dir, "uninstall.exe");
  if (!fs.existsSync(uninstaller)) fail("there is no uninstall.exe in the install folder");
  // What a friend's install leaves for the uninstaller: the app's data folder (the database, the
  // logs, where the notes are) and its two secrets in the Credential Manager (secrets.rs). Stand-ins,
  // on a runner that has never had Orrama: the real ones belong to a person.
  const appData = path.join(process.env.LOCALAPPDATA ?? fail("no LOCALAPPDATA"), APP_ID);
  if (fs.existsSync(appData)) fail(`${appData} already exists: run the uninstall check where Orrama never ran`);
  fs.mkdirSync(path.join(appData, "logs"), { recursive: true });
  fs.writeFileSync(path.join(appData, "basalt.db"), "a stand-in for the database\n");
  fs.writeFileSync(path.join(appData, "notes-folder.json"), `${JSON.stringify({ folder: notes })}\n`);
  writeCredential(CREDENTIAL, CREDENTIAL_USER);
  showCmdkey("with the stand-in written");
  if (!credentialExists(CREDENTIAL)) fail(`the stand-in for ${CREDENTIAL} is not in the Credential Manager`);
  say(`the stand-in for ${CREDENTIAL} is in the Credential Manager`);
  // "Delete the application data" ticked; the uninstaller copies itself away and returns at once:
  // wait for the app to be gone.
  spawnSync(uninstaller, ["/S", "/DELETEAPPDATA"], { stdio: "inherit", windowsHide: true });
  await waitFor("the uninstall", 120_000, async () => !fs.existsSync(main), () => showInstallPlaces(dir));
  say("uninstalled, with the application data");
  await waitFor(`${appData} to go`, 30_000, async () => !fs.existsSync(appData));
  say("the app's data folder is gone");
  // The hook runs last, after the folder has gone (Tauri's Section Uninstall): give it that moment.
  const until = Date.now() + 60_000;
  while (credentialExists(CREDENTIAL)) {
    if (Date.now() > until) {
      showCmdkey("after the uninstall");
      deleteCredential(CREDENTIAL);
      fail(`the uninstall left ${CREDENTIAL} in the Credential Manager`);
    }
    await sleep(1000);
  }
  showCmdkey("after the uninstall");
  say("its Credential Manager entry is gone");
  if (!fs.existsSync(path.join(notes, "Kept.md"))) fail("the uninstall took the notes folder with it");
  say("the notes folder and its note are still there");
}

/** The app's identifier: its data folder's name (tauri.conf.json). */
const APP_ID = "com.orrama.desktop";
/** The Credential Manager entry the app keeps its secrets in: "<user>.<service>" (secrets.rs, keyring). */
const CREDENTIAL_USER = "server secrets";
const CREDENTIAL = `${CREDENTIAL_USER}.${APP_ID}`;
/** cmdkey's own view, printed and never relied on (`/list:` only): a red run says what it saw. */
function showCmdkey(when) {
  const r = spawnSync("cmdkey", [`/list:${CREDENTIAL}`], { encoding: "utf8", windowsHide: true });
  console.log(`  cmdkey ${when}: exit ${r.status}, stdout ${JSON.stringify(r.stdout)}, stderr ${JSON.stringify(r.stderr)}`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-install-check-"));
const installer = arg("installer");
const app = arg("app");
console.log(`Install check in ${scratch}`);
if (installer) await installAndCheck(path.resolve(installer), scratch);
else if (app) await checkApp(path.resolve(app), scratch);
else fail("pass --app <Orrama.app | install folder> or --installer <setup.exe>");
fs.rmSync(scratch, { recursive: true, force: true });
console.log("Install check passed.");
