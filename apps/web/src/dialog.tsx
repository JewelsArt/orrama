import { useEffect, useRef, type HTMLAttributes, type RefObject } from "react";
import { focusInto, trapTab } from "./ui/focus.js";
import { useLayer } from "./ui/overlays.js";

export { wrapFocus } from "./ui/focus.js";

/**
 * A modal's box, for the screens that still draw their own: focus moves into it
 * when it opens, Tab and Shift-Tab stay inside it, and focus goes back to
 * whatever opened it when it closes.
 *
 * New work uses the system's Dialog and Sheet (ui/overlays.tsx), which draw the
 * box too. A screen that keeps this one passes `onEscape` to put it in the same
 * stack: Escape then closes it the way it closes every other layer, and only
 * when it is the top one (WEB-018).
 */
export function Dialog({
  label,
  role = "dialog",
  onClick,
  onEscape,
  children,
  ...rest
}: { label: string; role?: "dialog" | "alertdialog"; onEscape?: () => void } & HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusInto(box);
    const onKey = (e: KeyboardEvent) => trapTab(e, box);
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
      {onEscape && <EscapeLayer box={ref} onEscape={onEscape} />}
      {children}
    </div>
  );
}

/** Joins the overlay stack for Escape only: the box above traps Tab and restores focus itself. */
function EscapeLayer({ box, onEscape }: { box: RefObject<HTMLDivElement | null>; onEscape: () => void }) {
  useLayer({ kind: "dialog", onClose: onEscape, box, trap: false, focus: false, restore: false });
  return null;
}
