/**
 * The lists the entity pages, Find and Orr noticed read to know what each note is: people and
 * companies (People's own lists), projects (the board's), the vault's notes with their kind
 * and one-line description (`/api/vault/graph`), and their paths and life areas (the tree). Asked once per page, and again half a second
 * after the last note changes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Company, Contact, GraphData, ProjectRow, TreeNote } from "@basalt/schema/responses";
import { api, isAbort } from "../api.js";
import { onWs } from "../ws.js";
import type { Known } from "./links.js";

export interface KnownData {
  contacts: Contact[];
  companies: Company[];
  projects: ProjectRow[];
  nodes: GraphData["nodes"];
  /** Every readable note's path and life area. */
  tree: TreeNote[];
}

export function knownOf(d: Pick<KnownData, "contacts" | "companies" | "projects" | "nodes">): Known {
  return {
    people: new Set(d.contacts.map((c) => c.id)),
    companies: new Set(d.companies.map((c) => c.id)),
    projects: new Map(d.projects.filter((p) => p.noteId).map((p) => [p.noteId!, p.slug])),
    conversations: new Set(d.nodes.filter((n) => n.kind === "conversation").map((n) => n.id)),
  };
}

export function useKnown(): { data: KnownData | null; known: Known | null; failed: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<KnownData | null>(null);
  const [failed, setFailed] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    ctl.current?.abort();
    const c = (ctl.current = new AbortController());
    const opts = { signal: c.signal };
    try {
      const [contacts, companies, projects, graph, tree] = await Promise.all([
        api<Contact[]>("GET", "/api/contacts", undefined, opts),
        api<Company[]>("GET", "/api/companies", undefined, opts),
        api<ProjectRow[]>("GET", "/api/projects", undefined, opts),
        api<GraphData>("GET", "/api/vault/graph", undefined, opts),
        api<TreeNote[]>("GET", "/api/vault/tree", undefined, opts),
      ]);
      setData({ contacts, companies, projects, nodes: graph.nodes, tree });
      setFailed(false);
    } catch (e) {
      if (!isAbort(e)) setFailed(true);
    }
  }, []);
  useEffect(() => {
    void reload();
    let timer: ReturnType<typeof setTimeout>;
    const off = onWs((msg) => {
      if (msg.type !== "note-changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), 500);
    });
    return () => {
      off();
      clearTimeout(timer);
      ctl.current?.abort();
    };
  }, [reload]);
  const known = useMemo(() => (data ? knownOf(data) : null), [data]);
  return { data, known, failed, reload };
}

export type Load<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "failed" };

/**
 * One request, asked again when `deps` change, its answer as a state. The request is written
 * out where it is used, as a literal GET call, so the contract test's scan sees it; a
 * `null` fetcher asks nothing (a page that has no use for it).
 */
export function useLoad<T>(fetcher: ((signal: AbortSignal) => Promise<T>) | null, deps: unknown[]): Load<T> {
  const [s, setS] = useState<Load<T>>({ state: "loading" });
  const run = useRef(fetcher);
  run.current = fetcher;
  useEffect(() => {
    const f = run.current;
    if (!f) return setS({ state: "loading" });
    const ac = new AbortController();
    f(ac.signal)
      .then((data) => setS({ state: "ok", data }))
      .catch((e) => !isAbort(e) && setS({ state: "failed" }));
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!fetcher, ...deps]);
  return s;
}

/** A counter that moves half a second after the last note changes: pass it to `useLoad`. */
export function useNotesTick(): [number, () => void] {
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const off = onWs((msg) => {
      if (msg.type !== "note-changed") return;
      clearTimeout(timer);
      timer = setTimeout(bump, 500);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [bump]);
  return [tick, bump];
}
