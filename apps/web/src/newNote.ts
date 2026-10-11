/**
 * Making a note that does not exist yet (audit WEB-001).
 *
 * New note, New contact and New company used to PUT the template like any
 * save — an upsert — so a path already taken (re-adding someone you forgot
 * you had, typing an existing name) replaced that note's text in the vault,
 * silently. `createNote` asks for create-only: the server answers 409 and
 * writes nothing when a note is there in any spelling, and the message says
 * where. Every "New …" flow goes through it.
 *
 * Front-matter values are written as JSON strings, which YAML reads as
 * quoted scalars: a name like `Smith: Consulting` or `"Bob"` used to make the
 * front matter invalid.
 */
import { api } from "./api.js";

export function createNote(path: string, content: string): Promise<{ id: string; path: string }> {
  return api<{ id: string; path: string }>("PUT", "/api/vault/note", { path, content, create: true });
}

/** A YAML scalar that reads back as exactly `s`. */
const q = (s: string) => JSON.stringify(s);

/** A value written as it is — only for fixed text of our own, like `[contact]`. */
type Bare = { bare: string };

/** `---` front matter from fields, in order; a list is a flow sequence. */
function frontMatter(fields: [string, string | string[] | Bare][]): string {
  const value = (v: string | string[] | Bare) => (Array.isArray(v) ? `[${v.map(q).join(", ")}]` : typeof v === "string" ? q(v) : v.bare);
  return ["---", ...fields.map(([k, v]) => `${k}: ${value(v)}`), "---"].join("\n");
}

export function blankNote(title: string): string {
  return `${frontMatter([["title", title]])}\n\n`;
}

export interface ContactFields {
  name: string;
  sector: string;
  role: string;
  company: string;
  email: string;
  phone: string;
  linkedin: string;
}

export function contactNote(f: ContactFields): string {
  return [
    frontMatter([
      ["title", f.name],
      // Bare, as the vault writes tags everywhere: the editor's chip shows `#"contact"` otherwise.
      ["tags", { bare: "[contact]" }],
      ["sector", f.sector || "Other"],
      ["role", f.role],
      ["company", f.company],
      ["email", f.email],
      ["phone", f.phone],
      ["linkedin", f.linkedin],
    ]),
    `# ${f.name}`,
    "",
  ].join("\n");
}

export interface CompanyFields {
  name: string;
  sector: string;
  description: string;
  linkedin: string;
  website: string;
  careers: string;
  location: string;
  positions: string[];
}

export function companyNote(f: CompanyFields): string {
  return [
    frontMatter([
      ["title", f.name],
      ["tags", { bare: "[company]" }],
      ["sector", f.sector || "Other"],
      ["description", f.description],
      ["linkedin", f.linkedin],
      ["website", f.website],
      ["careers", f.careers],
      ["location", f.location],
      ["positions", f.positions],
    ]),
    `# ${f.name}`,
    "",
  ].join("\n");
}
