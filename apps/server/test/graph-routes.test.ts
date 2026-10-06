/**
 * The knowledge-graph endpoints: answers a model can use instead of reading
 * notes — and never an answer about a note the caller cannot read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-graph-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const vault = process.env.BASALT_VAULT_DIR;
const { ONTOLOGY_TEMPLATE } = await import("@basalt/core");
const { buildServer } = await import("../src/main.js");

const put = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), content);
};

let b: Awaited<ReturnType<typeof buildServer>>;
const tokens: Record<string, string> = {};
const get = async (who: string, url: string) => {
  const r = await b.app.inject({ method: "GET", url, headers: who ? { authorization: `Bearer ${tokens[who]}` } : {} });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const ok = async (who: string, url: string) => {
  const r = await get(who, url);
  if (r.status !== 200) throw new Error(`${url} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

beforeAll(async () => {
  fs.mkdirSync(vault, { recursive: true });
  put("Shared/vault-ontology.md", ONTOLOGY_TEMPLATE);
  put("Contacts/Companies/Acme.md", "---\ntags: [company]\nlocation: Rotterdam\n---\n# Acme\n");
  put("Contacts/Companies/Globex.md", "---\ntags: [company]\nlocation: Utrecht\n---\n# Globex\n");
  put("Contacts/Ada Quill.md", '---\ntags: [contact]\nrole: CEO\ncompany: "[[Acme]]"\n---\n# Ada Quill\n');
  // #only/marketing: erin (engineering) cannot read it — a project she must not learn exists.
  put("04-Projects/hush.md", "---\ntitle: Hush\ntags: [project/hush, only/marketing]\nstatus: on-track\ndeadline: 2026-12-01\n---\n# Hush\n\nQuiet launch plan.\n\n## People\n\n- [[Ada Quill]]\n");
  put("Shared/Notes.md", "---\ntype: claude-session\ndate: 2026-10-01\ndescription: Talked through the Acme launch\nabout: \"[[Acme]]\"\n---\n# Notes\n");
  await import("../src/seed.js");
  b = await buildServer();
  for (const [who, email] of [["jules", "jules@basalt.dev"], ["erin", "erin@basalt.dev"]] as const) {
    tokens[who] = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "basalt-demo" } })).json().token;
  }
}, 60_000);

afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("the five questions over HTTP", () => {
  it("schema: types, relations and counts", async () => {
    const s = await ok("jules", "/api/graph/schema");
    const count = (xs: { id: string; count: number }[], id: string) => xs.find((t) => t.id === id)?.count ?? 0;
    expect(count(s.types, "company")).toBeGreaterThanOrEqual(2); // the seed has companies of its own
    expect(count(s.relations, "works_at")).toBeGreaterThanOrEqual(1);
    expect(count(s.statuses, "on-track")).toBeGreaterThanOrEqual(1);
  });

  it("entities: by type and field, a title works as a reference", async () => {
    const r = await ok("jules", "/api/graph/entities?type=company&where=location=Rotterdam");
    expect(r.entities.map((e: { title: string }) => e.title)).toEqual(["Acme"]);
    const w = await ok("jules", "/api/graph/entities?relation=works_at&to=Acme");
    expect(w.entities.map((e: { title: string }) => e.title)).toEqual(["Ada Quill"]);
  });

  it("relations: neighbours with provenance, by title", async () => {
    const r = await ok("jules", "/api/graph/relations?entity=Hush");
    const inv = r.relations.find((x: { relation: string }) => x.relation === "involves");
    expect(inv.to[0]).toMatchObject({ title: "Ada Quill", via: "section", where: "## People", source: { title: "Hush" } });
    expect(r.relations.find((x: { relation: string }) => x.relation === "involves_company").to[0].title).toBe("Acme");
  });

  it("path: how two notes connect", async () => {
    const r = await ok("jules", "/api/graph/path?from=Hush&to=Acme");
    expect(r.paths[0].map((s: { relation: string }) => s.relation)).toEqual(["involves", "works_at"]);
  });

  it("summaries: one line per note, and what it is about", async () => {
    const r = await ok("jules", "/api/graph/summaries?type=conversation");
    expect(r.items).toEqual([{ id: expect.any(String), title: "Notes", date: "2026-10-01", about: { id: expect.any(String), title: "Acme" }, summary: "Talked through the Acme launch" }]);
  });
});

describe("access", () => {
  it("what a caller cannot read is not in any answer — and asking for it is the same 404 as asking for nothing", async () => {
    expect((await ok("erin", "/api/graph/entities?type=project&text=quiet")).total).toBe(0);
    expect((await ok("erin", "/api/graph/entities?text=hush")).total).toBe(0);
    const hidden = await get("erin", "/api/graph/relations?entity=Hush");
    const nothing = await get("erin", "/api/graph/relations?entity=Nonesuch");
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ ...nothing.body, error: expect.stringContaining("Hush") });
    expect((await get("erin", "/api/graph/path?from=Hush&to=Acme")).status).toBe(404);
    const acme = await ok("erin", "/api/graph/relations?entity=Acme");
    expect(JSON.stringify(acme)).not.toContain("Hush");
    expect(JSON.stringify(await ok("erin", "/api/graph/summaries"))).not.toContain("Hush");
  });

  it("an owner sees it", async () => {
    expect((await ok("jules", "/api/graph/entities?type=project&text=hush")).total).toBe(1);
  });

  it("needs a sign-in", async () => {
    expect((await get("", "/api/graph/schema")).status).toBe(401);
  });
});

describe("bad questions are 400s", () => {
  it.each([
    ["relation without to", "/api/graph/entities?relation=works_at"],
    ["where without =", "/api/graph/entities?where=location"],
    ["a date that is not one", "/api/graph/summaries?from=yesterday"],
    ["relations without an entity", "/api/graph/relations"],
  ])("%s", async (_n, url) => {
    expect((await get("jules", url)).status).toBe(400);
  });
});
