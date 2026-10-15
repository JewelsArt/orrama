/**
 * GET /api/graph/warnings (Orr noticed, R11): every warning one row per note, with what a fix
 * needs as data, from what the caller can read only. Fictional fixtures.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-noticed-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const vault = process.env.ORRAMA_VAULT_DIR;
const { ONTOLOGY_TEMPLATE } = await import("@orrama/core");
const { graphWarningsResponse } = await import("@orrama/schema/responses");
const { buildServer } = await import("../src/main.js");

const put = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), content);
};

let b: Awaited<ReturnType<typeof buildServer>>;
const tokens: Record<string, string> = {};
const warnings = async (who: string) => {
  const r = await b.app.inject({ method: "GET", url: "/api/graph/warnings", headers: { authorization: `Bearer ${tokens[who]}` } });
  if (r.statusCode !== 200) throw new Error(`${r.statusCode} ${r.body}`);
  return graphWarningsResponse.parse(r.json());
};

beforeAll(async () => {
  fs.mkdirSync(vault, { recursive: true });
  put("Shared/vault-ontology.md", ONTOLOGY_TEMPLATE);
  put("Contacts/Pieter Bakker.md", '---\ntags: [contact]\nrole: Owner\ncompany: "Bakker & Zn"\n---\n# Pieter Bakker\n');
  put("Contacts/Eve Ray.md", '---\ntags: [contact]\ncompany: "[[Move to Oost]]"\n---\n# Eve Ray\n');
  put("04-Projects/move-to-oost.md", "---\ntitle: Move to Oost\ntags: [project/move-to-oost, paused]\nstatus: at-risk\n---\n# Move to Oost\n");
  put("04-Projects/lisbon.md", "---\ntitle: Lisbon trip\ntags: [project/lisbon]\n---\n# Lisbon trip\n");
  put("Shared/Old pitch.md", "---\ntags: [project/pitch-deck]\n---\n# Old pitch\n");
  // erin (engineering) cannot read this company, so for her Hidden Hal works at nothing that is a note.
  put("Contacts/Companies/Hush Co.md", "---\ntags: [company, only/marketing]\n---\n# Hush Co\n");
  put("Contacts/Hidden Hal.md", '---\ntags: [contact]\ncompany: "[[Hush Co]]"\n---\n# Hidden Hal\n');
  put("Contacts/Secret Sam.md", "---\ntags: [contact, only/marketing]\n---\n# Secret Sam\n");
  await import("../src/seed.js");
  b = await buildServer();
  for (const [who, email] of [["jules", "jules@orrama.dev"], ["erin", "erin@orrama.dev"]] as const) {
    tokens[who] = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "orrama-demo" } })).json().token;
  }
}, 60_000);

afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

const find = (w: Awaited<ReturnType<typeof warnings>>, code: string, title: string) => w.warnings.find((x) => x.code === code && x.note.title === title);

describe("Orr noticed's warnings", () => {
  it("names the ontology note and each warning's note", async () => {
    const w = await warnings("jules");
    expect(w.typed).toBe(true);
    expect(w.ontology?.path).toBe("Shared/vault-ontology.md");
    expect(find(w, "person-without-company", "Pieter Bakker")?.note).toMatchObject({ type: "person", path: "Contacts/Pieter Bakker.md" });
  });

  it("carries what each fix needs", async () => {
    const w = await warnings("jules");
    expect(find(w, "unresolved-object", "Pieter Bakker")).toMatchObject({ relation: "works_at", target: "Bakker & Zn" });
    expect(find(w, "range-mismatch", "Eve Ray")).toMatchObject({ relation: "works_at", object: { title: "Move to Oost", type: "project" }, found: "project" });
    expect(find(w, "project-status-conflict", "Move to Oost")).toMatchObject({ field: "at-risk", tags: ["paused"] });
    expect(find(w, "project-without-status", "Lisbon trip")).toBeTruthy();
    expect(find(w, "document-orphan", "Old pitch")).toMatchObject({ tag: "project/pitch-deck" });
  });

  it("puts what one click fixes first", async () => {
    const codes = (await warnings("jules")).warnings.map((x) => x.code);
    expect(codes.indexOf("unresolved-object")).toBeLessThan(codes.indexOf("project-without-status"));
    expect(codes.indexOf("project-without-status")).toBeLessThan(codes.indexOf("document-orphan"));
  });

  it("says nothing about notes the caller cannot read, and a hidden object is no note to them", async () => {
    const all = await warnings("jules");
    expect(find(all, "person-without-company", "Secret Sam")).toBeTruthy();
    expect(find(all, "unresolved-object", "Hidden Hal")).toBeUndefined();
    const erin = await warnings("erin");
    expect(erin.warnings.some((x) => x.note.title === "Secret Sam")).toBe(false);
    expect(find(erin, "unresolved-object", "Hidden Hal")).toMatchObject({ target: "Hush Co" });
    expect(JSON.stringify(erin)).not.toContain("Secret Sam");
  });
});
