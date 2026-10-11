/**
 * A .pptx as plain slides: text, tables, speaker notes and raster images.
 *
 * Same reasoning as the .docx and .xlsx readers — the parsing happens on the
 * server and the browser only ever receives data. Here the data is not even
 * HTML: the reader builds its own elements from strings, so nothing in a deck
 * reaches `dangerouslySetInnerHTML`. Images travel as `data:` URIs, and only
 * after their BYTES say PNG, JPEG, GIF or WebP: a deck is a zip anyone can
 * assemble, and an SVG (or HTML) named image1.png is exactly the file that
 * would run script if it were ever rendered as a document on our origin. EMF,
 * WMF and TIFF are dropped too — the webview cannot draw them — and counted, so
 * the reader can say what it left out.
 *
 * The zip is read with node:zlib (zip.ts) rather than a library, because what
 * matters is the ceiling: every part is inflated with `maxOutputLength`, so a
 * part that lies about its size (a zip bomb) stops at the cap instead of
 * filling memory, and all the XML one preview reads shares one budget.
 */
import path from "node:path";
import { Parser } from "htmlparser2";
import { extract, readCentralDirectory, type ZipEntry } from "./zip.js";

/** Enough to read a long deck; the caps keep the JSON and the DOM sane. */
export const SLIDE_CAPS = {
  /** The file itself. Uploads stop at 25 MB; a deck dropped into the vault from Finder does not. */
  fileBytes: 80 * 1024 * 1024,
  /** Any one XML part, inflated. */
  xmlBytes: 8 * 1024 * 1024,
  /**
   * Every XML part the preview reads, inflated, together. Parsing costs ~70 ms
   * per MB on the event loop: twenty references to one 8 MB slide took 11 s
   * (audit INP-004). A real deck is far under it; past it the preview stops
   * at the last slide that fitted and says it was cut short.
   */
  xmlBudget: 16 * 1024 * 1024,
  /** Elements inside elements. A real slide is a few dozen deep; 5,000 overflowed the stack. */
  depth: 256,
  slides: 150,
  /** Characters of text per slide, notes included. */
  textPerSlide: 20_000,
  imagesPerSlide: 8,
  imageBytes: 4 * 1024 * 1024,
  /** All distinct images together, before base64. */
  imageBudget: 16 * 1024 * 1024,
};

export type SlideBlock = { kind: "p"; text: string; level: number } | { kind: "table"; rows: string[][] };

export interface Slide {
  n: number;
  title: string;
  hidden: boolean;
  blocks: SlideBlock[];
  /** Keys into `DeckPreview.media`; a logo on every slide is sent once. */
  images: { ref: string; alt: string }[];
  notes: string;
}

export interface DeckPreview {
  slides: Slide[];
  slideCount: number;
  truncated: boolean;
  media: Record<string, string>;
  /** Pictures left out: unsupported format, over a cap, or missing from the zip. */
  omittedImages: number;
}

// ---- xml ------------------------------------------------------------------

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** A tiny DOM. OOXML prefixes are conventional, so names keep them (`a:t`). */
function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        // Everything below walks the tree; a part nested past any real slide is refused (a 422).
        if (stack.length > SLIDE_CAPS.depth) throw new Error("presentation nested too deeply");
        const node: XmlNode = { name, attrs, children: [], text: "" };
        stack[stack.length - 1]!.children.push(node);
        stack.push(node);
      },
      ontext(text) {
        stack[stack.length - 1]!.text += text;
      },
      onclosetag() {
        if (stack.length > 1) stack.pop();
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml);
  parser.end();
  return root;
}

const local = (name: string) => name.slice(name.indexOf(":") + 1);

/** Every node below `node`, in document order. A stack, not recursion: a recursive generator costs a frame per level for every node. */
function* walk(node: XmlNode): Generator<XmlNode> {
  const stack = [...node.children].reverse();
  while (stack.length > 0) {
    const n = stack.pop()!;
    yield n;
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
}
const find = (node: XmlNode, name: string) => {
  for (const n of walk(node)) if (local(n.name) === name) return n;
  return undefined;
};
/** A relationship attribute (`r:id`, `r:embed`) — not the element's own `id`. */
const relAttr = (node: XmlNode, name: string) => {
  for (const [k, v] of Object.entries(node.attrs)) if (k.includes(":") && local(k) === name) return v;
  return undefined;
};

/** A paragraph's visible text: runs, fields, explicit breaks and tabs. */
function paragraphText(p: XmlNode): string {
  let out = "";
  const visit = (n: XmlNode) => {
    for (const c of n.children) {
      const l = local(c.name);
      if (l === "t") out += c.text;
      else if (l === "br") out += "\n";
      else if (l === "tab") out += "\t";
      else if (l !== "pPr" && l !== "rPr") visit(c);
    }
  };
  visit(p);
  return out.replace(/[ \t]+$/g, "");
}

/** A part's relationships, read through `xml` (the deck's budgeted reader). */
function relationships(xml: (part: string) => XmlNode | null, part: string): Map<string, { target: string; type: string }> {
  const dir = path.posix.dirname(part);
  const tree = xml(path.posix.join(dir, "_rels", `${path.posix.basename(part)}.rels`));
  const rels = new Map<string, { target: string; type: string }>();
  if (!tree) return rels;
  for (const n of walk(tree)) {
    if (local(n.name) !== "Relationship" || n.attrs["TargetMode"] === "External") continue;
    const id = n.attrs["Id"];
    const target = n.attrs["Target"];
    if (!id || !target) continue;
    // Targets are relative to the part's folder; an absolute one starts at the package root.
    const resolved = target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join(dir, target));
    rels.set(id, { target: resolved, type: n.attrs["Type"] ?? "" });
  }
  return rels;
}

// ---- images ---------------------------------------------------------------

/** The image type its bytes declare, or null for anything we will not draw. */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6))) return "image/gif";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// ---- slides ---------------------------------------------------------------

function shapeBlocks(shape: XmlNode, into: SlideBlock[]): void {
  for (const n of walk(shape)) {
    if (local(n.name) !== "tbl") continue;
    const rows = n.children
      .filter((c) => local(c.name) === "tr")
      .map((tr) =>
        tr.children
          .filter((c) => local(c.name) === "tc")
          .map((tc) =>
            [...walk(tc)]
              .filter((x) => local(x.name) === "p")
              .map(paragraphText)
              .join("\n")
              .trim(),
          ),
      );
    if (rows.length) into.push({ kind: "table", rows });
    return; // the table's paragraphs live in its cells, not loose on the slide
  }
  for (const n of walk(shape)) {
    if (local(n.name) !== "p") continue;
    const text = paragraphText(n);
    if (!text.trim()) continue;
    const pPr = n.children.find((c) => local(c.name) === "pPr");
    const level = Math.min(Math.max(Number(pPr?.attrs["lvl"] ?? 0) || 0, 0), 8);
    into.push({ kind: "p", text, level });
  }
}

const placeholderType = (shape: XmlNode) => {
  const ph = find(shape, "ph");
  return ph ? ph.attrs["type"] ?? "body" : null;
};

/** Shapes in reading (z-)order, descending into groups. */
function shapes(tree: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  const visit = (n: XmlNode) => {
    for (const c of n.children) {
      const l = local(c.name);
      if (l === "sp" || l === "graphicFrame" || l === "pic") out.push(c);
      // mc:AlternateContent carries the same shape twice; the Fallback is the
      // plain rendition (often a picture of an equation or a 3D model).
      else if (l === "AlternateContent") {
        const alt = c.children.find((x) => local(x.name) === "Fallback") ?? c.children.find((x) => local(x.name) === "Choice");
        if (alt) visit(alt);
      } else visit(c);
    }
  };
  visit(tree);
  return out;
}

const textOf = (shape: XmlNode) =>
  [...walk(shape)]
    .filter((n) => local(n.name) === "p")
    .map(paragraphText)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

export function readPptx(buf: Buffer): DeckPreview {
  if (buf.length > SLIDE_CAPS.fileBytes) throw new Error("presentation too large to preview");
  const entries = new Map<string, ZipEntry>(readCentralDirectory(buf).map((e) => [e.name, e]));
  let xmlLeft = SLIDE_CAPS.xmlBudget;
  let outOfBudget = false;
  const xml = (part: string) => {
    const bytes = extract(buf, entries, part, Math.min(SLIDE_CAPS.xmlBytes, xmlLeft));
    // A part that is there but did not fit what is left: the deck ran out, not the part.
    if (!bytes && entries.has(part) && xmlLeft < SLIDE_CAPS.xmlBytes) outOfBudget = true;
    if (!bytes) return null;
    xmlLeft -= bytes.length;
    return parseXml(bytes.toString("utf8"));
  };

  const pres = xml("ppt/presentation.xml");
  if (!pres) throw new Error("not a PowerPoint presentation");
  const presRels = relationships(xml, "ppt/presentation.xml");
  // Deck order is the sldIdLst, not the file names: slide7.xml can come first.
  // A part listed twice is read once — a real deck never repeats one, and a
  // crafted one repeated an 8 MB slide to be parsed over and over.
  const order = [
    ...new Set(
      [...walk(pres)]
        .filter((n) => local(n.name) === "sldId")
        .map((n) => presRels.get(relAttr(n, "id") ?? "")?.target)
        .filter((t): t is string => !!t && entries.has(t)),
    ),
  ];

  const media: Record<string, string> = {};
  const mediaKey = new Map<string, string | null>();
  let spent = 0;
  let omittedImages = 0;

  const imageFor = (target: string): string | null => {
    if (mediaKey.has(target)) return mediaKey.get(target)!;
    let key: string | null = null;
    const bytes = extract(buf, entries, target, SLIDE_CAPS.imageBytes);
    const type = bytes && sniffImage(bytes);
    if (bytes && type && spent + bytes.length <= SLIDE_CAPS.imageBudget) {
      key = `m${Object.keys(media).length + 1}`;
      media[key] = `data:${type};base64,${bytes.toString("base64")}`;
      spent += bytes.length;
    }
    mediaKey.set(target, key);
    return key;
  };

  const readSlide = (part: string, i: number): Slide => {
    const slide: Slide = { n: i + 1, title: "", hidden: false, blocks: [], images: [], notes: "" };
    const tree = xml(part);
    if (!tree) return slide;
    slide.hidden = tree.children.find((c) => local(c.name) === "sld")?.attrs["show"] === "0";
    const rels = relationships(xml, part);

    let firstText: { at: number; count: number; bulleted: boolean } | null = null;
    for (const shape of shapes(tree)) {
      if (local(shape.name) === "pic") {
        const blip = find(shape, "blip");
        const target = blip && rels.get(relAttr(blip, "embed") ?? "")?.target;
        if (!target) continue;
        const ref = slide.images.length < SLIDE_CAPS.imagesPerSlide ? imageFor(target) : null;
        if (!ref) {
          omittedImages++;
          continue;
        }
        slide.images.push({ ref, alt: find(shape, "cNvPr")?.attrs["descr"] ?? "" });
        continue;
      }
      const ph = placeholderType(shape);
      if (ph === "sldNum" || ph === "dt" || ph === "ftr") continue;
      if ((ph === "title" || ph === "ctrTitle") && !slide.title) {
        slide.title = textOf(shape);
        continue;
      }
      const at = slide.blocks.length;
      shapeBlocks(shape, slide.blocks);
      if (!firstText && slide.blocks.length > at) {
        firstText = { at, count: slide.blocks.length - at, bulleted: !!find(shape, "buChar") || !!find(shape, "buAutoNum") };
      }
    }
    // Decks built from plain text boxes (most generated ones) have no title
    // placeholder: their title is the first box, one short unbulleted line.
    const lead = firstText && firstText.count === 1 && !firstText.bulleted ? slide.blocks[firstText.at] : undefined;
    if (!slide.title && lead?.kind === "p" && lead.text.length <= 150) {
      slide.title = lead.text.replace(/\s+/g, " ").trim();
      slide.blocks.splice(firstText!.at, 1);
    }

    const notesPart = [...rels.values()].find((r) => r.type.endsWith("/notesSlide"))?.target;
    const notes = notesPart ? xml(notesPart) : null;
    if (notes) {
      slide.notes = shapes(notes)
        .filter((s) => placeholderType(s) === "body")
        .flatMap((s) => [...walk(s)].filter((n) => local(n.name) === "p").map(paragraphText))
        .join("\n")
        .trim();
    }
    capText(slide);
    return slide;
  };

  const slides: Slide[] = [];
  for (const part of order.slice(0, SLIDE_CAPS.slides)) {
    const slide = readSlide(part, slides.length);
    // The slide the budget ran out in is left out, not shown half-read.
    if (outOfBudget) break;
    slides.push(slide);
  }

  return { slides, slideCount: order.length, truncated: order.length > slides.length, media, omittedImages };
}

/** Holds a slide to `textPerSlide` characters; notes are cut first. */
function capText(slide: Slide): void {
  let left = SLIDE_CAPS.textPerSlide - slide.title.length;
  const kept: SlideBlock[] = [];
  for (const b of slide.blocks) {
    const size = b.kind === "p" ? b.text.length : b.rows.flat().join("").length;
    if (size > left) break;
    kept.push(b);
    left -= size;
  }
  slide.blocks = kept;
  slide.notes = slide.notes.slice(0, Math.max(0, left));
}
