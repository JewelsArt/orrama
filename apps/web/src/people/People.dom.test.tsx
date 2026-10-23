/**
 * People (structure.md §2.7): rows say who someone is and how they relate to you, every name
 * opens its thing, search and sector live in the address, and a person opens at their address
 * (the entity page; a person's sector, WEB-022, is tested there: entity/EntityPage.dom.test.tsx).
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company, Contact, PeopleContext, ProjectRow } from "@orrama/schema/responses";
import type { Me } from "../api.js";
import { People } from "./People.js";

const me = { id: "u1", username: "jules", email: "jules@orrama.dev", displayName: "Jules" } as unknown as Me;

const contact = (name: string, extra: Partial<Contact> = {}): Contact => ({
  id: `n-${name.toLowerCase().replace(/\W+/g, "")}`,
  name,
  path: `Contacts/${name}.md`,
  sector: "Other",
  role: "",
  company: "",
  companyId: null,
  email: "",
  phone: "",
  linkedin: "",
  personal: false,
  ...extra,
});
const company = (name: string, extra: Partial<Company> = {}): Company => ({
  id: `n-${name.toLowerCase().replace(/\W+/g, "")}`,
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

const CONTACTS = [
  contact("Ines Vermaat", { role: "Thesis supervisor", company: "[[Westerdok]]", companyId: "n-westerdok", sector: "University", email: "ines@example.com" }),
  contact("Bram de Wit", { role: "CEO", company: "[[Kade Social]]", companyId: "n-kadesocial", sector: "Leadership" }),
  contact("Pieter Bakker", { role: "Owner", company: "Bakker & Zn" }),
];
const COMPANIES = [company("Kade Social", { description: "Social-media agency", sector: "Marketing" }), company("Westerdok", { description: "Your school", sector: "University" })];
const PROJECTS = [{ slug: "graduation-thesis", noteId: "n-thesis", name: "Graduation thesis" }] as unknown as ProjectRow[];
const TYPED: PeopleContext = {
  typed: true,
  entries: [
    {
      id: "n-inesvermaat",
      relations: [
        { relation: "supervises", to: [{ id: "n-thesis", title: "Graduation thesis", type: "project" }] },
        { relation: "works_at", to: [{ id: "n-westerdok", title: "Westerdok", type: "company" }] },
      ],
      mention: { id: "n-drinks", title: "Kade drinks", at: "2026-09-25" },
    },
    { id: "n-kadesocial", relations: [{ relation: "employs", to: [{ id: "n-bramdewit", title: "Bram de Wit", type: "person" }] }], mention: null },
  ],
};
const PLAIN: PeopleContext = { typed: false, entries: CONTACTS.map((c) => ({ id: c.id, relations: [], mention: null })) };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
interface Sent {
  method: string;
  url: string;
  body: unknown;
}

function stub(context: PeopleContext = TYPED, overrides: Record<string, () => Response> = {}) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const path = url.replace(/\?.*$/, "");
      const own = overrides[`${method} ${path}`];
      if (own) return own();
      if (method === "GET" && path === "/api/contacts") return json(CONTACTS);
      if (method === "GET" && path === "/api/companies") return json(COMPANIES);
      if (method === "GET" && path === "/api/people/context") return json(context);
      if (method === "GET" && path === "/api/projects") return json(PROJECTS);
      if (method === "PATCH" && path.startsWith("/api/contacts/")) return json({ ok: true });
      if (method === "GET" && path.startsWith("/api/vault/note/")) return json({ id: "n-inesvermaat", path: "Contacts/Ines Vermaat.md", content: "---\nsector: University\n---\n# Ines\n", hash: "h" });
      if (method === "PUT" && path === "/api/vault/note") return json({ id: "n-new", path: "Contacts/New.md" });
      return json({ error: `no fixture for ${method} ${path}` }, 404);
    }),
  );
  return sent;
}

/** A row, by the name it opens (its role=button, not the link inside it); its name is its words. */
const starts = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&")}`);
const rowOf = (name: string) => screen.findByRole("button", { name: starts(name) });
const section = (label: string) => screen.getByRole("region", { name: label });

beforeEach(() => history.replaceState(null, "", "/people"));
afterEach(() => {
  cleanup(); // before the stubs go: a late request from the page must not reach happy-dom's real fetch
  vi.unstubAllGlobals();
});

describe("People: the rows", () => {
  it("says role, company and the relation that speaks for them, and when they were last mentioned", async () => {
    stub();
    render(<People me={me} onOpenNote={() => {}} />);
    const ines = await rowOf("Ines Vermaat");
    expect(ines.textContent).toContain("Thesis supervisor · Westerdok · supervises Graduation thesis");
    expect(ines.textContent).toContain("Kade drinks");
    expect(within(ines).getByRole("link", { name: "Graduation thesis" }).getAttribute("href")).toBe("/projects/graduation-thesis");
    expect(within(ines).getByRole("link", { name: "Westerdok" }).getAttribute("href")).toBe("/companies/westerdok");
    // [[Kade Social]] is read as Kade Social, never with its brackets.
    const bram = await rowOf("Bram de Wit");
    expect(bram.textContent).toContain("CEO · Kade Social");
    expect(document.body.textContent).not.toContain("[[");
    expect((await rowOf("Kade Social")).textContent).toContain("employs Bram de Wit");
  });

  it("is plain on a vault without an ontology", async () => {
    stub(PLAIN);
    render(<People me={me} onOpenNote={() => {}} />);
    const ines = await rowOf("Ines Vermaat");
    expect(ines.textContent).toContain("Thesis supervisor · Westerdok");
    expect(ines.textContent).not.toContain("supervises");
  });

  it("says when people work at a company that has no note, and the row creates it", async () => {
    stub();
    const user = userEvent.setup();
    render(<People me={me} onOpenNote={() => {}} />);
    const ghost = await rowOf("Bakker & Zn");
    expect(ghost.textContent).toContain("No note yet: Pieter Bakker works here");
    await user.click(ghost);
    const dialog = await screen.findByRole("dialog", { name: "New company" });
    expect((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Bakker & Zn");
  });

  it("opens a person at their address, and a name inside a row opens its own thing instead", async () => {
    stub();
    const user = userEvent.setup();
    render(<People me={me} onOpenNote={() => {}} />);
    await user.click(await rowOf("Ines Vermaat"));
    expect(location.pathname).toBe("/people/ines-vermaat"); // her entity page (R11), App's to show
    history.replaceState(null, "", "/people");
    const link = within(await rowOf("Ines Vermaat")).getByRole("link", { name: "Graduation thesis" });
    await user.click(link);
    expect(location.pathname).toBe("/projects/graduation-thesis");
  });
});

describe("People: search and sector", () => {
  it("narrow both lists and write themselves into the address", async () => {
    stub();
    const user = userEvent.setup();
    render(<People me={me} onOpenNote={() => {}} />);
    await rowOf("Ines Vermaat");
    await user.type(screen.getAllByRole("searchbox", { name: "Find a person or a company" })[0]!, "kade");
    await waitFor(() => expect(location.search).toBe("?q=kade"));
    expect(within(section("People")).queryByRole("button", { name: starts("Ines Vermaat") })).toBeNull();
    expect(within(section("People")).getByRole("button", { name: starts("Bram de Wit") })).toBeTruthy();
    expect(within(section("Companies")).getByRole("button", { name: starts("Kade Social") })).toBeTruthy();
    await user.clear(screen.getAllByRole("searchbox", { name: "Find a person or a company" })[0]!);
    await user.selectOptions(screen.getAllByRole("combobox", { name: "Sector" })[0]!, "University");
    await waitFor(() => expect(location.search).toBe("?sector=University"));
    expect(within(section("People")).getByRole("button", { name: starts("Ines Vermaat") })).toBeTruthy();
    expect(within(section("People")).queryByRole("button", { name: starts("Bram de Wit") })).toBeNull();
    expect(within(section("Companies")).getByRole("button", { name: starts("Westerdok") })).toBeTruthy();
    expect(within(section("Companies")).queryByRole("button", { name: starts("Bakker & Zn") })).toBeNull();
  });

  it("opens filtered when the address says so", async () => {
    history.replaceState(null, "", "/people?q=bram");
    stub();
    render(<People me={me} onOpenNote={() => {}} />);
    await rowOf("Bram de Wit");
    expect(within(section("People")).queryByRole("button", { name: starts("Ines Vermaat") })).toBeNull();
  });
});

describe("People: New", () => {
  it("creates a person create-only and opens their note", async () => {
    const sent = stub();
    const opened: string[] = [];
    const user = userEvent.setup();
    render(<People me={me} onOpenNote={(id) => opened.push(id)} />);
    await rowOf("Ines Vermaat");
    await user.click(screen.getAllByRole("button", { name: "Person" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "New person" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Emma Jansen");
    await user.click(within(dialog).getByRole("button", { name: "Add person" }));
    await waitFor(() => expect(opened).toEqual(["n-new"]));
    const put = sent.find((r) => r.method === "PUT")!;
    expect(put.body).toMatchObject({ path: "Contacts/Emma Jansen.md", create: true });
  });

  it("says a taken name in a Notice, keeps what was typed, and replaces nothing", async () => {
    stub(TYPED, { "PUT /api/vault/note": () => json({ error: "A note already exists at Contacts/Ines Vermaat.md." }, 409) });
    const user = userEvent.setup();
    render(<People me={me} onOpenNote={() => {}} />);
    await rowOf("Ines Vermaat");
    await user.click(screen.getAllByRole("button", { name: "Person" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "New person" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Ines Vermaat");
    await user.click(within(dialog).getByRole("button", { name: "Add person" }));
    const notice = await within(dialog).findByRole("alert");
    expect(notice.classList.contains("notice")).toBe(true);
    expect(notice.textContent).toContain("There's already a note with this name");
    expect(notice.textContent).toContain("Contacts/Ines Vermaat.md");
    expect(dialog.querySelector(".form-error")).toBeNull();
    expect((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Ines Vermaat");
  });
});
