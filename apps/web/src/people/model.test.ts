/** People's model: what a row says and how the lists are cut (structure.md §2.7). */
import { describe, expect, it } from "vitest";
import type { Company, Contact } from "@basalt/schema/responses";
import { byRecent, bySlug, companiesWithoutNote, companyFor, groupsOf, keyRelation, linkText, matches, peopleAt, sectorsIn, slugOf, type Entry } from "./model.js";
import { initials } from "../ui/controls.js";

const person = (name: string, company = "", extra: Partial<Contact> = {}): Contact => ({
  id: `n-${name}`,
  name,
  path: `Contacts/${name}.md`,
  sector: "Other",
  role: "",
  company,
  email: "",
  phone: "",
  linkedin: "",
  personal: false,
  ...extra,
});
const firm = (name: string, extra: Partial<Company> = {}): Company => ({
  id: `n-${name}`,
  name,
  path: `Contacts/Companies/${name}.md`,
  description: "",
  sector: "Other",
  linkedin: "",
  website: "",
  careers: "",
  location: "",
  positions: [],
  personal: false,
  ...extra,
});
const entry = (relations: Entry["relations"]): Entry => ({ id: "x", relations, mention: null });
const to = (title: string, type = "project") => ({ id: `n-${title}`, title, type });

describe("a row's words", () => {
  it("reads a [[link]] as the name it links to (the audit's latent bug)", () => {
    expect(linkText("[[Kade Social]]")).toBe("Kade Social");
    expect(linkText("[[Contacts/Companies/Kade Social|Kade]]")).toBe("Kade");
    expect(linkText("[[Contacts/Companies/Kade Social]]")).toBe("Kade Social");
    expect(linkText("Bakker & Zn")).toBe("Bakker & Zn");
  });

  it("gives 'de' names their family name's initial", () => {
    expect(initials("Bram de Wit")).toBe("BW");
    expect(initials("Femke de Graaf")).toBe("FG");
  });

  it("finds a contact's company note whether the field links it or names it", () => {
    const kade = firm("Kade Social");
    expect(companyFor(person("Bram", "[[Kade Social]]"), [kade])).toBe(kade);
    expect(companyFor(person("Noor", "kade social"), [kade])).toBe(kade);
    expect(companyFor(person("Pieter", "Bakker & Zn"), [kade])).toBeUndefined();
  });

  it("says the relation that speaks for a person, never their company twice", () => {
    const ines = entry([
      { relation: "involved_in", to: [to("Graduation thesis")] },
      { relation: "supervises", to: [to("Graduation thesis")] },
      { relation: "works_at", to: [to("Westerdok", "company")] },
    ]);
    expect(keyRelation(ines, "person")).toMatchObject({ phrase: "supervises", first: { title: "Graduation thesis" }, more: 0 });
    const daan = entry([
      { relation: "works_at", to: [to("Oost Runners", "company")] },
      { relation: "involved_in", to: [to("Half marathon"), to("Run club")] },
    ]);
    expect(keyRelation(daan, "person")).toMatchObject({ phrase: "in", first: { title: "Half marathon" }, more: 1 });
    expect(keyRelation(entry([{ relation: "works_at", to: [to("Kade", "company")] }]), "person")).toBeNull();
    expect(keyRelation(entry([{ relation: "employs", to: [to("Bram", "person"), to("Noor", "person")] }]), "company")).toMatchObject({ phrase: "employs", more: 1 });
  });

  it("is plain without an ontology: no relations, no line", () => {
    expect(keyRelation(entry([]), "person")).toBeNull();
    expect(keyRelation(undefined, "company")).toBeNull();
  });
});

describe("the lists", () => {
  it("cuts the A–Z into runs of letters, labelled by the letters they hold", () => {
    const names = ["Arjun", "Bram", "Camille", "Daan", "Emma", "Femke", "Hugo", "Ines", "Jasper", "Lotte", "Noor"];
    const g = groupsOf(names, (n) => n, 3);
    expect(g.map((x) => x.label)).toEqual(["A–C", "D–F", "H–J", "L–N"]);
    expect(g.flatMap((x) => x.items)).toEqual(names);
    expect(groupsOf(["Émile", "Eva"], (n) => n, 3).map((x) => x.label)).toEqual(["E"]);
  });

  it("orders Recent by the newest mention, the never-mentioned last", () => {
    const at: Record<string, string | undefined> = { a: "2026-09-01", b: "2026-10-01T09:00:00.000Z", c: undefined };
    expect(byRecent(["c", "a", "b"], (x) => x, (x) => at[x])).toEqual(["b", "a", "c"]);
  });

  it("names the companies people work at that have no note, once each", () => {
    const people = [person("Pieter Bakker", "Bakker & Zn"), person("Anna Bakker", "[[Bakker & Zn]]"), person("Claire", "AMSIB (HvA)"), person("Yara")];
    const ghosts = companiesWithoutNote(people, [firm("AMSIB")]);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]!.name).toBe("Bakker & Zn");
    expect(ghosts[0]!.people.map((p) => p.name)).toEqual(["Pieter Bakker", "Anna Bakker"]);
  });

  it("lists the people you know at a company as the old roster did", () => {
    const people = [person("Claire", "AMSIB (HvA)"), person("Bram", "[[Kade Social]]"), person("Yara")];
    expect(peopleAt(firm("AMSIB"), people).map((p) => p.name)).toEqual(["Claire"]);
    expect(peopleAt(firm("Kade Social"), people).map((p) => p.name)).toEqual(["Bram"]);
  });

  it("matches every word of a search, accents and links folded", () => {
    expect(matches("ines west", ["Inès Vermaat", "[[Westerdok]]"])).toBe(true);
    expect(matches("ines kade", ["Inès Vermaat", "[[Westerdok]]"])).toBe(false);
    expect(matches("  ", ["anything"])).toBe(true);
  });

  it("offers the sectors in use, once, Other last", () => {
    expect(sectorsIn([[{ sector: "Other" }, { sector: "Finance" }], [{ sector: "finance" }, { sector: "University" }]])).toEqual(["Finance", "University", "Other"]);
  });

  it("gives every note a slug from its file name, and finds it again", () => {
    expect(slugOf("Contacts/Ines Vermaat.md")).toBe("ines-vermaat");
    expect(slugOf("Contacts/Companies/Bakker & Zn.md")).toBe("bakker-zn");
    expect(slugOf("Contacts/Émile Zola.md")).toBe("emile-zola");
    const list = [{ path: "Personal/jules/Contacts/Ines Vermaat.md" }, { path: "Contacts/Ines Vermaat.md" }];
    expect(bySlug(list, "ines-vermaat")).toBe(list[1]);
  });
});
