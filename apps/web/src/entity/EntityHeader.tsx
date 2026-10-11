/**
 * The entity page's header (structure.md §2.5–2.6, §6 #28): the breadcrumb, a lead (a project's
 * progress ring, a person's ring, a company's square, a document's type), the title, one line
 * of meta, and the actions. One row on the desktop; on the phone the meta wraps under the title
 * and the actions leave for the top bar's ⋯ (the page passes them to `phoneActions` too, or
 * keeps them in its own menu).
 *
 * Built for the project page first; R11's person, company, conversation and document pages use
 * the same header with their own lead, meta and actions.
 */
import { type ReactNode } from "react";
import { Crumbs, type Crumb } from "../ui/layout.js";

export function EntityHeader({
  crumbs,
  lead,
  title,
  meta,
  actions,
}: {
  crumbs?: Crumb[];
  /** 44 px on the desktop, 36 on the phone. */
  lead?: ReactNode;
  title: ReactNode;
  /** The quiet line under the title: status, dates, area, counts. Items wrap. */
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="ent-head">
      {crumbs && crumbs.length > 0 && <Crumbs items={crumbs} />}
      <div className={`ent-id${lead ? "" : " no-lead"}`}>
        {lead && <span className="ent-lead">{lead}</span>}
        <div className="ent-x">
          <h1>{title}</h1>
          {meta && <div className="ent-meta">{meta}</div>}
        </div>
        {actions && <div className="ent-acts">{actions}</div>}
      </div>
    </header>
  );
}
