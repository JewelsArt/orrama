/**
 * Overlays: four kinds and one stacking rule (structure.md §1.4).
 *
 *   palette  ⌘K, centred in the top third (full screen on the phone)
 *   dialog   a decision: confirm, delete, a name; centred and small (a bottom sheet on the phone)
 *   sheet    something you look at without leaving: slides in from the right, 480 px
 *   panel    Ask Orr, beside the page
 *
 * Stacking, top to bottom: palette, dialog, sheet, panel (popovers and menus float above all
 * four). Opening one of a kind replaces the one of that kind already open. Escape always
 * closes the top one, and only that one. A modal layer takes focus when it opens, keeps Tab
 * inside, and gives focus back to whatever opened it when it closes.
 *
 * Before this there were eight overlay systems and ten modal styles, Escape worked in some and
 * not others, and ⌘K opened from Settings appeared under it (WEB-018).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { focusInto, trapTab } from "./focus.js";

export type LayerKind = "panel" | "sheet" | "dialog" | "palette" | "popover";
const RANK: Record<LayerKind, number> = { panel: 0, sheet: 1, dialog: 2, palette: 3, popover: 4 };

interface Entry {
  id: number;
  kind: LayerKind;
  seq: number;
  trap: boolean;
  opener: HTMLElement | null;
  close: () => void;
  box: () => HTMLElement | null;
}

const layers = new Map<number, Entry>();
let seq = 0;
let ids = 0;
const watchers = new Set<() => void>();
const changed = () => {
  for (const w of watchers) w();
};

/** The layer Escape closes: the highest kind, and of that kind the most recently opened. */
export function topLayer(): { id: number; kind: LayerKind } | undefined {
  let best: Entry | undefined;
  for (const l of layers.values()) if (!best || RANK[l.kind] > RANK[best.kind] || (RANK[l.kind] === RANK[best.kind] && l.seq > best.seq)) best = l;
  return best && { id: best.id, kind: best.kind };
}

/** Is any overlay open? The shell's own keys stand down while one is. */
export const anyLayerOpen = () => layers.size > 0;

/** Re-render when layers open or close. */
export function useLayersOpen(): number {
  return useSyncExternalStore(
    (cb) => {
      watchers.add(cb);
      return () => watchers.delete(cb);
    },
    () => layers.size,
  );
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  // Capture on window: the first listener to see the key, before any page's own Escape or Tab
  // handling, so a dialog over the note closes the dialog and leaves the note open.
  window.addEventListener(
    "keydown",
    (e) => {
      const top = topLayer();
      if (!top) return;
      const entry = layers.get(top.id)!;
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        entry.close();
      } else if (e.key === "Tab" && entry.trap) {
        const box = entry.box();
        if (box) trapTab(e, box);
      }
    },
    true,
  );
}

export interface LayerOptions {
  kind: LayerKind;
  /** Called when Escape, the scrim, or a newer layer of the same kind closes this one. */
  onClose: () => void;
  box: RefObject<HTMLElement | null>;
  /** Keep Tab inside (the modal kinds). */
  trap?: boolean;
  /** Move focus in on open (default true). */
  focus?: boolean;
  /** Give focus back to the opener on close (default true). */
  restore?: boolean;
}

/**
 * Register an open layer. Mount it while the layer is open; unmounting closes it. Returns the
 * layer's id.
 */
export function useLayer({ kind, onClose, box, trap = false, focus = true, restore = true }: LayerOptions): number {
  const close = useRef(onClose);
  close.current = onClose;
  const [id] = useState(() => ++ids);
  useLayoutEffect(() => {
    listen();
    let opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    // One of a kind: a newer layer replaces the open one. If it was opened from inside the one
    // it replaces, it inherits that one's opener, so closing it still lands somewhere real.
    for (const l of [...layers.values()]) {
      if (l.kind !== kind) continue;
      if (opener && l.box()?.contains(opener)) opener = l.opener;
      l.close();
    }
    layers.set(id, { id, kind, seq: ++seq, trap, opener, close: () => close.current(), box: () => box.current });
    changed();
    if (focus && box.current) focusInto(box.current);
    return () => {
      const entry = layers.get(id);
      layers.delete(id);
      changed();
      if (!restore || !entry?.opener?.isConnected) return;
      // Only when focus would otherwise be lost: inside the closing layer, or nowhere. If a
      // newer layer already has it, leave it there.
      const at = document.activeElement;
      const lost = !at || at === document.body || !at.isConnected || !!entry.box()?.contains(at) || !!box.current?.contains(at);
      if (lost) entry.opener.focus();
    };
    // kind, trap, focus and restore are fixed for a layer's life
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return id;
}

interface LayerProps {
  kind: LayerKind;
  onClose: () => void;
  /** The accessible name of the dialog. */
  label: string;
  children: ReactNode;
  className?: string;
  /** Draw the scrim behind (closes on click). */
  scrim?: boolean;
  /** "dialog" (default), "alertdialog", or null for a wrapper whose content already is one. */
  role?: "dialog" | "alertdialog" | null;
  modal?: boolean;
  trap?: boolean;
}

/**
 * A layer in a portal at the end of <body>. Used directly to give an existing overlay (the
 * search palette, quick capture, Settings) its place in the stack, its Escape and its focus
 * rules; Dialog, Sheet and Palette below are this with the system's boxes.
 */
export function Layer({ kind, onClose, label, children, className, scrim = false, role = "dialog", modal = true, trap = modal }: LayerProps) {
  const box = useRef<HTMLDivElement>(null);
  useLayer({ kind, onClose, box, trap });
  return createPortal(
    <div className="ui-layer" data-kind={kind}>
      {scrim && <div className="ui-scrim" onClick={onClose} aria-hidden="true" />}
      <div
        ref={box}
        className={className ?? "ui-bare"}
        tabIndex={-1}
        {...(role ? { role, "aria-modal": modal ? "true" : undefined, "aria-label": label } : {})}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

const TitleId = createContext<string | undefined>(undefined);

/** A decision: confirm, delete, a new note's name. */
export function Dialog({
  title,
  onClose,
  children,
  actions,
  role = "dialog",
  className,
}: {
  title: string;
  onClose: () => void;
  children?: ReactNode;
  /** The buttons, right-aligned at the foot. */
  actions?: ReactNode;
  role?: "dialog" | "alertdialog";
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayer({ kind: "dialog", onClose, box, trap: true });
  return createPortal(
    <div className="ui-layer" data-kind="dialog">
      <div className="ui-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={box} role={role} aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={`ui dialog${className ? ` ${className}` : ""}`}>
        <h2 id={titleId}>{title}</h2>
        <TitleId.Provider value={titleId}>{children}</TitleId.Provider>
        {actions && <div className="acts">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Something to look at without leaving the page: the task card, a document, a person. */
export function Sheet({
  title,
  onClose,
  children,
  head,
  className,
}: {
  title: string;
  onClose: () => void;
  children?: ReactNode;
  /** Extra controls in the header, before the close button. */
  head?: ReactNode;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayer({ kind: "sheet", onClose, box, trap: true });
  return createPortal(
    <div className="ui-layer" data-kind="sheet">
      <div className="ui-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={`ui ui-sheet${className ? ` ${className}` : ""}`}>
        <header className="ui-sheet-head">
          <h2 id={titleId}>{title}</h2>
          {head}
          <button type="button" className="btn quiet icon" onClick={onClose} aria-label="Close">
            <svg className="i" viewBox="0 0 20 20" aria-hidden="true" width="16" height="16">
              <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
            </svg>
          </button>
        </header>
        <div className="ui-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** The ⌘K box: a dialog of its own kind, above every other layer. */
export function Palette({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useLayer({ kind: "palette", onClose, box, trap: true });
  return createPortal(
    <div className="ui-layer" data-kind="palette">
      <div className="ui-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={box} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className="ui ui-palette">
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * A box floating by `anchor` (a menu, a picker). Closes on Escape and on a click outside;
 * focus moves in, and back to the anchor when it closes.
 */
export function Popover({
  anchor,
  onClose,
  label,
  children,
  className = "popover",
  role = "dialog",
  align = "start",
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  children: ReactNode;
  className?: string;
  role?: "dialog" | "menu" | "listbox";
  align?: "start" | "end";
}) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  useLayer({ kind: "popover", onClose, box, trap: false });
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const b = box.current?.getBoundingClientRect();
    if (!a || !b) return;
    const below = a.bottom + 6;
    const top = below + b.height > window.innerHeight - 8 && a.top - 6 - b.height > 8 ? a.top - 6 - b.height : below;
    const left = align === "end" ? a.right - b.width : a.left;
    setAt({ top, left: Math.max(8, Math.min(left, window.innerWidth - b.width - 8)) });
  }, [anchor, align]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={box}
      className={`ui ui-layer ${className}`}
      data-kind="popover"
      role={role}
      aria-label={label}
      tabIndex={-1}
      style={at ? { top: at.top, left: at.left } : { top: 0, left: 0, visibility: "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

/** A list of actions under a button. Arrow keys move, Enter picks, Escape closes. */
export function Menu({ anchor, onClose, label, items, align }: { anchor: RefObject<HTMLElement | null>; onClose: () => void; label: string; items: (MenuItem | "-")[]; align?: "start" | "end" }) {
  const move = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const list = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === "ArrowDown" ? (i + 1) % list.length : e.key === "ArrowUp" ? (i - 1 + list.length) % list.length : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : null;
    if (to === null) {
      if (e.key === "Tab") onClose();
      return;
    }
    e.preventDefault();
    list[to]?.focus();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} label={label} className="menu" role="menu" align={align}>
      <div onKeyDown={move} style={{ display: "contents" }}>
        {items.map((it, i) =>
          it === "-" ? (
            <hr key={`-${i}`} />
          ) : (
            <button
              key={it.label}
              type="button"
              role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={it.checked}
              className={it.danger ? "danger" : undefined}
              disabled={it.disabled}
              onClick={() => {
                onClose();
                it.onSelect();
              }}
            >
              {it.icon}
              {it.label}
            </button>
          ),
        )}
      </div>
    </Popover>
  );
}

/* ---- toasts: short news that takes no focus and asks nothing --------------------------- */

export interface ToastItem {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}
let toasts: ToastItem[] = [];
const toastWatchers = new Set<() => void>();
let toastIds = 0;
const toastsChanged = () => {
  for (const w of toastWatchers) w();
};

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  toastsChanged();
}

/** Say something briefly ("Saved", "Moved to Friday · Undo"). Gone after `ms`. */
export function toast(text: string, opts: { action?: ToastItem["action"]; ms?: number } = {}): number {
  const id = ++toastIds;
  toasts = [...toasts.slice(-2), { id, text, action: opts.action }];
  toastsChanged();
  setTimeout(() => dismissToast(id), opts.ms ?? 5000);
  return id;
}

/** Where toasts appear. Mounted once by the shell. */
export function Toaster() {
  const list = useSyncExternalStore(
    useCallback((cb: () => void) => {
      toastWatchers.add(cb);
      return () => toastWatchers.delete(cb);
    }, []),
    () => toasts,
  );
  return createPortal(
    <div className="ui ui-toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                dismissToast(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="btn sm x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <svg className="i" viewBox="0 0 20 20" aria-hidden="true" width="14" height="14">
              <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
            </svg>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** For content inside a Dialog that wants to point at its title (aria-describedby etc.). */
export const useDialogTitleId = () => useContext(TitleId);
