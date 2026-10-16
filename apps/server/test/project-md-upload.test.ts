/**
 * A .md uploaded as a project document is a note: the watcher indexes it and
 * Obsidian opens it. It used to be stored as bytes, outside store.write, so
 * it skipped every rule a note is created under. In the seed erin edits the
 * Atlas project note (it lives in Engineering) but is only a viewer of
 * 04-Projects, and she could still plant indexed notes in
 * 04-Projects/atlas/files, carrying any tag or another note's id (audit
 * README, "Leads noted by reviewers", checked in S09).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-md-upload-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

let b: Awaited<ReturnType<typeof buildServer>>;
const tokens: Record<string, string> = {};
const files = () => path.join(process.env.ORRAMA_VAULT_DIR!, "04-Projects/atlas/files");
const upload = async (who: string, name: string, data: string | Buffer) => {
  const r = await b.app.inject({
    method: "POST",
    url: "/api/projects/atlas/files",
    headers: signedIn(tokens[who]),
    payload: { name, dataBase64: Buffer.from(data).toString("base64") },
  });
  return { status: r.statusCode, body: r.json() };
};

beforeAll(async () => {
  b = await buildServer();
  for (const who of ["jules", "erin"]) {
    tokens[who] = sessionOf(await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@orrama.dev`, password: "orrama-demo" } }));
  }
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("a .md uploaded into a project's files", () => {
  it("is refused to someone who may not create notes in that folder, and nothing lands on disk", async () => {
    const r = await upload("erin", "planted.md", "---\ntags: [only/marketing]\n---\n# Planted\n");
    expect(r.status).toBe(403);
    expect(fs.existsSync(path.join(files(), "planted.md"))).toBe(false);
    expect(b.store.index.getByPath("04-Projects/atlas/files/planted.md")).toBeUndefined();
    // Her other documents still upload as files.
    expect((await upload("erin", "notes.pdf", "%PDF-1.4 hello")).status).toBe(200);
  });

  it("is created as a note for someone who may, and a second one with the name is numbered", async () => {
    const first = await upload("jules", "Minutes.md", "# Minutes\n\n- [ ] send the deck\n");
    expect(first).toMatchObject({ status: 200, body: { name: "Minutes.md" } });
    const note = b.store.index.getByPath("04-Projects/atlas/files/Minutes.md");
    expect(note?.id).toMatch(/^n-/); // indexed at once, with an id, like New note
    expect(note?.tasks.map((t) => t.text)).toEqual(["send the deck"]);
    const second = await upload("jules", "Minutes.md", "# Other minutes\n");
    expect(second).toMatchObject({ status: 200, body: { name: "Minutes (2).md" } });
    expect(fs.readFileSync(path.join(files(), "Minutes.md"), "utf8")).toContain("send the deck");
  });

  it("carrying another note's id, is a copy with an id of its own", async () => {
    const roadmap = b.store.index.getByPath("Engineering/Atlas Roadmap.md")!;
    const r = await upload("jules", "copy.md", `---\nid: ${roadmap.id}\n---\n# Copy\n`);
    expect(r.status).toBe(200);
    const copy = b.store.index.getByPath("04-Projects/atlas/files/copy.md")!;
    expect(copy.id).not.toBe(roadmap.id);
    expect(b.store.index.get(roadmap.id)?.path).toBe("Engineering/Atlas Roadmap.md");
  });

  it("that is not UTF-8 is refused rather than saved with replacement characters", async () => {
    const r = await upload("jules", "latin1.md", Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a]));
    expect(r.status).toBe(415);
    expect(fs.existsSync(path.join(files(), "latin1.md"))).toBe(false);
  });
});
