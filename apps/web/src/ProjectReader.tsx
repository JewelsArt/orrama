import { useMemo, useRef } from "react";
import type { ProjectWorkspace } from "@orrama/schema/responses";
import { HtmlPage } from "./HtmlPage.js";
import { artifactLinks, pagesOf, pageTitle } from "./projectPages.js";
import { Button, LinkButton } from "./ui/controls.js";
import { Icon } from "./ui/Icon.js";
import { dateLabel } from "./ui/dates.js";
import { Row, RowList } from "./ui/layout.js";
import { navigate, routeHref } from "./ui/router.js";
import { EmptyState } from "./ui/states.js";

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * The project's Reader tab (`/projects/<slug>/reader?page=<file>`): its .html documents shown
 * as the pages they are — the claude.ai artifacts saved into `files/`, reports — one at a
 * time, the list beside it. The page runs in the sealed frame `HtmlPage` draws. Where the
 * project note's Documents section links a page to its artifact, the live one is a click away:
 * that is where an artifact that keeps data on claude.ai has it.
 */
export function ProjectReader({ w, page }: { w: ProjectWorkspace; page?: string }) {
  const pages = useMemo(() => pagesOf(w.files), [w.files]);
  const links = useMemo(() => artifactLinks(w.content), [w.content]);
  const frame = useRef<HTMLIFrameElement>(null);

  if (pages.length === 0)
    return (
      <EmptyState
        pose="read"
        title="No pages in this project yet."
        text={
          <>
            An .html file in <code>04-Projects/{w.slug}/files/</code> opens here as the page it is: a saved claude.ai artifact, a report.
          </>
        }
      />
    );

  const current = pages.find((p) => p.name === page) ?? pages[0]!;
  const href = (name: string) => routeHref({ kind: "project", slug: w.slug, tab: "reader", page: name });
  const live = links.get(current.name);
  const canFull = typeof document !== "undefined" && document.fullscreenEnabled;

  return (
    <div className={`pj-reader${pages.length === 1 ? " one" : ""}`}>
      {pages.length > 1 && (
        <nav className="pj-reader-list" aria-label="Pages">
          <RowList label="Pages">
            {pages.map((p) => (
              <Row
                key={p.name}
                lead={<Icon name="globe" size={16} />}
                className={p.name === current.name ? "on" : undefined}
                title={pageTitle(p.name)}
                titleAttr={p.name}
                meta={`${size(p.size)} · ${dateLabel(p.mtimeMs)}`}
                href={href(p.name)}
                onOpen={() => navigate(href(p.name))}
              />
            ))}
          </RowList>
        </nav>
      )}
      <section className="pj-reader-page" aria-label={pageTitle(current.name)}>
        <header className="pj-reader-head">
          <h2 title={current.name}>{pageTitle(current.name)}</h2>
          {live && (
            <LinkButton size="sm" icon="ext" href={live} target="_blank" rel="noreferrer">
              Open on claude.ai
            </LinkButton>
          )}
          {canFull && (
            <Button size="sm" onClick={() => void frame.current?.requestFullscreen().catch(() => undefined)}>
              Full screen
            </Button>
          )}
        </header>
        <HtmlPage ref={frame} slug={w.slug} name={current.name} />
      </section>
    </div>
  );
}
