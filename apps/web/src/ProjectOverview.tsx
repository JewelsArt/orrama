/**
 * The project page's Overview tab (structure.md §2.5): one scroll, the note on the left, and on
 * the right, in this order, Decisions and the Inbox (the daily actions, at the top), the next
 * steps, the goals, People & companies (with *supervises* from the graph), Conversations
 * (`discussed_in`), Documents and the prompt. On the phone the right column comes first.
 *
 * Every module writes into the project note (sections.ts on the server): decisions and the
 * inbox are appended lines, goals and the prompt are sections written as sent, people are
 * `[[links]]` in `## People`. Documents are files in the project's folder.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteSync, SaveState } from "@orrama/sync/client";
import { api, isAbort, type Me, type NoteDetail } from "./api.js";
import { Confirm, type ConfirmRequest } from "./Confirm.js";
import { DocViewer } from "./DocViewer.js";
import { Editor } from "./Editor.js";
import { RelationRows, rolesOf, type RelationsState } from "./entity/index.js";
import { linkTo, slugOf } from "./entity/links.js";
import { openNoteSync, retire } from "./noteSync.js";
import { tabHref } from "./Project.js";
import { dueOf, RenameFileDialog, taskState, trashProjectFile, uploadProjectFiles, useTaskCard, type ProjectTask } from "./ProjectViews.js";
import { Button, Checkbox, Ring, Square } from "./ui/controls.js";
import { dateLabel } from "./ui/dates.js";
import { Input, SearchField, Textarea } from "./ui/fields.js";
import { Icon } from "./ui/Icon.js";
import { Module, Row, RowList } from "./ui/layout.js";
import { Menu, toast, type MenuItem } from "./ui/overlays.js";
import { navigate } from "./ui/router.js";
import { Notice } from "./ui/states.js";
import { attempt, useWrite } from "./ui/writes.js";
import { onWs } from "./ws.js";
import type { Company, Contact, ProjectCandidate, ProjectNote, ProjectPerson, ProjectWorkspace } from "@orrama/schema/responses";

const NEXT_STEPS = 5;
const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
/** "[[Westerdok]]" in a front-matter field reads "Westerdok". */
const plain = (s: string) => s.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").trim();
/** A link that opens inside the app on a plain click. */
const inApp = (e: React.MouseEvent, run: () => void) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  run();
};

export function ProjectOverview({
  w,
  me,
  relations,
  onChanged,
  onPatch,
  onOpenNote,
}: {
  w: ProjectWorkspace;
  me: Me;
  relations: RelationsState;
  onChanged: () => Promise<void>;
  onPatch: (body: Record<string, unknown>) => Promise<unknown>;
  onOpenNote: (id: string) => void;
}) {
  const slug = encodeURIComponent(w.slug);
  return (
    <div className="pj-ov">
      <article className="pj-doc" aria-label="The project note">
        <NoteEditor w={w} me={me} onOpenNote={onOpenNote} />
      </article>
      <div className="pj-side">
        <Log
          title="Decisions"
          section="decisions"
          tiles
          newestFirst
          w={w}
          items={w.decisions}
          placeholder="Log a decision…"
          onChanged={onChanged}
          onAdd={async (text) => {
            await api("POST", `/api/projects/${slug}/decisions`, { text });
            await onChanged();
          }}
        />
        <Log
          title="Inbox"
          section="inbox"
          newestFirst
          w={w}
          items={w.inbox}
          placeholder="A thought, a link, a follow-up…"
          asStep
          onChanged={onChanged}
          onAdd={async (text, task) => {
            await api("POST", `/api/projects/${slug}/capture`, { text, task });
            await onChanged();
          }}
        />
        <NextSteps w={w} onChanged={onChanged} onOpenNote={onOpenNote} />
        {(w.canEdit || w.goals.length > 0) && (
          <Log
            title="Goals"
            section="goals"
            w={w}
            items={w.goals}
            placeholder="Add a goal…"
            empty="No goals yet. What does done look like?"
            onChanged={onChanged}
            onAdd={async (text) => {
              await api("POST", `/api/projects/${slug}/goals`, { text });
              await onChanged();
            }}
          />
        )}
        <People w={w} relations={relations} onChanged={onChanged} onOpenNote={onOpenNote} />
        <Conversations relations={relations} onOpenNote={onOpenNote} />
        <Documents w={w} onChanged={onChanged} onOpenNote={onOpenNote} />
        <Prompt w={w} onSave={(prompt) => onPatch({ prompt })} />
      </div>
    </div>
  );
}

/* ---- the note itself, editable in place: the same editor as Notes ---------------------- */

function NoteEditor({ w, me, onOpenNote }: { w: ProjectWorkspace; me: Me; onOpenNote: (id: string) => void }) {
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [state, setState] = useState<SaveState | "idle">("idle");
  // A first load that failed says so with Retry, instead of "Opening the note…" for ever (WEB-010).
  const [loadFailed, setLoadFailed] = useState(false);
  const [tries, setTries] = useState(0);
  // The text goes through a NoteSync (packages/sync/src/client.ts). It used to load the note
  // once and never again, while Decisions, the Inbox and Goals on this same page write into
  // this same note on the server, so the next keystroke here saved stale text over the entry
  // just added.
  const [sync, setSync] = useState<NoteSync | null>(null);

  useEffect(() => {
    let live = true;
    let s: NoteSync | null = null;
    setLoadFailed(false);
    void (async () => {
      const n = await api<NoteDetail>("GET", `/api/vault/note/${w.noteId}`);
      if (!live) return;
      s = n.canEdit ? openNoteSync(n, { status: setState }, 700) : null;
      setNote(n);
      setSync(s);
    })().catch(() => {
      if (live) setLoadFailed(true);
    });
    const off = onWs((msg) => {
      if (msg.type === "note-changed" && (msg.noteId === w.noteId || msg.resync)) void s?.refresh();
    });
    return () => {
      live = false;
      off();
      retire(s);
    };
  }, [w.noteId, tries]);

  const completions = useMemo(
    () => ({ titles: [...w.people.map((p) => p.title), ...w.notes.map((n) => n.title)], users: [me.username], tags: [] as string[] }),
    [w.people, w.notes, me.username],
  );

  return (
    <>
      <div className="pj-doc-head">
        <a className="pj-path" href={`/notes/${w.path.replace(/\.md$/i, "").split("/").map(encodeURIComponent).join("/")}`} onClick={(e) => inApp(e, () => onOpenNote(w.noteId))}>
          Open in Notes
        </a>
        {state !== "idle" && <span className={state === "error" ? "pj-late" : undefined}>{state === "saving" ? "Saving…" : state === "error" ? "Not saved" : "Saved"}</span>}
      </div>
      {note ? (
        <div className="pj-editor">
          <Editor
            noteId={note.id}
            content={sync?.content ?? note.content}
            readOnly={!note.canEdit}
            completions={completions}
            onChange={(content) => sync?.edit(content)}
            sync={sync}
            onFollowLink={(title) => {
              const key = title.toLowerCase();
              const person = w.people.find((p) => p.title.toLowerCase() === key);
              if (person) return onOpenNote(person.id);
              // A [[chapter-2]] in the project note opens the chapter, not nothing because it
              // is not a contact.
              const n = w.notes.find((x) => x.title.toLowerCase() === key || x.path.replace(/^.*\//, "").replace(/\.md$/i, "").toLowerCase() === key);
              if (n) onOpenNote(n.id);
            }}
          />
        </div>
      ) : loadFailed ? (
        <Notice
          title="The note didn't open."
          text="The server didn't answer. Check it's running, then try again."
          actions={
            <Button size="sm" onClick={() => setTries((n) => n + 1)}>
              Retry
            </Button>
          }
        />
      ) : (
        <p className="q3">Opening the note…</p>
      )}
    </>
  );
}

/* ---- Decisions and the Inbox: the daily actions ---------------------------------------- */

/** "- **2026-10-06** — MASE over MAPE" → its day and its words. */
export function decisionOf(item: string): { day: string; text: string } {
  const m = /^\*\*(\d{4}-\d{2}-\d{2})\*\*\s*[—–-]\s*(.*)$/.exec(item.trim());
  return m ? { day: m[1]!, text: m[2]! } : { day: "", text: item.replace(/\*\*/g, "") };
}

type LineSection = "decisions" | "inbox" | "goals";

/**
 * Decisions, the Inbox and Goals: lines of the project note's `##` sections, added at the end
 * and each changed or removed from its ⋯ (an inbox line can also become a step under the
 * steps). A line is named to the server by its place and its words as the page saw them, so a
 * note changed since is refused, not edited in the wrong place.
 */
function Log({
  title,
  section,
  tiles,
  newestFirst,
  w,
  items,
  placeholder,
  empty,
  asStep,
  onAdd,
  onChanged,
}: {
  title: string;
  section: LineSection;
  /** Clay draws the lines as grey tiles (Decisions, on its board). */
  tiles?: boolean;
  /** Decisions and the Inbox show the newest line first; Goals keep the note's order. */
  newestFirst?: boolean;
  w: ProjectWorkspace;
  items: string[];
  placeholder: string;
  /** Said when there are no lines yet. */
  empty?: string;
  /** The Inbox can take a line as a step (a checkbox) instead. */
  asStep?: boolean;
  onAdd: (text: string, task: boolean) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [task, setTask] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const canEdit = w.canEdit;
  // Each line keeps its place in the section: that is how the server finds it again.
  const lines = items.map((item, index) => ({ item, index }));
  const shown = newestFirst ? lines.slice().reverse() : lines;
  const cap = all ? shown.length : newestFirst ? 4 : 8;
  const base = `/api/projects/${encodeURIComponent(w.slug)}/lines`;
  const what = section === "decisions" ? "decision" : section === "goals" ? "goal" : "line";
  const change = async (index: number, item: string, to: string) => {
    await api("PATCH", base, { section, index, text: item, to });
    await onChanged();
  };
  const remove = (index: number, item: string) =>
    setConfirm({
      title: `Remove this ${what}?`,
      body: `“${decisionOf(item).text}” comes out of the project note.`,
      confirmLabel: "Remove",
      danger: true,
      failed: `The ${what} wasn't removed.`,
      onConfirm: async () => {
        await api("POST", `${base}/remove`, { section, index, text: item });
        await onChanged();
      },
    });
  const toStep = (index: number, item: string) =>
    void attempt("The line wasn't made a step.", async () => {
      await api("POST", `${base}/step`, { section, index, text: item });
      await onChanged();
      toast("It's a step now, with the other steps.");
    });
  return (
    <Module title={title} count={items.length || undefined} className={tiles ? "pj-log tiles" : "pj-log"}>
      {canEdit && (
        <form
          className="pj-addline"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim() || busy) return;
            setBusy(true);
            setFailed(false);
            try {
              await onAdd(text.trim(), task);
              setText("");
            } catch {
              setFailed(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={`Add to ${title}`} />
          <Button type="submit" disabled={busy}>
            Add
          </Button>
          {asStep && (
            <label className="pj-asstep">
              <input type="checkbox" checked={task} onChange={(e) => setTask(e.target.checked)} /> as a step
            </label>
          )}
        </form>
      )}
      {failed && <Notice title={`Not added to ${title}`} text="The note could not be written. Your words are still in the field: try again." />}
      {shown.length === 0 && empty && <p className="q3 pj-none">{empty}</p>}
      {shown.length > 0 && (
        <ul className="pj-lines">
          {shown.slice(0, cap).map(({ item, index }) => (
            <LogLine
              key={`${index}-${item}`}
              item={item}
              label={title}
              canEdit={canEdit}
              editing={editing === index}
              onEdit={() => setEditing(index)}
              onCancel={() => setEditing(null)}
              onSave={async (to) => {
                await change(index, item, to);
                setEditing(null);
              }}
              actions={[
                { label: "Change", onSelect: () => setEditing(index) },
                ...(asStep ? [{ label: "Make it a step", onSelect: () => toStep(index, item) }] : []),
                { label: "Remove", danger: true, onSelect: () => remove(index, item) },
              ]}
            />
          ))}
        </ul>
      )}
      {shown.length > cap && (
        <button type="button" className="pj-more" onClick={() => setAll(true)}>
          {shown.length - cap} more
        </button>
      )}
      <Confirm request={confirm} onClose={() => setConfirm(null)} />
    </Module>
  );
}

/**
 * One line: its day (a decision's), its words, and its ⋯ beside it (shown on pointing or focus,
 * always on touch). Change turns the words into a field in place: Enter saves, Escape leaves.
 */
function LogLine({
  item,
  label,
  canEdit,
  editing,
  actions,
  onEdit,
  onCancel,
  onSave,
}: {
  item: string;
  label: string;
  canEdit: boolean;
  editing: boolean;
  actions: MenuItem[];
  onEdit: () => void;
  onCancel: () => void;
  onSave: (to: string) => Promise<void>;
}) {
  const d = decisionOf(item);
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState(d.text);
  const save = useWrite();
  const at = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (editing) setDraft(d.text);
  }, [editing, d.text]);
  return (
    <li className={`${d.day ? "dated" : ""}${canEdit ? " has-act" : ""}${menu ? " open" : ""}`.trim() || undefined}>
      {d.day && <span className="pj-day">{dateLabel(d.day)}</span>}
      {editing ? (
        <form
          className="pj-lineform"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            void save.run(`The ${label.toLowerCase()} line wasn't changed.`, () => onSave(draft.trim()));
          }}
        >
          <Input
            autoFocus
            value={draft}
            aria-label={`Change: ${d.text}`}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                onCancel();
              }
            }}
          />
          <Button type="submit" size="sm" disabled={save.busy || !draft.trim()}>
            Save
          </Button>
          <Button size="sm" kind="quiet" onClick={onCancel}>
            Cancel
          </Button>
          {save.error && <Notice title={save.error} />}
        </form>
      ) : (
        <span onDoubleClick={canEdit ? onEdit : undefined}>{d.text}</span>
      )}
      {canEdit && !editing && (
        <>
          <Button ref={at} kind="quiet" size="sm" icon="dots" className="pj-line-act" aria-label={`More for ${d.text}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} />
          {menu && <Menu anchor={at} align="end" label={d.text} onClose={() => setMenu(false)} items={actions} />}
        </>
      )}
    </li>
  );
}

/* ---- the next steps: late first, then by date ------------------------------------------ */

function NextSteps({ w, onChanged, onOpenNote }: { w: ProjectWorkspace; onChanged: () => Promise<void>; onOpenNote: (id: string) => void }) {
  const card = useTaskCard(onChanged, onOpenNote);
  const open = (w.tasks as ProjectTask[]).filter((t) => !t.checked);
  const steps = open
    .slice()
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || Number(b.status === "in-progress") - Number(a.status === "in-progress"))
    .slice(0, NEXT_STEPS);
  const check = (t: ProjectTask) =>
    attempt(t.checked ? "The step wasn't unticked." : "The step wasn't ticked.", async () => {
      await api("POST", "/api/tasks/check", { noteId: t.noteId, line: t.line, blockId: t.blockId, text: t.text, checked: !t.checked });
      await onChanged();
    });
  return (
    <Module
      title="Next steps"
      count={open.length}
      link={open.length > NEXT_STEPS ? { label: "All →", href: tabHref(w.slug, "todo"), onOpen: () => navigate(tabHref(w.slug, "todo")) } : undefined}
    >
      {steps.length === 0 ? (
        <p className="q3 pj-none">{w.total === 0 ? "No steps yet. Add one, or write a checkbox in the note." : "Every step is done."}</p>
      ) : (
        <RowList label="Next steps">
          {steps.map((t) => {
            const due = dueOf(t);
            return (
              <Row
                key={`${t.noteId}:${t.line}`}
                className="pj-step"
                lead={<Checkbox state={taskState(t)} label={`Done: ${t.text}`} onToggle={w.canEdit ? () => void check(t) : undefined} />}
                title={
                  <>
                    {t.text}
                    {t.status === "blocked" && <span className="q3"> · blocked</span>}
                    {t.key && <span className="chip-dl s pj-key">Key deadline</span>}
                  </>
                }
                titleAttr={t.text}
                trailing={due.text}
                late={due.late}
                onOpen={() => void card.open(t)}
              />
            );
          })}
        </RowList>
      )}
      {card.node}
    </Module>
  );
}

/* ---- People & companies -------------------------------------------------------------- */

interface Person {
  id: string;
  title: string;
  kind: "person" | "company";
  sub: string;
  /** Linked from the note (`## People` or the text): Remove deletes that link. */
  linked: ProjectPerson | null;
  /** Named in the project's `involves:`: Remove takes the name out of it too. */
  involves: boolean;
  /** Their own note says they supervise it (`supervises:`): taken off there. */
  supervises: boolean;
}

type PoolEntry = { id: string; name: string; sub: string; kind: "person" | "company"; path: string };

/**
 * Who works on the project. A name opens their own page (`/people/<slug>`, `/companies/<slug>`),
 * as everywhere else (§1.7); taking someone off this project is the row's ⋯ menu, and only
 * drops the `[[link]]` from the project note, never their note.
 */
function People({ w, relations, onChanged, onOpenNote }: { w: ProjectWorkspace; relations: RelationsState; onChanged: () => Promise<void>; onOpenNote: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [pool, setPool] = useState<PoolEntry[] | null>(null);
  const [failed, setFailed] = useState<"attach" | "remove" | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const roles = useMemo(() => rolesOf(relations.by), [relations.by]);

  // The note's links, then whoever the graph says is involved or supervises without a link
  // in the note (a supervisor's own `supervises:` field).
  const people = useMemo(() => {
    const has = (rel: string, id: string) => (relations.by.get(rel) ?? []).some((r) => r.id === id);
    const out = new Map<string, Person>();
    for (const p of w.people)
      out.set(p.id, { id: p.id, title: p.title, kind: p.kind === "company" ? "company" : "person", sub: plain([p.role, p.company].filter(Boolean).join(" · ")), linked: p, involves: has("involves", p.id), supervises: has("supervised_by", p.id) });
    for (const rel of ["supervised_by", "involves", "company_involved_in", "involves_company"])
      for (const r of relations.by.get(rel) ?? [])
        if (!out.has(r.id) && (r.type === "person" || r.type === "company"))
          out.set(r.id, { id: r.id, title: r.title, kind: r.type, sub: "", linked: null, involves: has("involves", r.id), supervises: has("supervised_by", r.id) });
    return [...out.values()];
  }, [w.people, relations.by]);
  // Someone the graph names but the note does not link: their page is found by the file name,
  // which only People's lists carry.
  const needPool = people.some((p) => !p.linked);

  useEffect(() => {
    if ((q.trim() === "" && !needPool) || pool) return;
    const ac = new AbortController();
    Promise.all([
      api<Contact[]>("GET", "/api/contacts", undefined, { signal: ac.signal }),
      api<Company[]>("GET", "/api/companies", undefined, { signal: ac.signal }),
    ])
      .then(([contacts, companies]) =>
        setPool([
          ...contacts.map((c) => ({ id: c.id, name: c.name, sub: plain([c.role, c.company].filter(Boolean).join(" · ")), kind: "person" as const, path: c.path })),
          ...companies.map((c) => ({ id: c.id, name: c.name, sub: c.sector, kind: "company" as const, path: c.path })),
        ]),
      )
      .catch((e) => {
        if (!isAbort(e)) setPool([]);
      });
    return () => ac.abort();
  }, [q, pool, needPool]);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle || !pool) return [];
    const have = new Set(people.map((p) => p.id));
    return pool.filter((p) => !have.has(p.id) && `${p.name} ${p.sub}`.toLowerCase().includes(needle)).slice(0, 6);
  }, [q, pool, people]);

  const attach = async (id: string) => {
    setFailed(null);
    try {
      await api("POST", `/api/projects/${encodeURIComponent(w.slug)}/people`, { noteId: id });
      setQ("");
      await onChanged();
    } catch {
      setFailed("attach");
    }
  };

  /** "No longer supervises": the project comes out of their own `supervises:`. */
  const unsupervise = (p: Person) =>
    setConfirm({
      title: `${p.title} no longer supervises ${w.name}?`,
      body: `This takes ${w.name} out of what ${p.title} supervises, in their note. Nothing else changes.`,
      confirmLabel: "Take it off",
      danger: true,
      onConfirm: async () => {
        setFailed(null);
        try {
          await api("DELETE", `/api/contacts/${p.id}/supervises/${w.noteId}`);
          await onChanged();
        } catch {
          setFailed("remove");
        }
      },
    });

  const remove = (p: Person) =>
    setConfirm({
      title: `Take ${p.title} off ${w.name}?`,
      // Remove takes the link out of `## People` only: someone the note's text links too stays.
      body: `This removes the link from the project note. Their own note stays as it is.${p.linked?.inText ? " They are still mentioned elsewhere in the project note, so they stay listed." : ""}${p.supervises ? " They still supervise it, so they stay listed." : ""}`,
      confirmLabel: "Take them off",
      danger: true,
      onConfirm: async () => {
        setFailed(null);
        try {
          await api("DELETE", `/api/projects/${encodeURIComponent(w.slug)}/people/${p.id}`);
          await onChanged();
        } catch {
          setFailed("remove");
        }
      },
    });

  /** Their page, by the file name; a note People does not list (no `#contact`/`#company`) opens in Notes. */
  const linkOf = (p: Person) => {
    const path = p.linked?.path ?? pool?.find((x) => x.id === p.id && x.kind === p.kind)?.path;
    return path ? linkTo({ kind: p.kind, slug: slugOf(path) }) : { onOpen: () => onOpenNote(p.id) };
  };

  return (
    <Module title="People & companies" count={people.length} className="pj-people tiles">
      {people.length > 0 && (
        <RowList label="People and companies">
          {people.map((p) => (
            <PersonRow
              key={p.id}
              p={p}
              word={roles.get(p.id) ?? "involved"}
              link={linkOf(p)}
              actions={
                w.canEdit
                  ? [
                      ...(p.linked || p.involves ? [{ label: "Remove from this project", danger: true, onSelect: () => remove(p) }] : []),
                      ...(p.supervises && p.kind === "person" ? [{ label: "No longer supervises", danger: true, onSelect: () => unsupervise(p) }] : []),
                    ]
                  : []
              }
            />
          ))}
        </RowList>
      )}
      {people.length === 0 && !w.canEdit && <p className="q3 pj-none">Nobody linked yet.</p>}
      {w.canEdit && (
        <div className="pj-picker">
          <SearchField label="Attach a person or company" placeholder="Attach a person or company…" value={q} onChange={(e) => setQ(e.target.value)} />
          {matches.length > 0 && (
            <RowList label="Matches">
              {matches.map((m) => (
                <Row key={m.id} lead={m.kind === "company" ? <Square name={m.name} small /> : <Ring name={m.name} small />} title={m.name} meta={m.sub || undefined} trailing="Attach" onOpen={() => void attach(m.id)} />
              ))}
            </RowList>
          )}
          {q.trim() && pool && matches.length === 0 && <p className="q3 pj-none">Nobody by that name who is not here already.</p>}
        </div>
      )}
      {failed === "attach" && <Notice title="Not attached" text="The link could not be written into the note. Try again." />}
      {failed === "remove" && <Notice title="Not removed" text="The link could not be taken out of the note. Try again." />}
      <Confirm request={confirm} onClose={() => setConfirm(null)} />
    </Module>
  );
}

/**
 * One person or company: the row is the link to their page, and the ⋯ beside it (never inside
 * it) holds Remove from this project.
 */
function PersonRow({ p, word, link, actions }: { p: Person; word: string; link: { href?: string; onOpen: () => void }; actions: MenuItem[] }) {
  return (
    <MenuRow
      label={p.title}
      actions={actions}
      row={{ className: "ent-rel", lead: p.kind === "company" ? <Square name={p.title} small /> : <Ring name={p.title} small />, title: p.title, meta: p.sub || undefined, trailing: word, href: link.href, onOpen: link.onOpen }}
    />
  );
}

/**
 * A row with its ⋯ beside it (never inside it): People's rows, Documents' notes and files. The
 * ⋯ shows on pointing or focus, and always on a touch screen or a phone-wide window, so
 * nothing is hover-only.
 */
export function MenuRow({ label, actions, row }: { label: string; actions: MenuItem[]; row: Parameters<typeof Row>[0] }) {
  const [menu, setMenu] = useState(false);
  const at = useRef<HTMLButtonElement>(null);
  const has = actions.length > 0;
  return (
    <div className={`pj-who${has ? " has-act" : ""}${menu ? " open" : ""}`}>
      <Row {...row} />
      {has && (
        <>
          <Button ref={at} kind="quiet" size="sm" icon="dots" className="pj-who-act" aria-label={`More for ${label}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} />
          {menu && <Menu anchor={at} align="end" label={label} onClose={() => setMenu(false)} items={actions} />}
        </>
      )}
    </div>
  );
}

/* ---- Conversations: what the graph says is about this project ---------------------------- */

function Conversations({ relations, onOpenNote }: { relations: RelationsState; onOpenNote: (id: string) => void }) {
  const talks = (relations.by.get("discussed_in") ?? []).filter((r) => r.type === "conversation");
  if (talks.length === 0) return null;
  return (
    <Module title="Conversations" count={talks.length}>
      <RelationRows label="Conversations" items={talks.map((c) => ({ id: c.id, title: c.title, kind: "conversation", onOpen: () => onOpenNote(c.id) }))} />
    </Module>
  );
}

/* ---- Documents: the project's notes and the files beside it --------------------------- */

function Documents({ w, onChanged, onOpenNote }: { w: ProjectWorkspace; onChanged: () => Promise<void>; onOpenNote: (id: string) => void }) {
  const [busy, setBusy] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [reading, setReading] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const slug = encodeURIComponent(w.slug);
  const upload = async (files: FileList | File[]) => {
    setErrors([]);
    const failed: string[] = [];
    await uploadProjectFiles(w.slug, files, (name) => setBusy(name), (msg) => failed.push(msg));
    setBusy("");
    setErrors(failed);
    await onChanged();
  };
  /** Take a note off the project: its tag goes, the note stays; Undo puts the tag back. */
  const takeOff = (n: ProjectNote) =>
    void attempt(`“${n.title}” wasn't taken off the project.`, async () => {
      await api("DELETE", `/api/projects/${slug}/notes/${encodeURIComponent(n.id)}`);
      await onChanged();
      toast(`“${n.title}” is no longer part of ${w.name}. The note stays where it is.`, {
        action: { label: "Undo", run: () => void attempt(`“${n.title}” wasn't put back.`, () => api("POST", `/api/projects/${slug}/notes`, { noteId: n.id }).then(onChanged)) },
      });
    });
  const count = w.notes.length + w.files.length;
  const cap = all ? Infinity : 6;
  const notes = w.notes.slice(0, cap);
  const files = w.files.slice(0, Math.max(0, cap - notes.length));
  return (
    <Module
      title="Documents"
      count={count}
      className={`pj-docs${over ? " over" : ""}`}
      link={{ label: "Board →", href: tabHref(w.slug, "documents"), onOpen: () => navigate(tabHref(w.slug, "documents")) }}
    >
      <div
        onDragOver={(e) => {
          if (!w.canEdit) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (w.canEdit && e.dataTransfer.files.length) void upload(e.dataTransfer.files);
        }}
      >
        {count === 0 ? (
          <p className="q3 pj-none">{w.canEdit ? "No documents yet. Upload a file or drop it here, or add a note you already have." : "No documents yet."}</p>
        ) : (
          <RowList label="Documents">
            {notes.map((n) => (
              <MenuRow
                key={n.id}
                label={n.title}
                actions={w.canEdit ? [{ label: "Open the note", onSelect: () => onOpenNote(n.id) }, { label: "Take off the project", danger: true, onSelect: () => takeOff(n) }] : []}
                row={{ lead: <Icon name="notes" size={18} />, title: n.title, meta: n.tasks > 0 ? `${n.done} of ${n.tasks} steps` : "note", onOpen: () => onOpenNote(n.id) }}
              />
            ))}
            {files.map((f) => (
              <MenuRow
                key={f.name}
                label={f.name}
                actions={
                  w.canEdit
                    ? [
                        { label: "Open", onSelect: () => setReading(f.name) },
                        { label: "Rename…", onSelect: () => setRenaming(f.name) },
                        { label: "Move to the trash", danger: true, onSelect: () => void trashProjectFile(w, f.name, onChanged) },
                      ]
                    : []
                }
                row={{ lead: <span className="pj-ext">{(f.ext || ".?").slice(1, 5).toUpperCase()}</span>, title: f.name, meta: kb(f.size), onOpen: () => setReading(f.name) }}
              />
            ))}
          </RowList>
        )}
        {count > cap && (
          <button type="button" className="pj-more" onClick={() => setAll(true)}>
            {count - cap} more
          </button>
        )}
        {w.canEdit && (
          <div className="pj-upload">
            <input
              ref={input}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void upload(e.target.files);
                e.target.value = "";
              }}
            />
            <Button size="sm" icon="upload" onClick={() => input.current?.click()} disabled={!!busy}>
              {busy ? `Uploading ${busy}…` : "Upload"}
            </Button>
            <Button size="sm" icon="plus" kind="quiet" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
              Add a note
            </Button>
          </div>
        )}
        {adding && <AddNote w={w} onAdded={onChanged} onClose={() => setAdding(false)} />}
      </div>
      {errors.length > 0 && <Notice title={errors.length === 1 ? "A file was not uploaded" : `${errors.length} files were not uploaded`} text={errors.join(" · ")} />}
      {reading && <DocViewer base={`/api/projects/${slug}/files`} name={reading} onClose={() => setReading(null)} />}
      {renaming && <RenameFileDialog w={w} name={renaming} onDone={onChanged} onClose={() => setRenaming(null)} />}
    </Module>
  );
}

/**
 * Add a note you already have: search your notes by name, pick one, and it joins the project
 * (its properties get the project's tag). A note in another project says so, and moves.
 */
function AddNote({ w, onAdded, onClose }: { w: ProjectWorkspace; onAdded: () => Promise<void>; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<ProjectCandidate[] | null>(null);
  const slug = encodeURIComponent(w.slug);
  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => {
      api<ProjectCandidate[]>("GET", `/api/projects/${slug}/notes/candidates?q=${encodeURIComponent(q.trim())}`, undefined, { signal: ac.signal }).then(setFound, (e) => {
        if (!isAbort(e)) setFound([]);
      });
    }, 150);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q, slug]);
  const add = (n: ProjectCandidate) =>
    void attempt(`“${n.title}” wasn't added.`, async () => {
      await api("POST", `/api/projects/${slug}/notes`, { noteId: n.id });
      await onAdded();
      toast(n.project ? `“${n.title}” moved here from ${n.project}.` : `“${n.title}” is part of ${w.name} now.`);
      onClose();
    });
  return (
    <div className="pj-picker pj-addnote">
      <SearchField label="Find a note to add" placeholder="Find a note to add…" autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} />
      {found && found.length > 0 && (
        <RowList label="Notes you can add">
          {found.slice(0, 8).map((n) => (
            <Row key={n.id} lead={<Icon name="notes" size={18} />} title={n.title} meta={n.project ? `in ${n.project}` : undefined} trailing="Add" onOpen={() => add(n)} />
          ))}
        </RowList>
      )}
      {found && found.length === 0 && <p className="q3 pj-none">{q.trim() ? "No note by that name that isn't here already." : "Every note you can change is here already."}</p>}
    </div>
  );
}

/* ---- the prompt: the standing context the agent reads through MCP `get_project` ------------ */

function Prompt({ w, onSave }: { w: ProjectWorkspace; onSave: (text: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState(w.prompt);
  const [saved, setSaved] = useState(false);
  const save = useWrite();
  useEffect(() => setDraft(w.prompt), [w.prompt]);
  return (
    <Module title="The prompt" className="pj-prompt">
      <p className="q3 pj-hint">What Orr, and Claude when it works with your notes, should always know about this project.</p>
      <form
        className="pj-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run("The prompt wasn't saved.", () => onSave(draft)).then((ok) => {
            if (!ok) return;
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          });
        }}
      >
        <Textarea
          rows={4}
          value={draft}
          disabled={!w.canEdit}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="You are helping with… Always check the latest export before…"
          aria-label="Project prompt"
        />
        {save.error && <Notice title={save.error} />}
        {w.canEdit && (
          <div className="acts">
            <Button type="submit" disabled={save.busy || (draft === w.prompt && !saved)}>
              {saved ? "Saved" : "Save the prompt"}
            </Button>
          </div>
        )}
      </form>
    </Module>
  );
}
