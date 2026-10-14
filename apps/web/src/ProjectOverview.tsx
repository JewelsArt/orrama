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
import type { NoteSync, SaveState } from "@basalt/sync/client";
import { api, isAbort, type Me, type NoteDetail } from "./api.js";
import { Confirm, type ConfirmRequest } from "./Confirm.js";
import { DocViewer } from "./DocViewer.js";
import { Editor } from "./Editor.js";
import { RelationRows, rolesOf, type RelationsState } from "./entity/index.js";
import { linkTo, slugOf } from "./entity/links.js";
import { openNoteSync, retire } from "./noteSync.js";
import { tabHref } from "./Project.js";
import { dueOf, taskState, uploadProjectFiles, useTaskCard, type ProjectTask } from "./ProjectViews.js";
import { Button, Checkbox, Ring, Square } from "./ui/controls.js";
import { dateLabel } from "./ui/dates.js";
import { Input, SearchField, Textarea } from "./ui/fields.js";
import { Icon } from "./ui/Icon.js";
import { Module, Row, RowList } from "./ui/layout.js";
import { Menu } from "./ui/overlays.js";
import { navigate } from "./ui/router.js";
import { Notice } from "./ui/states.js";
import { attempt, useWrite } from "./ui/writes.js";
import { onWs } from "./ws.js";
import type { Company, Contact, ProjectPerson, ProjectWorkspace } from "@basalt/schema/responses";

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
          items={w.decisions}
          placeholder="Log a decision…"
          canEdit={w.canEdit}
          onAdd={async (text) => {
            await api("POST", `/api/projects/${slug}/decisions`, { text });
            await onChanged();
          }}
        />
        <Log
          title="Inbox"
          items={w.inbox}
          placeholder="A thought, a link, a follow-up…"
          canEdit={w.canEdit}
          asStep
          onAdd={async (text, task) => {
            await api("POST", `/api/projects/${slug}/capture`, { text, task });
            await onChanged();
          }}
        />
        <NextSteps w={w} onChanged={onChanged} onOpenNote={onOpenNote} />
        <Goals w={w} onSave={(goals) => onPatch({ goals })} />
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
        <a className="pj-path" href={`/notes/${w.path.replace(/\.md$/i, "").split("/").map(encodeURIComponent).join("/")}`} onClick={(e) => inApp(e, () => onOpenNote(w.noteId))} title="Open in Notes">
          {w.path}
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

function Log({
  title,
  items,
  placeholder,
  canEdit,
  asStep,
  onAdd,
}: {
  title: string;
  items: string[];
  placeholder: string;
  canEdit: boolean;
  /** The Inbox can take a line as a step (a checkbox) instead. */
  asStep?: boolean;
  onAdd: (text: string, task: boolean) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [task, setTask] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [all, setAll] = useState(false);
  const shown = items.slice().reverse();
  const cap = all ? shown.length : 4;
  return (
    <Module title={title} count={items.length} className="pj-log">
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
      {shown.length > 0 && (
        <ul className="pj-lines">
          {shown.slice(0, cap).map((item, i) => {
            const d = decisionOf(item);
            return (
              <li key={`${i}-${item}`} className={d.day ? "dated" : undefined}>
                {d.day && <span className="pj-day">{dateLabel(d.day)}</span>}
                <span>{d.text}</span>
              </li>
            );
          })}
        </ul>
      )}
      {shown.length > cap && (
        <button type="button" className="pj-more" onClick={() => setAll(true)}>
          {shown.length - cap} more
        </button>
      )}
    </Module>
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

/* ---- goals: the `## Goals` section, edited as the note has it (COR-005) ------------------ */

function Goals({ w, onSave }: { w: ProjectWorkspace; onSave: (body: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useWrite();
  if (!w.canEdit && w.goals.length === 0) return null;
  return (
    <Module title="Goals" count={w.goals.length || undefined} className="pj-goals">
      {w.canEdit && (
        <Button
          size="sm"
          kind="quiet"
          className="pj-mod-act"
          onClick={() => {
            // The section as the note has it: checkboxes, nesting and prose round-trip
            // untouched (COR-005). The list below is display only.
            setDraft(w.goalsSource);
            setEditing((e) => !e);
            save.clear();
          }}
        >
          {editing ? "Cancel" : "Edit"}
        </Button>
      )}
      {editing ? (
        <form
          className="pj-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save.run("The goals weren't saved.", () => onSave(draft)).then((ok) => ok && setEditing(false));
          }}
        >
          <Textarea value={draft} rows={5} onChange={(e) => setDraft(e.target.value)} aria-label="Goals" />
          {save.error && <Notice title={save.error} />}
          <div className="acts">
            <Button type="submit" disabled={save.busy}>
              Save goals
            </Button>
          </div>
        </form>
      ) : w.goals.length === 0 ? (
        <p className="q3 pj-none">No goals yet. What does done look like?</p>
      ) : (
        <ul className="pj-goal-list">
          {w.goals.map((g, i) => (
            <li key={i}>{g}</li>
          ))}
        </ul>
      )}
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
    const out = new Map<string, Person>();
    for (const p of w.people)
      out.set(p.id, { id: p.id, title: p.title, kind: p.kind === "company" ? "company" : "person", sub: plain([p.role, p.company].filter(Boolean).join(" · ")), linked: p });
    for (const rel of ["supervised_by", "involves", "company_involved_in", "involves_company"])
      for (const r of relations.by.get(rel) ?? [])
        if (!out.has(r.id) && (r.type === "person" || r.type === "company")) out.set(r.id, { id: r.id, title: r.title, kind: r.type, sub: "", linked: null });
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

  const remove = (p: Person) =>
    setConfirm({
      title: `Take ${p.title} off ${w.name}?`,
      body: "This removes the link from the project note. Their own note stays as it is.",
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
    <Module title="People & companies" count={people.length} className="pj-people">
      {people.length > 0 && (
        <RowList label="People and companies">
          {people.map((p) => (
            <PersonRow key={p.id} p={p} word={roles.get(p.id) ?? "involved"} link={linkOf(p)} onRemove={w.canEdit && p.linked ? () => remove(p) : undefined} />
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
 * it) holds Remove from this project. It shows on pointing or focus, always on a touch screen.
 */
function PersonRow({ p, word, link, onRemove }: { p: Person; word: string; link: { href?: string; onOpen: () => void }; onRemove?: () => void }) {
  const [menu, setMenu] = useState(false);
  const at = useRef<HTMLButtonElement>(null);
  return (
    <div className={`pj-who${onRemove ? " has-act" : ""}${menu ? " open" : ""}`}>
      <Row
        className="ent-rel"
        lead={p.kind === "company" ? <Square name={p.title} small /> : <Ring name={p.title} small />}
        title={p.title}
        meta={p.sub || undefined}
        trailing={word}
        href={link.href}
        onOpen={link.onOpen}
      />
      {onRemove && (
        <>
          <Button ref={at} kind="quiet" size="sm" icon="dots" className="pj-who-act" aria-label={`More for ${p.title}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} />
          {menu && <Menu anchor={at} align="end" label={p.title} onClose={() => setMenu(false)} items={[{ label: "Remove from this project", danger: true, onSelect: onRemove }]} />}
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
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [reading, setReading] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [all, setAll] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const upload = async (files: FileList | File[]) => {
    setErrors([]);
    const failed: string[] = [];
    await uploadProjectFiles(w.slug, files, (name) => setBusy(name), (msg) => failed.push(msg));
    setBusy("");
    setErrors(failed);
    await onChanged();
  };
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
          <p className="q3 pj-none">
            No documents yet. Drop files here: they land in <code>04-Projects/{w.slug}/files/</code>. A note joins by carrying <code>{w.key}</code> in its tags.
          </p>
        ) : (
          <RowList label="Documents">
            {notes.map((n) => (
              <Row key={n.id} lead={<Icon name="notes" size={18} />} title={n.title} titleAttr={n.path} meta={n.tasks > 0 ? `${n.done} of ${n.tasks} steps` : "note"} onOpen={() => onOpenNote(n.id)} />
            ))}
            {files.map((f) => (
              <Row
                key={f.name}
                lead={<span className="pj-ext">{(f.ext || ".?").slice(1, 5).toUpperCase()}</span>}
                title={f.name}
                meta={kb(f.size)}
                onOpen={() => setReading(f.name)}
                hover={
                  w.canEdit ? (
                    <Button
                      size="sm"
                      kind="quiet"
                      icon="trash"
                      aria-label={`Delete ${f.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirm({
                          title: `Delete ${f.name}?`,
                          body: `This removes the file from disk, from 04-Projects/${w.slug}/files/. Orrama cannot bring it back.`,
                          confirmLabel: "Delete",
                          danger: true,
                          failed: `${f.name} wasn't deleted.`,
                          onConfirm: async () => {
                            await api("DELETE", `/api/projects/${encodeURIComponent(w.slug)}/files/${encodeURIComponent(f.name)}`);
                            await onChanged();
                          },
                        });
                      }}
                    />
                  ) : undefined
                }
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
            <span className="q3">or drop files here</span>
          </div>
        )}
      </div>
      {errors.length > 0 && <Notice title={errors.length === 1 ? "A file was not uploaded" : `${errors.length} files were not uploaded`} text={errors.join(" · ")} />}
      {reading && <DocViewer base={`/api/projects/${encodeURIComponent(w.slug)}/files`} name={reading} onClose={() => setReading(null)} />}
      <Confirm request={confirm} onClose={() => setConfirm(null)} />
    </Module>
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
      <p className="q3 pj-hint">Standing context for Orr and for Claude over MCP (`get_project`), so a session can pick this project up cold.</p>
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
