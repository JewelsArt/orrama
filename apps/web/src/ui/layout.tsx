/**
 * Boxes and rows (structure.md §6 #4–6, #29): the page header and its breadcrumb, the module (a
 * white box on the paper ground with its heading inside), the plain card, and the row, which is
 * a target across its whole width with arrow keys between rows (§1.7 #7).
 */
import { type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Icon } from "./Icon.js";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export interface Crumb {
  label: string;
  href?: string;
  onOpen?: () => void;
}

/** `Projects › Graduation thesis › Timeline`: every step but the last is a link back. */
export function Crumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={`${c.label}-${i}`} style={{ display: "contents" }}>
            {last ? (
              <span aria-current="page">{c.label}</span>
            ) : (
              <a
                href={c.href ?? "#"}
                onClick={(e) => {
                  if (!c.onOpen || !plainClick(e)) return;
                  e.preventDefault();
                  c.onOpen();
                }}
              >
                {c.label}
              </a>
            )}
            {!last && <Icon name="chev-r" size={14} />}
          </span>
        );
      })}
    </nav>
  );
}

/** A page's title row: title, quiet meta beside it, actions on the right, a breadcrumb above. */
export function PageHeader({ title, meta, crumbs, actions }: { title: ReactNode; meta?: ReactNode; crumbs?: Crumb[]; actions?: ReactNode }) {
  return (
    <header>
      {crumbs && crumbs.length > 0 && <Crumbs items={crumbs} />}
      <div className="phead">
        <h1>{title}</h1>
        {meta && <span className="meta">{meta}</span>}
        <span className="sp" />
        {actions}
      </div>
    </header>
  );
}

/**
 * A module: a rule, a heading with its count, a link to the place it summarises, then rows.
 * The heading and the count are links when they lead somewhere (§1.7 #2: every count opens the
 * list it counts).
 */
export function Module({
  title,
  titleHref,
  onTitle,
  count,
  onCount,
  link,
  children,
  className,
  label,
}: {
  title: string;
  titleHref?: string;
  onTitle?: () => void;
  count?: ReactNode;
  onCount?: () => void;
  link?: { label: string; href?: string; onOpen?: () => void };
  children?: ReactNode;
  className?: string;
  label?: string;
}) {
  const go = (fn?: () => void) => (e: MouseEvent) => {
    if (!fn || !plainClick(e)) return;
    e.preventDefault();
    fn();
  };
  return (
    <section className={cx("mod", className)} aria-label={label ?? title}>
      <div className="mh">
        <h2>
          {titleHref || onTitle ? (
            <a href={titleHref ?? "#"} onClick={go(onTitle)}>
              {title}
            </a>
          ) : (
            title
          )}
        </h2>
        {count !== undefined &&
          (onCount ? (
            <a className="c" href="#" onClick={go(onCount)}>
              {count}
            </a>
          ) : (
            <span className="c">{count}</span>
          ))}
        {link && (
          <a className="go" href={link.href ?? "#"} onClick={go(link.onOpen)}>
            {link.label}
          </a>
        )}
      </div>
      {children}
    </section>
  );
}

/** A plain white box on the ground. */
export const Card = ({ children, className }: { children: ReactNode; className?: string }) => <div className={cx("card", className)}>{children}</div>;

/** A group heading inside a module ("Late 3"). */
export const Group = ({ children, count, late }: { children: ReactNode; count?: ReactNode; late?: boolean }) => (
  <div className={cx("grp", late && "late")}>
    {children}
    {count !== undefined && <span className="c">{count}</span>}
  </div>
);

/**
 * A row: lead (a checkbox, a ring, a date), title and meta, and what trails (a time, an amount;
 * `hover` actions replace it under the pointer). The whole width opens it; Enter too.
 */
export function Row({
  lead,
  title,
  meta,
  trailing,
  late,
  hover,
  href,
  onOpen,
  titleAttr,
  className,
}: {
  lead?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  /** The trailing text in red: this is late. */
  late?: boolean;
  /** Secondary actions, shown at the row's end on hover. */
  hover?: ReactNode;
  href?: string;
  onOpen?: () => void;
  /** The whole title, for when it is cut short. */
  titleAttr?: string;
  className?: string;
}) {
  const body = (
    <>
      <span className="lead">{lead}</span>
      <span className="x">
        <span className="t">{title}</span>
        {meta && <span className="m">{meta}</span>}
      </span>
      {(trailing !== undefined || hover) && (
        <span className="end">
          {trailing !== undefined && <span className={cx("r", late && "late", !!hover && "hide-h")}>{trailing}</span>}
          {hover && <span className="hov">{hover}</span>}
        </span>
      )}
    </>
  );
  if (href !== undefined)
    return (
      <a
        className={cx("row", className)}
        href={href}
        title={titleAttr}
        data-row=""
        onClick={(e) => {
          if (!onOpen || !plainClick(e)) return;
          e.preventDefault();
          onOpen();
        }}
      >
        {body}
      </a>
    );
  return (
    <div
      className={cx("row", className)}
      role="button"
      tabIndex={0}
      title={titleAttr}
      data-row=""
      onClick={() => onOpen?.()}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return; // keys inside a nested control are its own
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.();
        }
      }}
    >
      {body}
    </div>
  );
}

/** Rows that arrow keys move between (§1.7 #7). */
export function RowList({ children, label }: { children: ReactNode; label?: string }) {
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-row]")];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const to = rows[e.key === "ArrowDown" ? i + 1 : i - 1];
    if (!to) return;
    e.preventDefault();
    to.focus();
  };
  return (
    <div className="rows" role={label ? "group" : undefined} aria-label={label} onKeyDown={move}>
      {children}
    </div>
  );
}
