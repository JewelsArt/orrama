import { useEffect, useRef, type HTMLAttributes } from "react";

/**
 * A modal's box: focus moves into it when it opens, Tab and Shift-Tab stay
 * inside it, and focus goes back to whatever opened it when it closes.
 *
 * The app's modals were plain divs over a backdrop. Opening one left focus on
 * the page behind, so a keyboard user tabbed through the hidden page instead
 * of the dialog, and closing it dropped focus on <body>.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Where Tab should go: from outside the dialog, to its first (or, with Shift,
 * last) control; from the last control, around to the first and back. Null
 * means "let the browser move focus normally".
 */
export function wrapFocus(count: number, index: number, backwards: boolean): number | null {
  if (count === 0) return null;
  if (index === -1) return backwards ? count - 1 : 0;
  if (!backwards && index === count - 1) return 0;
  if (backwards && index === 0) return count - 1;
  return null;
}

export function Dialog({
  label,
  role = "dialog",
  onClick,
  children,
  ...rest
}: { label: string; role?: "dialog" | "alertdialog" } & HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () => [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e.getClientRects().length > 0);
    if (!box.contains(document.activeElement)) (box.querySelector<HTMLElement>("[autofocus]") ?? controls()[0] ?? box).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = controls();
      const next = wrapFocus(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (list.length === 0) {
        e.preventDefault();
        box.focus();
      } else if (next !== null) {
        e.preventDefault();
        list[next]!.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <div
      ref={ref}
      role={role}
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation(); // a click inside is not a click on the backdrop
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
