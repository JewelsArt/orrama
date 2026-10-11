/**
 * The keys (structure.md §1.5), decided in one pure function so the rules can be tested:
 *
 *   1–8      the eight places, in rail order
 *   ⌘K / ⌘J  Find / Ask Orr (from anywhere, typing included)
 *   c        capture
 *   ⌘,       Settings (the macOS convention)
 *   ⌘[ / ⌘←  back
 *   ?        the sheet listing every key
 *   Esc      closes the top layer (the overlay stack, ui/overlays.tsx)
 *   ⌘R       reload (main.tsx, outside React, so it works even when a view has crashed)
 *   ← →      previous / next on a dated page (each such page, with isTyping below)
 *
 * ⌘ is Ctrl off a Mac. Single keys never fire while you type, and the shell's keys stand
 * down while an overlay is open (Escape is the way out of one).
 *
 * WEB-003: ⌘← and ⌘[ used to go back even while typing, before any "are you in a field?"
 * check: ⌘← (line start) and ⌘[ (outdent) left the note, and in the Mail composer ⌘←
 * unmounted Mail and the unsent message with it. Back now needs focus outside anything you
 * type in, an event nobody handled already (CodeMirror marks the keys it uses), and no Shift
 * (⌘⇧← selects to the line start) or Alt.
 */
import { PLACES, type Place } from "./router.js";

export type ShellAction =
  | { kind: "place"; place: Place }
  | { kind: "find" }
  | { kind: "ask" }
  | { kind: "capture" }
  | { kind: "settings" }
  | { kind: "back" }
  | { kind: "keys" };

const TEXT_INPUTS = new Set(["", "text", "search", "email", "password", "url", "tel", "number", "date", "time", "datetime-local", "month", "week"]);

/** Is this element somewhere you type: a text field, a select, contenteditable, the editor? */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") return TEXT_INPUTS.has(((el as HTMLInputElement).type ?? "").toLowerCase());
  if (el.isContentEditable) return true;
  return !!el.closest(".cm-editor, [contenteditable='true'], [contenteditable='']");
}

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}

/** What the shell does for a key, or null when the key is not the shell's. */
export function shellKey(e: KeyLike, typing: boolean, layerOpen: boolean): ShellAction | null {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey && !e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === "k") return { kind: "find" };
    if (k === "j") return { kind: "ask" };
    if (e.key === ",") return layerOpen ? null : { kind: "settings" };
    if (e.key === "[" || e.key === "ArrowLeft") return typing || layerOpen || e.defaultPrevented ? null : { kind: "back" };
    return null;
  }
  if (mod || e.altKey || typing || layerOpen || e.defaultPrevented) return null;
  if (e.key === "c") return { kind: "capture" };
  if (e.key === "?") return { kind: "keys" };
  const place = PLACES.find((p) => p.key === e.key);
  return place ? { kind: "place", place: place.place } : null;
}

/** The table the ? sheet shows: what you press, and what it does. */
export const KEY_TABLE: [keys: string, does: string][] = [
  ["1 – 8", "Today, Planning, Notes, Orrery, Projects, People, Mail, Money"],
  ["⌘K", "Find"],
  ["⌘J", "Ask Orr"],
  ["c", "Capture a line into your inbox"],
  ["⌘,", "Settings"],
  ["⌘[  ⌘←", "Back"],
  ["⌘R", "Reload"],
  ["← →", "Previous / next, on a dated page (Planning, Money's months)"],
  ["Esc", "Close the top layer"],
  ["?", "This list"],
];
