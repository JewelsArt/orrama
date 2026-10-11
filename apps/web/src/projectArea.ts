/**
 * Which life area a project is in, for its dot and the board's filter (structure.md §2.4). The
 * vault's `#vault-categories` note decides, as for every note (`/api/vault/tree` sends each
 * note's `category`); a project that note leaves in the catch-all keeps the area its own
 * `domain:` says, which is what the board grouped by before there were five areas.
 */
import { useEffect, useState } from "react";
import { api, isAbort, type TreeNote } from "./api.js";
import { CATEGORIES, type Category } from "./categories.js";

const DOMAIN_AREA: Record<string, string> = { academic: "school", professional: "work", personal: "personal" };

export function areaOf(category: string | undefined, domain: string | null | undefined): Category | null {
  if (category && category !== "personal") return CATEGORIES.find((c) => c.id === category) ?? null;
  const id = (domain && DOMAIN_AREA[domain]) || category;
  return CATEGORIES.find((c) => c.id === id) ?? null;
}

/** Each readable note's area, by id; empty until the tree has answered. Asks again when `refresh` changes, and not before it is set. */
export function useNoteAreas(refresh: unknown): Map<string, string> {
  const [areas, setAreas] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (refresh === undefined || refresh === null) return;
    const ac = new AbortController();
    api<TreeNote[]>("GET", "/api/vault/tree", undefined, { signal: ac.signal })
      .then((notes) => setAreas(new Map(notes.map((n) => [n.id, n.category]))))
      .catch((e) => {
        if (!isAbort(e)) setAreas(new Map());
      });
    return () => ac.abort();
  }, [refresh]);
  return areas;
}
