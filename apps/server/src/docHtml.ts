/**
 * The HTML a .docx becomes, made safe to hand to `dangerouslySetInnerHTML`.
 *
 * mammoth builds its own markup from the document, but it copies some VALUES
 * straight across — above all a hyperlink's target. A .docx whose link points
 * at `javascript:…` came out as a working `<a href="javascript:…">`, and the
 * reader renders into Orrama's own page, where one click runs with the
 * session (audit, high). The old defence was three regexes for <script> and
 * quoted on* handlers; neither is where the danger was.
 *
 * So this is an allowlist, not a blocklist: the HTML is parsed and rebuilt
 * from the elements and attributes mammoth actually emits, every text node and
 * attribute is re-escaped, a link keeps its target only for http(s), mailto,
 * tel and in-page anchors, and an image only for an embedded data:image.
 * Anything else is dropped; unknown elements keep their text, and the contents
 * of script-like elements go with them.
 */
import { Parser } from "htmlparser2";

/** What mammoth's default style map produces, plus footnotes and tables. */
const ELEMENTS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "sup", "sub",
  "a", "img", "br", "hr", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td",
  "blockquote", "pre", "code", "span", "div", "dl", "dt", "dd",
]);
const VOID = new Set(["br", "hr", "img"]);
/** Dropped along with everything inside them. */
const OPAQUE = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "form", "textarea", "select"]);

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");

/** A link target worth keeping, or null. Checked after stripping what browsers ignore. */
export function safeHref(raw: string): string | null {
  const v = raw.replace(/[\u0000- \u007f]/g, "");
  if (v.startsWith("#")) return raw.trim();
  return /^(https?:|mailto:|tel:)/i.test(v) ? raw.trim() : null;
}

const safeSrc = (raw: string) => (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]*$/i.test(raw.trim()) ? raw.trim() : null);
const safeId = (raw: string) => (/^[\w:.-]{1,100}$/.test(raw) ? raw : null);
const safeSpan = (raw: string) => (/^[1-9]\d{0,2}$/.test(raw) ? raw : null);

function attributesFor(tag: string, attrs: Record<string, string>): string {
  const keep: [string, string | null][] = [["id", attrs["id"] !== undefined ? safeId(attrs["id"]) : null]];
  if (tag === "a" && attrs["href"] !== undefined) keep.push(["href", safeHref(attrs["href"])]);
  if (tag === "img") {
    keep.push(["src", attrs["src"] !== undefined ? safeSrc(attrs["src"]) : null]);
    keep.push(["alt", attrs["alt"] ?? null]);
  }
  if (tag === "td" || tag === "th") {
    keep.push(["colspan", attrs["colspan"] !== undefined ? safeSpan(attrs["colspan"]) : null]);
    keep.push(["rowspan", attrs["rowspan"] !== undefined ? safeSpan(attrs["rowspan"]) : null]);
  }
  return keep
    .filter((kv): kv is [string, string] => kv[1] !== null)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join("");
}

export function sanitizeDocHtml(html: string): string {
  let out = "";
  let opaque = 0; // depth inside an element whose contents are dropped
  const open: string[] = [];
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (OPAQUE.has(name)) {
          opaque++;
          return;
        }
        if (opaque || !ELEMENTS.has(name)) return;
        if (name === "img" && (attrs["src"] === undefined || safeSrc(attrs["src"]) === null)) return;
        out += `<${name}${attributesFor(name, attrs)}>`;
        if (!VOID.has(name)) open.push(name);
      },
      ontext(text) {
        if (!opaque) out += escapeText(text);
      },
      onclosetag(name) {
        if (OPAQUE.has(name)) {
          opaque = Math.max(0, opaque - 1);
          return;
        }
        if (opaque || !ELEMENTS.has(name) || VOID.has(name)) return;
        const at = open.lastIndexOf(name);
        if (at === -1) return;
        // Close anything left open inside it, so the output always nests.
        while (open.length > at) out += `</${open.pop()}>`;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();
  while (open.length) out += `</${open.pop()}>`;
  return out;
}
