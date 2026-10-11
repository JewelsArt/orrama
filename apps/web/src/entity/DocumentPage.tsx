/**
 * A document's entity page (structure.md §2.6), `/documents/<path>`: a project's file (a PDF, a
 * deck, a sheet in `04-Projects/<slug>/files/`), a statement or payslip in the finance files, or
 * a note the ontology calls a document (one that belongs to a project). Header: the file's name,
 * its type and size; facts: which project, which folder; relations: what it is part of and
 * who mentions it; then the reader (R7's DocViewer, in the page) or the note in the editor.
 */
import type { Me, ProjectWorkspace } from "@basalt/schema/responses";
import { api } from "../api.js";
import { DocViewer } from "../DocViewer.js";
import { folderName } from "../notes/read.js";
import { LinkButton, NameLink } from "../ui/controls.js";
import { dateLabel } from "../ui/dates.js";
import { Icon } from "../ui/Icon.js";
import { Skeleton } from "../ui/states.js";
import { EntityHeader } from "./EntityHeader.js";
import { Missing, WarningsBox, orreryRoute, plainLinks } from "./shared.js";
import { useLoad, useNotesTick, type KnownData } from "./known.js";
import { anchor, linkTo, notePath, type Known } from "./links.js";
import { documentAt, fileType, relationGroups, sizeLabel } from "./model.js";
import { Facts, NoteBlock, RelationsBlock, useAreaColor, useHref, useNote, type FactItem } from "./parts.js";
import { useRelations } from "./relations.js";

const folderWords = (folder: string) => (folder ? folder.split("/").map(folderName).join(" / ") : "The top of your notes");

export function DocumentPage({ me, path, data, known }: { me: Me; path: string; data: KnownData; known: Known }) {
  const at = documentAt(path);
  if (at.kind === "note") {
    const n = data.tree.find((t) => t.path === at.path);
    return n ? <NoteDocument me={me} id={n.id} title={n.title} path={n.path} folder={n.folder} mtimeMs={n.mtimeMs} data={data} known={known} /> : <Missing what="document" />;
  }
  return <FileDocument at={at} path={path} data={data} />;
}

/* ---- a file: the reader in the page ------------------------------------------------------- */

function FileDocument({ at, path, data }: { at: Exclude<ReturnType<typeof documentAt>, { kind: "note" }>; path: string; data: KnownData }) {
  const project = at.kind === "project-file" ? data.projects.find((p) => p.slug === at.slug) : undefined;
  const ws = useLoad(at.kind === "project-file" ? (signal) => api<ProjectWorkspace>("GET", `/api/projects/${encodeURIComponent(at.slug)}`, undefined, { signal }) : null, [at.kind === "project-file" ? at.slug : ""]);
  if (at.kind === "project-file" && !project) return <Missing what="document" />;
  if (ws.state === "loading" && at.kind === "project-file") return <div className="ui ent-page"><Skeleton rows={6} /></div>;
  const file = ws.state === "ok" ? ws.data.files.find((f) => f.name === at.name) : undefined;
  if (at.kind === "project-file" && ws.state === "ok" && !file) return <Missing what="document" />;
  const folder = path.slice(0, path.lastIndexOf("/"));
  const where = project ? { label: project.name, route: { kind: "project" as const, slug: project.slug, tab: "documents" as const } } : { label: "Money", route: { kind: "money" as const, page: "documents" as const } };

  const facts: FactItem[] = [];
  facts.push({ k: at.kind === "project-file" ? "Project" : "Kept in", v: <NameLink {...linkTo(where.route)}>{where.label}</NameLink> });
  facts.push({ k: "Folder", v: <b>{folderWords(folder)}</b> });
  facts.push({ k: "Type", v: <b>{fileType(at.name)}</b> });
  if (file) facts.push({ k: "Size", v: <b>{sizeLabel(file.size)}</b> });
  if (file) facts.push({ k: "Added", v: <b>{dateLabel(new Date(file.mtimeMs))}</b> });

  const meta = [fileType(at.name), file ? sizeLabel(file.size) : null].filter(Boolean).join(" · ");
  return (
    <div className="ui ent-page ent-document">
      <EntityHeader
        crumbs={[{ label: where.label, ...linkTo(where.route) }, { label: at.name }]}
        lead={
          <span className="ent-badge" aria-hidden="true">
            <Icon name="doc" size={22} />
          </span>
        }
        title={at.name}
        meta={
          <span className="ent-sub">
            {meta} · part of <NameLink {...linkTo(where.route)}>{where.label}</NameLink>
          </span>
        }
      />
      <div className="ent-cols ent-cols-doc">
        <div className="ent-main">
          <Facts items={facts} />
        </div>
        <div className="ent-notecol">
          <DocViewer inline base={at.base} name={at.name} onClose={() => {}} />
        </div>
      </div>
    </div>
  );
}

/* ---- a note that is a document ------------------------------------------------------------ */

function NoteDocument({ me, id, title, path, folder, mtimeMs, data, known }: { me: Me; id: string; title: string; path: string; folder: string; mtimeMs: number; data: KnownData; known: Known }) {
  const [tick, bump] = useNotesTick();
  const rel = useRelations(id, tick);
  const { note, sync, state } = useNote(id);
  const hrefOf = useHref(data, known);
  const colorOf = useAreaColor(data);
  const { mentions, links } = plainLinks(note, data, known);
  const groups = relationGroups({ relations: rel.by, mentions, links });
  const partOf = rel.by.get("part_of") ?? [];

  const facts: FactItem[] = [];
  if (partOf.length) facts.push({ k: "Project", v: <span className="ent-list">{partOf.map((p) => <a key={p.id} className="ent-v" {...anchor(linkTo(hrefOf(p) ?? { kind: "notes", id: p.id }))}>{p.title}</a>)}</span> });
  facts.push({ k: "Folder", v: <b>{folderWords(folder)}</b> });
  facts.push({ k: "Edited", v: <b>{dateLabel(new Date(mtimeMs))}</b> });

  return (
    <div className="ui ent-page ent-document">
      <EntityHeader
        crumbs={[{ label: "Notes", ...linkTo({ kind: "notes" }) }, { label: title }]}
        lead={
          <span className="ent-badge" aria-hidden="true">
            <Icon name="doc" size={22} />
          </span>
        }
        title={title}
        meta={
          <span className="ent-sub">
            Document
            {partOf[0] && (
              <>
                {" "}
                · part of <NameLink {...linkTo(hrefOf(partOf[0]) ?? { kind: "notes", id: partOf[0].id })}>{partOf[0].title}</NameLink>
              </>
            )}
          </span>
        }
        actions={
          <>
            <LinkButton className="ent-wide" icon="orbit" {...anchor(linkTo(orreryRoute(path)))}>
              Show in the Orrery
            </LinkButton>
            <LinkButton icon="notes" aria-label="Open the note" data-tip="Open the note" {...anchor(linkTo({ kind: "notes", path: notePath(path) }))} />
          </>
        }
      />
      <div className="ent-cols">
        <div className="ent-main">
          <Facts items={facts} />
          <RelationsBlock title="Where it belongs" groups={groups} hrefOf={hrefOf} colorOf={colorOf} plain={rel.by.size === 0} />
        </div>
        <aside className="ent-side">
          <WarningsBox me={me} id={id} tick={tick} known={known} onFixed={bump} />
        </aside>
        <div className="ent-notecol">
          <NoteBlock title="The note" note={note} sync={sync} state={state} data={data} known={known} />
        </div>
      </div>
    </div>
  );
}
