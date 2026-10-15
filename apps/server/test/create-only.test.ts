/**
 * "Create" means create (audit WEB-001, STO-006, ACL-001's create_project).
 *
 * New note / New contact / New company PUT the template as an ordinary save,
 * which is an upsert: an existing note at the path had its text replaced. The
 * upload routes renamed the new file over a same-named one. `POST
 * /api/projects` checked the index for the exact, lower-cased slug path, and
 * missed `04-Projects/Thesis.md`. Now a create is refused with 409 when a note
 * is there in any spelling, and an upload never replaces a different file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-create-only-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.BASALT_VAULT_DIR;
fs.mkdirSync(VAULT, { recursive: true });
await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { writeFileAtomic } = await import("../src/atomicWrite.js");
const { docContent } = await import("@orrama/sync");

let b: Awaited<ReturnType<typeof buildServer>>;
const tokens: Record<string, string> = {};
const abs = (rel: string) => path.join(VAULT, rel);
const read = (rel: string) => fs.readFileSync(abs(rel), "utf8");
const call = async (who: string, method: string, url: string, payload?: Record<string, unknown>) => {
  const res = await b.app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${tokens[who]}` }, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: (() => { try { return res.json(); } catch { return null; } })() };
};
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

/** A one-page PDF whose text layer is `text` — enough for unpdf and parsePayslip. */
function textPdf(text: string): Buffer {
  const stream = `BT /F1 10 Tf 40 700 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

beforeAll(async () => {
  b = await buildServer();
  for (const who of ["jules", "mara"]) {
    tokens[who] = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@basalt.dev`, password: "basalt-demo" } })).json().token;
  }
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("creating a note (WEB-001)", () => {
  const CONTACT = "Contacts/Jan de Vries.md";
  const original = "---\ntitle: Jan de Vries\ntags: [contact]\n---\n# Jan de Vries\n\n## 2026-03-02 call\nRabobank referral letter.\n";

  it("an existing path is a 409, and the note is byte-identical", async () => {
    expect((await call("jules", "PUT", "/api/vault/note", { path: CONTACT, content: original })).status).toBe(200);
    const before = read(CONTACT);
    const res = await call("jules", "PUT", "/api/vault/note", { path: CONTACT, content: "---\ntitle: Jan de Vries\n---\n# Jan de Vries\n", create: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(`A note already exists at ${CONTACT}.`);
    expect(read(CONTACT)).toBe(before);
    // Refused before anything was recorded: the note's history still reads as the file.
    const id = b.store.index.getByPath(CONTACT)!.id;
    expect(docContent(b.store.doc(id))).toBe(before);
    expect(b.store.index.get(id)!.content).toBe(before);
  });

  it("so is any other spelling of it", async () => {
    const before = read(CONTACT);
    const res = await call("jules", "PUT", "/api/vault/note", { path: "contacts/jan DE vries.md", content: "x\n", create: true });
    expect(res.status).toBe(409);
    expect(read(CONTACT)).toBe(before);
    expect(fs.readdirSync(abs("Contacts")).filter((n) => n.toLowerCase() === "jan de vries.md")).toEqual(["Jan de Vries.md"]);
  });

  it("so is a file on disk the index has not taken in yet", async () => {
    fs.writeFileSync(abs("Contacts/Just Saved.md"), "from Obsidian\n");
    const res = await call("jules", "PUT", "/api/vault/note", { path: "Contacts/Just Saved.md", content: "template\n", create: true });
    expect(res.status).toBe(409);
    expect(read("Contacts/Just Saved.md")).toBe("from Obsidian\n");
  });

  it("a note the caller cannot read is refused without being described", async () => {
    expect((await call("jules", "PUT", "/api/vault/note", { path: "Shared/Eng Plan.md", content: "---\ntags: [only/engineering]\n---\nplan\n" })).status).toBe(200);
    const res = await call("mara", "PUT", "/api/vault/note", { path: "Shared/Eng Plan.md", content: "hi\n", create: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("A note already exists at that path.");
    expect(read("Shared/Eng Plan.md")).toContain("plan\n");
  });

  it("a free path is created", async () => {
    const res = await call("jules", "PUT", "/api/vault/note", { path: "Contacts/Someone New.md", content: "---\ntitle: \"Smith: Consulting\"\n---\n", create: true });
    expect(res.status).toBe(200);
    expect(b.store.index.get(res.body.id)?.title).toBe("Smith: Consulting");
  });

  it("without `create`, PUT is still the upsert every save uses", async () => {
    const res = await call("jules", "PUT", "/api/vault/note", { path: "Contacts/Someone New.md", content: "---\ntitle: Someone New\n---\nedited\n" });
    expect(res.status).toBe(200);
    expect(read("Contacts/Someone New.md")).toContain("edited\n");
  });
});

describe("creating a project does not replace a project note in another case", () => {
  it("POST /api/projects \"thesis\" with 04-Projects/Thesis.md there is a 409", async () => {
    expect((await call("jules", "PUT", "/api/vault/note", { path: "04-Projects/Thesis.md", content: "---\ntitle: Graduation Thesis\ntags: [project/thesis]\n---\n# Thesis\n\n- [ ] write ch1\n" })).status).toBe(200);
    const before = read("04-Projects/Thesis.md");
    const res = await call("jules", "POST", "/api/projects", { name: "Thesis" });
    expect(res.status).toBe(409);
    expect(read("04-Projects/Thesis.md")).toBe(before);
    expect(fs.readdirSync(abs("04-Projects"))).not.toContain("thesis.md");
  });
});

describe("the exclusive write", () => {
  it("refuses a file that is already there, leaving its bytes", () => {
    const f = path.join(process.env.BASALT_DATA_DIR!, "exclusive.txt");
    fs.writeFileSync(f, "mine");
    expect(() => writeFileAtomic(f, "theirs", { exclusive: true })).toThrow(/EEXIST/);
    expect(fs.readFileSync(f, "utf8")).toBe("mine");
    expect(fs.readdirSync(path.dirname(f)).filter((n) => n.includes("exclusive.txt") && n.endsWith(".tmp"))).toEqual([]);
    writeFileAtomic(path.join(path.dirname(f), "fresh.txt"), "new", { exclusive: true });
    expect(fs.readFileSync(path.join(path.dirname(f), "fresh.txt"), "utf8")).toBe("new");
  });
});

describe("uploads never replace a different file (STO-006)", () => {
  it("a project document with a name already used is kept beside it", async () => {
    const up = (name: string, data: string) => call("jules", "POST", "/api/projects/acme/files", { name, dataBase64: b64(data) });
    const dir = abs("04-Projects/acme/files");
    const first = await up("report.docx", "first report");
    expect(first.status).toBe(200);
    expect(first.body.name).toBe("report.docx");

    const second = await up("report.docx", "second report");
    expect(second.status).toBe(200);
    expect(second.body.name).toBe("report (2).docx");
    expect(fs.readFileSync(path.join(dir, "report.docx"), "utf8")).toBe("first report");
    expect(fs.readFileSync(path.join(dir, "report (2).docx"), "utf8")).toBe("second report");

    // The same bytes again are that file, not a third copy.
    const again = await up("report.docx", "first report");
    expect(again.body).toMatchObject({ name: "report.docx", unchanged: true });
    expect((await up("Report.DOCX", "first report")).body).toMatchObject({ name: "report.docx", unchanged: true });
    // Another spelling of a taken name is taken too.
    const upper = await up("REPORT.docx", "third report");
    // (REPORT (2).docx is report (2).docx as well, so the next free one.)
    expect(upper.body.name).toBe("REPORT (3).docx");
    expect(fs.readFileSync(path.join(dir, "report.docx"), "utf8")).toBe("first report");
    expect(fs.readdirSync(dir).sort()).toEqual(["REPORT (3).docx", "report (2).docx", "report.docx"].sort());
  });

  it("a statement with a name already used is kept beside it", async () => {
    const dir = abs("02-Areas/finance/files");
    const up = (data: string) => call("jules", "POST", "/api/finance/payslip", { name: "Bulletin de paie.csv", dataBase64: b64(data) });
    expect((await up("month,net\n2026-09,2100\n")).body).toMatchObject({ name: "Bulletin de paie.csv", stored: true });
    expect((await up("month,net\n2026-10,2150\n")).body).toMatchObject({ name: "Bulletin de paie (2).csv", stored: true });
    expect(fs.readFileSync(path.join(dir, "Bulletin de paie.csv"), "utf8")).toBe("month,net\n2026-09,2100\n");
    expect(fs.readFileSync(path.join(dir, "Bulletin de paie (2).csv"), "utf8")).toBe("month,net\n2026-10,2150\n");
  });

  it("a payslip is filed under the name it was stored as, and one already filed stores nothing", async () => {
    expect(
      (
        await call("jules", "PUT", "/api/vault/note", {
          path: "02-Areas/finance/Payslips.md",
          content: "---\ntitle: Payslips\ntags: [payslips]\n---\n# Payslips\n\n| Month | Gross | Net | File |\n|---|---|---|---|\n| 2026-02 | 1000.00 | 900.00 | feb.pdf |\n",
        })
      ).status,
    ).toBe(200);
    const dir = abs("02-Areas/finance/files");
    const slip = (period: string) => textPdf(`BRUTO 1.057,06 4.820,90 NETTOLOON 978,40 4.641,16 Verl. per. ${period}`);
    fs.writeFileSync(path.join(dir, "payslip.pdf"), slip("01/2026")); // January's, already in the folder

    const march = await call("jules", "POST", "/api/finance/payslip", { name: "payslip.pdf", dataBase64: b64(slip("03/2026")) });
    expect(march.body).toMatchObject({ filed: true, stored: true, name: "payslip (2).pdf" });
    expect(fs.readFileSync(path.join(dir, "payslip.pdf"))).toEqual(slip("01/2026"));
    expect(read("02-Areas/finance/Payslips.md")).toMatch(/\| 2026-03 \|.*\| payslip \(2\)\.pdf \|/);

    const listing = fs.readdirSync(dir).sort();
    const again = await call("jules", "POST", "/api/finance/payslip", { name: "march.pdf", dataBase64: b64(slip("03/2026")) });
    expect(again.body).toMatchObject({ filed: false, stored: false, reason: "2026-03 is already filed" });
    expect(fs.readdirSync(dir).sort()).toEqual(listing);
  });
});
