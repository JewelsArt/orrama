/**
 * Back up now and Restore (2F, backup.ts, routes/backup.ts): one .zip with the notes, a
 * consistent database snapshot, the readable export and a README; never the secret key
 * (Jules, D13); restored on a fresh install it lands signed in as the backup's account with
 * the same notes, projects, comments and history. What the key can't open on another computer
 * is left out, a folder with files in it needs a yes, and the notes never go inside the app's
 * own data folder.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWN_ORIGIN, sessionOf, signedIn } from "./helpers/session.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-backup-"));
process.env.ORRAMA_DATA_DIR = path.join(ROOT, "data");
delete process.env.ORRAMA_VAULT_DIR; // the folder is chosen in the app, as on a friend's computer
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const DATA = process.env.ORRAMA_DATA_DIR;
const OUT = path.join(ROOT, "out");
fs.mkdirSync(OUT, { recursive: true });

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { encryptSecret } = await import("../src/secrets.js");
const backup = await import("../src/backup.js");
const { ZipReader, ZipWriter } = await import("../src/backupZip.js");
const { exportOrrama } = await import("../src/exportData.js");
const R = await import("@orrama/schema/responses");

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let token = "";
let restarts = 0;
const restart = () => void restarts++;
const boot = async () => (built = await buildServer({ restart }));
const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: object, headers: Record<string, string> = signedIn(token)) => {
  const r = await built.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), res: r };
};
const upload = (zip: string, headers: Record<string, string>) =>
  built.app.inject({ method: "POST", url: "/api/backup/restore/look", headers: { ...headers, "content-type": "application/zip" }, payload: fs.readFileSync(zip) });

/** Every entry of a zip, inflated, by name. */
async function entries(zip: string): Promise<Map<string, Buffer>> {
  const z = ZipReader.open(zip);
  try {
    const out = new Map<string, Buffer>();
    for (const item of z.items) out.set(item.name, await z.read(item, 64 * 1024 * 1024));
    return out;
  } finally {
    z.close();
  }
}

let taskId = "";
let made: Awaited<ReturnType<typeof backup.makeBackup>>;
let before: { notes: number; projects: string[]; history: number };

beforeAll(async () => {
  await boot();
  token = sessionOf(await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
  const roadmap = built.store.index.getByPath("Engineering/Atlas Roadmap.md")!;
  const { line, raw: text } = roadmap.tasks.find((t) => t.text.startsWith("dashboard API"))!;
  taskId = (await call("POST", "/api/tasks/promote", { noteId: roadmap.id, line, text })).json.id;
  expect((await call("POST", `/api/tasks/${taskId}/comments`, { body: "Restored comment: ask Erin." })).status).toBe(200);
  // Stored encrypted: what the key opens.
  expect((await call("POST", "/api/admin/ai", { provider: "google", model: "gemini-2.5-flash", apiKey: "g-secret-ai-key-0123456789" })).status).toBe(200);
  const me = built.db.select().from(tables.users).all().find((u) => u.username === "jules")!;
  built.db.insert(tables.mailAccounts).values({ id: "ma-1", userId: me.id, email: "jules@example.com", imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com", smtpPort: 465, passwordEncrypted: encryptSecret("mail-app-password-xyz"), createdAt: Date.now() } as never).run();
  // A note edited, so it has history.
  const note = built.store.index.getByPath("Engineering/Atlas Roadmap.md")!;
  const read = await call("GET", `/api/vault/note/${note.id}`);
  await call("PUT" as "POST", "/api/vault/note", { path: note.path, content: `${read.json.content}\nOne more line.\n`, baseContent: read.json.content, baseHash: read.json.hash });
  before = {
    notes: built.store.index.all().length,
    projects: ((await call("GET", "/api/projects")).json as { name: string }[]).map((p) => p.name).sort(),
    history: (await call("GET", `/api/vault/note/${note.id}/history`)).json.revisions?.length ?? 0,
  };
  made = (await call("POST", "/api/backup", { folder: OUT })).json;
});

afterAll(async () => {
  await built?.app.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("Back up now", () => {
  it("writes one zip, named for the day, where it was asked, and says its size", async () => {
    R.backupResponse.parse(made);
    expect(made.name).toMatch(/^Orrama backup \d{4}-\d{2}-\d{2}\.zip$/);
    const file = path.join(OUT, made.name);
    expect(fs.statSync(file).size).toBe(made.bytes);
    expect(made.notes).toBe(before.notes);
    expect(fs.readdirSync(OUT)).toEqual([made.name]); // no .partial left
  });

  it("holds the notes, the database, the export, the manifest and a README in plain words", async () => {
    const z = await entries(path.join(OUT, made.name));
    const names = [...z.keys()];
    for (const n of ["README.txt", "backup.json", "basalt.db", "export.json"]) expect(names).toContain(n);
    expect(names).toContain("notes/Engineering/Atlas Roadmap.md");
    expect(names.filter((n) => n.startsWith("notes/") && n.endsWith(".md")).length).toBe(made.notes);
    // The notes are the files as they are on disk, byte for byte.
    const roadmap = path.join(DATA, "vault", "Engineering", "Atlas Roadmap.md");
    expect(z.get("notes/Engineering/Atlas Roadmap.md")!.equals(fs.readFileSync(roadmap))).toBe(true);
    const manifest = JSON.parse(z.get("backup.json")!.toString("utf8"));
    expect(manifest).toMatchObject({ format: "orrama-backup", formatVersion: 1, notes: made.notes });
    const readme = z.get("README.txt")!.toString("utf8");
    expect(readme).toContain("I have a backup");
    expect(readme).toContain("Restore from a backup");
    expect(readme).toMatch(/Mail and Orr's AI ask to be connected again/);
    expect(readme).not.toMatch(/launchctl|pnpm|terminal|Node/i);
  });

  it("never holds the secret key or the session secret (D13)", async () => {
    const z = await entries(path.join(OUT, made.name));
    for (const [name, bytes] of z) {
      for (const secret of [process.env.ORRAMA_SECRET_KEY!, process.env.ORRAMA_JWT_SECRET!]) {
        expect(bytes.includes(Buffer.from(secret)), `${secret.slice(0, 12)}… in ${name}`).toBe(false);
      }
    }
    // The encrypted values are in the database, still sealed.
    expect(z.get("export.json")!.toString("utf8")).not.toContain("g-secret-ai-key");
  });

  it("refuses to write inside the notes folder", async () => {
    const r = await call("POST", "/api/backup", { folder: path.join(DATA, "vault", "Engineering") });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/inside your notes folder/);
  });

  it("in a browser: made in the data folder, downloaded once, then gone", async () => {
    const r = await call("POST", "/api/backup", { folder: null });
    expect(r.status).toBe(200);
    expect(r.json.folder).toBeNull();
    const got = await built.app.inject({ method: "GET", url: r.json.download, headers: signedIn(token) });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-disposition"]).toContain("attachment");
    expect(got.rawPayload.subarray(0, 4).readUInt32LE(0)).toBe(0x04034b50);
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readdirSync(path.join(DATA, "backups-out"))).toEqual([]);
    expect((await built.app.inject({ method: "GET", url: "/api/backup/download/..%2Fbasalt.db", headers: signedIn(token) })).statusCode).toBe(400);
  });

  it("is the owner's, from a session", async () => {
    expect((await call("POST", "/api/backup", { folder: OUT }, {})).status).toBe(401);
    const tok = (await call("POST", "/api/tokens", { label: "x" })).json.token as string;
    expect((await call("POST", "/api/backup", { folder: OUT }, signedIn(tok))).status).toBe(403);
    // Another account, signed in, is not the owner: no backup, no restore.
    const erin = sessionOf(await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "erin@orrama.dev", password: "orrama-demo" } }));
    expect(erin).not.toBe("");
    expect((await call("POST", "/api/backup", { folder: OUT }, signedIn(erin))).status).toBe(403);
    expect((await upload(path.join(OUT, made.name), signedIn(erin))).statusCode).toBe(403);
  });
});

describe("the snapshot", () => {
  it("is consistent while the server writes", async () => {
    // Big enough that SQLite's backup takes many steps, so writes land between them.
    const sqlite = (built.db as unknown as { $client: Database.Database }).$client;
    sqlite.exec("create table if not exists pairs (k text primary key, side text, v blob)");
    const blob = Buffer.alloc(8192, 7);
    const pair = sqlite.transaction((i: number) => {
      sqlite.prepare("insert into pairs values (?, 'a', ?)").run(`a${i}`, blob);
      sqlite.prepare("insert into pairs values (?, 'b', ?)").run(`b${i}`, blob);
    });
    for (let i = 0; i < 600; i++) pair(i);
    // Committed before the backup starts: it must be in the snapshot.
    sqlite.prepare("insert into meta (key, value) values ('backup-marker', 'there')").run();
    let n = 600;
    let writing = true;
    const writer = (async () => {
      while (writing && n < 700) {
        pair(n++);
        await new Promise((r) => setImmediate(r));
      }
    })();
    const into = fs.mkdtempSync(path.join(ROOT, "snap-"));
    const res = await exportOrrama({ into });
    writing = false;
    await writer;
    const snap = new Database(path.join(res.dir, "basalt.db"), { readonly: true });
    try {
      expect(snap.pragma("integrity_check", { simple: true })).toBe("ok");
      const count = (side: string) => (snap.prepare("select count(*) as c from pairs where side = ?").get(side) as { c: number }).c;
      expect(count("a")).toBe(count("b"));
      expect(count("a")).toBeGreaterThanOrEqual(600);
      expect(snap.prepare("select value from meta where key = 'backup-marker'").get()).toEqual({ value: "there" });
    } finally {
      snap.close();
      sqlite.exec("drop table pairs; delete from meta where key = 'backup-marker'");
    }
  });
});

describe("export (the command)", () => {
  it("copies notes-folder.json, and its restore text says nothing of launchd", async () => {
    const chosen = path.join(DATA, "notes-folder.json");
    fs.writeFileSync(chosen, JSON.stringify({ folder: path.join(DATA, "vault") }));
    try {
      const into = fs.mkdtempSync(path.join(ROOT, "export-"));
      const { dir } = await exportOrrama({ into });
      expect(fs.readdirSync(dir).sort()).toEqual(["README.txt", "basalt.db", "export.json", "notes-folder.json"]);
      const readme = fs.readFileSync(path.join(dir, "README.txt"), "utf8");
      expect(readme).not.toMatch(/launchctl|launchd/);
      expect(readme).toContain("Quit Orrama");
      expect(readme).toContain("Copy notes-folder.json");
    } finally {
      fs.rmSync(chosen, { force: true });
    }
  });
});

describe("where the notes go", () => {
  it("never inside Orrama's own data folder, nor a folder that holds it", async () => {
    expect(R.restoreFolderResponse.parse((await call("POST", "/api/backup/restore/folder", { folder: path.join(DATA, "notes") })).json).problem).toMatch(/inside Orrama's own folder/);
    expect(backup.lookAtTarget(path.join(DATA, "notes")).problem).toMatch(/inside Orrama's own folder/);
    expect(backup.lookAtTarget(ROOT).problem).toMatch(/holds Orrama's own files/);
    expect(backup.lookAtTarget(path.join(ROOT, "fresh-notes"))).toMatchObject({ problem: null, files: 0 });
    expect(backup.lookAtTarget(path.join(ROOT, "no", "such", "place")).problem).toMatch(/There is no folder/);
  });
});

describe("reading a backup", () => {
  it("refuses a zip that is not one, and a name that climbs out of the folder", async () => {
    const plain = path.join(ROOT, "plain.zip");
    const w = ZipWriter.open(plain);
    w.addBuffer("hello.txt", "hi");
    w.close();
    await expect(backup.lookAtBackup(plain)).rejects.toThrow(/isn't an Orrama backup/);

    const z = await entries(path.join(OUT, made.name));
    const evil = path.join(ROOT, "evil.zip");
    const e = ZipWriter.open(evil);
    e.addBuffer("backup.json", z.get("backup.json")!);
    e.addBuffer("basalt.db", z.get("basalt.db")!);
    e.addBuffer("notes/../../escaped.md", "# out");
    e.close();
    await expect(backup.lookAtBackup(evil)).rejects.toThrow(/won't write/);

    const text = path.join(ROOT, "not-a-zip.zip");
    fs.writeFileSync(text, "just text");
    await expect(backup.lookAtBackup(text)).rejects.toThrow(/isn't a \.zip/);
  });

  it("refuses an entry whose bytes are not what the zip says", async () => {
    const good = path.join(ROOT, "crc.zip");
    const w = ZipWriter.open(good);
    w.addBuffer("a.txt", "hello hello hello");
    w.close();
    const buf = fs.readFileSync(good);
    // Flip one byte of the deflated data (right after the 30-byte header and the 5-byte name).
    buf[35] = buf[35]! ^ 0xff;
    fs.writeFileSync(good, buf);
    const z = ZipReader.open(good);
    try {
      await expect(z.read(z.items[0]!, 1024)).rejects.toThrow();
    } finally {
      z.close();
    }
    expect(zlib.crc32("x")).toBeTypeOf("number");
  });
});

describe("restoring on another computer", () => {
  it("leaves out what this key can't open, and says so", async () => {
    const other = path.join(ROOT, "other");
    fs.mkdirSync(other);
    fs.mkdirSync(backup.uploadDir(other), { recursive: true });
    fs.copyFileSync(path.join(OUT, made.name), backup.uploadedZip(other));
    const otherKey = "another-computers-key-0123456789abcdef";
    const look = await backup.lookAtBackup(backup.uploadedZip(other), { dataDir: other, secretKey: otherKey });
    expect(look.keyOpens).toBe(false);
    expect(look.account.email).toBe("jules@orrama.dev");
    const staged = await backup.stageRestore({ folder: path.join(ROOT, "other-notes"), replace: false, dataDir: other, secretKey: otherKey });
    expect(staged.dropped.sort()).toEqual(["ai", "mail"]);
    const db = new Database(path.join(backup.pendingDir(other), "basalt.db"), { readonly: true });
    try {
      expect(db.prepare("select ai_key_encrypted as k from workspace").get()).toEqual({ k: null });
      expect(db.prepare("select count(*) as c from mail_accounts").get()).toEqual({ c: 0 });
      // Everything else came: the comment, the AI's provider.
      expect((db.prepare("select count(*) as c from task_comments").get() as { c: number }).c).toBeGreaterThan(0);
      expect(db.prepare("select ai_provider as p from workspace").get()).toEqual({ p: "google" });
    } finally {
      db.close();
    }
  });

  it("keeps them on the computer the key belongs to", async () => {
    const same = path.join(ROOT, "same");
    fs.mkdirSync(backup.uploadDir(same), { recursive: true });
    fs.copyFileSync(path.join(OUT, made.name), backup.uploadedZip(same));
    expect((await backup.lookAtBackup(backup.uploadedZip(same), { dataDir: same })).keyOpens).toBe(true);
    const staged = await backup.stageRestore({ folder: path.join(ROOT, "same-notes"), replace: false, dataDir: same });
    expect(staged.dropped).toEqual([]);
  });

  it("throws an unfinished staging away and keeps the database", () => {
    const dir = path.join(ROOT, "unfinished");
    fs.mkdirSync(backup.pendingDir(dir), { recursive: true });
    fs.writeFileSync(path.join(backup.pendingDir(dir), "basalt.db"), "half");
    fs.writeFileSync(path.join(dir, "basalt.db"), "the live one");
    expect(backup.applyPendingRestore(dir)).toBeNull();
    expect(fs.readFileSync(path.join(dir, "basalt.db"), "utf8")).toBe("the live one");
    expect(fs.existsSync(backup.pendingDir(dir))).toBe(false);
  });
});

describe("restoring on a fresh install", () => {
  const target = path.join(ROOT, "My notes");
  let session = "";

  beforeAll(async () => {
    // A fresh install: no database, no notes, nobody signed up.
    await built.app.close();
    for (const f of fs.readdirSync(DATA)) fs.rmSync(path.join(DATA, f), { recursive: true, force: true });
    await boot();
    expect((await call("GET", "/api/auth/status", undefined, {})).json.needsSetup).toBe(true);
  });

  it("takes the zip in before anyone has an account, from our own page only", async () => {
    const zip = path.join(OUT, made.name);
    expect((await upload(zip, { origin: "https://evil.example" })).statusCode).toBe(403);
    const look = await upload(zip, { origin: OWN_ORIGIN });
    expect(look.statusCode).toBe(200);
    R.backupLookResponse.parse(look.json());
    expect(look.json()).toMatchObject({ notes: made.notes, account: { email: "jules@orrama.dev" }, keyOpens: true, folderFiles: 0 });
  });

  it("refuses a folder with files in it without a yes, and writes nothing", async () => {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "mine.md"), "# Mine\n");
    const r = await call("POST", "/api/backup/restore", { folder: target, replace: false }, { origin: OWN_ORIGIN });
    expect(r.status).toBe(409);
    expect(r.json.files).toBe(1);
    expect(fs.readdirSync(target)).toEqual(["mine.md"]);
    expect(fs.existsSync(backup.pendingDir())).toBe(false);
    expect(restarts).toBe(0);
    fs.rmSync(target, { recursive: true });
  });

  it("restores into an empty folder, restarts, and lands signed in as the backup's account", async () => {
    const r = await call("POST", "/api/backup/restore", { folder: target, replace: false }, { origin: OWN_ORIGIN });
    expect(r.status).toBe(200);
    R.restoreResponse.parse(r.json);
    expect(r.json.dropped).toEqual([]);
    session = sessionOf(r.res);
    expect(session).not.toBe("");
    await new Promise((res) => setTimeout(res, 20));
    expect(restarts).toBe(1);
    // What main.ts's restart does: close this build, make a new one.
    await built.app.close();
    await boot();
    token = session;
    const me = await call("GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.json.username).toBe("jules");
    expect((await call("GET", "/api/auth/status", undefined, {})).json).toMatchObject({ needsSetup: false, chooseNotes: false });
    expect(built.store.vaultRoot).toBe(path.resolve(target));
    expect(built.store.index.all().length).toBe(before.notes);
    expect(((await call("GET", "/api/projects")).json as { name: string }[]).map((p) => p.name).sort()).toEqual(before.projects);
    const comments = await call("GET", `/api/tasks/${taskId}/comments`);
    expect(JSON.stringify(comments.json)).toContain("Restored comment: ask Erin.");
    const note = built.store.index.getByPath("Engineering/Atlas Roadmap.md")!;
    expect((await call("GET", `/api/vault/note/${note.id}/history`)).json.revisions.length).toBe(before.history);
    // The database it replaced is kept, and the old sessions are over.
    expect(fs.readdirSync(path.join(DATA, "backups")).some((n) => n.startsWith("basalt-before-restore-"))).toBe(true);
    expect(fs.existsSync(backup.pendingDir())).toBe(false);
  });

  it("is the owner's once an account exists", async () => {
    expect((await upload(path.join(OUT, made.name), { origin: OWN_ORIGIN })).statusCode).toBe(401);
    expect((await call("POST", "/api/backup/restore", { folder: target, replace: true }, { origin: OWN_ORIGIN })).status).toBe(401);
  });
});
