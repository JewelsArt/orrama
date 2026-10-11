/** Focus inside a modal layer: what can take it, and where Tab goes next. */

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** The controls in `box` a keyboard can reach, in order (hidden ones left out). */
export function focusables(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e.getClientRects().length > 0);
}

/**
 * Where Tab should go: from outside the box, to its first (or, with Shift, last) control; from
 * the last control, around to the first and back. Null means "let the browser move focus".
 */
export function wrapFocus(count: number, index: number, backwards: boolean): number | null {
  if (count === 0) return null;
  if (index === -1) return backwards ? count - 1 : 0;
  if (!backwards && index === count - 1) return 0;
  if (backwards && index === 0) return count - 1;
  return null;
}

/** Move focus into `box`: its [autofocus] control, else its first control, else the box. */
export function focusInto(box: HTMLElement): void {
  if (box.contains(document.activeElement)) return;
  (box.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? focusables(box)[0] ?? box).focus();
}

/** One Tab keypress inside a trapped box: wraps at the ends, never leaves the box. */
export function trapTab(e: KeyboardEvent, box: HTMLElement): void {
  if (e.key !== "Tab") return;
  const list = focusables(box);
  if (list.length === 0) {
    e.preventDefault();
    box.focus();
    return;
  }
  const next = wrapFocus(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey);
  if (next !== null) {
    e.preventDefault();
    list[next]!.focus();
  }
}
