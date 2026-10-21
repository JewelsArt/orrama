/**
 * New (structure.md §1.3): a task, a note, an event or a project, prefilled for the page you
 * are on (context.ts). Today's New button opens it on the desktop, and the phone's top bar +
 * everywhere but Today (whose + is Capture). Each dialog makes its thing through the route that
 * already makes it, and opens it or says where it went:
 *
 * - Task: `POST /api/capture` (your inbox) or `POST /api/projects/:slug/capture` (a step in the
 *   project), with `due:` when a date is given.
 * - Note: `PUT /api/vault/note` create-only (newNote.ts), so a name already taken is said under
 *   the field and never replaced; in a project it carries the project's tag.
 * - Event: `POST /api/events`, on your calendar note.
 * - Project: `POST /api/projects`, create-only; it opens.
 */
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { api } from "../api.js";
import { parseDurationInput, parseTimeInput } from "../calendarMath.js";
import { parseDateInput } from "../entity/dateInput.js";
import { blankNote, createNote } from "../newNote.js";
import { Button } from "../ui/controls.js";
import { dateLabel, minutesLabel } from "../ui/dates.js";
import { Field, Form, Input } from "../ui/fields.js";
import { Icon } from "../ui/Icon.js";
import { Dialog, Menu, toast, type MenuItem } from "../ui/overlays.js";
import { navigate, type Route } from "../ui/router.js";
import { newContext, type NewContext } from "./context.js";

type Kind = "task" | "note" | "event" | "project";

/** The menu, then the dialog picked from it. `onDone` when both are gone. */
export function New({ anchor, route, extra = [], onDone }: { anchor: RefObject<HTMLElement | null>; route: Route; extra?: MenuItem[]; onDone: () => void }) {
  const [phase, setPhase] = useState<"menu" | Kind | "gone">("menu");
  const [ctx] = useState<NewContext>(() => newContext(route));
  useEffect(() => {
    if (phase === "gone") onDone();
  }, [phase, onDone]);
  const close = () => setPhase("gone");
  const pick = (k: Kind) => () => setPhase(k);
  const projectStep = ctx.task.project;

  const items: (MenuItem | "-")[] = [
    { label: projectStep ? "Step in this project" : "Task", icon: <Icon name="check" size={16} />, onSelect: pick("task") },
    { label: ctx.note.project ? "Note in this project" : "Note", icon: <Icon name="notes" size={16} />, onSelect: pick("note") },
    { label: "Event", icon: <Icon name="calendar" size={16} />, onSelect: pick("event") },
    { label: "Project", icon: <Icon name="projects" size={16} />, onSelect: pick("project") },
    // A page's own things (Today's ledgers): the menu closes, the page opens them.
    ...(extra.length ? (["-", ...extra.map((x) => ({ ...x, onSelect: () => (setPhase("gone"), x.onSelect()) }))] as (MenuItem | "-")[]) : []),
  ];

  return (
    <>
      {/* The menu closes itself before an item runs; both land in one render, so the pick wins. */}
      {phase === "menu" && <Menu anchor={anchor} label="New" align="end" items={items} onClose={close} />}
      {phase === "task" && <NewTask ctx={ctx} onClose={close} />}
      {phase === "note" && <NewNote ctx={ctx} onClose={close} />}
      {phase === "event" && <NewEvent ctx={ctx} onClose={close} />}
      {phase === "project" && <NewProject ctx={ctx} onClose={close} />}
    </>
  );
}

/** A dialog that makes one thing: what it throws is said under the form, which stays open. */
function Making({ title, confirm, onClose, make, children }: { title: string; confirm: string; onClose: () => void; make: () => Promise<void> | null; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const job = make();
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      await job;
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "That didn't work. Try again.");
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose} className="new-dlg">
      <Form
        onSubmit={() => void submit()}
        actions={
          <>
            <Button kind="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="solid" disabled={busy}>
              {confirm}
            </Button>
          </>
        }
      >
        {children}
        {error && (
          <p className="new-err" role="alert">
            {error}
          </p>
        )}
      </Form>
    </Dialog>
  );
}

/** A date typed as words ("fri", "19 Oct"), said back under the field. */
function useTypedDate(initial?: string) {
  const [text, setText] = useState(initial ? dateLabel(initial) : "");
  const value = parseDateInput(text);
  // Said back only when it reads differently from what was typed ("fri" → "Fri 16 Oct").
  const said = value ? dateLabel(value) : "No date";
  return { text, setText, value, help: value === null || said === text.trim() ? undefined : said, error: value === null ? "Not a date yet: try 19 Oct" : null };
}

function NewTask({ ctx, onClose }: { ctx: NewContext; onClose: () => void }) {
  const [text, setText] = useState("");
  const due = useTypedDate(ctx.task.due);
  const slug = ctx.task.project;
  return (
    <Making
      title={slug ? "New step" : "New task"}
      confirm="Add"
      onClose={onClose}
      make={() => {
        if (!text.trim() || due.value === null) return null;
        const line = text.trim().replace(/\n/g, " ") + (due.value ? ` due:${due.value}` : "");
        return (async () => {
          if (slug) {
            await api("POST", `/api/projects/${encodeURIComponent(slug)}/capture`, { text: line, task: true });
            toast("Added to the project's steps.");
          } else {
            const inbox = await api<{ path: string }>("POST", "/api/capture", { text: line });
            toast("In your inbox.", { action: { label: "Open", run: () => navigate({ kind: "notes", path: inbox.path.replace(/\.md$/i, "") }) } });
          }
        })();
      }}
    >
      <Field label={slug ? "The step" : "The task"}>
        <Input data-autofocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Thijs to sign the data agreement" />
      </Field>
      <Field label="Due (optional)" help={due.help} error={due.error}>
        <Input value={due.text} onChange={(e) => due.setText(e.target.value)} placeholder="e.g. Fri 16 Oct" />
      </Field>
      <p className="q3 new-where">{slug ? "It goes under “Tasks” in the project's note." : "It goes to your inbox."}</p>
    </Making>
  );
}

/** A note's front matter: its title, and the project tag that makes it one of the project's notes. */
function noteText(title: string, project?: string): string {
  if (!project) return blankNote(title);
  // The tag bare, as the vault writes tags (newNote.ts); a slug is one path segment of letters,
  // digits, `-` and `_`, so it needs no quoting.
  return `---\ntitle: ${JSON.stringify(title)}\ntags: [project/${project}]\n---\n\n`;
}

function NewNote({ ctx, onClose }: { ctx: NewContext; onClose: () => void }) {
  const [path, setPath] = useState(ctx.note.folder);
  return (
    <Making
      title="New note"
      confirm="Create"
      onClose={onClose}
      make={() => {
        const name = path.trim();
        if (!name) return null;
        return (async () => {
          if (name.endsWith("/")) throw new Error("Add the note's name after the folder.");
          const file = name.endsWith(".md") ? name : `${name}.md`;
          // Create-only: a note already at this path is a 409, said here, never replaced.
          const res = await createNote(file, noteText(file.split("/").pop()!.replace(/\.md$/, ""), ctx.note.project));
          navigate({ kind: "notes", id: res.id });
        })();
      }}
    >
      <Field label="Path" help={ctx.note.project ? "In the project's folder, tagged so it joins the project." : "A folder and a name, like Ideas/Reading list"}>
        <Input
          data-autofocus
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          placeholder="Ideas/Reading list"
        />
      </Field>
    </Making>
  );
}

/** The next whole hour from now, inside the day: what an event typed now most likely means. */
const nextHour = (now = new Date()) => Math.min(23, now.getHours() + 1) * 60;

function NewEvent({ ctx, onClose }: { ctx: NewContext; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const date = useTypedDate(ctx.event.date);
  const [start, setStart] = useState(minutesLabel(nextHour()));
  const [length, setLength] = useState("1h");
  const startMin = parseTimeInput(start);
  const durationMin = parseDurationInput(length);
  return (
    <Making
      title="New event"
      confirm="Add"
      onClose={onClose}
      make={() => {
        if (!title.trim() || !date.value || startMin === null || durationMin === null) return null;
        const day = date.value;
        return (async () => {
          await api("POST", "/api/events", { title: title.trim(), date: day, startMin, durationMin });
          toast(`On your calendar, ${dateLabel(day)}.`, { action: { label: "Open", run: () => navigate({ kind: "planning", scale: "day", at: day }) } });
        })();
      }}
    >
      <Field label="What">
        <Input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Dashboard review" maxLength={140} />
      </Field>
      <div className="new-row">
        <Field label="Day" help={date.value ? date.help : undefined} error={date.value === "" ? "Give it a day" : date.error}>
          <Input value={date.text} onChange={(e) => date.setText(e.target.value)} placeholder="Fri 16 Oct" />
        </Field>
        <Field label="Starts" error={startMin === null ? "A time, like 15:00" : null}>
          <Input value={start} onChange={(e) => setStart(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="For" error={durationMin === null ? "Like 1h or 30m" : null}>
          <Input value={length} onChange={(e) => setLength(e.target.value)} />
        </Field>
      </div>
    </Making>
  );
}

function NewProject({ ctx, onClose }: { ctx: NewContext; onClose: () => void }) {
  const [name, setName] = useState("");
  return (
    <Making
      title="New project"
      confirm="Create"
      onClose={onClose}
      make={() => {
        if (!name.trim()) return null;
        return (async () => {
          const res = await api<{ slug: string }>("POST", "/api/projects", { name: name.trim(), ...(ctx.project.domain ? { domain: ctx.project.domain } : {}) });
          navigate({ kind: "project", slug: res.slug });
        })();
      }}
    >
      <Field label="What is it called?">
        <Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Graduation thesis" />
      </Field>
    </Making>
  );
}
