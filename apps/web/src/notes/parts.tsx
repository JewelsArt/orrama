/**
 * The Notes page's pieces (structure.md §2.3, the Notes boards): the tree pane, Notes home, the
 * note's header, and the side panel. They draw; Notes.tsx holds the state and every request.
 */
import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { GraphRelations, NoteDetail, NotesOverview, TreeNote } from "@orrama/schema/responses";
import { CATEGORIES, categoryOf } from "../categories.js";
import { FileTree, type TreeActions } from "../FileTree.js";
import { Icon } from "../ui/Icon.js";
import { HeadMark } from "../ui/orr/Orr.js";
import { Button, Checkbox, LinkButton, Ring, Square, type TaskState } from "../ui/controls.js";
import { Module, Row, RowList } from "../ui/layout.js";
import { Menu, type MenuItem } from "../ui/overlays.js";
import { EmptyState, Skeleton } from "../ui/states.js";
import { editedLabel, folderName, relationWords, snippet } from "./read.js";

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
/** A link that goes somewhere in the app: a real href, and a plain click stays in the page. */
export const follow = (fn: () => void) => (e: MouseEvent) => {
  if (!plainClick(e)) return;
  e.preventDefault();
  fn();
};

/* ---- the tree pane ------------------------------------------------------------------------ */

export interface TreePaneProps {
  tree: TreeNote[] | null;
  shown: TreeNote[];
  activeId: string | null;
  pinned: TreeNote[];
  recent: TreeNote[];
  inbox: TreeNote | null;
  filter: string;
  onFilter: (q: string) => void;
  area: string;
  onArea: (id: string) => void;
  areaCounts: Map<string, number>;
  reveal?: string;
  onOpen: (id: string) => void;
  hrefOf: (n: TreeNote) => string;
  onHome: () => void;
  onNew: () => void;
  onNewFolder: () => void;
  /** Every folder, empty ones too, and what can be done to a row (1C). */
  folders?: string[];
  actions?: TreeActions;
  /** The Trash view: its address, and whether it is the page open now. */
  trashHref: string;
  onTrash: () => void;
  inTrash: boolean;
}

/** One row of the tree's own lists (Pinned, Recent, Inbox). */
function TreeRow({ n, icon, meta, active, onOpen, href }: { n: TreeNote; icon: "pin" | "doc" | "inbox"; meta?: ReactNode; active: boolean; onOpen: () => void; href: string }) {
  return (
    <a className={active ? "ti on" : "ti"} href={href} aria-current={active ? "page" : undefined} onClick={follow(onOpen)}>
      <Icon name={icon} />
      <span>{n.title}</span>
      <small>{meta}</small>
    </a>
  );
}

/** The tree: Pinned, Recent, then the folders with your inbox first (the Notes board). */
export function TreePane(p: TreePaneProps) {
  const areaBtn = useRef<HTMLButtonElement>(null);
  const [areaMenu, setAreaMenu] = useState(false);
  const areaLabel = CATEGORIES.find((c) => c.id === p.area)?.label;
  const searching = p.filter.trim() !== "";
  // One filter control (structure.md §2.3): the life areas are a menu beside the text filter,
  // not a select plus five chips.
  const items: MenuItem[] = [
    { label: `All notes · ${p.tree?.length ?? 0}`, onSelect: () => p.onArea("all") },
    ...CATEGORIES.filter((c) => (p.areaCounts.get(c.id) ?? 0) > 0).map((c) => ({
      label: `${c.label} · ${p.areaCounts.get(c.id)}`,
      onSelect: () => p.onArea(c.id),
    })),
  ];
  return (
    <aside className="nt-tree" aria-label="Notes">
      <div className="nt-tree-h">
        <a href="/notes" className="nt-tree-title" onClick={follow(p.onHome)}>
          Notes
        </a>
        <Button kind="quiet" size="sm" icon="folder" aria-label="New folder" tip="New folder" onClick={p.onNewFolder} />
        <Button kind="quiet" size="sm" icon="plus" aria-label="New note" tip="New note" onClick={p.onNew} />
      </div>
      <div className="nt-filter">
        <label className="inp">
          <Icon name="search" size={15} />
          <input value={p.filter} onChange={(e) => p.onFilter(e.target.value)} placeholder="Filter notes" aria-label="Filter notes" />
          {p.filter && (
            <button type="button" className="nt-x" onClick={() => p.onFilter("")} aria-label="Clear the filter">
              <Icon name="x" size={14} />
            </button>
          )}
        </label>
        <Button
          ref={areaBtn}
          kind="quiet"
          size="sm"
          icon="filter"
          aria-label={areaLabel ? `Showing ${areaLabel}: choose a life area` : "Choose a life area"}
          aria-haspopup="menu"
          aria-expanded={areaMenu}
          className={p.area !== "all" ? "nt-area on" : "nt-area"}
          tip="Life areas"
          onClick={() => setAreaMenu(true)}
        />
        {areaMenu && <Menu anchor={areaBtn} label="Life areas" items={items} align="end" onClose={() => setAreaMenu(false)} />}
      </div>
      {p.area !== "all" && areaLabel && (
        <button type="button" className="chip nt-area-chip" onClick={() => p.onArea("all")} aria-label={`Show all notes, not only ${areaLabel}`}>
          <span className="ui-dot" style={{ background: CATEGORIES.find((c) => c.id === p.area)?.color }} />
          {areaLabel}
          <Icon name="x" size={13} />
        </button>
      )}
      <div className="nt-tree-scroll">
        {!searching && p.pinned.length > 0 && (
          <>
            <div className="tsec">Pinned</div>
            {p.pinned.map((n) => (
              <TreeRow key={n.id} n={n} icon="pin" active={n.id === p.activeId} onOpen={() => p.onOpen(n.id)} href={p.hrefOf(n)} />
            ))}
          </>
        )}
        {!searching && p.recent.length > 0 && (
          <>
            <div className="tsec">Recent</div>
            {p.recent.map((n) => (
              <TreeRow key={n.id} n={n} icon="doc" meta={editedLabel(n.mtimeMs)} active={n.id === p.activeId} onOpen={() => p.onOpen(n.id)} href={p.hrefOf(n)} />
            ))}
          </>
        )}
        {!searching && <div className="tsec">Folders</div>}
        {!searching && p.inbox && (
          <TreeRow n={{ ...p.inbox, title: "Inbox" }} icon="inbox" meta={p.inbox.openTasks || ""} active={p.inbox.id === p.activeId} onOpen={() => p.onOpen(p.inbox!.id)} href={p.hrefOf(p.inbox)} />
        )}
        {p.tree === null ? (
          <Skeleton rows={6} label="Reading your notes" />
        ) : (
          <FileTree
            notes={p.shown}
            activeId={p.activeId}
            onOpen={p.onOpen}
            hrefOf={p.hrefOf}
            filter={p.filter}
            reveal={p.reveal}
            folders={p.area === "all" ? p.folders : undefined}
            actions={p.actions}
          />
        )}
        {!searching && (
          <a className={p.inTrash ? "ti on nt-trash-row" : "ti nt-trash-row"} href={p.trashHref} aria-current={p.inTrash ? "page" : undefined} onClick={follow(p.onTrash)}>
            <Icon name="trash" />
            <span>Trash</span>
          </a>
        )}
      </div>
    </aside>
  );
}

/* ---- Notes home ----------------------------------------------------------------------------- */

export interface HomeProps {
  tree: TreeNote[] | null;
  overview: NotesOverview | null;
  pinned: TreeNote[];
  recent: TreeNote[];
  inbox: TreeNote | null;
  areaCounts: Map<string, number>;
  onOpen: (id: string) => void;
  hrefOf: (n: TreeNote) => string;
  onArea: (id: string) => void;
  onNew: () => void;
  /** A folder's last segment as words (a project's folder says the project). */
  folderLabel?: (folder: string, segment: string) => string;
  /** The folder tree, on a phone, where the tree has no pane of its own. */
  phoneTree?: ReactNode;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/**
 * Notes home (structure.md §2.3): the first visit's page, and where closing a note lands —
 * recent, pinned, your inbox, the counts that left Today (§2.1 "Gone"), the life areas that
 * filter the tree, and the Orrery, which took over the map (§8 #3).
 */
export function NotesHome(p: HomeProps) {
  const o = p.overview;
  const where = (n: TreeNote) => (n.folder ? (p.folderLabel ?? ((_f: string, seg: string) => folderName(seg)))(n.folder, n.folder.split("/").pop()!) : "Top folder");
  if (p.tree === null)
    return (
      <div className="nt-home">
        <Skeleton rows={5} label="Reading your notes" />
      </div>
    );
  if (p.tree.length === 0)
    return (
      <div className="nt-home">
        <EmptyState
          pose="write"
          title="No notes yet"
          text="Write your first note and it'll be here."
          actions={
            <Button kind="solid" size="sm" icon="plus" onClick={p.onNew}>
              New note
            </Button>
          }
        />
        {p.phoneTree && <div className="nt-phone-tree">{p.phoneTree}</div>}
      </div>
    );
  const areas = CATEGORIES.filter((c) => (p.areaCounts.get(c.id) ?? 0) > 0);
  return (
    <div className="nt-home">
      <header className="nt-home-h">
        <h1>Notes</h1>
        <span className="q3">
          {o ? `${plural(o.notes, "note")} · ${plural(o.conversations, "conversation")}` : plural(p.tree.length, "note")}
        </span>
        <span className="sp" />
        <LinkButton kind="quiet" size="sm" icon="orbit" href="/orrery">
          Open the Orrery
        </LinkButton>
        <Button kind="solid" size="sm" icon="plus" onClick={p.onNew}>
          New note
        </Button>
      </header>
      {o && (
        <p className="nt-counts">
          <a href="/planning/week">{plural(o.openTasks, "open task")}</a>
          <span>·</span>
          <span>{plural(o.doneTasks, "done task", "done")}</span>
        </p>
      )}
      <div className="nt-mods">
        <Module title="Recent" count={p.recent.length || undefined}>
          <RowList label="Recent notes">
            {p.recent.map((n) => (
              <Row key={n.id} lead={<Icon name="doc" />} title={n.title} meta={where(n)} trailing={editedLabel(n.mtimeMs)} href={p.hrefOf(n)} onOpen={() => p.onOpen(n.id)} />
            ))}
          </RowList>
        </Module>
        <Module title="Pinned" count={p.pinned.length || undefined}>
          {p.pinned.length > 0 ? (
            <RowList label="Pinned notes">
              {p.pinned.map((n) => (
                <Row key={n.id} lead={<Icon name="pin" />} title={n.title} meta={where(n)} href={p.hrefOf(n)} onOpen={() => p.onOpen(n.id)} />
              ))}
            </RowList>
          ) : (
            <p className="nt-hint">Pin a note from its ··· menu and it waits here, on every device.</p>
          )}
        </Module>
        <Module title="Inbox" count={p.inbox ? p.inbox.openTasks : undefined}>
          {p.inbox ? (
            <RowList label="Inbox">
              <Row
                lead={<Icon name="inbox" />}
                title="Your captures"
                meta={p.inbox.openTasks ? plural(p.inbox.openTasks, "to sort", "to sort") : "All sorted"}
                trailing={editedLabel(p.inbox.mtimeMs)}
                href={p.hrefOf(p.inbox)}
                onOpen={() => p.onOpen(p.inbox!.id)}
              />
            </RowList>
          ) : (
            <p className="nt-hint">What you capture with c lands in your inbox note.</p>
          )}
        </Module>
        <Module title="Life areas" count={areas.length || undefined}>
          <RowList label="Life areas">
            {areas.map((c) => (
              <Row
                key={c.id}
                lead={<span className="ui-dot" style={{ background: c.color }} />}
                title={c.label}
                trailing={p.areaCounts.get(c.id)}
                onOpen={() => p.onArea(c.id)}
              />
            ))}
          </RowList>
        </Module>
      </div>
      {p.phoneTree && (
        <Module title="Folders" className="nt-phone-tree">
          {p.phoneTree}
        </Module>
      )}
    </div>
  );
}

/* ---- the note's header -------------------------------------------------------------------- */

export function NoteTop({
  path,
  folderLabel = folderName,
  onHome,
  onFolder,
  orrery,
  menu,
  onTree,
}: {
  path: string;
  /** A folder's name as words: a project's folder says the project's name. */
  folderLabel?: (folder: string, segment: string) => string;
  onHome: () => void;
  onFolder: (folder: string) => void;
  orrery: string;
  menu: (MenuItem | "-")[];
  /** On a phone, the tree opens as a sheet from here. */
  onTree: () => void;
}) {
  const more = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const folders = path.split("/").slice(0, -1);
  return (
    <div className="nt-top">
      <Button kind="quiet" size="sm" icon="sidebar" className="nt-tree-btn" aria-label="Browse notes" onClick={onTree} />
      {/* Every step is a link (the board): Notes is home, a folder opens in the tree. */}
      <nav className="crumbs" aria-label="Where this note is">
        <a href="/notes" onClick={follow(onHome)}>
          Notes
        </a>
        {folders.map((f, i) => (
          <span key={i} style={{ display: "contents" }}>
            <Icon name="chev-r" size={14} />
            <a href="/notes" onClick={follow(() => onFolder(folders.slice(0, i + 1).join("/")))} title={`Show ${folderLabel(folders.slice(0, i + 1).join("/"), f)} in the tree`}>
              {folderLabel(folders.slice(0, i + 1).join("/"), f)}
            </a>
          </span>
        ))}
      </nav>
      <span className="sp" />
      <LinkButton kind="quiet" size="sm" icon="orbit" href={orrery} className="nt-orrery">
        Show in the Orrery
      </LinkButton>
      <Button ref={more} kind="quiet" size="sm" icon="dots" aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(true)} />
      {open && <Menu anchor={more} label="Note" items={menu} align="end" onClose={() => setOpen(false)} />}
    </div>
  );
}

/* ---- the side panel ------------------------------------------------------------------------- */

type Rel = GraphRelations["relations"][number];
type RelTo = Rel["to"][number];

/** The mark beside a related thing: a ring for a person, a square for a company (§2.6). */
function RelMark({ to }: { to: { title: string; type: string } }) {
  if (to.type === "person") return <Ring name={to.title} small />;
  if (to.type === "company") return <Square name={to.title} small />;
  if (to.type === "conversation") return <Icon name="chat" size={15} />;
  if (to.type === "project") return <Icon name="projects" size={15} />;
  return <Icon name="doc" size={15} />;
}

export interface SideProps {
  note: NoteDetail;
  /** What each linked note is, from the tree's tags: a person (#contact) or a company (#company). */
  kindOf: (id: string) => "person" | "company" | "note";
  /** Typed relations, when the vault has an ontology; null on a vault without one (links instead). */
  relations: Rel[] | null;
  related: { id: string; title: string }[];
  hrefOfId: (id: string) => string;
  onOpen: (id: string) => void;
  onTag: (tag: string) => void;
  onCheck: (t: NoteDetail["tasks"][number]) => void;
  onPromote: (t: NoteDetail["tasks"][number]) => void;
}

const stateOf = (t: NoteDetail["tasks"][number]): TaskState => (t.checked ? "done" : t.status === "in-progress" ? "progress" : t.status === "blocked" ? "blocked" : "open");

/**
 * About this note (structure.md §2.3, in this order): Relations in words, both directions and
 * grouped — the graph's first place outside the Orrery; then Tasks, Backlinks with a clean line
 * each, Outgoing links, what Orr thinks is related, and Tags.
 */
export function SidePanel(p: SideProps) {
  const { note } = p;
  const outgoing = note.links;
  const linksTo = outgoing.filter((l) => l.targetId && !l.locked);
  const seen = new Set<string>();
  const uniq = <T extends { id: string }>(xs: T[]) => xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  const name = (id: string, title: string, extra?: ReactNode, mark?: ReactNode) => (
    <a key={id} href={p.hrefOfId(id)} onClick={follow(() => p.onOpen(id))}>
      {mark}
      {title}
      {extra}
    </a>
  );
  // The note's own links, in words: what it mentions (the board), and, on a vault without an
  // ontology, what mentions it — there, links are all the graph there is. On a typed vault a
  // link the graph already tells as a relation is not said twice.
  const told = new Set((p.relations ?? []).flatMap((r) => r.to.map((t) => t.id)));
  seen.clear();
  const mentions = uniq(linksTo.map((l) => ({ id: l.targetId!, title: l.alias ?? l.target }))).filter((x) => !told.has(x.id) && x.id !== note.id);
  seen.clear();
  const mentionedIn = p.relations ? [] : uniq(note.backlinks.map((b) => ({ id: b.fromId, title: b.fromTitle })));
  const plain: { k: string; v: { id: string; title: string }[] }[] = [
    { k: "mentions", v: mentions },
    { k: "mentioned in", v: mentionedIn },
  ].filter((r) => r.v.length > 0);
  const linkMark = (id: string, title: string) => {
    const k = p.kindOf(id);
    return k === "person" ? <Ring name={title} small /> : k === "company" ? <Square name={title} small /> : null;
  };
  const tags = [...new Set(note.tags.map((t) => t.tag))];

  return (
    <aside className="nt-side" aria-label="About this note">
      <section aria-label="Relations">
        <h3>Relations</h3>
        {p.relations && p.relations.length + plain.length > 0 ? (
            <div className="rels">
              {p.relations.map((r) => (
                <div className="rel" key={r.relation}>
                  <span className="k">{relationWords(r.relation)}</span>
                  <span className="v">
                    {r.to.map((to: RelTo) =>
                      name(
                        to.id,
                        to.title,
                        to.through?.length ? <span className="q3 nt-via"> via {to.through.map((t) => t.title).join(", ")}</span> : to.text ? <span className="q3 nt-via"> not linked yet</span> : null,
                        <RelMark to={to} />,
                      ),
                    )}
                  </span>
                </div>
              ))}
              {plain.map((r) => (
                <div className="rel" key={r.k}>
                  <span className="k">{r.k}</span>
                  <span className="v">{r.v.map((x) => name(x.id, x.title, null, linkMark(x.id, x.title)))}</span>
                </div>
              ))}
            </div>
        ) : !p.relations && plain.length > 0 ? (
          <div className="rels">
            {plain.map((r) => (
              <div className="rel" key={r.k}>
                <span className="k">{r.k}</span>
                <span className="v">{r.v.map((x) => name(x.id, x.title, null, linkMark(x.id, x.title)))}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="nt-hint">{p.relations ? "Nothing in the graph points here yet." : "No links in or out yet."}</p>
        )}
      </section>

      {note.tasks.length > 0 && (
        <section aria-label="Tasks">
          <h3>
            Tasks <span className="c">{note.tasks.filter((t) => !t.checked).length}</span>
          </h3>
          <ul className="nt-tasks">
            {note.tasks.map((t) => (
              <li key={`${t.line}:${t.text}`} className={t.checked ? "done" : undefined}>
                <Checkbox state={stateOf(t)} label={t.text} onToggle={() => p.onCheck(t)} />
                <span className="nt-task-t">{t.text}</span>
                {t.blockId ? (
                  <span className="nt-promoted" title="Promoted: Planning keeps track of this task even when its words change" aria-label="Promoted">
                    <Icon name="bolt" size={14} />
                  </span>
                ) : (
                  note.canEdit && <Button kind="quiet" size="sm" icon="bolt" aria-label={`Promote “${t.text}”`} tip="Promote, so Planning keeps track of this task even when its words change" onClick={() => p.onPromote(t)} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Backlinks">
        <h3>
          Backlinks <span className="c">{note.backlinks.length}</span>
        </h3>
        {note.backlinks.length === 0 ? (
          <p className="nt-hint">No note links here yet.</p>
        ) : (
          note.backlinks.map((b, i) => (
            <a key={`${b.fromId}:${i}`} className="row nt-link" href={p.hrefOfId(b.fromId)} onClick={follow(() => p.onOpen(b.fromId))}>
              <span className="x">
                <span className="t">{b.fromTitle}</span>
                {b.context && <span className="m">“{snippet(b.context)}”</span>}
              </span>
            </a>
          ))
        )}
      </section>

      <section aria-label="Outgoing links">
        <h3>
          Outgoing links <span className="c">{outgoing.length}</span>
        </h3>
        {outgoing.length === 0 && <p className="nt-hint">This note links to nothing yet.</p>}
        {outgoing.map((l, i) =>
          l.locked ? (
            <span key={i} className="row nt-link locked" title="You don't have access to this note">
              <span className="x">
                <span className="t">
                  <Icon name="lock" size={14} /> {l.alias ?? l.target}
                </span>
              </span>
            </span>
          ) : l.targetId ? (
            <a key={i} className="row nt-link" href={p.hrefOfId(l.targetId)} onClick={follow(() => p.onOpen(l.targetId!))}>
              <span className="x">
                <span className="t">{l.alias ?? l.target}</span>
              </span>
            </a>
          ) : (
            <span key={i} className="row nt-link missing">
              <span className="x">
                <span className="t">{l.alias ?? l.target}</span>
                <span className="m">not written yet</span>
              </span>
            </span>
          ),
        )}
      </section>

      {p.related.length > 0 && (
        <section aria-label="Orr thinks these are related">
          <h3>
            <HeadMark size={14} />
            Orr thinks these are related
          </h3>
          {p.related.map((r) => (
            <a key={r.id} className="row nt-link" href={p.hrefOfId(r.id)} onClick={follow(() => p.onOpen(r.id))}>
              <span className="x">
                <span className="t">{r.title}</span>
              </span>
            </a>
          ))}
        </section>
      )}

      {tags.length > 0 && (
        <section aria-label="Tags">
          <h3>Tags</h3>
          <div className="nt-tags">
            {tags.map((t) => (
              <button key={t} type="button" onClick={() => p.onTag(t)} title={`Notes tagged #${t}`}>
                #{t}
              </button>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}

/** A note's area chip: its project (which opens it), or its life area (which filters the tree). */
export function AreaChip({ note, project, onArea }: { note: TreeNote | undefined; project: { slug: string; name: string } | null; onArea: (id: string) => void }) {
  const area = note ? categoryOf(note) : "other";
  const c = CATEGORIES.find((x) => x.id === area);
  if (project)
    return (
      <a className="chip" href={`/projects/${encodeURIComponent(project.slug)}`}>
        <span className="ui-dot" style={{ background: c?.color ?? "var(--c-other)" }} />
        {project.name}
      </a>
    );
  if (!c) return null;
  return (
    <button type="button" className="chip" onClick={() => onArea(c.id)} title={`Show only ${c.label} in the tree`}>
      <span className="ui-dot" style={{ background: c.color }} />
      {c.label}
    </button>
  );
}
