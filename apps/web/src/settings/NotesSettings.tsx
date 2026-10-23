/**
 * Settings → Notes (structure.md §3.1 #4): the folder this server reads the notes from, the life
 * areas (settings/LifeAreas.tsx), and the ontology with Orr noticed. The folder
 * is changed here with the first run's chooser (Change…, door/NotesChoice.tsx), unless it is set
 * where the server starts (ORRAMA_VAULT_DIR), and the example from first run is removed here.
 * The ontology is a note, so this section shows it and opens it.
 */
import { useCallback, useEffect, useState, type MouseEvent } from "react";
import type { GraphSchema, ServerSettings, TreeNote } from "@orrama/schema/responses";
import { api } from "../api.js";
import { Confirm, type ConfirmRequest } from "../Confirm.js";
import { NotesChoice } from "../door/NotesChoice.js";
import { Button, Dot } from "../ui/controls.js";
import { Dialog } from "../ui/overlays.js";
import { Icon } from "../ui/Icon.js";
import { navigate, routeHref, type Route } from "../ui/router.js";
import { Skeleton } from "../ui/states.js";
import { SectionHead, StateLine, SubHead, type SectionMeta } from "./parts.js";
import { LifeAreasSection } from "./LifeAreas.js";

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
  const [how, setHow] = useState<"export" | null>(null);
  const [changing, setChanging] = useState(false);
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);

  /** Asked again after the example goes: the counts below are the folder's. */
  const [version, setVersion] = useState(0);
  const loadServer = useCallback(() => setVersion((v) => v + 1), []);

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
  }, [owner, version]);

  const removeExample = () =>
    setAsk({
      title: "Remove the example?",
      body: "Garden studio, Sam Rivera and Oakline Builders go to the trash, with anything you added to them, and the site visit leaves your calendar. Your own notes stay.",
      confirmLabel: "Remove the example",
      danger: true,
      failed: "The example wasn't removed.",
      onConfirm: async () => {
        await api("DELETE", "/api/settings/example");
        loadServer();
      },
    });

  const tagged = (tag: string) => tree?.find((n) => n.tags.includes(tag));
  const ontologyNote = tagged("vault-ontology");
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
            <>
              <StateLine
                tone="ok"
                title={server.notesFolder}
                detail={server.fixed ? `${plural(server.notes, "note")} · set where Orrama starts` : plural(server.notes, "note")}
                action={
                  server.fixed ? undefined : (
                    <Button size="sm" onClick={() => setChanging(true)}>
                      Change…
                    </Button>
                  )
                }
              />
              {server.example > 0 && (
                <StateLine
                  tone="off"
                  title="The example"
                  detail="Garden studio, Sam Rivera, Oakline Builders and a site visit this week."
                  action={
                    <Button size="sm" onClick={removeExample}>
                      Remove the example
                    </Button>
                  }
                />
              )}
            </>
          ) : (
            <StateLine tone="bad" title="The server didn't say" detail="Reload the page to try again." />
          )}
          {changing && server && (
            <Dialog title="Where are your notes?" onClose={() => setChanging(false)}>
              <NotesChoice
                server={server}
                place="settings"
                onCancel={() => setChanging(false)}
                onDone={(_way, moved) => {
                  // Another folder: everything on screen was the old one's.
                  if (moved) return window.location.reload();
                  setChanging(false);
                  loadServer();
                }}
              />
            </Dialog>
          )}
          <Confirm request={ask} onClose={() => setAsk(null)} />
        </div>
      )}

      <LifeAreasSection />

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
