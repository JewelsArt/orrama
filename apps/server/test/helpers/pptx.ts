/**
 * Office files built by hand for tests — a .pptx is a zip anyone can
 * assemble. Shared by slides.test.ts and contract.test.ts.
 */
import zlib from "node:zlib";

/** A deflate zip. `declare` overrides an entry's stated size, to fake a bomb. */
export function zip(files: Record<string, string | Buffer>, declare: Record<string, number> = {}): Buffer {
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

export const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
export const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const rels = (list: [string, string, string][]) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join("")}</Relationships>`;
export const para = (text: string, lvl = 0) => `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ""}<a:r><a:rPr lang="en-GB"/><a:t>${text}</a:t></a:r></a:p>`;
export const bullet = (text: string) => `<a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>${text}</a:t></a:r></a:p>`;
export const sp = (ph: string | null, body: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ""}</p:nvPr></p:nvSpPr><p:txBody>${body}</p:txBody></p:sp>`;
export const pic = (rid: string, descr: string) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="9" name="Picture" descr="${descr}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/></p:blipFill></p:pic>`;
export const slideXml = (shapes: string, attrs = "") => `<?xml version="1.0"?><p:sld ${NS}${attrs}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;

// A 1×1 PNG: real bytes, so the sniffer has something true to say.
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>');
export const EMF = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x6c, 0x00, 0x00, 0x00, 0x20, 0x45, 0x4d, 0x46]);

export function deck(presentationPad = ""): Buffer {
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
