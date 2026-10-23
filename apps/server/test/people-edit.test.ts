/**
 * Stage 1, 1F: a person's facts, where they work and what they supervise, set from their page;
 * a company's card refused rather than half-written; who works where read one way; and a
 * plain name in a relation property following a rename. Every write is what a person would
 * type in the note, every other byte the same.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-people-edit-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const vault = process.env.ORRAMA_VAULT_DIR;
const { ONTOLOGY_TEMPLATE } = await import("@orrama/core");
const { contactsResponse } = await import("@orrama/schema/responses");
const { buildServer } = await import("../src/main.js");

const put = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), content);
};
/** A note as written, less the id line the first index stamps into it. */
const read = (rel: string) => fs.readFileSync(path.join(vault, rel), "utf8").replace(/^id: n-[0-9a-z]+\n/m, "");

let b: Awaited<ReturnType<typeof buildServer>>;
const tokens: Record<string, string> = {};
const call = async (who: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  b.app.inject({ method, url, payload: payload as object, headers: signedIn(tokens[who]) });
const contacts = async (who = "jules") => contactsResponse.parse((await call(who, "GET", "/api/contacts")).json());
const idOf = async (title: string) => {
  const tree = (await call("jules", "GET", "/api/vault/tree")).json() as { id: string; title: string }[];
  return tree.find((n) => n.title === title)!.id;
};

const ANA = '---\ntitle: "Ana Duarte"\ntags: [contact]\nsector: "Finance"\nrole: "Analyst"\ncompany: ""\nemail: ""\nphone: ""\nlinkedin: ""\n---\n# Ana Duarte\n\nMet at the [[Kade drinks]].\n';

beforeAll(async () => {
  fs.mkdirSync(vault, { recursive: true });
  put("Orrama/Ontology.md", ONTOLOGY_TEMPLATE);
  put("Contacts/Companies/Harbourline.md", "---\ntags: [company]\nsector: Finance\n---\n# Harbourline\n");
  put("Contacts/Companies/AMSIB (HvA).md", "---\ntags: [company]\n---\n# AMSIB (HvA)\n");
  put("Contacts/Companies/Old Card.md", "---\ntags: [company]\nsummary: Makes boxes\n---\n# Old Card\n");
  put("Contacts/Companies/Broken Co.md", "---\ntags: [company]\nsector: [unclosed\n---\n# Broken Co #company\n");
  put("Contacts/Ana Duarte.md", ANA);
  put("Contacts/Bo Plain.md", "---\ntags: [contact]\ncompany: Harbourline\nnote: Harbourline\n---\n# Bo Plain\n\nWorks at Harbourline.\n");
  put("Contacts/Cas Link.md", '---\ntags: [contact]\ncompany: "[[Contacts/Companies/Harbourline|Harbourline]]"\n---\n# Cas Link\n');
  put("Contacts/Dee Bare.md", "---\ntags: [contact]\ncompany: [[Harbourline]]\n---\n# Dee Bare\n");
  put("Contacts/Eli Short.md", "---\ntags: [contact]\ncompany: AMSIB\n---\n# Eli Short\n");
  put("Contacts/Fay Nowhere.md", "---\ntags: [contact]\ncompany: Nowhere Ltd\n---\n# Fay Nowhere\n");
  put("Contacts/Gus Broken.md", "---\ntags: [contact]\nrole: [unclosed\n---\n# Gus Broken #contact\n");
  put("Contacts/Hal Two.md", '---\ntags: [contact]\nsupervises: "[[Graduation thesis]]"\n---\n# Hal Two\n');
  put("Contacts/Jon Hand.md", '---\ntags: [contact]\nsupervises: "[[Graduation thesis]]"\n---\n# Jon Hand\n');
  put("Contacts/Ivy Plain.md", "---\ntags: [contact]\nsupervises: Graduation thesis\n---\n# Ivy Plain\n");
  put("04-Projects/graduation-thesis.md", "---\ntitle: Graduation thesis\ntags: [project/graduation-thesis]\nstatus: active\n---\n# Graduation thesis\n");
  put("04-Projects/pitch-deck.md", '---\ntitle: Pitch deck\ntags: [project/pitch-deck]\ninvolves: ["[[Ana Duarte]]", "[[Bo Plain]]"]\n---\n# Pitch deck\n\n## People\n\n- [[Ana Duarte]]\n- [[Cas Link]]\n');
  put("04-Projects/solo.md", '---\ntitle: Solo\ntags: [project/solo]\ninvolves: "[[Ana Duarte]]"\n---\n# Solo\n');
  put("Shared/Kade drinks.md", "# Kade drinks\n");
  put("Contacts/Kit Label.md", "---\ntags: [contact]\n---\n# Kit Label\n");
  put("04-Projects/atlas.md", "---\ntitle: Atlas\ntags: [project/atlas]\n---\n# Atlas\n\n## People\n\n- [[Contacts/Kit Label|Kit Label]]\n\n## Notes\n\nAsk [[Contacts/Kit Label|Kit Label]] about it.\n");
  await import("../src/seed.js");
  b = await buildServer();
  for (const [who, email] of [["jules", "jules@orrama.dev"], ["erin", "erin@orrama.dev"]] as const) {
    tokens[who] = sessionOf(await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "orrama-demo" } }));
  }
}, 60_000);

afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("who works where: GET /api/contacts companyId", () => {
  it("reads a link, a plain name, a bare [[link]] YAML made a list of, and a name inside the company's", async () => {
    const list = await contacts();
    const at = (name: string) => list.find((c) => c.name === name)!;
    const northwind = await idOf("Harbourline");
    expect(at("Bo Plain").companyId).toBe(northwind);
    expect(at("Cas Link").companyId).toBe(northwind);
    expect(at("Dee Bare")).toMatchObject({ company: "[[Harbourline]]", companyId: northwind });
    expect(at("Eli Short").companyId).toBe(await idOf("AMSIB (HvA)"));
    expect(at("Fay Nowhere")).toMatchObject({ company: "Nowhere Ltd", companyId: null });
    expect(at("Ana Duarte").companyId).toBeNull();
  });
});

describe("PATCH /api/contacts/:id: a person's facts", () => {
  it("changes the role and phone in place, every other byte the same", async () => {
    const r = await call("jules", "PATCH", `/api/contacts/${await idOf("Ana Duarte")}`, { role: "Lead analyst", phone: "+31 6 1234 5678" });
    expect(r.statusCode).toBe(200);
    expect(read("Contacts/Ana Duarte.md")).toBe(ANA.replace('role: "Analyst"', "role: Lead analyst").replace('phone: ""', "phone: +31 6 1234 5678"));
  });

  it("writes where they work as a link to the company's note, and clears it", async () => {
    const ana = await idOf("Ana Duarte");
    const before = read("Contacts/Ana Duarte.md");
    expect((await call("jules", "PATCH", `/api/contacts/${ana}`, { companyId: await idOf("Harbourline") })).statusCode).toBe(200);
    expect(read("Contacts/Ana Duarte.md")).toBe(before.replace('company: ""', 'company: "[[Contacts/Companies/Harbourline|Harbourline]]"'));
    expect((await contacts()).find((c) => c.name === "Ana Duarte")!.companyId).toBe(await idOf("Harbourline"));
    expect((await call("jules", "PATCH", `/api/contacts/${ana}`, { companyId: null })).statusCode).toBe(200);
    expect(read("Contacts/Ana Duarte.md")).toBe(before);
  });

  it("adds no empty fact the note never had", async () => {
    const before = read("Contacts/Bo Plain.md");
    expect((await call("jules", "PATCH", `/api/contacts/${await idOf("Bo Plain")}`, { email: "", role: "" })).statusCode).toBe(200);
    expect(read("Contacts/Bo Plain.md")).toBe(before);
  });

  it("refuses unreadable properties with a 409 and a sentence, and writes nothing", async () => {
    const before = read("Contacts/Gus Broken.md");
    const r = await call("jules", "PATCH", `/api/contacts/${await idOf("Gus Broken")}`, { phone: "1" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/can't be read/);
    expect(read("Contacts/Gus Broken.md")).toBe(before);
  });

  it("takes one line per fact, a company note for where they work, and something to change", async () => {
    const ana = await idOf("Ana Duarte");
    const before = read("Contacts/Ana Duarte.md");
    expect((await call("jules", "PATCH", `/api/contacts/${ana}`, { role: "a\nb" })).statusCode).toBe(400);
    expect((await call("jules", "PATCH", `/api/contacts/${ana}`, { companyId: await idOf("Bo Plain") })).statusCode).toBe(400);
    expect((await call("jules", "PATCH", `/api/contacts/${ana}`, {})).statusCode).toBe(400);
    expect(read("Contacts/Ana Duarte.md")).toBe(before);
  });
});

describe("supervises, from the person's side", () => {
  it("writes one project as a link, a second makes a list, and the same one twice is said, not written", async () => {
    const ana = await idOf("Ana Duarte");
    const before = read("Contacts/Ana Duarte.md");
    expect((await call("jules", "POST", `/api/contacts/${ana}/supervises`, { projectId: await idOf("Graduation thesis") })).statusCode).toBe(200);
    expect(read("Contacts/Ana Duarte.md")).toBe(before.replace('linkedin: ""\n', 'linkedin: ""\nsupervises: "[[04-Projects/graduation-thesis|Graduation thesis]]"\n'));
    const again = await call("jules", "POST", `/api/contacts/${ana}/supervises`, { projectId: await idOf("Graduation thesis") });
    expect(again.json()).toMatchObject({ already: true });
    expect((await call("jules", "POST", `/api/contacts/${ana}/supervises`, { projectId: await idOf("Pitch deck") })).statusCode).toBe(200);
    expect(read("Contacts/Ana Duarte.md")).toContain("supervises:\n  - \"[[04-Projects/graduation-thesis|Graduation thesis]]\"\n  - \"[[04-Projects/pitch-deck|Pitch deck]]\"\n");
    // Removing keeps the other, then the key goes with the last.
    expect((await call("jules", "DELETE", `/api/contacts/${ana}/supervises/${await idOf("Graduation thesis")}`)).statusCode).toBe(200);
    expect(read("Contacts/Ana Duarte.md")).not.toContain("graduation-thesis");
    expect(read("Contacts/Ana Duarte.md")).toContain("pitch-deck");
    expect((await call("jules", "DELETE", `/api/contacts/${ana}/supervises/${await idOf("Pitch deck")}`)).statusCode).toBe(200);
    expect(read("Contacts/Ana Duarte.md")).toBe(before);
  });

  it("removes a supervision written by hand, plain or linked", async () => {
    const thesis = await idOf("Graduation thesis");
    expect((await call("jules", "DELETE", `/api/contacts/${await idOf("Jon Hand")}/supervises/${thesis}`)).statusCode).toBe(200);
    expect(read("Contacts/Jon Hand.md")).toBe("---\ntags: [contact]\n---\n# Jon Hand\n");
  });

  it("names projects only", async () => {
    const r = await call("jules", "POST", `/api/contacts/${await idOf("Ana Duarte")}/supervises`, { projectId: await idOf("Kade drinks") });
    expect(r.statusCode).toBe(400);
  });
});

describe("PATCH /api/companies/:id", () => {
  it("changes an older summary: rather than writing description: beside it", async () => {
    expect((await call("jules", "PATCH", `/api/companies/${await idOf("Old Card")}`, { description: "Makes crates" })).statusCode).toBe(200);
    expect(read("Contacts/Companies/Old Card.md")).toBe("---\ntags: [company]\nsummary: Makes crates\n---\n# Old Card\n");
  });

  it("refuses unreadable properties with a 409, and writes nothing", async () => {
    const before = read("Contacts/Companies/Broken Co.md");
    const r = await call("jules", "PATCH", `/api/companies/${await idOf("Broken Co")}`, { location: "Delft" });
    expect(r.statusCode).toBe(409);
    expect(read("Contacts/Companies/Broken Co.md")).toBe(before);
  });
});

describe("a project's Remove takes an involves: value too", () => {
  it("drops the ## People line and the property's value, keeping the rest", async () => {
    const r = await call("jules", "DELETE", `/api/projects/pitch-deck/people/${await idOf("Ana Duarte")}`);
    expect(r.statusCode).toBe(200);
    expect(read("04-Projects/pitch-deck.md")).toBe('---\ntitle: Pitch deck\ntags: [project/pitch-deck]\ninvolves:\n  - "[[Bo Plain]]"\n---\n# Pitch deck\n\n## People\n\n- [[Cas Link]]\n');
  });

  it("drops the key with its only value", async () => {
    expect((await call("jules", "DELETE", `/api/projects/solo/people/${await idOf("Ana Duarte")}`)).statusCode).toBe(200);
    expect(read("04-Projects/solo.md")).toBe("---\ntitle: Solo\ntags: [project/solo]\n---\n# Solo\n");
  });
});

describe("GET /api/contacts/:id/projects", () => {
  it("lists what they supervise, and the projects that list them in ## People or involves:", async () => {
    const of = async (name: string) => ((await call("jules", "GET", `/api/contacts/${await idOf(name)}/projects`)).json() as { title: string; relation: string }[]).map((p) => `${p.relation} ${p.title}`);
    expect(await of("Hal Two")).toEqual(["supervises Graduation thesis"]);
    expect(await of("Cas Link")).toEqual(["involved Pitch deck"]);
    expect(await of("Bo Plain")).toEqual(["involved Pitch deck"]);
    expect(await of("Fay Nowhere")).toEqual([]);
  });
});

describe("a rename takes plain names in relation properties with it", () => {
  it("rewrites company: Harbourline and the link's old label, never another property or the body", async () => {
    const r = await call("jules", "POST", "/api/vault/move", { fromPath: "Contacts/Companies/Harbourline.md", toPath: "Contacts/Companies/Harbourline BV.md", links: true });
    expect(r.statusCode).toBe(200);
    expect(read("Contacts/Bo Plain.md")).toBe("---\ntags: [contact]\ncompany: Harbourline BV\nnote: Harbourline\n---\n# Bo Plain\n\nWorks at Harbourline.\n");
    expect(read("Contacts/Cas Link.md")).toBe('---\ntags: [contact]\ncompany: "[[Contacts/Companies/Harbourline BV|Harbourline BV]]"\n---\n# Cas Link\n');
    expect(read("Contacts/Dee Bare.md")).toBe("---\ntags: [contact]\ncompany: [[Harbourline BV]]\n---\n# Dee Bare\n");
    const list = await contacts();
    const bv = await idOf("Harbourline BV");
    for (const name of ["Bo Plain", "Cas Link", "Dee Bare"]) expect(list.find((c) => c.name === name)!.companyId).toBe(bv);
  });

  it("counts plain names among the links that follow, before the rename", async () => {
    const thesis = await idOf("Graduation thesis");
    const l = (await call("jules", "GET", `/api/vault/note/${thesis}/linkers?to=${encodeURIComponent("04-Projects/Thesis.md")}`)).json() as { notes: { title: string }[] };
    expect(l.notes.map((n) => n.title).sort()).toEqual(["Hal Two", "Ivy Plain"]);
  });

  it("relabels a ## People link that said the old name, never a link in the prose", async () => {
    const r = await call("jules", "POST", "/api/vault/move", { fromPath: "Contacts/Kit Label.md", toPath: "Contacts/Kit Labelle.md", links: true });
    expect(r.statusCode).toBe(200);
    expect(read("04-Projects/atlas.md")).toBe("---\ntitle: Atlas\ntags: [project/atlas]\n---\n# Atlas\n\n## People\n\n- [[Contacts/Kit Labelle|Kit Labelle]]\n\n## Notes\n\nAsk [[Contacts/Kit Labelle|Kit Label]] about it.\n");
  });

  it("rewrites supervises: by its title when a project is renamed", async () => {
    const r = await call("jules", "POST", "/api/vault/move", { fromPath: "04-Projects/graduation-thesis.md", toPath: "04-Projects/Thesis.md", links: true });
    expect(r.statusCode).toBe(200);
    expect(read("Contacts/Ivy Plain.md")).toBe("---\ntags: [contact]\nsupervises: Thesis\n---\n# Ivy Plain\n");
    expect(read("Contacts/Hal Two.md")).toBe('---\ntags: [contact]\nsupervises: "[[Thesis]]"\n---\n# Hal Two\n');
  });
});
