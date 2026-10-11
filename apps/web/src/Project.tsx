import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "./dialog.js";
import { api, isAbort, latestOnly, unlessAborted, type DashboardTask, type Me, type NoteDetail } from "./api.js";
import { ContactSheet, initials as sheetInitials, type CompanyRecord, type ContactRecord } from "./cards.js";
import { DOMAIN_COLOR, daysTo } from "./categories.js";
import { Confirm, type ConfirmRequest } from "./Confirm.js";
import { DocViewer } from "./DocViewer.js";
import type { NoteSync, SaveState } from "@basalt/sync/client";
import { Editor } from "./Editor.js";
import { ProjectBoard, ProjectTimeline, ProjectTodo } from "./ProjectViews.js";
import { IconPlus, IconSearch, IconX } from "./icons.js";
import { openNoteSync, retire } from "./noteSync.js";
import { onWs } from "./ws.js";
import type { ProjectFile, ProjectNote, ProjectPerson, ProjectWorkspace } from "@basalt/schema/responses";
export type { ProjectFile, ProjectNote, ProjectPerson, ProjectWorkspace };

type View = "overview" | "timeline" | "documents" | "todo";
const VIEWS: { id: View; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "documents", label: "Documents" },
  { id: "todo", label: "To-do" },
];
const readView = (): View => {
  try {
    const v = localStorage.getItem("basalt-proj-view");
    return VIEWS.some((x) => x.id === v) ? (v as View) : "overview";
  } catch {
    return "overview";
  }
};

/** Upload files into 04-Projects/<slug>/files/ — used by the Documents board. */
async function uploadProjectFiles(slug: string, files: FileList | File[], onError: (msg: string) => void) {
  for (const file of Array.from(files)) {
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("could not read file"));
        reader.readAsDataURL(file);
      });
      await api("POST", `/api/projects/${encodeURIComponent(slug)}/files`, { name: file.name, dataBase64 });
    } catch (e) {
      onError(`${file.name}: ${e instanceof Error ? e.message : "upload failed"}`);
    }
  }
}

const STATUSES = ["planning", "on-track", "at-risk", "blocked", "sleeping", "cancelled", "done"] as const;
const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * The project workspace: one page per project, opened from the Overview board.
 *
 * Everything on it is the project note — goals, the prompt, decisions and the
 * inbox are `##` sections, people are `[[links]]`, tasks are checkboxes, and the
 * documents sit in `04-Projects/<slug>/files/` next to it on disk. Nothing here
 * is a database row, so the page survives a re-index and the note still reads
 * like a note in any other editor.
 */
export function Project({ me, slug, onBack, onOpenNote }: { me: Me; slug: string; onBack: () => void; onOpenNote: (id: string) => void }) {
  const [w, setW] = useState<ProjectWorkspace | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>(readView);
  const [uploadErr, setUploadErr] = useState("");
  const boardUpload = useRef<HTMLInputElement>(null);
  const pickView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem("basalt-proj-view", v);
    } catch {
      /* the choice just is not remembered */
    }
  };

  const [nextLoad] = useState(latestOnly);
  const load = useCallback(async () => {
    try {
      setW(await api<ProjectWorkspace>("GET", `/api/projects/${encodeURIComponent(slug)}`, undefined, { signal: nextLoad() }));
    } catch (err) {
      if (isAbort(err)) return;
      setError(err instanceof Error ? err.message : "failed to load");
    }
  }, [slug, nextLoad]);

  useEffect(() => {
    void load();
  }, [load]);

  // Someone else editing the note (or the agent appending a decision) refreshes here.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const off = onWs((msg) => {
      if (msg.type !== "note-changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 600);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [load]);

  const patch = async (body: Record<string, unknown>) => {
    await api("PATCH", `/api/projects/${encodeURIComponent(slug)}`, body);
    await load();
  };

  if (error) return <p className="empty" style={{ padding: 24 }}>{error}</p>;
  if (!w) return <p className="empty" style={{ padding: 24 }}>Loading…</p>;

  const pct = w.total === 0 ? 0 : Math.round((w.done / w.total) * 100);
  const left = w.deadline ? daysTo(w.deadline) : null;
  const color = DOMAIN_COLOR[w.domain ?? ""] ?? "var(--accent)";

  return (
    <div className={`proj ${view === "overview" ? "split" : ""}`}>
      <header className="proj-top">
        <div className="proj-top-id">
        <button className="proj-back" onClick={onBack} aria-label="Back to Overview">
          ← Overview
        </button>
        <h1 className="proj-name">{w.name}</h1>
        {w.domain && (
          <span className="proj-domain" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
            {w.domain}
          </span>
        )}
        </div>

        {/* Controls and the ring travel together: as one flex item they wrap to
            the next line as a unit. Loose in the header they wrapped separately,
            which stranded the ring alone on a line of its own. */}
        <div className="proj-top-meta">
        <span className="proj-meta">
          <select
            className="proj-status"
            value={w.status || "planning"}
            disabled={!w.canEdit}
            onChange={(e) => void patch({ status: e.target.value })}
            aria-label="Project status"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <label className="proj-date">
            start
            <input type="date" value={w.start} disabled={!w.canEdit} onChange={(e) => void patch({ start: e.target.value })} />
          </label>
          <label className="proj-date">
            deadline
            <input type="date" value={w.deadline} disabled={!w.canEdit} onChange={(e) => void patch({ deadline: e.target.value })} />
          </label>
          {left !== null && (
            <span className={`proj-count ${left < 0 ? "over" : left <= 14 ? "soon" : ""}`}>
              {left < 0 ? `${-left} days over` : left === 0 ? "due today" : `${left} days left`}
            </span>
          )}
        </span>

        <span className="proj-pct" title={`${w.done} of ${w.total} steps done`}>
          <svg width="42" height="42" viewBox="0 0 42 42">
            <circle cx="21" cy="21" r="17" fill="none" stroke="var(--border)" strokeWidth="4" />
            <circle
              cx="21"
              cy="21"
              r="17"
              fill="none"
              stroke={color}
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={`${(pct / 100) * 106.8} 106.8`}
              transform="rotate(-90 21 21)"
            />
          </svg>
          <b>{pct}%</b>
        </span>
        </div>
      </header>

      <nav className="proj-tabs" role="tablist" aria-label="Project views">
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" aria-selected={view === v.id} className={`proj-tab ${view === v.id ? "active" : ""}`} onClick={() => pickView(v.id)}>
            {v.label}
            {v.id === "timeline" && <i>{w.tasks.filter((t) => t.due).length}</i>}
            {v.id === "documents" && <i>{w.files.length}</i>}
            {v.id === "todo" && <i>{w.tasks.filter((t) => !t.checked).length}</i>}
          </button>
        ))}
      </nav>

      {view === "timeline" && <ProjectTimeline w={w} onChanged={load} onOpenNote={onOpenNote} />}
      {view === "todo" && <ProjectTodo w={w} onChanged={load} onOpenNote={onOpenNote} />}
      {view === "documents" && (
        <>
          <input
            ref={boardUpload}
            type="file"
            multiple
            hidden
            onChange={async (e) => {
              const files = e.target.files;
              if (files?.length) {
                setUploadErr("");
                await uploadProjectFiles(w.slug, files, setUploadErr);
                await load();
              }
              e.target.value = "";
            }}
          />
          {uploadErr && <p className="form-error">{uploadErr}</p>}
          <ProjectBoard w={w} onUpload={() => boardUpload.current?.click()} />
        </>
      )}

      {view === "overview" && (
      <div className="proj-grid">
        <div className="proj-col">
          <Goals w={w} onSave={(body) => patch({ goals: body })} />
          <NoteCard w={w} me={me} onOpenNote={onOpenNote} />
        </div>

        <div className="proj-col side">
          <Notes w={w} onOpenNote={onOpenNote} />
          <Files w={w} onChanged={load} />
          <People w={w} onChanged={load} onOpenNote={onOpenNote} />
          <Prompt w={w} onSave={(text) => patch({ prompt: text })} />
          <Log
            title="Decisions"
            hint="What was decided, and why. Dated automatically."
            items={w.decisions}
            placeholder="Decided to…"
            disabled={!w.canEdit}
            onAdd={async (text) => {
              await api("POST", `/api/projects/${encodeURIComponent(slug)}/decisions`, { text });
              await load();
            }}
          />
          <Log
            title="Inbox"
            hint="Dump it here now, sort it later."
            items={w.inbox}
            placeholder="Thought, link, follow-up…"
            disabled={!w.canEdit}
            withTaskToggle
            onAdd={async (text, task) => {
              await api("POST", `/api/projects/${encodeURIComponent(slug)}/capture`, { text, task });
              await load();
            }}
          />
        </div>
      </div>
      )}
    </div>
  );
}

function Card({
  title,
  count,
  action,
  raised,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  /** Lift this card above its siblings while it has a dropdown open — every card
   *  is its own stacking context (backdrop-filter), so an inner z-index alone
   *  still loses to the next card down the column. */
  raised?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`proj-card ${raised ? "raised" : ""}`}>
      <header className="proj-card-head">
        <h2>{title}</h2>
        {count !== undefined && <span className="ct-count">{count}</span>}
        {action}
      </header>
      {children}
    </section>
  );
}

/** Goals are the `## Goals` section: prose in the note, a checklist on the page. */
function Goals({ w, onSave }: { w: ProjectWorkspace; onSave: (body: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  return (
    <Card
      title="Goals"
      count={w.goals.length}
      action={
        w.canEdit && (
          <button
            className="proj-mini"
            onClick={() => {
              // The section as the note has it: checkboxes, nesting and prose
              // round-trip untouched (COR-005). The list below is display only.
              setDraft(w.goalsSource);
              setEditing((e) => !e);
            }}
          >
            {editing ? "Cancel" : "Edit"}
          </button>
        )
      }
    >
      {editing ? (
        <form
          className="proj-inline"
          onSubmit={async (e) => {
            e.preventDefault();
            await onSave(draft);
            setEditing(false);
          }}
        >
          <textarea value={draft} rows={5} onChange={(e) => setDraft(e.target.value)} aria-label="Goals" />
          <button className="primary">Save goals</button>
        </form>
      ) : w.goals.length === 0 ? (
        <p className="empty">No goals yet — what does done look like?</p>
      ) : (
        <ul className="proj-goals">
          {w.goals.map((g, i) => (
            <li key={i}>{g}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}


/**
 * Notes belonging to this project. Membership is the same rule the task counts
 * use (`projectOf` on the server): nearest project folder, else the first
 * `project/` tag. Folder alone is not enough, which is the thing that is easy to
 * forget when a note is created by hand.
 */
function Notes({ w, onOpenNote }: { w: ProjectWorkspace; onOpenNote: (id: string) => void }) {
  return (
    <Card title="Notes" count={w.notes.length}>
      {w.notes.length === 0 ? (
        <p className="empty">
          No notes yet. A note joins this project by carrying <code>{w.key}</code> in its front-matter tags.
        </p>
      ) : (
        <ul className="proj-notes">
          {w.notes.map((n) => (
            <li key={n.id}>
              <button className="proj-note-link" onClick={() => onOpenNote(n.id)} title={n.path}>
                <span className="proj-note-title">{n.title}</span>
                {n.tasks > 0 && (
                  <span className="proj-note-tasks">
                    {n.done}/{n.tasks}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Documents: real files in 04-Projects/<slug>/files/, uploaded from here. */
function Files({ w, onChanged }: { w: ProjectWorkspace; onChanged: () => Promise<void> }) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const upload = async (files: FileList | File[]) => {
    setErr("");
    for (const file of Array.from(files)) {
      setBusy(file.name);
      try {
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = () => reject(new Error("could not read file"));
          reader.readAsDataURL(file);
        });
        await api("POST", `/api/projects/${encodeURIComponent(w.slug)}/files`, { name: file.name, dataBase64 });
      } catch (e) {
        setErr(`${file.name}: ${e instanceof Error ? e.message : "upload failed"}`);
      }
    }
    setBusy("");
    await onChanged();
  };

  // Documents open in the app's own reader (PDF, DOCX, text, images).
  const [reading, setReading] = useState<string | null>(null);

  return (
    <Card
      title="Documents"
      count={w.files.length}
      action={
        w.canEdit && (
          <button className="proj-mini" onClick={() => input.current?.click()}>
            <IconPlus /> Upload
          </button>
        )
      }
    >
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
      <div
        className={`proj-drop ${over ? "over" : ""}`}
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
        {w.files.length === 0 ? (
          <p className="empty">Drop PDFs, briefs, exports here — they land in 04-Projects/{w.slug}/files/.</p>
        ) : (
          <ul className="proj-files">
            {w.files.map((f) => (
              <li key={f.name}>
                <button className="proj-file" onClick={() => setReading(f.name)} title="Open">
                  <span className="proj-ext">{(f.ext || ".?").slice(1).toUpperCase()}</span>
                  <span className="proj-fname">{f.name}</span>
                  <span className="proj-fsize">{kb(f.size)}</span>
                </button>
                {w.canEdit && (
                  <button
                    className="proj-del"
                    aria-label={`Delete ${f.name}`}
                    onClick={() =>
                      setConfirm({
                        title: `Delete ${f.name}?`,
                        body: `This removes the file from disk — 04-Projects/${w.slug}/files/. It is not recoverable from inside Basalt.`,
                        confirmLabel: "Delete",
                        danger: true,
                        onConfirm: async () => {
                          await api("DELETE", `/api/projects/${encodeURIComponent(w.slug)}/files/${encodeURIComponent(f.name)}`);
                          await onChanged();
                        },
                      })
                    }
                  >
                    <IconX />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {busy && <p className="proj-hint">Uploading {busy}…</p>}
      {err && <p className="form-error">{err}</p>}
      {reading && <DocViewer base={`/api/projects/${encodeURIComponent(w.slug)}/files`} name={reading} onClose={() => setReading(null)} />}
      <Confirm request={confirm} onClose={() => setConfirm(null)} />
    </Card>
  );
}

/** People and companies, attached by writing a real [[link]] into ## People. */
function People({ w, onChanged, onOpenNote }: { w: ProjectWorkspace; onChanged: () => Promise<void>; onOpenNote: (id: string) => void }) {
  const [open, setOpen] = useState<ProjectPerson | null>(null);
  const [q, setQ] = useState("");
  const [pool, setPool] = useState<{ id: string; name: string; sub: string; kind: string }[]>([]);

  useEffect(() => {
    if (q.trim() === "" || pool.length > 0) return;
    void (async () => {
      const [contacts, companies] = await Promise.all([
        api<{ id: string; name: string; role: string; company: string }[]>("GET", "/api/contacts"),
        api<{ id: string; name: string; sector: string }[]>("GET", "/api/companies"),
      ]);
      setPool([
        ...contacts.map((c) => ({ id: c.id, name: c.name, sub: [c.role, c.company].filter(Boolean).join(" · "), kind: "contact" })),
        ...companies.map((c) => ({ id: c.id, name: c.name, sub: c.sector, kind: "company" })),
      ]);
    })();
  }, [q, pool.length]);

  const attached = new Set(w.people.map((p) => p.id));
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle === "") return [];
    return pool.filter((p) => !attached.has(p.id) && `${p.name} ${p.sub}`.toLowerCase().includes(needle)).slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, pool, w.people]);

  return (
    <Card title="People & companies" count={w.people.length} raised={matches.length > 0}>
      {w.people.length > 0 && (
        <ul className="proj-people">
          {w.people.map((p) => (
            <li key={p.id}>
              <button className="proj-person" onClick={() => setOpen(p)}>
                <span className={`proj-av ${p.kind}`}>{p.title.split(/\s+/).slice(0, 2).map((s) => s[0]).join("")}</span>
                <span>
                  <b>{p.title}</b>
                  <i>{[p.role, p.company].filter(Boolean).join(" · ") || p.kind}</i>
                </span>
              </button>
              {p.linkedin && (
                <a className="proj-li" href={`https://${p.linkedin.replace(/^https?:\/\//, "")}`} target="_blank" rel="noreferrer" title="LinkedIn">
                  in
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <PersonModal
          person={open}
          projectName={w.name}
          canEdit={w.canEdit}
          onClose={() => setOpen(null)}
          onOpenNote={(id) => {
            setOpen(null);
            onOpenNote(id);
          }}
          onRemove={async () => {
            await api("DELETE", `/api/projects/${encodeURIComponent(w.slug)}/people/${open.id}`);
            setOpen(null);
            await onChanged();
          }}
        />
      )}
      {w.canEdit && (
        <div className="proj-picker">
          <label className="ct-search">
            <IconSearch />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Attach a contact or company…" aria-label="Attach a contact or company" />
          </label>
          {matches.length > 0 && (
            <ul className="proj-matches">
              {matches.map((m) => (
                <li key={m.id}>
                  <button
                    onClick={async () => {
                      await api("POST", `/api/projects/${encodeURIComponent(w.slug)}/people`, { noteId: m.id });
                      setQ("");
                      await onChanged();
                    }}
                  >
                    <b>{m.name}</b> <i>{m.sub}</i>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * A linked person or company, opened from the project without leaving it: the
 * same card the Contacts page shows, plus the one action that only makes sense
 * here — detaching them from this project (which just drops the [[link]]).
 */
function PersonModal({
  person,
  projectName,
  canEdit,
  onClose,
  onOpenNote,
  onRemove,
}: {
  person: ProjectPerson;
  projectName: string;
  canEdit: boolean;
  onClose: () => void;
  onOpenNote: (id: string) => void;
  onRemove: () => Promise<void>;
}) {
  const [record, setRecord] = useState<ContactRecord | null>(null);
  const [company, setCompany] = useState<CompanyRecord | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const ac = new AbortController();
    const { signal } = ac;
    void (async () => {
      if (person.kind === "company") {
        const all = await api<CompanyRecord[]>("GET", "/api/companies", undefined, { signal });
        setCompany(all.find((c) => c.id === person.id) ?? null);
      } else {
        const all = await api<ContactRecord[]>("GET", "/api/contacts", undefined, { signal });
        setRecord(all.find((c) => c.id === person.id) ?? null);
      }
    })().catch(unlessAborted);
    return () => ac.abort();
  }, [person]);

  const fallback: ContactRecord = {
    id: person.id,
    name: person.title,
    path: person.path,
    sector: "",
    role: person.role,
    company: person.company,
    email: "",
    phone: "",
    linkedin: person.linkedin,
    personal: false,
  };

  return (
    <div className="ct-backdrop" onClick={onClose}>
      <Dialog label="Person" className="ct-modal">
        {person.kind === "company" && company ? (
          <div className="sheet">
            <header className="sheet-head">
              <button className="sheet-back" onClick={onClose}>
                ← {projectName}
              </button>
            </header>
            <div className="sheet-id">
              <span className="sheet-av">{sheetInitials(company.name)}</span>
              <div>
                <div className="sheet-name">{company.name}</div>
                <div className="sheet-sub">{[company.sector, company.location].filter(Boolean).join(" · ")}</div>
              </div>
            </div>
            <p className="sheet-sub">{company.description}</p>
            {company.positions.length > 0 && (
              <div className="co-pos">
                {company.positions.map((x) => (
                  <span key={x} className="co-chip">
                    {x}
                  </span>
                ))}
              </div>
            )}
            <div className="sheet-actions">
              <button className="ct-btn" onClick={() => onOpenNote(company.id)}>
                Open note
              </button>
              {canEdit && (
                <button className="ct-btn danger" onClick={() => void onRemove()}>
                  Remove
                </button>
              )}
            </div>
          </div>
        ) : (
          <ContactSheet
            contact={record ?? fallback}
            onBack={onClose}
            backLabel={projectName}
            onOpenNote={onOpenNote}
            onRemove={canEdit ? () => void onRemove() : undefined}
          />
        )}
      </Dialog>
    </div>
  );
}

/** The standing instructions the agent reads through MCP `get_project`. */
function Prompt({ w, onSave }: { w: ProjectWorkspace; onSave: (text: string) => Promise<void> }) {
  const [draft, setDraft] = useState(w.prompt);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(w.prompt), [w.prompt]);

  return (
    <Card title="Prompt">
      <p className="proj-hint">Standing context for Claude. Read by `get_project` over MCP, so a session can pick this project up cold.</p>
      <form
        className="proj-inline"
        onSubmit={async (e) => {
          e.preventDefault();
          await onSave(draft);
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
        }}
      >
        <textarea
          rows={5}
          value={draft}
          disabled={!w.canEdit}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="You are helping with… The thesis compares NL and FR forecasting. Always check the latest export before…"
          aria-label="Project prompt"
        />
        {w.canEdit && <button className="primary">{saved ? "Saved" : "Save prompt"}</button>}
      </form>
    </Card>
  );
}

function Log({
  title,
  hint,
  items,
  placeholder,
  disabled,
  withTaskToggle,
  onAdd,
}: {
  title: string;
  hint: string;
  items: string[];
  placeholder: string;
  disabled: boolean;
  withTaskToggle?: boolean;
  onAdd: (text: string, task: boolean) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [task, setTask] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Card title={title} count={items.length}>
      <p className="proj-hint">{hint}</p>
      {items.length > 0 && (
        <ul className="proj-log">
          {items
            .slice()
            .reverse()
            .map((d, i) => (
              <li key={i}>{d.replace(/\*\*/g, "")}</li>
            ))}
        </ul>
      )}
      {!disabled && (
        <form
          className="proj-add"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim() || busy) return;
            setBusy(true);
            await onAdd(text.trim(), task);
            setText("");
            setBusy(false);
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={`Add to ${title}`} />
          {withTaskToggle && (
            <label className="proj-toggle" title="Add as a checkbox task instead of a note">
              <input type="checkbox" checked={task} onChange={(e) => setTask(e.target.checked)} /> task
            </label>
          )}
          <button className="primary" disabled={busy}>
            Add
          </button>
        </form>
      )}
    </Card>
  );
}

/** The project note itself, editable in place — same editor as Architecture. */
function NoteCard({ w, me, onOpenNote }: { w: ProjectWorkspace; me: Me; onOpenNote: (id: string) => void }) {
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [state, setState] = useState<SaveState | "idle">("idle");
  // The card's text goes through a NoteSync (packages/sync/src/client.ts). It
  // used to load the note once and never again, while the Decisions, Inbox and
  // Goals cards on this same page write into this same note on the server — so
  // the next keystroke here saved the stale text over the entry just added.
  const [sync, setSync] = useState<NoteSync | null>(null);

  useEffect(() => {
    let live = true;
    let s: NoteSync | null = null;
    void (async () => {
      const n = await api<NoteDetail>("GET", `/api/vault/note/${w.noteId}`);
      if (!live) return;
      s = n.canEdit ? openNoteSync(n, { status: setState }, 700) : null;
      setNote(n);
      setSync(s);
    })();
    const off = onWs((msg) => {
      if (msg.type === "note-changed" && (msg.noteId === w.noteId || msg.resync)) void s?.refresh();
    });
    return () => {
      live = false;
      off();
      retire(s);
    };
  }, [w.noteId]);

  const completions = useMemo(
    () => ({ titles: [...w.people.map((p) => p.title), ...w.notes.map((n) => n.title)], users: [me.username], tags: [] as string[] }),
    [w.people, w.notes, me.username],
  );

  return (
    <Card
      title="Project note"
      action={
        <span className="proj-note-meta">
          <code>{w.path}</code>
          {state !== "idle" && <em>{state === "saving" ? "saving…" : state === "error" ? "save failed" : "saved"}</em>}
        </span>
      }
    >
      {note ? (
        <div className="proj-editor">
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
              // A [[chapter-2]] in the project note should open the chapter, not
              // silently do nothing because it is not a contact.
              const note = w.notes.find(
                (n) => n.title.toLowerCase() === key || n.path.replace(/^.*\//, "").replace(/\.md$/i, "").toLowerCase() === key,
              );
              if (note) onOpenNote(note.id);
            }}
          />
        </div>
      ) : (
        <p className="empty">Loading note…</p>
      )}
    </Card>
  );
}
