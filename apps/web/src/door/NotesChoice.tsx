/**
 * "Where are your notes?" (structure.md §2.14 step 2): start with an example, start empty, or
 * use notes you already have. The same chooser at first run (in the door) and in Settings →
 * Notes (Change…, in a dialog). Styles: styles/door.css (`dr-ch…`).
 *
 * In the desktop app "Use notes I already have" opens the system's folder chooser (desktop.ts);
 * in a browser, and if the chooser can't open, the folder is typed.
 *
 * A picked or typed folder is looked at before anything is chosen (POST …/notes-folder/look): whether it
 * is there, how many notes it holds, and what Orrama will add to them, said in plain words.
 * Choosing a folder other than the one read now restarts the server to read it; the chooser
 * waits until the server says it reads the new folder, then starts there (POST
 * /api/settings/start: the note that says what things are, and the example when asked).
 */
import { useEffect, useRef, useState } from "react";
import type { FolderLook, ServerSettings } from "@orrama/schema/responses";
import { api, ApiError } from "../api.js";
import { inApp, pickFolder } from "../desktop.js";
import { Button } from "../ui/controls.js";
import { Field, Input } from "../ui/fields.js";

export type NotesWay = "example" | "empty" | "existing";

/** How long to wait for a restarted server to answer from the new folder. */
const RESTART_WAIT_MS = 60_000;

const n = (x: number) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const notes = (x: number) => `${n(x)} ${x === 1 ? "note" : "notes"}`;

/** What a looked-at folder holds, and what Orrama adds to it, in words. */
export function lookWords(look: FolderLook): string {
  if (look.problem) return look.problem;
  const count = look.more ? `More than ${notes(look.notes)}` : look.notes === 0 ? "No notes in it yet" : notes(look.notes);
  const ids =
    look.current || look.unstamped === 0
      ? ""
      : ` Orrama adds a short id line at the top of ${look.unstamped === look.notes && !look.more ? (look.notes === 1 ? "it" : "each") : `${n(look.unstamped)} of them`}, once, so links keep working when a note is renamed.`;
  const kinds = look.ontology ? "" : " It also adds one note, What things are, that tells it who is a person, a company or a project.";
  return `${count}.${ids}${kinds}`;
}

/** Wait until the server reads `folder` (it restarts to do so): requests fail in between. */
async function readsFolder(folder: string): Promise<void> {
  const until = Date.now() + RESTART_WAIT_MS;
  await new Promise((r) => setTimeout(r, 300));
  for (;;) {
    try {
      const s = await api<ServerSettings>("GET", "/api/settings/server");
      if (s.notesFolder === folder) return;
    } catch {
      /* restarting */
    }
    if (Date.now() > until) throw new Error("Orrama didn't come back after restarting. Reload the page.");
    await new Promise((r) => setTimeout(r, 400));
  }
}

export function NotesChoice({
  server,
  place,
  onDone,
  onCancel,
}: {
  /** The folder read now. */
  server: ServerSettings;
  place: "first" | "settings";
  /** The folder is settled and started; `moved` when the server now reads another one. */
  onDone: (way: NotesWay, moved: boolean) => void;
  onCancel?: () => void;
}) {
  const fixed = server.fixed;
  const [way, setWay] = useState<NotesWay>(fixed && server.notes > 0 ? "existing" : place === "first" ? "example" : "existing");
  const [folder, setFolder] = useState("");
  const [look, setLook] = useState<FolderLook | null>(null);
  const [own, setOwn] = useState<FolderLook | null>(null);
  const [busy, setBusy] = useState<null | "saving" | "restarting">(null);
  const [error, setError] = useState("");
  const typed = useRef(0);
  /** The app's folder chooser, until it fails once: then the folder is typed. */
  const [chooser, setChooser] = useState(inApp);

  const choose = async () => {
    setError("");
    try {
      const picked = await pickFolder("Where are your notes?");
      if (picked) setFolder(picked);
    } catch {
      setChooser(false);
      setError("The folder chooser didn't open. Type the folder instead.");
    }
  };

  // Orrama's own folder (or the fixed one): what an example or an empty start would add to it.
  useEffect(() => {
    let alive = true;
    api<FolderLook>("POST", "/api/settings/notes-folder/look", { folder: fixed ? server.notesFolder : null })
      .then((l) => alive && setOwn(l))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [fixed, server.notesFolder]);

  // A typed folder is looked at once typing pauses.
  useEffect(() => {
    if (way !== "existing" || fixed) return;
    const at = ++typed.current;
    setLook(null);
    if (!folder.trim()) return;
    const t = setTimeout(() => {
      api<FolderLook>("POST", "/api/settings/notes-folder/look", { folder })
        .then((l) => at === typed.current && setLook(l))
        .catch(() => at === typed.current && setError("Orrama couldn't look at that folder. Try again."));
    }, 350);
    return () => clearTimeout(t);
  }, [folder, way, fixed]);

  const ready = !busy && (way !== "existing" || fixed || (!!look && !look.problem));

  const go = async () => {
    if (!ready) return;
    setError("");
    setBusy("saving");
    try {
      let moved = false;
      if (!fixed) {
        const target = way === "existing" ? folder : null;
        const needs = way === "existing" ? !look?.current : !server.own;
        if (needs) {
          const res = await api<{ folder: string; restart: boolean }>("PUT", "/api/settings/notes-folder", { folder: target });
          if (res.restart) {
            setBusy("restarting");
            await readsFolder(res.folder);
            moved = true;
          }
        }
      }
      await api("POST", "/api/settings/start", { example: way === "example" });
      onDone(way, moved);
    } catch (e) {
      setBusy(null);
      setError(e instanceof ApiError && e.status === 400 ? e.message : e instanceof Error && /didn't come back/.test(e.message) ? e.message : "That didn't work. Try again in a moment.");
    }
  };

  const option = (id: NotesWay, title: string, detail: string) => (
    <button key={id} type="button" role="radio" aria-checked={way === id} className={way === id ? "dr-ch-opt on" : "dr-ch-opt"} disabled={!!busy} onClick={() => setWay(id)}>
      <b>{title}</b>
      <span>{detail}</span>
    </button>
  );
  const ownAdds = own && !own.ontology ? " Orrama adds one note, What things are, that tells it who is a person, a company or a project." : "";

  return (
    <form
      className="dr-ch"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
      noValidate
    >
      {fixed ? (
        <p className="dr-ch-fixed">
          Your notes are in <b>{server.notesFolder}</b>. That folder is set where Orrama starts, so it stays.
        </p>
      ) : null}
      {(!fixed || server.notes === 0) && (
        <div className="dr-ch-opts" role="radiogroup" aria-label="Where your notes are">
          {option("example", "Start with an example", "A project with three steps, a person, their company and an event this week, to try things on. Remove it in Settings when you're done.")}
          {option("empty", "Start empty", fixed ? "Your notes start in that folder." : "A new folder on this computer, kept by Orrama.")}
          {!fixed && option("existing", "Use notes I already have", "A folder of notes you already keep on this computer.")}
        </div>
      )}
      {!fixed && way === "existing" && chooser && (
        <div className="dr-ch-pick">
          {folder ? (
            <p className="dr-ch-picked">
              <b>{look?.folder || folder}</b>
              <span className={look?.problem ? "bad" : undefined}>{look ? lookWords(look) : "Looking at it…"}</span>
            </p>
          ) : null}
          <Button onClick={() => void choose()} disabled={!!busy}>
            {folder ? "Choose another folder…" : "Choose the folder…"}
          </Button>
        </div>
      )}
      {!fixed && way === "existing" && !chooser && (
        <Field label="Folder" error={look?.problem ?? null} help={look && !look.problem ? lookWords(look) : "The whole path, like ~/Documents/Notes."}>
          <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="~/Documents/Notes" autoFocus spellCheck={false} autoCapitalize="off" autoComplete="off" disabled={!!busy} />
        </Field>
      )}
      {way !== "existing" && ownAdds && <p className="dr-ch-note">{ownAdds.trim()}</p>}
      {fixed && server.notes > 0 && own && !own.ontology && <p className="dr-ch-note">{ownAdds.trim()}</p>}
      {error && (
        <p className="dr-err" role="alert">
          {error}
        </p>
      )}
      {busy === "restarting" && <p className="dr-ch-note" aria-live="polite">Orrama restarts to read that folder…</p>}
      <div className="dr-ch-acts">
        {onCancel && (
          <Button onClick={onCancel} disabled={!!busy}>
            Cancel
          </Button>
        )}
        <Button kind="solid" type="submit" className={place === "first" ? "dr-go" : undefined} disabled={!ready}>
          {busy ? "One moment…" : fixed && server.notes > 0 ? "Use these notes" : place === "first" ? "Continue" : "Use this folder"}
        </Button>
      </div>
    </form>
  );
}
