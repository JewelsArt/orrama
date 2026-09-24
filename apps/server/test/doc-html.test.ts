/**
 * A .docx rendered in the project reader must not be able to run code.
 *
 * mammoth copies a hyperlink's target straight into `<a href>`, and the reader
 * puts the HTML into Basalt's own page. A document linking to `javascript:…`
 * ran with the session on one click (audit, high). The fixture
 * test/fixtures/links.docx is a real .docx with a `javascript:` link, a
 * mixed-case one, an https link and a mailto link.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-dochtml-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { sanitizeDocHtml, safeHref } = await import("../src/docHtml.js");

describe("sanitizeDocHtml", () => {
  const clean = sanitizeDocHtml;

  it("drops script link targets however they are spelled", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "jav&#x61;script:alert(1)",
      "&#106;avascript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      const out = clean(`<p><a href="${href}">x</a></p>`);
      expect(out, href).toBe("<p><a>x</a></p>");
    }
  });

  it("keeps ordinary links and in-page anchors", () => {
    expect(clean('<a href="https://example.com/a?b=1&amp;c=2">x</a>')).toBe('<a href="https://example.com/a?b=1&amp;c=2">x</a>');
    expect(clean('<a href="mailto:a@example.com">x</a>')).toBe('<a href="mailto:a@example.com">x</a>');
    expect(clean('<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup>')).toBe('<sup><a id="footnote-ref-1" href="#footnote-1">[1]</a></sup>');
  });

  it("drops event handlers, quoted or not, and every attribute it does not know", () => {
    expect(clean("<p onclick=alert(1) style=\"color:red\" class=x>t</p>")).toBe("<p>t</p>");
    expect(clean('<a href="https://ok.example" onmouseover=\'alert(1)\'>t</a>')).toBe('<a href="https://ok.example">t</a>');
  });

  it("drops script, style and svg together with what is inside them", () => {
    expect(clean("<p>a<script>alert(1)</script>b</p>")).toBe("<p>ab</p>");
    expect(clean("<style>p{}</style><p>t</p>")).toBe("<p>t</p>");
    expect(clean('<svg><a href="javascript:alert(1)"><text>x</text></a></svg><p>t</p>')).toBe("<p>t</p>");
  });

  it("keeps embedded images and drops remote ones", () => {
    expect(clean('<img src="data:image/png;base64,iVBORw0KGgo=" alt="chart">')).toBe('<img src="data:image/png;base64,iVBORw0KGgo=" alt="chart">');
    expect(clean('<img src="https://tracker.example/p.gif">')).toBe("");
    expect(clean('<img src="data:image/svg+xml;base64,PHN2Zz4=">')).toBe("");
  });

  it("re-escapes text and attribute values, and keeps the structure mammoth made", () => {
    expect(clean("<p>1 &lt; 2 &amp; &lt;b&gt;</p>")).toBe("<p>1 &lt; 2 &amp; &lt;b&gt;</p>");
    expect(clean('<img src="data:image/png;base64,AA==" alt="&quot;><script>">')).toBe('<img src="data:image/png;base64,AA==" alt="&quot;&gt;&lt;script&gt;">');
    expect(clean("<table><tr><td colspan=\"2\">a</td></tr></table><ul><li><strong>b</strong></li></ul>")).toBe(
      '<table><tr><td colspan="2">a</td></tr></table><ul><li><strong>b</strong></li></ul>',
    );
    expect(clean("<custom-tag>kept text</custom-tag>")).toBe("kept text");
    expect(clean("<p><strong>unclosed</p>")).toBe("<p><strong>unclosed</strong></p>");
  });

  it("a control character in front of a script link does not get it through", () => {
    expect(safeHref("\u0001javascript:x")).toBeNull();
    expect(safeHref("#top")).toBe("#top");
  });
});

describe("GET /api/projects/:slug/files/:name/html", () => {
  let app: Awaited<ReturnType<typeof buildServer>>["app"];
  let token = "";

  beforeAll(async () => {
    await import("../src/seed.js");
    app = (await buildServer()).app;
    token = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })).json().token;
    const dir = path.join(process.env.BASALT_VAULT_DIR!, "04-Projects/atlas/files");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(import.meta.dirname, "fixtures/links.docx"), path.join(dir, "links.docx"));
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
  });

  it("serves a real .docx with its script links gone and its real links intact", async () => {
    const r = await app.inject({ method: "GET", url: "/api/projects/atlas/files/links.docx/html", headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(200);
    const { html } = r.json() as { html: string };
    expect(html).toContain("link rId1"); // the document was converted, not refused
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html).not.toContain("<script");
    expect(html).toContain('href="https://example.com/ok"');
    expect(html).toContain('href="mailto:someone@example.com"');
  });
});
