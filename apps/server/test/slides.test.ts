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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-slides-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { readPptx, sniffImage, SLIDE_CAPS } = await import("../src/slides.js");
const { deck, zip, NS, PNG, SVG, EMF, para, rels, slideXml, sp } = await import("./helpers/pptx.js");


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

/**
 * A small file can still be a lot of work: the per-part cap held, but one 8 MB
 * slide listed twenty times was parsed twenty times (11 s on the event loop),
 * nothing bounded the XML across parts, and 5,000 nested elements overflowed
 * the stack (audit INP-004).
 */
describe("readPptx on a deck built to be expensive", () => {
  const deckOf = (slides: string[], ids = slides.map((_, i) => `rId${i + 1}`)) =>
    zip({
      "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${ids.map((id, i) => `<p:sldId id="${256 + i}" r:id="${id}"/>`).join("")}</p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": rels(slides.map((_, i) => [`rId${i + 1}`, "slide", `slides/slide${i + 1}.xml`])),
      ...Object.fromEntries(slides.map((x, i) => [`ppt/slides/slide${i + 1}.xml`, x])),
    });

  it("a slide listed forty times is read once", { timeout: 30_000 }, () => {
    const big = slideXml(sp(null, para("x").repeat(20_000)));
    const d = readPptx(deckOf([big], Array(40).fill("rId1")));
    expect(d.slideCount).toBe(1);
    expect(d.slides).toHaveLength(1);
    expect(d.truncated).toBe(false);
  });

  it("all the XML one preview reads shares a budget, and the deck stops at the last slide that fitted", { timeout: 30_000 }, () => {
    const slideBytes = 3 * 1024 * 1024;
    const big = slideXml(sp(null, para("y").repeat(Math.ceil(slideBytes / para("y").length))));
    const d = readPptx(deckOf(Array(8).fill(big)));
    const fit = Math.floor(SLIDE_CAPS.xmlBudget / Buffer.byteLength(big));
    expect(fit).toBeLessThan(8);
    expect(d.slideCount).toBe(8);
    expect(d.slides).toHaveLength(fit);
    expect(d.truncated).toBe(true);
    expect(d.slides.every((s) => s.blocks.length > 0)).toBe(true); // whole slides, none half-read
  });

  it("a part nested past any real slide is refused, not a stack overflow; ordinary nesting still reads", () => {
    const nested = (depth: number) => slideXml(sp(null, "<a:g>".repeat(depth) + para("deep text") + "</a:g>".repeat(depth)));
    expect(() => readPptx(deckOf([nested(5000)]))).toThrow(/nested too deeply/);
    const ok = readPptx(deckOf([nested(150)]));
    expect(ok.slides[0]!.title).toBe("deep text");
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
    const atlas = path.join(process.env.ORRAMA_VAULT_DIR!, "04-Projects/atlas/files");
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
    const skunk = path.join(process.env.ORRAMA_VAULT_DIR!, "04-Projects/skunkworks/files");
    fs.mkdirSync(skunk, { recursive: true });
    fs.writeFileSync(path.join(skunk, "secret.pptx"), deck());
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
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
