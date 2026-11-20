/**
 * What every piece of the Me page shares: the persona, its links, which things are lit, and the
 * one way to open something (the panel beside the page). Everything you can see opens its thing.
 */
import { createContext, useContext } from "react";
import type { Persona } from "@orrama/schema/responses";
import type { PersonaGraph } from "@orrama/core/persona-graph";

export interface MeShared {
  p: Persona;
  g: PersonaGraph;
  lanes: string[];
  /** The keys lit by what the pointer is on, or null when nothing is. */
  lit: ReadonlySet<string> | null;
  light: (key: string | null) => void;
  /** Open a thing in the panel: `project:…`, `exp:…`, `skill:…`, `proof:…`, `person:…`, `question:<index>`, `write:<about>`. */
  open: (key: string) => void;
  /** A draft under review: nothing writes to a note yet. */
  draft: boolean;
  /** Its id, for Introduce me and Write as me while it is reviewed (they write from the draft). */
  draftId: string | null;
  /** A mailbox is connected: "Use in an email" can open the composer. */
  mail: boolean;
  ai: boolean;
  /** Open the persona note in Notes. */
  openNote: () => void;
}

export const MeContext = createContext<MeShared | null>(null);

export function useMe(): MeShared {
  const v = useContext(MeContext);
  if (!v) throw new Error("useMe outside the Me page");
  return v;
}

/** The class and pointer handlers that make a thing light what it connects to. */
export function useLink(key: string) {
  const { lit, light, open } = useMe();
  return {
    className: lit ? (lit.has(key) ? "lit" : "faded") : "",
    onPointerEnter: () => light(key),
    onFocus: () => light(key),
    // Tabbing away un-lights it: a highlight never outlives what it was about.
    onBlur: () => light(null),
    onClick: () => open(key),
    "data-key": key,
  };
}
