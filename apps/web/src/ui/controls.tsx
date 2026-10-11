/**
 * The small parts of Orrama's system (structure.md §6): buttons, text tabs, the segmented
 * switch, chips, the four-state checkbox, rings and squares, the progress ring, the bar, the
 * keycap, a name inside a sentence. Classes are the board's (ui.css); hover, focus and active
 * states come with them.
 */
import { forwardRef, useRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";
import { HeadMark } from "./orr/Orr.js";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* 1 · Button --------------------------------------------------------------------------------- */

export interface ButtonLook {
  /** solid: the main action, in Orr's gradient · quiet: no box until you point at it */
  kind?: "default" | "solid" | "quiet";
  size?: "md" | "sm";
  icon?: IconName;
  danger?: boolean;
  /** Orr's own action (his proposal, his draft): his head, and his warm wash. */
  orr?: boolean;
}

const buttonClass = ({ kind = "default", size = "md", danger }: ButtonLook, iconOnly: boolean, extra?: string) =>
  cx("btn", kind !== "default" && kind, size === "sm" && "sm", iconOnly && "icon", danger && "danger", extra);

const buttonInside = ({ icon, orr }: ButtonLook, children: ReactNode) => (
  <>
    {orr && <HeadMark size={16} />}
    {icon && <Icon name={icon} size={16} />}
    {children}
  </>
);

/** A button. An icon-only button needs an aria-label (and gets a tooltip from `tip`). */
export const Button = forwardRef<HTMLButtonElement, ButtonLook & ButtonHTMLAttributes<HTMLButtonElement> & { tip?: string }>(function Button(
  { kind, size, icon, danger, orr, tip, className, children, type = "button", ...rest },
  ref,
) {
  const look = { kind, size, icon, danger, orr };
  return (
    <button ref={ref} type={type} className={buttonClass(look, !children, className)} data-tip={tip} {...rest}>
      {buttonInside(look, children)}
    </button>
  );
});

/** The same look on a link, for things that go somewhere. */
export const LinkButton = forwardRef<HTMLAnchorElement, ButtonLook & AnchorHTMLAttributes<HTMLAnchorElement>>(function LinkButton(
  { kind, size, icon, danger, orr, className, children, ...rest },
  ref,
) {
  const look = { kind, size, icon, danger, orr };
  return (
    <a ref={ref} className={buttonClass(look, !children, className)} {...rest}>
      {buttonInside(look, children)}
    </a>
  );
});

/* 2 · Text tabs, and the segmented switch ---------------------------------------------------- */

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number | string;
  /** An address: the tab is a link, and a click is a navigation the app handles. */
  href?: string;
}

/** Arrow keys between sibling controls in a group, wrapping; Home and End. */
function arrowTo(e: KeyboardEvent<HTMLElement>, selector: string, vertical = false): HTMLElement | null {
  const list = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)];
  const i = list.indexOf(document.activeElement as HTMLElement);
  const next = vertical ? "ArrowDown" : "ArrowRight";
  const prev = vertical ? "ArrowUp" : "ArrowLeft";
  const to = e.key === next ? (i + 1) % list.length : e.key === prev ? (i - 1 + list.length) % list.length : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : -1;
  if (to < 0 || list.length === 0) return null;
  e.preventDefault();
  list[to]!.focus();
  return list[to]!;
}

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** Page tabs (a project's Overview · Timeline · Documents · To-do). The current one is underlined in Orr's orange. */
export function Tabs<T extends string>({ items, value, onChange, label, bare }: { items: TabItem<T>[]; value: T; onChange: (id: T) => void; label: string; bare?: boolean }) {
  return (
    <div
      className={cx("tabs", bare && "bare")}
      role="tablist"
      aria-label={label}
      onKeyDown={(e) => {
        const el = arrowTo(e, '[role="tab"]');
        const id = el?.dataset.id as T | undefined;
        if (id) onChange(id);
      }}
    >
      {items.map((t) => {
        const on = t.id === value;
        const inside = (
          <>
            {t.label}
            {t.count !== undefined && <span className="n">{t.count}</span>}
          </>
        );
        const common = { role: "tab", "aria-selected": on, tabIndex: on ? 0 : -1, "data-id": t.id } as const;
        return t.href ? (
          <a
            key={t.id}
            {...common}
            className={on ? "on" : undefined}
            href={t.href}
            onClick={(e) => {
              if (!plainClick(e)) return;
              e.preventDefault();
              onChange(t.id);
            }}
          >
            {inside}
          </a>
        ) : (
          <button key={t.id} type="button" {...common} onClick={() => onChange(t.id)}>
            {inside}
          </button>
        );
      })}
    </div>
  );
}

/** One of a few views of the same thing (Lanes / Hours; Day · Week · Month). Drawn as text tabs, as on the boards. */
export function Segmented<T extends string>({ items, value, onChange, label }: { items: { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div
      className="tabs bare"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        const el = arrowTo(e, '[role="radio"]');
        const id = el?.dataset.id as T | undefined;
        if (id) onChange(id);
      }}
    >
      {items.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={t.id === value} tabIndex={t.id === value ? 0 : -1} data-id={t.id} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* 8 · Chips ---------------------------------------------------------------------------------- */

/** A filter: an area's dot and name, a status word, a type. Every chip filters (§1.7 #5). */
export function Chip({ dot, on, onClick, children, title }: { dot?: string; on?: boolean; onClick?: () => void; children: ReactNode; title?: string }) {
  return (
    <button type="button" className={cx("chip", on && "on")} aria-pressed={on} onClick={onClick} title={title}>
      {dot && <span className="ui-dot" style={{ background: dot }} />}
      {children}
    </button>
  );
}

/** The key deadline: the one red fill in the app. */
export const DeadlineChip = ({ children, small }: { children: ReactNode; small?: boolean }) => <span className={cx("chip-dl", small && "s")}>{children}</span>;

/** The ontology's status words, each with its dot (structure.md §2.4). */
export type StatusWord = "planned" | "on track" | "at risk" | "paused" | "completed" | "archived" | "cancelled";
export const Status = ({ value }: { value: StatusWord }) => <span className={cx("status", value.replace(" ", "-"))}>{value}</span>;

/** A small dot in an area's colour. */
export const Dot = ({ color, label }: { color: string; label?: string }) => (
  <span className="ui-dot" style={{ background: color }} {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })} />
);

/* 7 · Checkbox: open · in progress · blocked · done ------------------------------------------- */

export type TaskState = "open" | "progress" | "blocked" | "done";
const CB_CLASS: Record<TaskState, string> = { open: "", progress: "prog", blocked: "block", done: "done" };
const CB_ARIA: Record<TaskState, "true" | "false" | "mixed"> = { open: "false", progress: "mixed", blocked: "false", done: "true" };

/** The task checkbox, one drawing for the four states of the vault's checkboxes. */
export function Checkbox({ state, onToggle, label }: { state: TaskState; onToggle?: () => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={CB_ARIA[state]}
      aria-label={state === "blocked" ? `${label} (blocked)` : label}
      className={cx("cb", CB_CLASS[state])}
      onClick={(e) => {
        e.stopPropagation(); // ticking a row's box does not open the row
        onToggle?.();
      }}
    />
  );
}

/* 9 · Ring (person), square (company), progress ring (project) ------------------------------ */

/** Words that start a surname, not end one: "Bas de Wit" is BW, not Bd. */
const PARTICLES = new Set(["de", "den", "der", "van", "von", "te", "ten", "ter", "la", "le", "du", "da", "di", "del", "dos", "das", "'t", "het", "op", "in", "of", "and", "&"]);

/** Two letters for a name: its first word and its last real one, upper case (§2.7). */
export function initials(name: string): string {
  const words = name
    .replace(/\[\[|\]\]/g, "")
    .split(/[\s\-_.]+/)
    .filter((w) => w && !PARTICLES.has(w.toLowerCase()) && /\p{L}/u.test(w));
  if (words.length === 0) return "?";
  const first = [...words[0]!].find((c) => /\p{L}/u.test(c)) ?? "";
  if (words.length === 1) return first.toUpperCase();
  const last = [...words[words.length - 1]!].find((c) => /\p{L}/u.test(c)) ?? "";
  return (first + last).toUpperCase();
}

/** A person: their initials in a ring. */
export const Ring = ({ name, small }: { name: string; small?: boolean }) => (
  <span className={cx("ring", small && "sm")} aria-hidden="true">
    {initials(name)}
  </span>
);

/** A company: its initials in a square, so it never looks like a colleague. */
export const Square = ({ name, small }: { name: string; small?: boolean }) => (
  <span className={cx("sq", small && "sm")} aria-hidden="true">
    {initials(name)}
  </span>
);

/** A project's progress, 0–1, as a ring in Orr's orange. */
export function ProgressRing({ value, size = 30, label }: { value: number; size?: number; label?: string }) {
  const c = 2 * Math.PI * 11;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg className="pr" viewBox="0 0 30 30" width={size} height={size} {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      <circle className="t" cx="15" cy="15" r="11" />
      {v > 0 && <circle className="v" cx="15" cy="15" r="11" strokeDasharray={`${(v * c).toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 15 15)" />}
    </svg>
  );
}

/* 30 · Bar · 32 · Keycap · a name in a sentence ---------------------------------------------- */

/** Pace or progress, 0–1, with an optional marker (where a typical month sits). */
export function Bar({ value, marker, label }: { value: number; marker?: number; label?: string }) {
  const pct = (n: number) => `${Math.max(0, Math.min(1, n)) * 100}%`;
  return (
    <div className="ui-bar" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <i style={{ width: pct(value) }} />
      {marker !== undefined && <u style={{ left: pct(marker) }} />}
    </div>
  );
}

// A span, not <kbd>: older stylesheets still style the bare element.
export const Kbd = ({ children }: { children: ReactNode }) => <span className="kbd">{children}</span>;

/** A name inside a sentence ("Both wait on Thijs Brouwer"): it opens the thing (§1.7 #1). */
export function NameLink({ href, onOpen, children }: { href?: string; onOpen?: () => void; children: ReactNode }) {
  const ref = useRef<HTMLAnchorElement>(null);
  return (
    <a
      ref={ref}
      className="ui-nm"
      href={href ?? "#"}
      onClick={(e) => {
        if (!onOpen || !plainClick(e)) return;
        e.preventDefault();
        onOpen();
      }}
    >
      {children}
    </a>
  );
}
