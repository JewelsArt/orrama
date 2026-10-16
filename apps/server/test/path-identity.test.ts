/**
 * One path identity: the spelling on disk (audit STO-012, ACL-001, REG-006).
 *
 * APFS and NTFS are case-insensitive (and APFS normalisation-insensitive), so
 * `Shared/eng secret.md` and `Shared/Eng Secret.md` are one file. Orrama
 * compared them as strings: an API write to the other spelling was judged as
 * the creation of a fresh, untagged note — past `#only/` and subfolder grants
 * — and renamed over the real file; a case-only rename in Obsidian made the
 * watcher take each spelling for a copy of the other and restamp the file
 * with alternating ids, forever. Now every path a caller sends is resolved to
 * the entry the directory actually holds, matched case- and NFC-insensitively
 * (VaultStore.resolvePath), and the watcher only believes names the directory
 * lists exactly.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-path-identity-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.ORRAMA_VAULT_DIR;
fs.mkdirSync(VAULT, { recursive: true });
await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");

/** Whether this volume folds case — the watcher half only means anything where it does. */
const CASE_INSENSITIVE = (() => {
  const probe = path.join(process.env.ORRAMA_DATA_DIR!, "CaseProbe");
  fs.writeFileSync(probe, "");
  const folds = fs.existsSync(path.join(process.env.ORRAMA_DATA_DIR!, "caseprobe"));
  fs.rmSync(probe);
  return folds;
})();

/** Whether this volume reads `ſ` (U+017F, long s) as `s`: APFS does; ext4 and, by the Windows run, NTFS do not. */
const FOLDS_LONG_S = (() => {
  const probe = path.join(process.env.ORRAMA_DATA_DIR!, "sprobe");
  fs.writeFileSync(probe, "");
  const folds = fs.existsSync(path.join(process.env.ORRAMA_DATA_DIR!, "\u017Fprobe"));
  fs.rmSync(probe);
  return folds;
})();

type Built = Awaited<ReturnType<typeof buildServer>>;
let b: Built;
const tokens: Record<string, string> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const abs = (rel: string) => path.join(VAULT, rel);
const read = (rel: string) => fs.readFileSync(abs(rel), "utf8");
const restamps: string[] = [];
/** A name stored decomposed, the way macOS keeps what some apps write. */
const NFD = "Shared/Re\u0301sume\u0301.md";

const put = async (who: string, body: Record<string, unknown>) => {
  const res = await b.app.inject({ method: "PUT", url: "/api/vault/note", headers: signedIn(tokens[who]), payload: body });
  return { status: res.statusCode, json: (() => { try { return res.json(); } catch { return null; } })() };
};
const indexPaths = (prefix: string) =>
  b.store.index
    .all()
    .map((n) => n.path)
    .filter((p) => p.toLowerCase().startsWith(prefix.toLowerCase()))
    .sort();

beforeAll(async () => {
  // On disk before boot, so the first index holds it: waiting for the watcher instead failed
  // when every package's tests ran at once, and macOS delivered the event 25 s late.
  fs.mkdirSync(path.dirname(abs(NFD)), { recursive: true });
  fs.writeFileSync(abs(NFD), "---\ntitle: R\u00e9sum\u00e9\n---\nv1\n");
  b = await buildServer();
  for (const who of ["jules", "mara"]) {
    tokens[who] = sessionOf(await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@orrama.dev`, password: "orrama-demo" } }));
  }
  const warn = console.warn;
  console.warn = (...a: unknown[]) => {
    if (String(a[0]).includes("carries note id")) restamps.push(String(a[0]));
    warn(...a);
  };
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("API writes resolve to the note on disk (ACL-001)", () => {
  it("a non-member writing a case variant of an #only note's path is refused, and the note is untouched", async () => {
    const real = "Shared/Eng Secret.md";
    expect((await put("jules", { path: real, content: "---\ntitle: Eng Secret\ntags: [only/engineering]\n---\n# Eng secret\n" })).status).toBe(200);
    const before = read(real);
    // mara (marketing) edits Shared/ but is not in engineering.
    expect((await put("mara", { path: real, content: "pwned\n" })).status).toBe(403);
    const variant = await put("mara", { path: "Shared/eng secret.md", content: "pwned by mara\n" });
    expect(variant.status).toBe(403);
    expect(fs.readdirSync(abs("Shared"))).toContain("Eng Secret.md");
    expect(fs.readdirSync(abs("Shared"))).not.toContain("eng secret.md");
    expect(read(real)).toBe(before);
    expect(indexPaths("Shared/eng secret")).toEqual([real]);
  });

  it("a case-variant folder is judged by the grant of the folder on disk", async () => {
    // Make marketing an editor of the vault root. Engineering's own grant
    // still says engineering only; `engineering/` used to miss it and fall
    // through to the root, where mara may edit.
    const mkt = b.db.select().from(tables.teams).where(eq(tables.teams.slug, "marketing")).get()!;
    const rootGrant = and(eq(tables.folderGrants.teamId, mkt.id), eq(tables.folderGrants.folder, ""));
    b.db.update(tables.folderGrants).set({ role: "editor" }).where(rootGrant).run();
    try {
      const real = "Engineering/Atlas Roadmap.md";
      const before = read(real);
      expect((await put("mara", { path: real, content: "roadmap overwritten by mara\n" })).status).toBe(403);
      const res = await put("mara", { path: "engineering/Atlas Roadmap.md", content: "roadmap overwritten by mara\n" });
      expect(res.status).toBe(403);
      expect(read(real)).toBe(before);
      expect(fs.readdirSync(VAULT)).not.toContain("engineering");
    } finally {
      b.db.update(tables.folderGrants).set({ role: "viewer" }).where(rootGrant).run();
    }
  });

  it("a spelling only the volume folds (ſ for s) is still another user's personal note, and is refused", async () => {
    // APFS reads `Perſonal` (U+017F, long s) as `Personal`; NFC and toLowerCase
    // leave it alone. The audit's repro wrote erin's inbox through it (ACL-001).
    // mara edits the vault root, as in the repro; Personal/ is never hers.
    // Where the volume does not fold ſ (Linux, Windows), `Perſonal` is a folder
    // of its own that mara may create; the private note is untouched either way.
    const mkt = b.db.select().from(tables.teams).where(eq(tables.teams.slug, "marketing")).get()!;
    const rootGrant = and(eq(tables.folderGrants.teamId, mkt.id), eq(tables.folderGrants.folder, ""));
    b.db.update(tables.folderGrants).set({ role: "editor" }).where(rootGrant).run();
    try {
      const real = "Personal/jules/Private.md";
      expect((await put("jules", { path: real, content: "---\ntitle: Private\n---\nmine\n" })).status).toBe(200);
      const before = read(real);
      const res = await put("mara", { path: "Perſonal/jules/Private.md", content: "mara was here\n" });
      expect(read(real)).toBe(before);
      if (FOLDS_LONG_S) {
        expect(res.status).toBe(403);
        expect(fs.readdirSync(VAULT)).not.toContain("Perſonal");
      } else {
        expect(res.status).toBe(200);
        expect(fs.readdirSync(VAULT)).toContain("Perſonal");
        // A new note of mara's own: the server stamps its id, as on every create.
        expect(read("Perſonal/jules/Private.md")).toMatch(/^---\nid: n-[a-z0-9]+\n---\nmara was here\n$/);
        fs.rmSync(abs("Perſonal"), { recursive: true });
      }
    } finally {
      b.db.update(tables.folderGrants).set({ role: "viewer" }).where(rootGrant).run();
    }
  });

  it("an owner write to a case variant edits that note — same id, merged, one index entry", async () => {
    const real = "Shared/Meeting Notes 2026-07-01.md";
    const note = b.store.index.getByPath(real)!;
    const before = read(real);
    const res = await put("jules", { path: "shared/meeting notes 2026-07-01.md", content: before.replace("Cross-team sync.", "Cross-team sync, edited.") });
    expect(res.status).toBe(200);
    expect(res.json.id).toBe(note.id);
    expect(res.json.path).toBe(real);
    expect(read(real)).toContain("Cross-team sync, edited.");
    expect(read(real)).toContain("[[Atlas Roadmap]] on track");
    expect(fs.readdirSync(abs("Shared"))).toContain("Meeting Notes 2026-07-01.md");
    expect(indexPaths("Shared/Meeting Notes")).toEqual([real]);
  });

  it("a name stored decomposed (NFD) is reached by its composed (NFC) spelling", async () => {
    const held = b.store.index.all().find((n) => n.path.normalize("NFC") === "Shared/R\u00e9sum\u00e9.md");
    expect(held).toBeDefined();
    expect(fs.readdirSync(abs("Shared"))).toContain(path.basename(NFD)); // still decomposed on disk
    const res = await put("jules", { path: "Shared/R\u00e9sum\u00e9.md", content: "---\ntitle: R\u00e9sum\u00e9\n---\nv2\n" });
    expect(res.status).toBe(200);
    expect(res.json.id).toBe(held!.id);
    expect(res.json.path).toBe(held!.path);
    expect(b.store.index.all().filter((n) => n.path.normalize("NFC") === "Shared/R\u00e9sum\u00e9.md")).toHaveLength(1);
  });

  it("a file on disk the watcher has not settled yet is still that note, not a creation", async () => {
    // Obsidian just saved it; the watcher waits 300 ms. A write in between
    // used to be judged as the creation of an untagged note.
    fs.writeFileSync(abs("Shared/Fresh Secret.md"), "---\ntitle: Fresh Secret\ntags: [only/engineering]\n---\nsecret\n");
    const res = await put("mara", { path: "Shared/fresh secret.md", content: "pwned\n" });
    expect(res.status).toBe(403);
    expect(read("Shared/Fresh Secret.md")).toContain("secret\n");
    expect(read("Shared/Fresh Secret.md")).not.toContain("pwned");
  });

  it("a brand-new note keeps the spelling it was given", async () => {
    const res = await put("jules", { path: "Shared/Brand New Idea.md", content: "hello\n" });
    expect(res.status).toBe(200);
    expect(res.json.path).toBe("Shared/Brand New Idea.md");
    expect(fs.readdirSync(abs("Shared"))).toContain("Brand New Idea.md");
  });

  it("a move that only changes a note's case renames it in place", async () => {
    const res = await b.app.inject({
      method: "POST",
      url: "/api/vault/move",
      headers: signedIn(tokens.jules),
      payload: { fromPath: "Shared/Brand New Idea.md", toPath: "Shared/brand new idea.md" },
    });
    expect(res.statusCode).toBe(200);
    expect(fs.readdirSync(abs("Shared"))).toContain("brand new idea.md");
    expect(fs.readdirSync(abs("Shared"))).not.toContain("Brand New Idea.md");
    expect(indexPaths("Shared/brand new idea")).toEqual(["Shared/brand new idea.md"]);
  });

  it("a move onto another note's case variant is refused", async () => {
    const res = await b.app.inject({
      method: "POST",
      url: "/api/vault/move",
      headers: signedIn(tokens.jules),
      payload: { fromPath: "Shared/brand new idea.md", toPath: "shared/eng secret.md" },
    });
    expect(res.statusCode).toBe(409);
    expect(read("Shared/Eng Secret.md")).toContain("# Eng secret");
  });
});

// Up to 25 s a step: with every package's tests running at once, macOS can deliver a file
// event that late (a fixed 1.5 s failed there).
describe.runIf(CASE_INSENSITIVE)("a case-only rename outside Orrama (STO-012)", { timeout: 120_000 }, () => {
  /** Wait for the watcher to show `done`, then 1.5 s more for anything it would do after it
   *  (a restamp, a rewrite, the old spelling coming back). */
  const settle = async (done: () => boolean) => {
    for (let t = 0; t < 250 && !done(); t++) await sleep(100);
    await sleep(1500);
  };
  const only = (prefix: string, ...paths: string[]) => () => indexPaths(prefix).join("|") === paths.join("|");

  it("leaves one index entry under the new spelling, with its id, and never rewrites the file", async () => {
    fs.mkdirSync(abs("Notes"), { recursive: true });
    fs.writeFileSync(abs("Notes/Meeting notes.md"), "# Meeting\n\n- [ ] follow up\n");
    await settle(only("Notes/", "Notes/Meeting notes.md"));
    const id = b.store.index.getByPath("Notes/Meeting notes.md")?.id;
    expect(id).toMatch(/^n-/);
    const stamped = read("Notes/Meeting notes.md");
    restamps.length = 0;

    fs.renameSync(abs("Notes/Meeting notes.md"), abs("Notes/Meeting Notes.md"));
    const mtime = fs.statSync(abs("Notes/Meeting Notes.md")).mtimeMs;
    await settle(only("Notes/", "Notes/Meeting Notes.md"));
    expect(fs.readdirSync(abs("Notes"))).toEqual(["Meeting Notes.md"]);
    expect(indexPaths("Notes/")).toEqual(["Notes/Meeting Notes.md"]);
    expect(b.store.index.getByPath("Notes/Meeting Notes.md")?.id).toBe(id);
    expect(read("Notes/Meeting Notes.md")).toBe(stamped);
    expect(fs.statSync(abs("Notes/Meeting Notes.md")).mtimeMs).toBe(mtime);
    expect(restamps).toEqual([]);

    // …and back.
    fs.renameSync(abs("Notes/Meeting Notes.md"), abs("Notes/Meeting notes.md"));
    await settle(only("Notes/", "Notes/Meeting notes.md"));
    expect(fs.readdirSync(abs("Notes"))).toEqual(["Meeting notes.md"]);
    expect(indexPaths("Notes/")).toEqual(["Notes/Meeting notes.md"]);
    expect(b.store.index.getByPath("Notes/Meeting notes.md")?.id).toBe(id);
    expect(read("Notes/Meeting notes.md")).toBe(stamped);
    expect(restamps).toEqual([]);
  });

  it("a late event for the old spelling does not bring it back", async () => {
    // chokidar reports the old spelling as "change" or "unlink", in either
    // order with the new one's "add"; existsSync says yes to it either way.
    const id = b.store.index.getByPath("Notes/Meeting notes.md")?.id;
    const settle = (b.store as unknown as { handleExternalChange(e: string, rel: string, abs: string): void }).handleExternalChange.bind(b.store);
    for (const event of ["change", "unlink", "add"]) {
      settle(event, "Notes/Meeting Notes.md", abs("Notes/Meeting Notes.md"));
      expect(indexPaths("Notes/")).toEqual(["Notes/Meeting notes.md"]);
      expect(b.store.index.getByPath("Notes/Meeting notes.md")?.id).toBe(id);
    }
    expect(restamps).toEqual([]);
  });

  it("a case-only rename of a folder moves every note in it, ids kept, nothing rewritten", async () => {
    fs.mkdirSync(abs("Box"), { recursive: true });
    fs.writeFileSync(abs("Box/One.md"), "one\n");
    fs.writeFileSync(abs("Box/Two.md"), "two\n");
    await settle(only("Box/", "Box/One.md", "Box/Two.md"));
    const ids = ["Box/One.md", "Box/Two.md"].map((p) => b.store.index.getByPath(p)?.id);
    const bytes = ["Box/One.md", "Box/Two.md"].map(read);
    restamps.length = 0;

    fs.renameSync(abs("Box"), abs("box"));
    await settle(only("Box/", "box/One.md", "box/Two.md"));
    expect(indexPaths("Box/")).toEqual(["box/One.md", "box/Two.md"]);
    expect(["box/One.md", "box/Two.md"].map((p) => b.store.index.getByPath(p)?.id)).toEqual(ids);
    expect(["box/One.md", "box/Two.md"].map(read)).toEqual(bytes);
    expect(fs.readdirSync(VAULT)).toContain("box");
    expect(restamps).toEqual([]);
  });

  it("a real copy is still a copy: it gets its own id", async () => {
    fs.copyFileSync(abs("Notes/Meeting notes.md"), abs("Notes/Meeting notes copy.md"));
    await settle(() => restamps.length > 0 && !!b.store.index.getByPath("Notes/Meeting notes copy.md"));
    const orig = b.store.index.getByPath("Notes/Meeting notes.md")!;
    const copy = b.store.index.getByPath("Notes/Meeting notes copy.md")!;
    expect(copy.id).not.toBe(orig.id);
    expect(restamps).toHaveLength(1);
  });
});
