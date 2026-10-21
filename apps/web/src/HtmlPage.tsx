import { forwardRef, useState } from "react";

/**
 * An .html document shown as the page it is, scripts and all — a saved claude.ai artifact, a
 * report. The server serves it from `…/files/:name/page` into a sandbox (pageSandbox.ts on the
 * server), and the frame says the same: no `allow-same-origin`, so the page runs in an opaque
 * origin with no session, none of Orrama's storage and no reach into this window. The two
 * lists must agree; `HtmlPage.dom.test.tsx` holds this one.
 *
 * Unlike the mail reader's frame (which runs no script and keeps the origin, to measure the
 * message), this one is sized by its container: an artifact is a whole page, often taller than
 * the screen and scrolling itself.
 */
export const PAGE_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

export const pageUrl = (slug: string, name: string) => `/api/projects/${encodeURIComponent(slug)}/files/${encodeURIComponent(name)}/page`;

export const HtmlPage = forwardRef<HTMLIFrameElement, { slug: string; name: string; className?: string }>(function HtmlPage({ slug, name, className }, ref) {
  const src = pageUrl(slug, name);
  const [loaded, setLoaded] = useState<string | null>(null);
  return (
    <div className={`html-page${className ? ` ${className}` : ""}`}>
      {loaded !== src && <p className="html-page-wait">Opening…</p>}
      <iframe
        ref={ref}
        key={src}
        src={src}
        title={name}
        sandbox={PAGE_SANDBOX}
        referrerPolicy="no-referrer"
        allow="fullscreen"
        onLoad={() => setLoaded(src)}
      />
    </div>
  );
});
