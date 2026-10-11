/**
 * Settings → Notes (structure.md §3.1 #4): the folder this server reads the notes from, the life
 * areas (the vault's own `#vault-categories` note), and the ontology with Orr noticed. All of it
 * is the server's and the vault's: the folder is set where the server is started, the areas
 * and the ontology are notes, so this section shows them and opens them rather than editing.
 */
import { useEffect, useState, type MouseEvent } from "react";
import type { GraphSchema, ServerSettings, TreeNote } from "@basalt/schema/responses";
import { api } from "../api.js";
import { CATEGORIES } from "../categories.js";
import { Dot } from "../ui/controls.js";
import { Icon } from "../ui/Icon.js";
import { navigate, routeHref, type Route } from "../ui/router.js";
import { Skeleton } from "../ui/states.js";
import { SectionHead, StateLine, SubHead, type SectionMeta } from "./parts.js";

const plain = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
const go = (to: Route) => (e: MouseEvent) => {
  if (!plain(e)) return;
  e.preventDefault();
  navigate(to);
};
const noteRoute = (n: TreeNote): Route => ({ kind: "notes", path: n.path.replace(/\.md$/i, "") });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function NotesSection({ meta, owner }: { meta: SectionMeta; owner: boolean }) {
  const [server, setServer] = useState<ServerSettings | null | undefined>(owner ? undefined : null);
  const [tree, setTree] = useState<TreeNote[] | null>(null);
  const [schema, setSchema] = useState<GraphSchema | null>(null);
  const [how, setHow] = useState<"folder" | "export" | null>(null);

  useEffect(() => {
    if (owner)
      api<ServerSettings>("GET", "/api/settings/server")
        .then(setServer)
        .catch(() => setServer(null));
    api<TreeNote[]>("GET", "/api/vault/tree")
      .then(setTree)
      .catch(() => setTree([]));
    api<GraphSchema>("GET", "/api/graph/schema")
      .then(setSchema)
      .catch(() => setSchema(null));
  }, [owner]);

  const tagged = (tag: string) => tree?.find((n) => n.tags.includes(tag));
  const areasNote = tagged("vault-categories");
  const ontologyNote = tagged("vault-ontology");
  const counts = new Map<string, number>();
  for (const n of tree ?? []) counts.set(n.category, (counts.get(n.category) ?? 0) + 1);
  const warnings = schema?.warnings.reduce((t, w) => t + w.count, 0) ?? 0;

  return (
    <section className="set-sec" aria-label={meta.label}>
      <SectionHead meta={meta} />

      {owner && (
        <div>
          <SubHead>Notes folder</SubHead>
          {server === undefined ? (
            <Skeleton rows={1} label="Loading the notes folder" />
          ) : server ? (
            <StateLine
              tone="ok"
              title={server.notesFolder}
              detail={`${plural(server.notes, "note")} · read live, also by Obsidian`}
              action={
                <button type="button" className="set-how" aria-expanded={how === "folder"} onClick={() => setHow(how === "folder" ? null : "folder")}>
                  How to change it?
                </button>
              }
            />
          ) : (
            <StateLine tone="bad" title="The server didn't say" detail="Reload the page to try again." />
          )}
          {how === "folder" && (
            <p className="set-help">
              The folder is set where the server starts: <code>BASALT_VAULT_DIR</code> in its launch agent on the Mac. Change it
              there and restart the agent; the first read gives every note an id line.
            </p>
          )}
        </div>
      )}

      <div>
        <SubHead
          aside={
            areasNote && (
              <a className="set-link" href={routeHref(noteRoute(areasNote))} onClick={go(noteRoute(areasNote))}>
                Open the rules
              </a>
            )
          }
        >
          Life areas
        </SubHead>
        {tree === null ? (
          <Skeleton rows={2} label="Loading life areas" />
        ) : (
          <>
            <div className="set-areas">
              {CATEGORIES.map((c) => (
                <a key={c.id} className="set-area" href={routeHref({ kind: "orrery", area: c.id })} onClick={go({ kind: "orrery", area: c.id })}>
                  <Dot color={c.color} />
                  <span>{c.label}</span>
                  <small>{plural(counts.get(c.id) ?? 0, "note")}</small>
                </a>
              ))}
            </div>
            <p className="set-help">
              {areasNote
                ? "Which notes fall in each area is decided by the note tagged #vault-categories: phrases or patterns against a note's path and tags, first row wins."
                : "Only the PARA folders are known. A note tagged #vault-categories, with a | Category | Matches | table, sorts the rest."}
            </p>
          </>
        )}
      </div>

      <div>
        <SubHead
          aside={
            ontologyNote && (
              <a className="set-link" href={routeHref(noteRoute(ontologyNote))} onClick={go(noteRoute(ontologyNote))}>
                Open the ontology
              </a>
            )
          }
        >
          What Orr knows
        </SubHead>
        {schema && schema.types.length > 0 ? (
          <div className="set-rows">
            <div className="set-fact">
              <span>
                <b>{plural(schema.types.length, "kind")} of thing</b>, {plural(schema.relations.length, "relation")}
              </span>
              <small>from the note tagged #vault-ontology</small>
            </div>
            <a className="set-fact link" href={routeHref({ kind: "notes-health" })} onClick={go({ kind: "notes-health" })}>
              <span>
                <b>Orr noticed</b>, {warnings === 0 ? "nothing to fix" : plural(warnings, "thing")} {warnings === 0 ? "" : "to look at"}
              </span>
              <Icon name="chev-r" size={14} />
            </a>
          </div>
        ) : (
          <p className="set-help">
            Nothing is typed yet. A note tagged #vault-ontology, with Types, Relations, Statuses and Rules tables, lets Orr
            answer from the graph and say what is missing.
          </p>
        )}
      </div>

      <div>
        <SubHead>Export</SubHead>
        <p className="set-help">
          Everything only the database holds (task comments, settings, accounts) as a readable file and a restorable copy, with
          every secret left out.{" "}
          <button type="button" className="set-how" aria-expanded={how === "export"} onClick={() => setHow(how === "export" ? null : "export")}>
            How?
          </button>
        </p>
        {how === "export" && (
          <p className="set-help">
            In Terminal, in the Orrama folder, run <code>pnpm --dir apps/server export</code>. It writes to the server's data
            folder, never into your notes.
          </p>
        )}
      </div>
    </section>
  );
}
