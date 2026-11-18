/**
 * Orrama's entry in Claude Desktop's settings file (claudeConfig.ts): only `mcpServers.orrama`
 * changes, every other byte stays (the other servers, Claude's own preferences, spacing, line
 * endings, a BOM), a backup goes beside it, and a file that isn't JSON, or isn't shaped like
 * Claude's, is left alone and said in words.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { backupPath, changeDesktopConfig, ClaudeConfigError, desktopConfigPath, entryOf, readDesktopEntry, withEntry, withoutEntry } from "../src/claudeConfig.js";

const ENTRY = { command: "/Applications/Orrama.app/Contents/MacOS/node", args: ["/Applications/Orrama.app/Contents/Resources/server/mcp.mjs"], env: { ORRAMA_CONNECTION: "/data/claude/connection.json" } };
const ours = (v: unknown) => (v as { env?: { ORRAMA_CONNECTION?: string } }).env?.ORRAMA_CONNECTION === "/data/claude/connection.json";

/** A settings file the way people have them: another server laid out by hand, Claude's preferences after. */
const OTHERS = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/sam/Desktop"]
    },
    "weather":   { "command": "uvx", "args": [ "weather-mcp" ],  "env": {"KEY":"k"} }
  },
  "preferences": {"quickEntryShortcut": "off", "menuBarEnabled": false}
}
`;
const FILESYSTEM = OTHERS.slice(OTHERS.indexOf('"filesystem"'), OTHERS.indexOf("\n    },") + 6);
const WEATHER = '"weather":   { "command": "uvx", "args": [ "weather-mcp" ],  "env": {"KEY":"k"} }';
const PREFS = '"preferences": {"quickEntryShortcut": "off", "menuBarEnabled": false}';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-claude-config-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("adding Orrama's entry", () => {
  it("keeps every other server and Claude's preferences byte for byte", () => {
    const out = withEntry(OTHERS, ENTRY);
    expect(JSON.parse(out).mcpServers.orrama).toEqual(ENTRY);
    for (const part of [FILESYSTEM, WEATHER, PREFS]) expect(out).toContain(part);
    expect(out.replace(/,\n {4}"orrama": \{[\s\S]*?\n {4}\}/, "")).toBe(OTHERS);
    expect(Object.keys(JSON.parse(out).mcpServers)).toEqual(["filesystem", "weather", "orrama"]);
  });

  it("replaces an entry already there, in its place, and nothing else", () => {
    const old = OTHERS.replace('"filesystem": {', '"orrama": { "command": "node", "args": ["old.js"] },\n    "filesystem": {');
    const out = withEntry(old, ENTRY);
    expect(JSON.parse(out).mcpServers.orrama).toEqual(ENTRY);
    expect(Object.keys(JSON.parse(out).mcpServers)).toEqual(["orrama", "filesystem", "weather"]);
    for (const part of [FILESYSTEM, WEATHER, PREFS]) expect(out).toContain(part);
    expect(withEntry(out, ENTRY)).toBe(out);
  });

  it("makes the list in a file with none, and a file from nothing", () => {
    const prefsOnly = '{\n\t"preferences": {"menuBarEnabled": false}\n}\n';
    const out = withEntry(prefsOnly, ENTRY);
    expect(out.startsWith('{\n\t"preferences": {"menuBarEnabled": false},\n\t"mcpServers": {\n\t\t"orrama": {')).toBe(true);
    expect(JSON.parse(out)).toEqual({ preferences: { menuBarEnabled: false }, mcpServers: { orrama: ENTRY } });
    expect(JSON.parse(withEntry("", ENTRY))).toEqual({ mcpServers: { orrama: ENTRY } });
    expect(JSON.parse(withEntry('{ "mcpServers": {} }', ENTRY))).toEqual({ mcpServers: { orrama: ENTRY } });
    expect(JSON.parse(withEntry("{}", ENTRY))).toEqual({ mcpServers: { orrama: ENTRY } });
  });

  it("keeps a BOM and Windows line endings", () => {
    const crlf = `\uFEFF${OTHERS.replaceAll("\n", "\r\n")}`;
    const out = withEntry(crlf, ENTRY);
    expect(out.startsWith("\uFEFF{")).toBe(true);
    expect(out.replaceAll("\r\n", "")).not.toContain("\n");
    expect(JSON.parse(out.slice(1)).mcpServers.orrama).toEqual(ENTRY);
  });

  it("refuses a file that isn't JSON, naming the line, and one not shaped like Claude's", () => {
    const broken = '{\n  "mcpServers": {\n    "a": { "command": "x", },\n  }\n}\n';
    expect(() => withEntry(broken, ENTRY)).toThrow(/mistake in it \(line 3\)/);
    expect(() => withEntry("[1, 2]", ENTRY)).toThrow(ClaudeConfigError);
    expect(() => withEntry('{"mcpServers": ["orrama"]}', ENTRY)).toThrow(/isn't laid out the way Claude writes it/);
    expect(() => withEntry('{"a": 1} trailing', ENTRY)).toThrow(/mistake in it/);
  });
});

describe("taking it out", () => {
  it("removes only Orrama's own entry, wherever it sits, and leaves the rest as it was", () => {
    const added = withEntry(OTHERS, ENTRY);
    const back = withoutEntry(added, ours);
    expect(back).toEqual({ text: OTHERS, removed: true });
    const first = OTHERS.replace('"filesystem": {', `"orrama": ${JSON.stringify(ENTRY)},\n    "filesystem": {`);
    expect(withoutEntry(first, ours).text).toBe(OTHERS);
    const only = '{\n  "mcpServers": {\n    "orrama": ' + JSON.stringify(ENTRY) + "\n  }\n}\n";
    expect(withoutEntry(only, ours).text).toBe('{\n  "mcpServers": {}\n}\n');
  });

  it("leaves an `orrama` someone else wrote", () => {
    const theirs = withEntry(OTHERS, { command: "node", args: ["/Users/sam/orrama/apps/mcp/dist/index.js"], env: { ORRAMA_TOKEN: "x" } });
    expect(withoutEntry(theirs, ours)).toEqual({ text: theirs, removed: false });
    expect(withoutEntry("", ours)).toEqual({ text: "", removed: false });
  });
});

describe("the file on disk", () => {
  it("writes beside a backup of what was there, keeping the file's permissions", () => {
    const dir = path.join(tmp, "a", "Claude");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "claude_desktop_config.json");
    fs.writeFileSync(file, OTHERS, { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    expect(changeDesktopConfig(file, (t) => withEntry(t, ENTRY))).toBe("changed");
    expect(fs.readFileSync(backupPath(file), "utf8")).toBe(OTHERS);
    expect(entryOf(fs.readFileSync(file, "utf8"))).toEqual(ENTRY);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    expect(changeDesktopConfig(file, (t) => withEntry(t, ENTRY))).toBe("unchanged");
    expect(fs.readdirSync(dir).sort()).toEqual(["claude_desktop_config.json", "claude_desktop_config.json.orrama-backup"]);
  });

  it("makes nothing when Claude Desktop isn't on this computer", () => {
    const file = path.join(tmp, "none", "Claude", "claude_desktop_config.json");
    expect(changeDesktopConfig(file, (t) => withEntry(t, ENTRY))).toBe("absent");
    expect(fs.existsSync(path.join(tmp, "none"))).toBe(false);
    expect(readDesktopEntry(file)).toEqual({ state: "absent" });
  });

  it("starts the file when Claude's folder is there but the file isn't", () => {
    const dir = path.join(tmp, "fresh", "Claude");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "claude_desktop_config.json");
    expect(readDesktopEntry(file)).toEqual({ state: "read", entry: undefined });
    expect(changeDesktopConfig(file, (t) => withEntry(t, ENTRY))).toBe("changed");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ mcpServers: { orrama: ENTRY } });
    expect(fs.existsSync(backupPath(file))).toBe(false);
  });

  it("leaves a broken file untouched, with no backup, and says why", () => {
    const dir = path.join(tmp, "broken", "Claude");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "claude_desktop_config.json");
    const broken = '{ "mcpServers": { "a": 1, } ';
    fs.writeFileSync(file, broken);
    expect(() => changeDesktopConfig(file, (t) => withEntry(t, ENTRY))).toThrow(/mistake in it \(line 1\)/);
    expect(fs.readFileSync(file, "utf8")).toBe(broken);
    expect(fs.readdirSync(dir)).toEqual(["claude_desktop_config.json"]);
    expect(readDesktopEntry(file)).toMatchObject({ state: "broken", words: expect.stringMatching(/left it alone/) });
  });

  it("knows where Claude Desktop keeps it on a Mac and on Windows", () => {
    expect(desktopConfigPath("darwin", {}, "/Users/sam")).toBe(path.join("/Users/sam", "Library", "Application Support", "Claude", "claude_desktop_config.json"));
    expect(desktopConfigPath("win32", { APPDATA: "C:\\Users\\Sam\\AppData\\Roaming" }, "C:\\Users\\Sam")).toBe(path.join("C:\\Users\\Sam\\AppData\\Roaming", "Claude", "claude_desktop_config.json"));
    expect(desktopConfigPath("win32", {}, "/home/sam")).toBe(path.join("/home/sam", "AppData", "Roaming", "Claude", "claude_desktop_config.json"));
  });
});
