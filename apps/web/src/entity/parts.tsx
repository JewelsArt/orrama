/**
 * The entity page's blocks (structure.md §2.6, board mockups/screens/notes-entity.html): facts
 * from the front matter in one box, relations in words, how you know someone, what is going on
 * with them, then the note (the live editor) or a conversation's turns. Built on R8's header and
 * the system's module and rows; every name opens its thing (§1.7 #1).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { NoteSync, SaveState } from "@basalt/sync/client";
import { api, isAbort, type NoteDetail } from "../api.js";
import { CATEGORIES } from "../categories.js";
import { Editor } from "../Editor.js";
import { openNoteSync, retire } from "../noteSync.js";
import { noteForLink } from "../notes/links.js";
import { NameLink, Ring, Square } from "../ui/controls.js";
import { Icon } from "../ui/Icon.js";
import { navigate, type Route } from "../ui/router.js";
import { onWs } from "../ws.js";
import type { KnownData } from "./known.js";
import { anchor, linkTo, notePath, routeOf, type Known } from "./links.js";
import type { Brief, Group, PathStep, Turn } from "./model.js";

// One empty tree for every render before the lists arrive: a fresh [] would
// recompute the editor's completions on each render (react-hooks/exhaustive-deps).
const NO_TREE: KnownData["tree"] = [];

/** Where a related note opens, from its id: the tree knows its path. */
export function useHref(data: KnownData | null, known: Known | null) {
  const paths = useMemo(() => new Map((data?.tree ?? []).map((n) => [n.id, n])), [data]);
  return useMemo(
    () => (b: { id: string; type: string }): Route | null => {
      const n = paths.get(b.id);
      return n && known ? routeOf({ id: b.id, path: n.path, type: b.type }, known) : null;
    },
    [paths, known],
  );
}

/** The life area's colour of a note, for a project's dot. */
export function useAreaColor(data: KnownData | null) {
  const areas = useMemo(() => new Map((data?.tree ?? []).map((n) => [n.id, n.category])), [data]);
  return (id: string) => CATEGORIES.find((c) => c.id === areas.get(id))?.color ?? "var(--c-other)";
}

/** The small mark before a name: a ring, a square, a project's area dot, a chat or a page. */
export function Mark({ b, color }: { b: Brief; color?: string }) {
  if (b.type === "person") return <Ring name={b.title} small />;
  if (b.type === "company") return <Square name={b.title} small />;
  if (b.type === "project") return <span className="ui-dot" style={{ background: color ?? "var(--c-other)" }} aria-hidden="true" />;
  return <Icon name={b.type === "conversation" ? "chat" : "notes"} size={15} />;
}

/** A related name: its mark and its title, opening its thing (or plain text when it has no page). */
export function Named({ b, to, color }: { b: Brief; to: Route | null; color?: string }) {
  const inner = (
    <>
      <Mark b={b} color={color} />
      {b.title}
    </>
  );
  return to ? (
    <NameLink {...linkTo(to)}>
      <span className="ent-named">{inner}</span>
    </NameLink>
  ) : (
    <span className="ent-named">{inner}</span>
  );
}

/* ---- facts --------------------------------------------------------------------------------- */

export interface FactItem {
  k: string;
  v: ReactNode;
}

/** The front matter that says who or what this is, in one box (the board's four across). */
export function Facts({ items }: { items: FactItem[] }) {
  if (items.length === 0) return null;
  return (
    <dl className="ent-facts" data-n={Math.min(items.length, 4)}>
      {items.map((f) => (
        <div key={f.k}>
          <dt>{f.k}</dt>
          <dd>{f.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---- relations, in words ------------------------------------------------------------------ */

const SHOWN = 3;

function GroupRow({ g, hrefOf, colorOf }: { g: Group; hrefOf: (b: Brief) => Route | null; colorOf: (id: string) => string }) {
  const [all, setAll] = useState(false);
  const items = all ? g.items : g.items.slice(0, SHOWN);
  return (
    <div className="ent-rel-row">
      <span className="k">{g.word}</span>
      <span className="v">
        {items.map((b) => (
          <span key={b.id} className="ent-rel-item">
            <Named b={b} to={hrefOf(b)} color={colorOf(b.id)} />
            {b.note && <small>{b.note}</small>}
          </span>
        ))}
        {!all && g.items.length > SHOWN && (
          <button type="button" className="ent-more" onClick={() => setAll(true)}>
            + {g.items.length - SHOWN} more
          </button>
        )}
      </span>
    </div>
  );
}

/** "How Ines relates · from your notes": each relation in words, both directions. */
export function RelationsBlock({ title, groups, hrefOf, colorOf, plain }: { title: string; groups: Group[]; hrefOf: (b: Brief) => Route | null; colorOf: (id: string) => string; plain: boolean }) {
  if (groups.length === 0) return null;
  return (
    <section className="ent-block" aria-label={title}>
      <h2>
        {title} <span className="c">{plain ? "links in your notes" : "from your notes"}</span>
      </h2>
      <div className="ent-rels">
        {groups.map((g) => (
          <GroupRow key={g.key} g={g} hrefOf={hrefOf} colorOf={colorOf} />
        ))}
      </div>
    </section>
  );
}

/* ---- how you know them -------------------------------------------------------------------- */

/** "How you know Camille Roux · a path through your notes": you, each step's word, them. */
export function PathBlock({ name, steps, hrefOf, colorOf }: { name: string; steps: PathStep[]; hrefOf: (b: Brief) => Route | null; colorOf: (id: string) => string }) {
  return (
    <section className="ent-block ent-hide-phone" aria-label={`How you know ${name}`}>
      <h2>
        How you know {name} <span className="c">a path through your notes</span>
      </h2>
      <div className="ent-path">
        <Named b={steps[0]!.from} to={hrefOf(steps[0]!.from)} color={colorOf(steps[0]!.from.id)} />
        {steps.map((s, i) => (
          <span key={i} className="ent-step">
            <span className="arrow">{s.relation.replace(/_/g, " ")} →</span>
            <Named b={s.to} to={hrefOf(s.to)} color={colorOf(s.to.id)} />
          </span>
        ))}
      </div>
    </section>
  );
}

/* ---- the note ------------------------------------------------------------------------------ */

/** The note itself, below, in the live editor (R7's): typing saves through the note's sync. */
export function useNote(noteId: string | null | undefined) {
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [sync, setSync] = useState<NoteSync | null>(null);
  const [state, setState] = useState<SaveState | "idle">("idle");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!noteId) return;
    let live = true;
    let s: NoteSync | null = null;
    const ac = new AbortController();
    setNote(null);
    setFailed(false);
    api<NoteDetail>("GET", `/api/vault/note/${noteId}`, undefined, { signal: ac.signal })
      .then((n) => {
        if (!live) return;
        s = n.canEdit ? openNoteSync(n, { status: setState }, 700) : null;
        setNote(n);
        setSync(s);
      })
      .catch((e) => !isAbort(e) && live && setFailed(true));
    const off = onWs((msg) => {
      if (msg.type === "note-changed" && (msg.noteId === noteId || msg.resync)) void s?.refresh();
    });
    return () => {
      live = false;
      ac.abort();
      off();
      retire(s);
    };
  }, [noteId]);
  return { note, sync, state, failed };
}

export function NoteBlock({
  title,
  note,
  sync,
  state,
  data,
  known,
}: {
  title: string;
  note: NoteDetail | null;
  sync: NoteSync | null;
  state: SaveState | "idle";
  data: KnownData | null;
  known: Known | null;
}) {
  const tree = data?.tree ?? NO_TREE;
  const completions = useMemo(() => ({ titles: tree.map((n) => n.title), users: [], tags: [] as string[] }), [tree]);
  if (!note) return null;
  return (
    <section className="ent-block ent-note" aria-label={title}>
      <h2>
        {title}
        <a className="c ent-path-link" {...anchor(linkTo({ kind: "notes", path: notePath(note.path) }))} title="Open in Notes">
          {note.path}
        </a>
        {state !== "idle" && <span className={`c${state === "error" ? " late" : ""}`}>{state === "saving" ? "Saving…" : state === "error" ? "Not saved" : "Saved"}</span>}
      </h2>
      <div className="ent-editor">
        <Editor
          noteId={note.id}
          content={sync?.content ?? note.content}
          readOnly={!note.canEdit}
          completions={completions}
          onChange={(content) => sync?.edit(content)}
          sync={sync}
          onFollowLink={(target) => {
            const id = noteForLink(target, note.links, tree);
            const hit = id ? tree.find((n) => n.id === id) : undefined;
            if (hit && known) navigate(routeOf({ id: hit.id, path: hit.path }, known));
          }}
        />
      </div>
    </section>
  );
}

/* ---- a conversation's turns --------------------------------------------------------------- */

/** Bold, italic and code inside a line, as elements (never as HTML). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[\[([^\]|]+)(?:\|([^\]]+))?\]\])/g;
  let at = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<b key={i++}>{t.slice(2, -2)}</b>);
    else if (t.startsWith("`")) out.push(<code key={i++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("[[")) out.push(<span key={i++} className="ent-wl">{m[3] ?? m[2]}</span>);
    else out.push(<em key={i++}>{t.slice(1, -1)}</em>);
    at = m.index + t.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** A turn's text: paragraphs, quotes, list items and code, as elements. */
function TurnText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let para: string[] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      if (code) {
        blocks.push(
          <pre key={blocks.length}>
            <code>{code.join("\n")}</code>
          </pre>,
        );
        code = null;
      } else {
        flush();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(raw);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (quote) {
      flush();
      blocks.push(<blockquote key={blocks.length}>{inline(quote[1]!)}</blockquote>);
    } else if (item) {
      flush();
      blocks.push(
        <p key={blocks.length} className="li">
          {inline(item[1]!)}
        </p>,
      );
    } else para.push(line.trim());
  }
  if (code) blocks.push(<pre key={blocks.length}><code>{(code as string[]).join("\n")}</code></pre>);
  flush();
  return <>{blocks}</>;
}

export function Turns({ turns, you }: { turns: Turn[]; you: string }) {
  return (
    <section className="ent-block ent-turns" aria-label="The conversation">
      <h2>The conversation</h2>
      <ol>
        {turns.map((t, i) => (
          <li key={i} className={t.speaker.toLowerCase() === you.toLowerCase() ? "ent-you" : undefined}>
            <span className="ent-who">{t.speaker}</span>
            <div className="ent-said">
              <TurnText text={t.text} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
