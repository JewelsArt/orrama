/**
 * The notes folder is chosen in the app (first run, Settings → Notes) and kept in the data
 * folder (`notes-folder.json`), read at boot when ORRAMA_VAULT_DIR is not set; when it is set
 * (Jules's launchd agent) the variable wins and the app cannot change it. Choosing another
 * folder restarts the server to read it. Looking at a folder first says whether it exists, how
 * many notes it holds and how many get the one-time id line, and writes nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-notes-folder-"));
process.env.ORRAMA_DATA_DIR = dataDir;
delete process.env.ORRAMA_VAULT_DIR; // a friend's install: nothing set where Orrama starts
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

// A folder of notes the person already keeps elsewhere: one with an id, two without.
const theirs = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-their-notes-"));
fs.mkdirSync(path.join(theirs, "Trips"));
fs.writeFileSync(path.join(theirs, "Ideas.md"), "# Ideas\n");
fs.writeFileSync(path.join(theirs, "Trips", "Lisbon.md"), "---\ntitle: Lisbon\n---\n# Lisbon\n");
fs.writeFileSync(path.join(theirs, "Stamped.md"), "---\nid: n-abc123\n---\n# Stamped\n");
// They already say what things are, in a note of their own.
const { ONTOLOGY_TEMPLATE } = await import("@orrama/core");
fs.mkdirSync(path.join(theirs, "Meta"));
fs.writeFileSync(path.join(theirs, "Meta", "Kinds.md"), ONTOLOGY_TEMPLATE);
fs.mkdirSync(path.join(theirs, ".obsidian"));
fs.writeFileSync(path.join(theirs, ".obsidian", "Hidden.md"), "# not a note\n");
const theirBytes = () => ["Ideas.md", "Trips/Lisbon.md", "Stamped.md", "Meta/Kinds.md"].map((f) => fs.readFileSync(path.join(theirs, f), "utf8"));
const original = theirBytes();

const { buildServer } = await import("../src/main.js");
const { env, NOTES_FOLDER_FILE, ownNotesFolder, vaultDir } = await import("../src/env.js");

type Built = Awaited<ReturnType<typeof buildServer>>;
let b: Built;
let session = "";
const restart = vi.fn();
const as = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  b.app.inject({ method, url, headers: signedIn(session), ...(payload !== undefined ? { payload: payload as object } : {}) });

beforeAll(async () => {
  b = await buildServer({ restart });
  const r = await b.app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: "alex@example.test", username: "alex", displayName: "Alex", password: "correct horse battery" },
  });
  session = sessionOf(r);
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(theirs, { recursive: true, force: true });
});

describe("with no folder chosen", () => {
  it("reads Orrama's own folder, in the data folder, and Settings says it can be changed", async () => {
    expect(b.store.vaultRoot).toBe(ownNotesFolder());
    expect((await as("GET", "/api/settings/server")).json()).toMatchObject({ fixed: false, own: true, notes: 0, example: 0 });
  });
});

describe("looking at a folder", () => {
  it("counts its notes and the ones that get an id line, and writes nothing", async () => {
    const r = await as("POST", "/api/settings/notes-folder/look", { folder: theirs });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ problem: null, notes: 4, more: false, unstamped: 3, ontology: true, current: false });
    expect(theirBytes()).toEqual(original);
  });

  it("says what is wrong with one that can't be used", async () => {
    const look = async (folder: string) => (await as("POST", "/api/settings/notes-folder/look", { folder })).json().problem;
    expect(await look(path.join(theirs, "nope"))).toBe("There is no folder there.");
    expect(await look(path.join(theirs, "Ideas.md"))).toBe("That is a file, not a folder.");
    expect(await look("notes")).toBe("Type the whole path, starting with / or ~/.");
    expect(await look(path.dirname(dataDir))).toBe("That folder holds Orrama's own files. Pick the folder your notes are in.");
  });

  it("is a session's, never an API token's", async () => {
    const tok = await as("POST", "/api/tokens", { label: "script" });
    const r = await b.app.inject({ method: "POST", url: "/api/settings/notes-folder/look", headers: signedIn(tok.json().token), payload: { folder: theirs } });
    expect(r.statusCode).toBe(403);
  });
});

describe("choosing a folder", () => {
  it("stores it in the data folder and restarts the server to read it", async () => {
    const r = await as("PUT", "/api/settings/notes-folder", { folder: theirs });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ restart: true });
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, NOTES_FOLDER_FILE), "utf8"))).toEqual({ folder: path.resolve(theirs) });
    expect(vaultDir()).toBe(path.resolve(theirs));
  });

  it("is read at boot: a new build reads that folder and stamps each note once", async () => {
    await b.app.close();
    b = await buildServer({ restart });
    expect(b.store.vaultRoot).toBe(path.resolve(theirs));
    expect(b.store.index.all().map((n) => n.path).sort()).toEqual(["Ideas.md", "Meta/Kinds.md", "Stamped.md", "Trips/Lisbon.md"]);
    expect(fs.readFileSync(path.join(theirs, "Stamped.md"), "utf8")).toBe(original[2]);
    expect(fs.readFileSync(path.join(theirs, "Ideas.md"), "utf8")).toMatch(/^---\nid: n-/);
    expect((await as("GET", "/api/settings/server")).json()).toMatchObject({ fixed: false, own: false, notes: 4 });
  });

  it("starting there writes no second ontology note: the folder's own is the one read", async () => {
    expect((await as("POST", "/api/settings/start", { example: false })).json()).toEqual({ ontology: "there", example: 0 });
    expect(fs.existsSync(path.join(theirs, "Orrama"))).toBe(false);
    expect((await b.app.inject({ method: "GET", url: "/api/auth/status" })).json()).toEqual({ needsSetup: false, chooseNotes: false, resetHere: false });
  });

  it("choosing the folder already read restarts nothing", async () => {
    restart.mockClear();
    expect((await as("PUT", "/api/settings/notes-folder", { folder: theirs })).json()).toMatchObject({ restart: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(restart).not.toHaveBeenCalled();
  });

  it("Orrama's own folder again removes the stored choice", async () => {
    expect((await as("PUT", "/api/settings/notes-folder", { folder: null })).json()).toMatchObject({ restart: true });
    expect(fs.existsSync(path.join(dataDir, NOTES_FOLDER_FILE))).toBe(false);
    expect(vaultDir()).toBe(ownNotesFolder());
  });

  it("a stored folder that is gone is ignored at boot, not a crash", async () => {
    fs.writeFileSync(path.join(dataDir, NOTES_FOLDER_FILE), JSON.stringify({ folder: path.join(theirs, "moved-away") }));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(vaultDir()).toBe(ownNotesFolder());
    } finally {
      quiet.mockRestore();
      fs.rmSync(path.join(dataDir, NOTES_FOLDER_FILE));
    }
  });
});

describe("with ORRAMA_VAULT_DIR set (Jules's agent)", () => {
  it("the variable wins over a stored choice, and the app can't change it", async () => {
    fs.writeFileSync(path.join(dataDir, NOTES_FOLDER_FILE), JSON.stringify({ folder: theirs }));
    const fixed = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-fixed-"));
    env.vaultDir = fixed;
    try {
      expect(vaultDir()).toBe(fixed);
      await b.app.close();
      b = await buildServer({ restart });
      expect(b.store.vaultRoot).toBe(fixed);
      expect((await as("GET", "/api/settings/server")).json()).toMatchObject({ fixed: true });
      const r = await as("PUT", "/api/settings/notes-folder", { folder: theirs });
      expect(r.statusCode).toBe(409);
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, NOTES_FOLDER_FILE), "utf8"))).toEqual({ folder: theirs });
    } finally {
      env.vaultDir = null;
      fs.rmSync(fixed, { recursive: true, force: true });
    }
  });
});
