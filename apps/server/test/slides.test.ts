/**
 * The .pptx reader: slide text, tables, notes and raster images — as data.
 *
 * A deck is a zip anyone can assemble, so the tests build one by hand: the
 * slide order comes from presentation.xml (not the file names), an SVG with a
 * script inside that calls itself image2.png must not come back as an image,
 * and a part that lies about its inflated size must stop at the cap.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-slides-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { readPptx, sniffImage, SLIDE_CAPS } = await import("../src/slides.js");

/** A deflate zip. `declare` overrides an entry's stated size, to fake a bomb. */
function zip(files: Record<string, string | Buffer>, declare: Record<string, number> = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const data = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const size = declare[name] ?? raw.length;
    const crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (list: [string, string, string][]) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join("")}</Relationships>`;
const para = (text: string, lvl = 0) => `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ""}<a:r><a:rPr lang="en-GB"/><a:t>${text}</a:t></a:r></a:p>`;
const bullet = (text: string) => `<a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>${text}</a:t></a:r></a:p>`;
const sp = (ph: string | null, body: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ""}</p:nvPr></p:nvSpPr><p:txBody>${body}</p:txBody></p:sp>`;
const pic = (rid: string, descr: string) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="9" name="Picture" descr="${descr}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/></p:blipFill></p:pic>`;
const slideXml = (shapes: string, attrs = "") => `<?xml version="1.0"?><p:sld ${NS}${attrs}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;

// A 1×1 PNG: real bytes, so the sniffer has something true to say.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>');
const EMF = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x6c, 0x00, 0x00, 0x00, 0x20, 0x45, 0x4d, 0x46]);

function deck(presentationPad = ""): Buffer {
  return zip({
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${NS}>${presentationPad}<p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId4"/><p:sldId id="259" r:id="rId9"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels([
      ["rId2", "slide", "slides/slide1.xml"],
      ["rId3", "slide", "slides/slide2.xml"],
      ["rId4", "slide", "slides/slide3.xml"],
      ["rId9", "slide", "slides/slide4.xml"],
    ]),
    // Text boxes, no placeholders — how generated decks are built.
    "ppt/slides/slide3.xml": slideXml(sp(null, `<a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>Why we are starting here</a:t></a:r></a:p>`) + sp(null, bullet("Chapters 1-3 are the plan") + bullet("Supervisor signs off"))),
    // A lone bulleted line first is a bullet, not a title.
    "ppt/slides/slide4.xml": slideXml(sp(null, bullet("Only point")) + sp(null, para("Closing words"))),
    // Listed FIRST in sldIdLst, despite the file name.
    "ppt/slides/slide2.xml": slideXml(sp("ctrTitle", para("Opening &amp; scope")) + sp("subTitle", para("Supervision, 1 Oct"))),
    "ppt/slides/slide1.xml": slideXml(
      sp("title", para("Research questions")) +
        sp(null, para("Main question") + para("Sub-question one", 1) + `<a:p><a:r><a:t>Line</a:t></a:r><a:br/><a:r><a:t>break</a:t></a:r></a:p>`) +
        `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody>${para("Market")}</a:txBody></a:tc><a:tc><a:txBody>${para("MAPE")}</a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody>${para("NL")}</a:txBody></a:tc><a:tc><a:txBody>${para("12%")}</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>` +
        sp("sldNum", para("2")) +
        `<p:grpSp>${pic("rId5", "Forecast chart")}${pic("rId6", "evil")}${pic("rId7", "metafile")}${pic("rId5", "same chart again")}</p:grpSp>`,
      ' show="0"',
    ),
    "ppt/slides/_rels/slide1.xml.rels": rels([
      ["rId5", "image", "../media/image1.png"],
      ["rId6", "image", "../media/image2.png"],
      ["rId7", "image", "../media/image3.emf"],
      ["rId8", "notesSlide", "../notesSlides/notesSlide1.xml"],
    ]),
    "ppt/notesSlides/notesSlide1.xml": `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree>${sp("sldImg", "")}${sp("body", para("Ask about the data window"))}${sp("sldNum", para("2"))}</p:spTree></p:cSld></p:notes>`,
    "ppt/media/image1.png": PNG,
    "ppt/media/image2.png": SVG,
    "ppt/media/image3.emf": EMF,
  });
}

describe("readPptx", () => {
  it("reads slides in deck order with their title, bullets, table and notes", () => {
    const d = readPptx(deck());
    expect(d.slideCount).toBe(4);
    expect(d.truncated).toBe(false);
    expect(d.slides.map((s) => s.title)).toEqual(["Opening & scope", "Research questions", "Why we are starting here", ""]);
    expect(d.slides[2]!.blocks.map((b) => b.kind === "p" && b.text)).toEqual(["Chapters 1-3 are the plan", "Supervisor signs off"]);
    expect(d.slides[3]!.blocks.map((b) => b.kind === "p" && b.text)).toEqual(["Only point", "Closing words"]);
    expect(d.slides[0]!.blocks).toEqual([{ kind: "p", text: "Supervision, 1 Oct", level: 0 }]);

    const s = d.slides[1]!;
    expect(s.hidden).toBe(true);
    expect(s.blocks).toEqual([
      { kind: "p", text: "Main question", level: 0 },
      { kind: "p", text: "Sub-question one", level: 1 },
      { kind: "p", text: "Line\nbreak", level: 0 },
      { kind: "table", rows: [["Market", "MAPE"], ["NL", "12%"]] },
    ]);
    expect(s.notes).toBe("Ask about the data window"); // body placeholder only, no slide number
  });

  it("keeps real raster images, once, and drops anything else however it is named", () => {
    const d = readPptx(deck());
    const s = d.slides[1]!;
    expect(s.images).toEqual([
      { ref: "m1", alt: "Forecast chart" },
      { ref: "m1", alt: "same chart again" },
    ]);
    expect(Object.keys(d.media)).toEqual(["m1"]);
    expect(d.media["m1"]).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    // the SVG-with-a-script called image2.png, and the EMF
    expect(d.omittedImages).toBe(2);
    expect(JSON.stringify(d)).not.toContain("svg");
  });

  it("sniffs by bytes, not by name", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a......"))).toBe("image/gif");
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(Buffer.from("<html><script>x</script></html>"))).toBeNull();
    expect(sniffImage(EMF)).toBeNull();
  });

  it("a part that inflates past the cap is refused, whatever size it declares", () => {
    const pad = " ".repeat(SLIDE_CAPS.xmlBytes + 1024);
    const honest = deck(pad);
    expect(() => readPptx(honest)).toThrow(/not a PowerPoint/);
    // Same bomb, but the zip claims presentation.xml is 200 bytes.
    const lying = zip(
      {
        "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${NS}>${pad}<p:sldIdLst/></p:presentation>`,
      },
      { "ppt/presentation.xml": 200 },
    );
    expect(() => readPptx(lying)).toThrow(/not a PowerPoint/);
  });

  it("anything that is not a zip is an error, not a crash", () => {
    expect(() => readPptx(Buffer.from("definitely not a deck"))).toThrow();
    expect(() => readPptx(zip({ "word/document.xml": "<w:document/>" }))).toThrow(/not a PowerPoint/);
  });
});

describe("GET /api/projects/:slug/files/:name/slides", () => {
  let app: Awaited<ReturnType<typeof buildServer>>["app"];
  const tokens: Record<string, string> = {};
  const get = (who: string, url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${tokens[who]}` } });

  beforeAll(async () => {
    await import("../src/seed.js");
    app = (await buildServer()).app;
    for (const who of ["jules", "erin", "mara"]) {
      tokens[who] = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@basalt.dev`, password: "basalt-demo" } })).json().token;
    }
    const atlas = path.join(process.env.BASALT_VAULT_DIR!, "04-Projects/atlas/files");
    fs.mkdirSync(atlas, { recursive: true });
    fs.writeFileSync(path.join(atlas, "supervision.pptx"), deck());
    fs.writeFileSync(path.join(atlas, "broken.pptx"), "not a zip at all");
    // A project only mara can read, with a real deck in it.
    await app.inject({
      method: "PUT",
      url: "/api/vault/note",
      headers: { authorization: `Bearer ${tokens["mara"]}` },
      payload: { path: "Personal/mara/Skunkworks.md", content: "---\ntitle: Skunkworks\ntags:\n  - project/skunkworks\n---\n# Skunkworks\n" },
    });
    const skunk = path.join(process.env.BASALT_VAULT_DIR!, "04-Projects/skunkworks/files");
    fs.mkdirSync(skunk, { recursive: true });
    fs.writeFileSync(path.join(skunk, "secret.pptx"), deck());
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
  });

  it("serves the deck as data", async () => {
    const r = await get("jules", "/api/projects/atlas/files/supervision.pptx/slides");
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.slides.map((s: { title: string }) => s.title).slice(0, 2)).toEqual(["Opening & scope", "Research questions"]);
    expect(d.omittedImages).toBe(2);
  });

  it("refuses other types, broken decks and traversal", async () => {
    expect((await get("jules", "/api/projects/atlas/files/x.docx/slides")).statusCode).toBe(400);
    expect((await get("jules", "/api/projects/atlas/files/broken.pptx/slides")).statusCode).toBe(422);
    expect((await get("jules", "/api/projects/atlas/files/missing.pptx/slides")).statusCode).toBe(404);
    expect((await get("jules", `/api/projects/atlas/files/${encodeURIComponent("../../x.pptx")}/slides`)).statusCode).toBe(400);
  });

  it("a deck in a project the caller cannot read is a 404", async () => {
    expect((await get("mara", "/api/projects/skunkworks/files/secret.pptx/slides")).statusCode).toBe(200);
    expect((await get("erin", "/api/projects/skunkworks/files/secret.pptx/slides")).statusCode).toBe(404);
  });
});
