/**
 * GET /api/people/context: the line under each name on the People page (its
 * relations in the graph) and the newest note that mentions them — both from
 * what the caller can read, and plain on a vault without an ontology.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-people-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const vault = process.env.ORRAMA_VAULT_DIR;
const { ONTOLOGY_TEMPLATE } = await import("@orrama/core");
const { peopleContextResponse } = await import("@orrama/schema/responses");
const { buildServer } = await import("../src/main.js");

const put = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), content);
};

let b: Awaited<ReturnType<typeof buildServer>>;
const tokens: Record<string, string> = {};
const call = async (who: string, method: "GET" | "PUT", url: string, payload?: unknown) => {
  const r = await b.app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${tokens[who]}` } });
  if (r.statusCode !== 200) throw new Error(`${url} → ${r.statusCode} ${r.body}`);
  return r.json();
};
type Ctx = { typed: boolean; entries: { id: string; relations: { relation: string; to: { title: string; type: string }[] }[]; mention: { title: string; at: string } | null }[] };
const context = async (who: string): Promise<Ctx> => peopleContextResponse.parse(await call(who, "GET", "/api/people/context"));
const idOf = async (who: string, title: string) => ((await call(who, "GET", "/api/contacts")) as { id: string; name: string }[]).find((c) => c.name === title)?.id ?? ((await call(who, "GET", "/api/companies")) as { id: string; name: string }[]).find((c) => c.name === title)!.id;
const of = async (who: string, title: string) => {
  const id = await idOf(who, title);
  return (await context(who)).entries.find((e) => e.id === id)!;
};
const rel = (e: Ctx["entries"][number], r: string) => e.relations.find((x) => x.relation === r)?.to.map((t) => t.title) ?? [];

beforeAll(async () => {
  fs.mkdirSync(vault, { recursive: true });
  put("Shared/vault-ontology.md", ONTOLOGY_TEMPLATE);
  put("Contacts/Companies/Westerdok.md", "---\ntags: [company]\n---\n# Westerdok\n");
  put("Contacts/Ines Vermaat.md", '---\ntags: [contact]\nrole: Thesis supervisor\ncompany: "[[Westerdok]]"\nsupervises: "[[Graduation thesis]]"\n---\n# Ines Vermaat\n');
  put("Contacts/Bram de Wit.md", "---\ntags: [contact]\nrole: CEO\n---\n# Bram de Wit\n");
  put("04-Projects/graduation-thesis.md", "---\ntitle: Graduation thesis\ntags: [project/graduation-thesis]\nstatus: active\n---\n# Graduation thesis\n\n## People\n\n- [[Ines Vermaat]]\n");
  // erin (engineering) cannot read this one: a project she must not learn Bram is in.
  put("04-Projects/hush.md", "---\ntitle: Hush\ntags: [project/hush, only/marketing]\n---\n# Hush\n\n## People\n\n- [[Bram de Wit]]\n");
  // Mentions: a dated meeting, an older one, a future one, and a hidden one.
  put("Shared/Kade drinks.md", "---\ndate: 2026-09-25\n---\n# Kade drinks\n\nWith [[Ines Vermaat]] and [[Bram de Wit]].\n");
  put("Shared/Coffee.md", "---\ndate: 2026-08-01\n---\n# Coffee\n\n[[Ines Vermaat]] again, and [[Ines Vermaat]].\n");
  put("Shared/Next lunch.md", "---\ndate: 2999-01-01\n---\n# Next lunch\n\n[[Bram de Wit]] next millennium.\n");
  put("Shared/Hush call.md", "---\ndate: 2026-10-01\ntags: [only/marketing]\n---\n# Hush call\n\n[[Bram de Wit]] about Hush.\n");
  await import("../src/seed.js");
  b = await buildServer();
  for (const [who, email] of [["jules", "jules@basalt.dev"], ["erin", "erin@basalt.dev"]] as const) {
    tokens[who] = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "basalt-demo" } })).json().token;
  }
}, 60_000);

afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("the People page's context", () => {
  it("gives each person their relations, by name, both directions", async () => {
    const ctx = await context("jules");
    expect(ctx.typed).toBe(true);
    const ines = await of("jules", "Ines Vermaat");
    expect(rel(ines, "supervises")).toEqual(["Graduation thesis"]);
    expect(rel(ines, "involved_in")).toEqual(["Graduation thesis"]); // the inverse of the project's ## People
    expect(rel(ines, "works_at")).toEqual(["Westerdok"]);
    expect(rel(await of("jules", "Westerdok"), "employs")).toEqual(["Ines Vermaat"]);
  });

  it("names the newest ordinary note that mentions them, by the day it is about", async () => {
    const ines = await of("jules", "Ines Vermaat");
    expect(ines.mention).toMatchObject({ title: "Kade drinks", at: "2026-09-25" });
    // A project's own note lists people as a matter of record: not a mention.
    expect(ines.mention?.title).not.toBe("Graduation thesis");
    // A note dated in the future has not happened yet.
    expect((await of("jules", "Bram de Wit")).mention).toMatchObject({ title: "Hush call", at: "2026-10-01" });
  });

  it("knows nothing about a note the caller cannot read, at either end", async () => {
    const bram = await of("erin", "Bram de Wit");
    expect(rel(bram, "involved_in")).toEqual([]);
    expect(bram.mention).toMatchObject({ title: "Kade drinks" });
    expect(JSON.stringify(await context("erin"))).not.toMatch(/Hush/);
  });

  it("is plain on a vault without an ontology", async () => {
    await call("jules", "PUT", "/api/vault/note", { path: "Shared/vault-ontology.md", content: "# Not an ontology any more\n" });
    const ctx = await context("jules");
    expect(ctx.typed).toBe(false);
    expect(ctx.entries.every((e) => e.relations.length === 0)).toBe(true);
    expect((await of("jules", "Ines Vermaat")).mention).toMatchObject({ title: "Kade drinks" }); // links are not the ontology's
  });
});
