/**
 * WEB-022: a contact's sector is set by core's front-matter writer on the
 * server, never by rewriting note text with a regex. A body line that happens
 * to begin `sector:` is the note's own words.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-sector-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const vault = process.env.ORRAMA_VAULT_DIR;
const { parseNote } = await import("@orrama/core");
const { buildServer } = await import("../src/main.js");

const put = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), content);
};
const read = (rel: string) => fs.readFileSync(path.join(vault, rel), "utf8");
/** The note below its front matter, byte for byte. */
const body = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/, "");

let b: Awaited<ReturnType<typeof buildServer>>;
const tokens: Record<string, string> = {};
const patch = async (who: string, id: string, payload: unknown) =>
  b.app.inject({ method: "PATCH", url: `/api/contacts/${id}`, payload: payload as object, headers: signedIn(tokens[who]) });
const idOf = async (who: string, name: string) =>
  (await b.app.inject({ method: "GET", url: "/api/contacts", headers: signedIn(tokens[who]) })).json().find((c: { name: string }) => c.name === name)?.id as string;

// Written in Obsidian: an inline #contact, a rule, and a body line that begins "sector:".
const YARA = "# Yara Haddad #contact\n\nMet at the alumni evening.\n\n---\n\n## Notes\n\nsector: moved to banking last spring\n";

beforeAll(async () => {
  fs.mkdirSync(vault, { recursive: true });
  put("Contacts/Yara Haddad.md", YARA);
  put("Contacts/Noor El Amrani.md", "---\ntags: [contact]\nrole: Account lead\nsector: Marketing\n---\n# Noor El Amrani\n\nsector: not this line\n");
  put("Contacts/Broken.md", "---\ntags: [contact]\nrole: [unclosed\n---\n# Broken #contact\n");
  put("Shared/Not a contact.md", "# Not a contact\n");
  put("Marketing/Secret contact.md", "---\ntags: [contact, only/marketing]\n---\n# Secret contact\n");
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

describe("PATCH /api/contacts/:id (WEB-022)", () => {
  it("sets the sector in the front matter of a note written without one, and leaves the body alone", async () => {
    const before = read("Contacts/Yara Haddad.md");
    const r = await patch("jules", await idOf("jules", "Yara Haddad"), { sector: "Finance" });
    expect(r.statusCode).toBe(200);
    const after = read("Contacts/Yara Haddad.md");
    expect(parseNote(after).frontmatter["sector"]).toBe("Finance");
    expect(body(after)).toBe(body(before));
    expect(after).toContain("sector: moved to banking last spring\n");
  });

  it("changes an existing sector key and never a body line that begins sector:", async () => {
    const before = read("Contacts/Noor El Amrani.md");
    expect((await patch("jules", await idOf("jules", "Noor El Amrani"), { sector: "Leadership" })).statusCode).toBe(200);
    const after = read("Contacts/Noor El Amrani.md");
    expect(parseNote(after).frontmatter["sector"]).toBe("Leadership");
    expect(body(after)).toBe(body(before));
    const list = (await b.app.inject({ method: "GET", url: "/api/contacts", headers: signedIn(tokens.jules) })).json();
    expect(list.find((c: { name: string }) => c.name === "Noor El Amrani").sector).toBe("Leadership");
  });

  it("refuses, and writes nothing, when the front matter does not parse", async () => {
    const before = read("Contacts/Broken.md");
    const r = await patch("jules", await idOf("jules", "Broken"), { sector: "Finance" });
    expect(r.statusCode).toBe(409);
    expect(read("Contacts/Broken.md")).toBe(before);
  });

  it("takes one short line, on a contact the caller can read", async () => {
    const yara = await idOf("jules", "Yara Haddad");
    expect((await patch("jules", yara, { sector: "" })).statusCode).toBe(400);
    expect((await patch("jules", yara, { sector: "Finance\ntags: [x]" })).statusCode).toBe(400);
    const tree = (await b.app.inject({ method: "GET", url: "/api/vault/tree", headers: signedIn(tokens.jules) })).json() as { id: string; path: string }[];
    const other = tree.find((n) => n.path === "Shared/Not a contact.md")!.id;
    const untouched = read("Shared/Not a contact.md");
    expect((await patch("jules", other, { sector: "Finance" })).statusCode).toBe(400);
    expect(read("Shared/Not a contact.md")).toBe(untouched);
    const secret = await idOf("jules", "Secret contact");
    expect((await patch("erin", secret, { sector: "Finance" })).statusCode).toBe(404);
  });
});
