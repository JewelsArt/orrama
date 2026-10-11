/**
 * What every entity page shares: the page for an address that names nothing, Orr's warnings
 * about this one note (with their fixes), the note's plain links as names, and Show in the
 * Orrery's address.
 */
import { useMemo } from "react";
import type { GraphWarnings, Me } from "@basalt/schema/responses";
import { api } from "../api.js";
import { Fixes, Sentence, useFixes } from "../noticed/fixes.js";
import { itemsOf } from "../noticed/model.js";
import { slugOf as orrerySlug } from "../orrery/model.js";
import { LinkButton, NameLink } from "../ui/controls.js";
import { HeadMark } from "../ui/orr/Orr.js";
import { type Route } from "../ui/router.js";
import { Notice } from "../ui/states.js";
import { useLoad, type KnownData } from "./known.js";
import { anchor, kindOf, linkTo, type Known } from "./links.js";
import type { Brief } from "./model.js";

/** An address that names nothing: said plainly, with the way back. */
export function Missing({ what }: { what: "person" | "company" | "conversation" | "document" }) {
  const back: Route = what === "person" || what === "company" ? { kind: "people" } : { kind: "notes" };
  return (
    <div className="ui ent-page">
      <Notice
        title={`There's no ${what} at this address.`}
        text="Its note may have been renamed, moved or made private."
        actions={
          <LinkButton size="sm" {...anchor(linkTo(back))}>
            {what === "person" || what === "company" ? "Back to People" : "Back to Notes"}
          </LinkButton>
        }
      />
    </div>
  );
}

/* ---- what every page shares: warnings, relations, the path -------------------------------- */

/** Orr's warnings about this one note, as his work at the top of the side (§2.6, §2.15). */
export function useOwnWarnings(id: string, tick: number) {
  const all = useLoad((signal) => api<GraphWarnings>("GET", "/api/graph/warnings", undefined, { signal }), [tick]);
  return useMemo(() => (all.state === "ok" ? itemsOf(all.data.warnings.filter((w) => w.note.id === id)) : []), [all, id]);
}

export function WarningsBox({ me, id, tick, known, onFixed }: { me: Me; id: string; tick: number; known: Known; onFixed: () => void }) {
  const items = useOwnWarnings(id, tick);
  const { run, dialog } = useFixes(me, known, onFixed);
  if (items.length === 0) return dialog ? <>{dialog}</> : null;
  return (
    <div className="oprop boxed ent-warn ent-warnbox" role="note" aria-label="Orr noticed">
      <HeadMark size={18} />
      <div>
        {items.map((it) => (
          <div key={it.key} className="ent-warn-one">
            <Sentence parts={it.parts} known={known} self={id} />
            <Fixes item={it} known={known} onFix={(f, v) => void run(it, f, v)} />
          </div>
        ))}
        <p className="ent-warn-all">
          <NameLink {...linkTo({ kind: "notes-health" })}>Everything Orr noticed</NameLink>
        </p>
      </div>
      {dialog}
    </div>
  );
}

/** A note's mentions (who links here) and links (what it links to), as briefs the page can name. */
export function plainLinks(note: { id: string; backlinks: { fromId: string; fromTitle: string }[]; links: { targetId: string | null; locked: boolean }[] } | null, data: KnownData, known: Known) {
  if (!note) return { mentions: [], links: [] };
  const byId = new Map(data.tree.map((n) => [n.id, n]));
  const brief = (id: string, title: string): Brief => ({ id, title, type: kindOf({ id }, known) });
  const mentions = [...new Map(note.backlinks.filter((b) => b.fromId !== note.id).map((b) => [b.fromId, brief(b.fromId, b.fromTitle)])).values()];
  const links = [...new Map(note.links.filter((l) => l.targetId && !l.locked && l.targetId !== note.id && byId.has(l.targetId)).map((l) => [l.targetId!, brief(l.targetId!, byId.get(l.targetId!)!.title)])).values()];
  return { mentions, links };
}

/** Show in the Orrery: Steps with this thing in the middle (R4's address). */
export const orreryRoute = (path: string): Route => ({ kind: "orrery", center: orrerySlug(path) });

