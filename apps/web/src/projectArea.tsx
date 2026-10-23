/**
 * Which life area a project is in, for its dot and the board's filter (structure.md §2.4), and the
 * project header's menu that moves it (1D). The server decides the area (`/api/projects` and the
 * project page send `area`: the note's `area:`, else the areas' words, else its old `domain:`,
 * else the catch-all); the menu writes `area:` through `PATCH /api/projects/:slug`, as the group
 * menu beside it writes `group:` (projectGroup.tsx).
 */
import { useRef, useState } from "react";
import type { Category } from "./categories.js";
import { Dot } from "./ui/controls.js";
import { Menu, type MenuItem } from "./ui/overlays.js";
import { navigate, routeHref } from "./ui/router.js";
import { attempt } from "./ui/writes.js";

/** The area of a project, by the id the server sent; null for one the list doesn't have. */
export function areaOf(id: string | null | undefined, areas: readonly Category[]): Category | null {
  return areas.find((c) => c.id === id) ?? null;
}

/** The area in the project page's header: its name, and a click lists the areas to move it to, and the board filtered to it. */
export function AreaMenu({ area, areas, canEdit, write }: { area: Category | null; areas: readonly Category[]; canEdit: boolean; write: (name: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const at = useRef<HTMLButtonElement>(null);
  const board = area ? { kind: "projects" as const, area: area.id } : { kind: "projects" as const };
  if (!canEdit)
    return area ? (
      <a
        className="ent-link"
        href={routeHref(board)}
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          navigate(board);
        }}
      >
        <span className="ui-dot" style={{ background: area.color }} />
        {area.label}
      </a>
    ) : null;
  const items: (MenuItem | "-")[] = areas.map((a) => ({
    label: a.label,
    icon: <Dot color={a.color} />,
    checked: a.id === area?.id,
    onSelect: () => a.id !== area?.id && void attempt("The area wasn't changed.", () => write(a.label)),
  }));
  if (area) items.push("-", { label: `Every project in ${area.label}`, onSelect: () => navigate(board) });
  return (
    <>
      <button ref={at} type="button" className="ent-link" aria-haspopup="menu" aria-expanded={open} aria-label={area ? `Life area: ${area.label}. Change it` : "Pick a life area"} onClick={() => setOpen((v) => !v)}>
        {area && <span className="ui-dot" style={{ background: area.color }} />}
        {area?.label ?? "Pick a life area"}
      </button>
      {open && <Menu anchor={at} label="Life area" onClose={() => setOpen(false)} items={items} />}
    </>
  );
}
