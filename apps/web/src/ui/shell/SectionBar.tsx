/**
 * A page's own sections, handed to the shell (Clay, 19 October 2026).
 *
 * Clay has two navs, as in the Vertix reel: the places on the left, and a page's sections
 * (Money's tabs, a project's tabs, Planning's Day · Week · Month, the areas on Projects) in a
 * white pill bar at the top, the current one black. Paper keeps them where they have always
 * been. A page says what its sections are once, by wrapping them in <SectionBar>: in Paper they
 * render in place; in Clay they render into the shell's top bar (a portal, so the page keeps
 * its state, its handlers and its keys). Nothing else about the page changes.
 *
 * Outside a shell (a page rendered alone in a test) they render in place.
 */
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Look } from "../theme.js";

export interface ShellLook {
  look: Look;
  /** The top bar's slot for a page's sections: only in Clay, and null while it is not on screen. */
  slot: HTMLElement | null;
}

export const ShellLookContext = createContext<ShellLook>({ look: "paper", slot: null });

/** Paper or Clay, as the shell around this page draws it. */
export const useLook = (): Look => useContext(ShellLookContext).look;

export function SectionBar({ children }: { children: ReactNode }) {
  const { slot } = useContext(ShellLookContext);
  if (slot) return createPortal(children, slot);
  return <>{children}</>;
}
