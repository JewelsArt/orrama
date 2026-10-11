/** Money's small pieces of state: the Month | Year switch, and ← → between months. */
import { useEffect, useRef, useState } from "react";
import { readKey, writeKey } from "../storage.js";
import { isTyping } from "../ui/keys.js";
import { anyLayerOpen } from "../ui/overlays.js";
import { monthStep } from "./model.js";

export type Grain = "month" | "year";
const GRAIN_KEY = "basalt-fin-grain";

/** Month or Year, remembered on this device; the default works when storage does not. */
export function useGrain(): [Grain, (g: Grain) => void] {
  const [grain, setGrain] = useState<Grain>(() => (readKey(GRAIN_KEY) === "year" ? "year" : "month"));
  return [
    grain,
    (g) => {
      setGrain(g);
      writeKey(GRAIN_KEY, g);
    },
  ];
}

/** ← and → go to the previous and next month (structure.md §1.5), when there is one. */
export function useMonthKeys(prev: string | null, next: string | null, go: (month: string) => void) {
  const at = useRef({ prev, next, go });
  at.current = { prev, next, go };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = monthStep(e, isTyping(e.target), anyLayerOpen());
      const month = step === -1 ? at.current.prev : step === 1 ? at.current.next : null;
      if (!month) return;
      e.preventDefault();
      at.current.go(month);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
