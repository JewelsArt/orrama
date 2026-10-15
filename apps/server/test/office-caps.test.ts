/**
 * Office documents are zips anyone can assemble, and a zip states its parts'
 * sizes without having to be honest. A 60 KB .docx whose document.xml
 * inflated to 20 MB took mammoth 9 s and 1.7 GB of memory, and exceljs held
 * whatever a workbook inflated to (audit INP-004). Now every part is inflated
 * against a cap before either library sees the file (zip.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-office-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { assertInflatesWithin, DOCX_CAPS, TooLargeError, XLSX_CAPS } = await import("../src/zip.js");
const { readStatementFile } = await import("../src/routes/finance.js");
const { zip } = await import("./helpers/pptx.js");

const MB = 1024 * 1024;
const caps = { fileBytes: 10 * MB, xmlBytes: 1 * MB, totalBytes: 2 * MB };
const filler = (bytes: number) => "a".repeat(bytes);

describe("assertInflatesWithin", () => {
  it("lets a document inside its caps through", async () => {
    await expect(assertInflatesWithin(zip({ "word/document.xml": filler(900_000), "word/media/image1.png": filler(900_000) }), caps)).resolves.toBeUndefined();
  });

  it("refuses an XML part past its cap, whatever size the zip declares for it", async () => {
    const big = { "word/document.xml": filler(MB + 1) };
    await expect(assertInflatesWithin(zip(big), caps)).rejects.toBeInstanceOf(TooLargeError);
    await expect(assertInflatesWithin(zip(big, { "word/document.xml": 200 }), caps)).rejects.toBeInstanceOf(TooLargeError);
  });

  it("holds an image to the whole budget, not the XML cap", async () => {
    await expect(assertInflatesWithin(zip({ "word/media/image1.png": filler(1.5 * MB) }), caps)).resolves.toBeUndefined();
    await expect(assertInflatesWithin(zip({ "word/media/image1.png": filler(1.5 * MB), "word/media/image2.png": filler(0.6 * MB) }), caps)).rejects.toBeInstanceOf(TooLargeError);
  });

  it("counts a part the directory lists twice, twice", async () => {
    const two = zip({ "word/a.xml": filler(900_000), "word/b.xml": filler(900_000), "word/c.png": filler(300_000) });
    await expect(assertInflatesWithin(two, caps)).rejects.toBeInstanceOf(TooLargeError);
    // Same bytes, but both XML parts named a.xml: still 2.1 MB to inflate.
    const dup = Buffer.from(two.toString("latin1").replaceAll("word/b.xml", "word/a.xml"), "latin1");
    await expect(assertInflatesWithin(dup, caps)).rejects.toBeInstanceOf(TooLargeError);
  });

  it("refuses a file over its size on disk, and calls anything unreadable unreadable, not too large", async () => {
    await expect(assertInflatesWithin(Buffer.alloc(caps.fileBytes + 1), caps)).rejects.toBeInstanceOf(TooLargeError);
    const notZip = assertInflatesWithin(Buffer.from("not a zip"), caps);
    await expect(notZip).rejects.toThrow();
    await expect(notZip).rejects.not.toBeInstanceOf(TooLargeError);
    // A compression method nothing here reads (12 is bzip2), in the central directory.
    const z = zip({ "word/document.xml": "<w:document/>" });
    z.writeUInt16LE(12, z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    await expect(assertInflatesWithin(z, caps)).rejects.toThrow(/unsupported/);
  });
});

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (bodyXml: string, declare: Record<string, number> = {}) =>
  zip(
    {
      "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${bodyXml}</w:body></w:document>`,
    },
    declare,
  );
const para = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;

const xlsx = (sheetXml: string) =>
  zip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetXml}</sheetData></worksheet>`,
  });
const row = (r: number, cells: (string | number)[]) =>
  `<row r="${r}">${cells.map((v, c) => `<c r="${String.fromCharCode(65 + c)}${r}"${typeof v === "string" ? ' t="inlineStr"><is><t>' + v + "</t></is>" : `><v>${v}</v>`}</c>`).join("")}</row>`;

describe("the document routes", () => {
  let app: Awaited<ReturnType<typeof buildServer>>["app"];
  let token = "";
  const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  const project = () => path.join(process.env.ORRAMA_VAULT_DIR!, "04-Projects/atlas/files");
  const finance = () => path.join(process.env.ORRAMA_VAULT_DIR!, "02-Areas/finance/files");
  // Just over the XML cap: as XML of short paragraphs, the shape that cost mammoth the most.
  const overDocx = () => para("aaaaaaaaaaaaaaaaaaaa").repeat(Math.ceil((DOCX_CAPS.xmlBytes + 1024) / para("aaaaaaaaaaaaaaaaaaaa").length));
  const overSheet = () => {
    const unit = row(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    return unit.repeat(Math.ceil((XLSX_CAPS.xmlBytes + 1024) / unit.length));
  };

  beforeAll(async () => {
    await import("../src/seed.js");
    app = (await buildServer()).app;
    token = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } })).json().token;
    fs.mkdirSync(project(), { recursive: true });
    fs.mkdirSync(finance(), { recursive: true });
    fs.writeFileSync(path.join(project(), "fine.docx"), docx(para("Chapter one")));
    // The bomb as it was found: a small file that says its document.xml is small.
    fs.writeFileSync(path.join(project(), "bomb.docx"), docx(overDocx(), { "word/document.xml": 4096 }));
    fs.writeFileSync(path.join(project(), "broken.docx"), "not a zip at all");
    fs.writeFileSync(path.join(project(), "fine.xlsx"), xlsx(row(1, ["Name", "Value"]) + row(2, ["a", 1])));
    fs.writeFileSync(path.join(project(), "bomb.xlsx"), xlsx(overSheet()));
    fs.writeFileSync(path.join(finance(), "bomb.xlsx"), xlsx(overSheet()));
  }, 60_000); // ~75 MB of documents to build

  afterAll(async () => {
    await app.close();
    fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
  });

  it("a .docx inside its caps converts; one that inflates past them is a 413; one that is not a zip a 422", { timeout: 30_000 }, async () => {
    const fine = await get("/api/projects/atlas/files/fine.docx/html");
    expect(fine.statusCode).toBe(200);
    expect(fine.json().html).toContain("Chapter one");
    expect(fs.statSync(path.join(project(), "bomb.docx")).size).toBeLessThan(100 * 1024);
    expect((await get("/api/projects/atlas/files/bomb.docx/html")).statusCode).toBe(413);
    expect((await get("/api/projects/atlas/files/broken.docx/html")).statusCode).toBe(422);
  });

  it("a workbook that inflates past its caps is a 413 in a project and in finance", { timeout: 30_000 }, async () => {
    const fine = await get("/api/projects/atlas/files/fine.xlsx/sheet");
    expect(fine.statusCode).toBe(200);
    expect(fine.json().sheets[0].rows).toEqual([["Name", "Value"], ["a", "1"]]);
    expect((await get("/api/projects/atlas/files/bomb.xlsx/sheet")).statusCode).toBe(413);
    expect((await get("/api/finance/files/bomb.xlsx/sheet")).statusCode).toBe(413);
  });

  it("a statement workbook past its caps counts for nothing, and says why", { timeout: 30_000 }, async () => {
    const st = await readStatementFile(path.join(finance(), "bomb.xlsx"));
    expect(st.rows).toEqual([]);
    expect(st.problem).toBe("the workbook is too large to read");
  });
});
