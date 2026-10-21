/**
 * The dialogs behind rename, move and the trash (1C), shared by every page that changes a note
 * or a folder: Notes, and the people, area and project pages after it. They call
 * `noteActions.ts`; what the server refuses is said under the field, and the dialog stays open
 * so the name can be fixed instead of typed again (NameDialog's rule). Also the note's History
 * sheet and the Trash view.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Linkers, NoteHistory, Revision, TrashItem } from "@orrama/schema/responses";
import { api, isAbort, latestOnly } from "../api.js";
import type { ConfirmRequest } from "../Confirm.js";
import {
  emptyTrash,
  folderLeaf,
  folderOf,
  linkersOf,
  linkersSentence,
  makeFolder,
  moveFolder,
  moveNote,
  nameOf,
  nameProblem,
  notePath,
  renameFolder,
  restoreFromTrash,
  sayMoved,
  trashFolder,
  trashList,
  type Moved,
} from "../noteActions.js";
import { Button } from "../ui/controls.js";
import { dateTimeLabel } from "../ui/dates.js";
import { Field, Form, Input, SearchField } from "../ui/fields.js";
import { Icon } from "../ui/Icon.js";
import { Dialog, Sheet, toast } from "../ui/overlays.js";
import { EmptyState, Notice, Skeleton } from "../ui/states.js";
import { attempt, failureText } from "../ui/writes.js";
import { changeWords, diffLines, withContext } from "./diff.js";
import { folderName } from "./read.js";

/** A folder as words: each part without its number prefix, "Projects / Kitchen". */
export const folderWords = (folder: string) => (folder ? folder.split("/").map(folderName).join(" / ") : "Top folder");

/** The sentence under a name field: why it can't be, or what will follow it. */
function useLinkers(noteId: string | undefined, toPath: string | null): Linkers | null {
  const [linkers, setLinkers] = useState<Linkers | null>(null);
  const [next] = useState(latestOnly);
  useEffect(() => {
    if (!noteId || !toPath) {
      setLinkers(null);
      return;
    }
    const signal = next();
    const t = setTimeout(() => {
      linkersOf(noteId, toPath, signal).then(setLinkers, (e) => {
        if (!isAbort(e)) setLinkers(null);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [noteId, toPath, next]);
  return linkers;
}

/** One name, prefilled and selected, then a button: rename a note or a folder, or name a new folder. */
function NameForm({
  title,
  initial,
  confirm,
  what,
  help,
  onSubmit,
  onClose,
  below,
  onName,
}: {
  title: string;
  initial: string;
  confirm: string;
  what: "note" | "folder";
  help?: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
  below?: string | null;
  onName?: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const submit = async () => {
    const problem = nameProblem(name, what);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (e) {
      setError(failureText(e, `The ${what} wasn't ${confirm === "Create" ? "made" : "renamed"}.`));
      setBusy(false);
    }
  };
  const same = name.trim() === initial;
  return (
    <Dialog title={title} onClose={onClose}>
      <Form
        onSubmit={() => void submit()}
        actions={
          <>
            <Button kind="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="solid" disabled={busy || !name.trim() || (same && confirm !== "Create")}>
              {confirm}
            </Button>
          </>
        }
      >
        <Field label="Name" help={help} error={error}>
          <Input
            ref={input}
            data-autofocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
              onName?.(e.target.value);
            }}
          />
        </Field>
        {below && !error && <p className="nt-follow">{below}</p>}
      </Form>
    </Dialog>
  );
}

/** Rename a note: its file and its title, and the links that name it follow (Jules, 21 Oct). */
export function RenameNoteDialog({ note, onDone, onClose }: { note: { id: string; path: string }; onDone: (moved: Moved) => void; onClose: () => void }) {
  const initial = nameOf(note.path);
  const [name, setName] = useState(initial);
  const to = name.trim() && name.trim() !== initial && !nameProblem(name, "note") ? notePath(folderOf(note.path), name.trim()) : null;
  const linkers = useLinkers(note.id, to);
  return (
    <NameForm
      title="Rename note"
      initial={initial}
      confirm="Rename"
      what="note"
      onName={setName}
      below={to ? linkersSentence(linkers) : null}
      onSubmit={async (n) => {
        const done = await moveNote(note.path, notePath(folderOf(note.path), n));
        sayMoved(`Renamed to “${n}”.`, note.path, done, (path) => onDone({ ...done, path }));
        onDone(done);
      }}
      onClose={onClose}
    />
  );
}

/** Name a new folder inside `parent` ("" is the top folder). */
export function NewFolderDialog({ parent, onDone, onClose }: { parent: string; onDone: (path: string) => void; onClose: () => void }) {
  return (
    <NameForm
      title="New folder"
      initial=""
      confirm="Create"
      what="folder"
      help={parent ? `Inside ${folderWords(parent)}` : undefined}
      onSubmit={async (n) => {
        const made = await makeFolder(parent ? `${parent}/${n}` : n);
        onDone(made.path);
      }}
      onClose={onClose}
    />
  );
}

/** Rename a folder; everything in it goes along. */
export function RenameFolderDialog({ folder, onDone, onClose }: { folder: string; onDone: (path: string) => void; onClose: () => void }) {
  const initial = folderLeaf(folder);
  return (
    <NameForm
      title="Rename folder"
      initial={initial}
      confirm="Rename"
      what="folder"
      onSubmit={async (n) => {
        const done = await renameFolder(folder, n);
        toast(`Renamed to “${n}”.`, {
          ms: 8000,
          action: { label: "Undo", run: () => void attempt("The folder wasn't put back.", () => moveFolder(done.path, folder).then(() => onDone(folder))) },
        });
        onDone(done.path);
      }}
      onClose={onClose}
    />
  );
}

/**
 * Move a note or a folder: pick where in a list of every folder you can see, filtered by what
 * you type. A note's links that name it by its place follow; a folder takes everything in it.
 */
export function MoveDialog({
  item,
  folders,
  onDone,
  onClose,
}: {
  item: { kind: "note"; id: string; path: string; title: string } | { kind: "folder"; path: string };
  folders: string[];
  onDone: (path: string) => void;
  onClose: () => void;
}) {
  const here = item.kind === "note" ? folderOf(item.path) : folderOf(item.path);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = item.kind === "note" ? item.title : folderName(folderLeaf(item.path));
  // A folder can't go into itself or anything inside it.
  const inside = (f: string) => item.kind === "folder" && (f === item.path || f.startsWith(`${item.path}/`));
  const choices = useMemo(() => {
    const all = ["", ...folders.filter((f) => !inside(f))];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((f) => folderWords(f).toLowerCase().includes(needle) || f.toLowerCase().includes(needle)) : all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, q]);
  const to = pick === null ? null : item.kind === "note" ? notePath(pick, nameOf(item.path)) : pick ? `${pick}/${folderLeaf(item.path)}` : folderLeaf(item.path);
  const linkers = useLinkers(item.kind === "note" ? item.id : undefined, item.kind === "note" ? to : null);
  const submit = async () => {
    if (pick === null || to === null) return;
    setBusy(true);
    setError(null);
    try {
      if (item.kind === "note") {
        const done = await moveNote(item.path, to);
        sayMoved(`Moved “${name}” to ${folderWords(pick)}.`, item.path, done, onDone);
        onDone(done.path);
      } else {
        const done = await moveFolder(item.path, to);
        toast(`Moved “${name}” to ${folderWords(pick)}.`, {
          ms: 8000,
          action: { label: "Undo", run: () => void attempt("The folder wasn't put back.", () => moveFolder(done.path, item.path).then(() => onDone(item.path))) },
        });
        onDone(done.path);
      }
      onClose();
    } catch (e) {
      setError(failureText(e, `“${name}” wasn't moved.`));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Move “${name}”`}
      onClose={onClose}
      className="nt-move"
      actions={
        <>
          <Button kind="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="solid" disabled={busy || pick === null || pick === here} onClick={() => void submit()}>
            Move here
          </Button>
        </>
      }
    >
      <SearchField label="Find a folder" placeholder="Find a folder" value={q} onChange={(e) => setQ(e.target.value)} data-autofocus />
      <div className="nt-pick" role="radiogroup" aria-label="Folders">
        {choices.map((f) => (
          <button
            key={f || "(top)"}
            type="button"
            role="radio"
            aria-checked={pick === f}
            className={pick === f ? "ti on" : "ti"}
            disabled={f === here}
            onClick={() => {
              setPick(f);
              setError(null);
            }}
          >
            <Icon name={f ? "folder" : "notes"} />
            <span>{folderWords(f)}</span>
            {f === here && <small>here now</small>}
          </button>
        ))}
        {choices.length === 0 && <p className="nt-none">No folder matches “{q.trim()}”.</p>}
      </div>
      {error ? <Notice title={error} /> : to && linkersSentence(linkers) ? <p className="nt-follow">{linkersSentence(linkers)}</p> : null}
    </Dialog>
  );
}

/** The Confirm for a folder going to the trash: it says how many notes go with it. */
export function trashFolderRequest(folder: string, notes: number, after: () => void): ConfirmRequest {
  const name = folderName(folderLeaf(folder));
  return {
    title: `Move “${name}” to the trash?`,
    body:
      notes === 0
        ? "It's empty. You can put it back from the trash."
        : `${notes === 1 ? "The note" : notes === 2 ? "Both notes" : `All ${notes} notes`} in it ${notes === 1 ? "goes" : "go"} too, with any other files. You can put them back from the trash until you empty it.`,
    confirmLabel: "Move to the trash",
    danger: true,
    failed: `“${name}” wasn't moved to the trash.`,
    onConfirm: async () => {
      await trashFolder(folder);
      toast(`Moved “${name}” to the trash.`, { ms: 8000 });
      after();
    },
  };
}

/* ---- History ------------------------------------------------------------------------------ */

/**
 * The note's earlier versions, newest first, each against the note as it is now; "Restore this
 * version" hands the text back to the page, which saves it as a normal edit — so it becomes the
 * newest version and can itself be undone.
 */
export function HistorySheet({
  noteId,
  title,
  current,
  me,
  canEdit,
  onRestore,
  onClose,
}: {
  noteId: string;
  title: string;
  /** The note's text as the editor has it now. */
  current: string;
  me: { id: string };
  canEdit: boolean;
  onRestore: (text: string, at: number) => void;
  onClose: () => void;
}) {
  const [revs, setRevs] = useState<NoteHistory["revisions"] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Revision | null>(null);
  const [next] = useState(latestOnly);
  const load = (before?: number) =>
    api<NoteHistory>("GET", `/api/vault/note/${encodeURIComponent(noteId)}/history?limit=30${before !== undefined ? `&before=${before}` : ""}`).then(
      (h) => {
        setRevs((r) => [...(before !== undefined ? (r ?? []) : []), ...h.revisions]);
        setNextBefore(h.nextBefore);
      },
      () => setFailed(true),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);
  const show = (seq: number) => {
    if (open?.seq === seq) return setOpen(null);
    api<Revision>("GET", `/api/vault/note/${encodeURIComponent(noteId)}/history/${seq}`, undefined, { signal: next() }).then(setOpen, (e) => {
      if (!isAbort(e)) toast("That version couldn't be read. Try again in a moment.");
    });
  };
  const who = (authorId: string | null) => (authorId === null ? "outside Orrama" : authorId === me.id ? "you" : "someone else");
  const diff = useMemo(() => (open ? diffLines(open.content, current) : null), [open, current]);
  // The newest revision is the note as it is: nothing to restore there.
  const newest = revs?.[0]?.seq;
  return (
    <Sheet title={`History of “${title}”`} onClose={onClose} className="nt-history">
      {failed ? (
        <Notice title="The history couldn't be read." text="Try again in a moment." />
      ) : revs === null ? (
        <Skeleton rows={5} label="Reading the history" />
      ) : revs.length === 0 ? (
        <p className="nt-hint">No earlier versions yet. Each save from now on is kept here.</p>
      ) : (
        <ol className="nt-revs">
          {revs.map((r) => (
            <li key={r.seq} className={open?.seq === r.seq ? "on" : undefined}>
              <button type="button" className="ti" aria-expanded={open?.seq === r.seq} onClick={() => show(r.seq)}>
                <Icon name={open?.seq === r.seq ? "chev-d" : "chev-r"} />
                <span>
                  {dateTimeLabel(r.at)}
                  {r.seq === newest && <em className="q3"> · now</em>}
                </span>
                <small>
                  {who(r.authorId)} · {r.length.toLocaleString("en-GB")} characters
                </small>
              </button>
              {open?.seq === r.seq && diff && (
                <div className="nt-rev">
                  <p className="nt-follow">{changeWords(diff) ? `Since this version: ${changeWords(diff)}.` : "The same as the note now."}</p>
                  {changeWords(diff) && (
                    <pre className="nt-diff" aria-label="What changed since this version">
                      {withContext(diff).map((l, i) =>
                        l.kind === "fold" ? (
                          <span key={i} className="fold">
                            {l.count} unchanged {l.count === 1 ? "line" : "lines"}
                          </span>
                        ) : (
                          <span key={i} className={l.kind}>
                            <i aria-hidden="true">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</i>
                            {l.text || " "}
                          </span>
                        ),
                      )}
                    </pre>
                  )}
                  {canEdit && r.seq !== newest && changeWords(diff) && (
                    <Button
                      size="sm"
                      onClick={() => {
                        onRestore(open.content, open.at);
                        onClose();
                      }}
                    >
                      Restore this version
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
          {nextBefore !== null && (
            <li>
              <Button kind="quiet" size="sm" onClick={() => void load(nextBefore)}>
                Show older versions
              </Button>
            </li>
          )}
        </ol>
      )}
    </Sheet>
  );
}

/* ---- the Trash view ----------------------------------------------------------------------- */

/**
 * What is in the trash (/notes/trash): each note and file, where it came from and when it went
 * in, with Restore; and Empty trash behind a Confirm, the only permanent delete.
 */
export function TrashView({ onOpen, onChanged, ask }: { onOpen: (id: string) => void; onChanged: () => void; ask: (r: ConfirmRequest) => void }) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = () =>
    trashList().then(
      (t) => {
        setItems(t);
        setFailed(false);
      },
      () => setFailed(true),
    );
  useEffect(() => {
    void load();
  }, []);
  const restore = (it: TrashItem) =>
    void attempt(`“${it.title}” wasn't put back.`, async () => {
      const back = await restoreFromTrash(it.path);
      await load();
      onChanged();
      const moved = back.path !== it.from ? ` as “${nameOf(back.path)}”, beside the one there now` : "";
      toast(`Put “${it.title}” back in ${folderWords(folderOf(back.path))}${moved}.`, back.id ? { action: { label: "Open", run: () => onOpen(back.id!) } } : {});
    });
  const removable = items?.filter((i) => i.canRestore) ?? [];
  const notes = removable.filter((i) => i.kind === "note").length;
  const files = removable.length - notes;
  const counted = [notes ? `${notes} ${notes === 1 ? "note" : "notes"}` : null, files ? `${files} ${files === 1 ? "file" : "files"}` : null].filter(Boolean).join(" and ");
  const empty = () =>
    ask({
      title: "Empty the trash?",
      body: `${counted.charAt(0).toUpperCase()}${counted.slice(1)} ${removable.length === 1 ? "is" : "are"} deleted for good. This can't be undone.`,
      confirmLabel: "Empty trash",
      danger: true,
      failed: "The trash wasn't emptied.",
      onConfirm: async () => {
        const r = await emptyTrash();
        await load();
        toast(r.kept ? `Emptied. ${r.kept} ${r.kept === 1 ? "item" : "items"} you can't change stayed.` : "The trash is empty.");
      },
    });
  return (
    <div className="nt-home nt-trash">
      <header className="nt-home-h">
        <h1>Trash</h1>
        {items && items.length > 0 && <span className="q3">{items.length === 1 ? "1 item" : `${items.length} items`}</span>}
        <span className="sp" />
        {removable.length > 0 && (
          <Button size="sm" danger icon="trash" onClick={empty}>
            Empty trash
          </Button>
        )}
      </header>
      {failed ? (
        <Notice title="The trash couldn't be read." text="Try again in a moment." />
      ) : items === null ? (
        <Skeleton rows={4} label="Reading the trash" />
      ) : items.length === 0 ? (
        <EmptyState pose="sit" title="The trash is empty" text="Notes and folders you move to the trash wait here until you empty it." />
      ) : (
        <>
          <p className="nt-hint">Everything here waits until you empty the trash.</p>
          <div className="rows nt-trash-list" role="list" aria-label="In the trash">
            {items.map((it) => (
              <div className="row" role="listitem" key={it.path}>
                <span className="lead">
                  <Icon name={it.kind === "note" ? "doc" : "clip"} />
                </span>
                <span className="x">
                  <span className="t">{it.title}</span>
                  <span className="m">
                    from {folderWords(folderOf(it.from))} · {dateTimeLabel(it.at)}
                  </span>
                </span>
                <span className="end">
                  {it.canRestore ? (
                    <Button size="sm" icon="back" onClick={() => restore(it)} aria-label={`Restore “${it.title}”`}>
                      Restore
                    </Button>
                  ) : (
                    <span className="r">read-only</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
