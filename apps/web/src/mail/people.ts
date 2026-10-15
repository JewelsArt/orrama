/**
 * Who a message is from, in Orrama's terms (§1.7 "every name opens its thing"): the sender is a
 * person you know (a #contact note, by address, then by name), or someone at a company you know
 * (a #company note, by the contact's company, then by the address's domain against the
 * company's website). Nothing is guessed beyond that: an unknown sender stays plain text.
 *
 * Whether the sender is drawn as a ring (a person) or a square (an organisation) also says
 * nothing new: a known contact is a person; a role address (noreply@, news@) or a sender named
 * after their company is an organisation; anyone else is a person.
 */
import type { Company, Contact, ProjectRow } from "@orrama/schema/responses";

export interface Sender {
  kind: "person" | "company";
  contact?: Contact;
  /** The company note behind the sender (theirs, or the domain's). */
  company?: Company;
  /** The contact's company as written, when no company note matches it. */
  companyName?: string;
}

const norm = (s: string) =>
  s
    .replace(/\[\[|\]\]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** The address part of "Ines <i.vermaat@westerdok.example>", lower case. */
export function addressOf(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1]! : from).trim().toLowerCase();
}

const domainOf = (address: string) => address.split("@")[1] ?? "";

/** A website's host without www: "https://www.westerdok.example/careers" → "westerdok.example". */
export function hostOf(url: string): string {
  const s = url.trim();
  if (!s) return "";
  try {
    return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Mail sent by a role, not a person. */
const ROLE_ADDRESS = /^(no-?reply|do-?not-?reply|news(letter)?|info|hello|team|support|notifications?|updates|mail(er)?|contact|careers|jobs|marketing|billing|invoices?|accounts?|service|admin)\b/i;

export function matchSender(from: string, fromName: string, contacts: Contact[], companies: Company[]): Sender {
  const address = addressOf(from);
  const name = norm(fromName);
  const contact =
    contacts.find((c) => c.email && c.email.split(/[,;\s]+/).some((e) => e.trim().toLowerCase() === address)) ??
    (name ? contacts.find((c) => norm(c.name) === name) : undefined);
  const domain = domainOf(address);
  const byName = contact?.company ? companies.find((co) => norm(co.name) === norm(contact.company)) : undefined;
  const byDomain = domain ? companies.find((co) => {
    const h = hostOf(co.website);
    return !!h && (domain === h || domain.endsWith(`.${h}`));
  }) : undefined;
  const company = byName ?? (contact?.company ? undefined : byDomain);
  const companyName = !company && contact?.company ? contact.company.replace(/\[\[|\]\]/g, "").trim() : undefined;
  if (contact) return { kind: "person", contact, company, companyName };
  const org = ROLE_ADDRESS.test(address.split("@")[0] ?? "") || (!!company && !!name && name.includes(norm(company.name)));
  return { kind: org ? "company" : "person", company };
}

/**
 * The slug in a person's or company's address, from its note's file name (structure.md §1.2):
 * "Contacts/Ines Vermaat.md" → "ines-vermaat". People (R9) and the entity pages (R11) own the
 * rule; this is the same one until theirs lands.
 */
export function entitySlug(path: string): string {
  const file = path.split("/").pop()!.replace(/\.md$/i, "");
  return (
    file
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || file
  );
}

/** A project's slug by its note's id, so a relation to a project note opens the project. */
export const projectSlugs = (projects: ProjectRow[]) => new Map(projects.filter((p) => p.noteId).map((p) => [p.noteId!, p.slug]));
