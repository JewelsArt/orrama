/**
 * A project's group inside its area (front matter `group:`, Jules 20 Oct: "some work is for
 * Scooperz, some for my website making, some personal branding"). The Projects board splits one
 * area's projects by it (`boardGroups`, OverviewHead.tsx); the project page sets it here, from a
 * menu of the groups other projects already use, or a new one, so no one has to type Markdown.
 */
import { useEffect, useRef, useState } from "react";
import { api, isAbort } from "./api.js";
import type { ProjectRow } from "@orrama/schema/responses";
import { NameDialog } from "./ui/NameDialog.js";
import { Menu, type MenuItem } from "./ui/overlays.js";
import { attempt } from "./ui/writes.js";

/** Every group the projects you can read use, each once (compared without case), by name. */
export function groupNames(rows: { group: string | null }[], current = ""): string[] {
  const by = new Map<string, string>();
  for (const g of [current, ...rows.map((r) => r.group ?? "")]) {
    const name = g.trim();
    if (name && !by.has(name.toLocaleLowerCase())) by.set(name.toLocaleLowerCase(), name);
  }
  return [...by.values()].sort((a, b) => a.localeCompare(b));
}

/** The groups in use, from `/api/projects`; empty until it answers. Asks again when `refresh` changes. */
export function useProjectGroups(refresh: unknown): { group: string | null }[] {
  const [rows, setRows] = useState<{ group: string | null }[]>([]);
  useEffect(() => {
    if (refresh === undefined || refresh === null) return;
    const ac = new AbortController();
    api<ProjectRow[]>("GET", "/api/projects", undefined, { signal: ac.signal })
      .then(setRows)
      .catch((e) => {
        if (!isAbort(e)) setRows([]);
      });
    return () => ac.abort();
  }, [refresh]);
  return rows;
}

/** The group in the project page's header: its name, and a click lists the groups to move it to. */
export function GroupMenu({
  value,
  canEdit,
  rows,
  write,
}: {
  value: string;
  canEdit: boolean;
  rows: { group: string | null }[];
  /** Writes the group; "" takes the project out of its group. A failure is said here. */
  write: (group: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const at = useRef<HTMLButtonElement>(null);
  if (!canEdit) return value ? <span>{value}</span> : null;
  const pick = (g: string) => void attempt("The group wasn't changed.", () => write(g));
  const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
  const items: (MenuItem | "-")[] = groupNames(rows, value).map((g) => ({ label: g, checked: same(g, value), onSelect: () => !same(g, value) && pick(g) }));
  if (items.length > 0) items.push("-");
  items.push({ label: "New group…", onSelect: () => setNaming(true) });
  if (value) items.push({ label: "No group", onSelect: () => pick("") });
  return (
    <>
      <button ref={at} type="button" className="ent-link" aria-haspopup="menu" aria-expanded={open} aria-label={value ? `Group: ${value}. Change it` : "Add to a group"} onClick={() => setOpen((v) => !v)}>
        {value || "Add to a group"}
      </button>
      {open && <Menu anchor={at} label="Group" onClose={() => setOpen(false)} items={items} />}
      {naming && (
        <NameDialog
          title="New group"
          label="What is the group called?"
          help="Projects in one area are split by group on the Projects page."
          placeholder="Websites"
          confirm="Add"
          onSubmit={async (name) => {
            await write(name);
          }}
          onClose={() => setNaming(false)}
        />
      )}
    </>
  );
}
