/**
 * How an .html document is served when the reader shows it as a page.
 *
 * Every other document route keeps scripts out: a .docx is rebuilt from an
 * allowlist (docHtml.ts), the mail reader's frame runs none, and the raw file
 * route downloads anything scriptable rather than render it on our origin. A
 * saved claude.ai artifact is the opposite case — a page that only works when
 * its own scripts run (React and Babel from a CDN, a chart library, a canvas
 * viewer drawing its boards in frames of its own).
 *
 * So it runs, but sealed off. The `sandbox` directive below gives the page an
 * opaque origin even when it is opened on its own, not only in our frame (the
 * frame's `sandbox` attribute says the same, `HtmlPage.tsx`): without
 * `allow-same-origin` it reads no cookie and none of Orrama's storage, cannot
 * reach into the window that framed it, and the session cookie never rides its
 * requests — it is SameSite=Strict, and an opaque origin is never same-site,
 * so `fetch("/api/…")` from the page answers 401. `frame-ancestors 'self'`
 * stops any other site from framing it.
 *
 * What it may load is what artifacts load, and no more: inline script and
 * style (the page is one file), `eval` (Babel compiles the JSX in the page),
 * data: and blob: (inlined images, frames built from strings), the five script
 * CDNs claude.ai artifacts are allowed to use, and Google Fonts. Images may
 * come from any https host, as in mail with images shown. Forms post nowhere.
 */
export const PAGE_SANDBOX = ["allow-scripts", "allow-forms", "allow-modals", "allow-popups", "allow-popups-to-escape-sandbox", "allow-downloads"] as const;

const CDNS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdn.tailwindcss.com", "https://code.jquery.com"];

export const PAGE_CSP = [
  `sandbox ${PAGE_SANDBOX.join(" ")}`,
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' data: blob: ${CDNS.join(" ")}`,
  `style-src 'unsafe-inline' data: blob: https://fonts.googleapis.com ${CDNS.join(" ")}`,
  `font-src data: blob: https://fonts.gstatic.com ${CDNS.join(" ")}`,
  "img-src data: blob: https:",
  "media-src data: blob:",
  `connect-src data: blob: ${CDNS.join(" ")}`,
  "worker-src blob:",
  "frame-src data: blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** Only these are served as pages. */
export const isPageName = (name: string) => /\.html?$/i.test(name);
