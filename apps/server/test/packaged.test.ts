/**
 * The server inside the desktop app (stage 2, `ORRAMA_PACKAGED=1`; the contract is in
 * ~/orrama-next/build/2-COMMON.md). Its shell says where the data and the web app are, hands it
 * a launch id that /api/health repeats, and a friend's notes go to `~/Orrama` (Jules, 25 Oct
 * 2026, D3), never into the data folder an uninstall may delete. Nothing here changes the
 * server run from the checkout: those defaults are held at the end.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-packaged-"));
const data = path.join(tmp, "data");
const notes = path.join(tmp, "notes");
const web = path.join(tmp, "web");
fs.mkdirSync(web);
const INDEX = "<!doctype html><title>Orrama</title><p>the packaged web app</p>\n";
fs.writeFileSync(path.join(web, "index.html"), INDEX);
const LAUNCH = crypto.randomBytes(16).toString("hex");
// The packaged default is ~/Orrama: a home of the test's own, so nothing here can write the
// real one (os.homedir() reads HOME, USERPROFILE on Windows).
const home = path.join(tmp, "home");
fs.mkdirSync(home);
process.env.HOME = home;
process.env.USERPROFILE = home;

process.env.ORRAMA_PACKAGED = "1";
process.env.ORRAMA_DATA_DIR = data;
delete process.env.ORRAMA_VAULT_DIR; // the shell never sets it
process.env.ORRAMA_DEFAULT_NOTES_DIR = notes;
process.env.ORRAMA_WEB_DIST = web;
process.env.ORRAMA_LAUNCH_ID = LAUNCH;
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

// A folder left by an earlier install (an uninstall keeps the notes): one note, no id line yet.
fs.mkdirSync(notes);
const LEFT = "# Left from before\n";
fs.writeFileSync(path.join(notes, "Left.md"), LEFT);

const { buildServer } = await import("../src/main.js");
const { env, envProblems, NOTES_FOLDER_FILE, notChosenFolder, ownNotesFolder } = await import("../src/env.js");
const { expandHome, ONTOLOGY_PATH } = await import("../src/firstRun.js");
const { VERSION, bundled } = await import("../src/build.js");

type Built = Awaited<ReturnType<typeof buildServer>>;
let b: Built;
let session = "";
const as = (method: "GET" | "POST", url: string, payload?: object) => b.app.inject({ method, url, headers: signedIn(session), ...(payload ? { payload } : {}) });

beforeAll(async () => {
  b = await buildServer();
  const r = await b.app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: "sam@example.test", username: "sam", displayName: "Sam", password: "correct horse battery" },
  });
  session = sessionOf(r);
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("what the shell hands the server", () => {
  it("health repeats the launch id, so the shell knows its own child", async () => {
    const r = (await b.app.inject({ method: "GET", url: "/api/health" })).json();
    expect(r).toMatchObject({ ok: true, launch: LAUNCH });
  });

  it("serves the web app from ORRAMA_WEB_DIST, and hashes that one for the build id", async () => {
    const page = await b.app.inject({ method: "GET", url: "/projects" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toBe(INDEX);
    const build = crypto.createHash("sha1").update(INDEX).digest("hex").slice(0, 12);
    expect((await b.app.inject({ method: "GET", url: "/api/health" })).json().build).toBe(build);
  });

  it("reads no folder of the person's before they choose one: nothing made, nothing stamped", async () => {
    expect(env.packaged).toBe(true);
    expect(b.store.vaultRoot).toBe(notChosenFolder());
    expect(fs.readFileSync(path.join(notes, "Left.md"), "utf8")).toBe(LEFT);
    expect(fs.existsSync(path.join(home, "Orrama"))).toBe(false);
    expect(fs.existsSync(path.join(data, "vault"))).toBe(false);
    // The chooser looks at Orrama's own folder without making it or writing in it.
    expect((await as("POST", "/api/settings/notes-folder/look", { folder: null })).json()).toMatchObject({ notes: 1, current: false });
    expect((await as("GET", "/api/settings/server")).json()).toMatchObject({ own: false });
    // And nothing can start in the stand-in.
    const early = await as("POST", "/api/settings/start", { example: false });
    expect(early.statusCode).toBe(409);
    expect(fs.readdirSync(notChosenFolder())).toEqual([]);
  });

  it("Start empty: the default notes folder is chosen, kept, and read from the next start", async () => {
    const chose = (await b.app.inject({ method: "PUT", url: "/api/settings/notes-folder", headers: signedIn(session), payload: { folder: null } })).json();
    expect(chose).toMatchObject({ restart: true });
    expect(JSON.parse(fs.readFileSync(path.join(data, NOTES_FOLDER_FILE), "utf8"))).toEqual({ folder: notes });
    await b.app.close();
    b = await buildServer();
    expect(b.store.vaultRoot).toBe(notes);
    expect((await as("POST", "/api/settings/start", { example: false })).json()).toMatchObject({ ontology: "written" });
    expect(fs.existsSync(path.join(notes, ONTOLOGY_PATH))).toBe(true);
    expect(fs.readFileSync(path.join(notes, "Left.md"), "utf8")).toMatch(/^---\nid: n-/);
  });

  it("the chosen default folder, deleted since, is made again rather than lost", async () => {
    await b.app.close();
    fs.rmSync(notes, { recursive: true, force: true });
    b = await buildServer();
    expect(b.store.vaultRoot).toBe(notes);
    expect(fs.existsSync(notes)).toBe(true);
  });

  it("refuses a notes folder inside the data folder, which an uninstall may delete", async () => {
    const inside = path.join(data, "my notes");
    fs.mkdirSync(inside);
    const r = await as("POST", "/api/settings/notes-folder/look", { folder: inside });
    expect(r.json().problem).toBe("That folder is inside Orrama's own folder, which uninstalling the app may delete. Pick a folder of your own.");
  });

  it("says its version from its own package, not from a file two folders up", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")) as { version: string };
    expect(bundled).toBe(false); // under tsx; the bundle's own is held by bundle.test.ts
    expect(VERSION).toBe(pkg.version);
    expect((await as("GET", "/api/settings/server")).json().version).toBe(pkg.version);
  });
});

describe("the defaults", () => {
  it("a friend's notes go to ~/Orrama; from the checkout, to the data folder as before", () => {
    expect(ownNotesFolder("/d", { packaged: true, defaultNotesDir: null })).toBe(path.join(home, "Orrama"));
    expect(ownNotesFolder("/d", { packaged: false, defaultNotesDir: null })).toBe(path.join("/d", "vault"));
    expect(ownNotesFolder("/d", { packaged: true, defaultNotesDir: "/x" })).toBe("/x");
  });

  it("names what is wrong with a packaged environment", () => {
    expect(envProblems({ ORRAMA_PACKAGED: "1" })).toEqual(["ORRAMA_PACKAGED=1 needs ORRAMA_DATA_DIR (the app's own data folder)"]);
    expect(envProblems({ ORRAMA_PACKAGED: "yes", ORRAMA_DATA_DIR: data })).toEqual([`ORRAMA_PACKAGED="yes" means nothing — it is "1" or unset`]);
    expect(envProblems({ ORRAMA_PACKAGED: "1", ORRAMA_DATA_DIR: data, ORRAMA_LAUNCH_ID: "abc" })).toEqual(["ORRAMA_LAUNCH_ID must be 32 hexadecimal characters"]);
    expect(envProblems({ ORRAMA_PACKAGED: "1", ORRAMA_DATA_DIR: data, ORRAMA_LAUNCH_ID: LAUNCH, ORRAMA_WEB_DIST: web, ORRAMA_DEFAULT_NOTES_DIR: notes })).toEqual([]);
  });
});

describe("a typed ~ on a computer with no HOME", () => {
  it("is the home folder all the same (Windows has USERPROFILE, not HOME)", () => {
    delete process.env.HOME;
    try {
      const typed = expandHome("~/Notes");
      expect(path.isAbsolute(typed)).toBe(true);
      expect(typed).toBe(path.join(os.homedir(), "Notes"));
    } finally {
      process.env.HOME = home;
    }
  });
});
