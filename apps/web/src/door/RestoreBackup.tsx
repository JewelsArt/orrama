/**
 * Restore a backup (2F): first run's "I have a backup" (Setup.tsx) and Settings → Notes →
 * Restore from a backup… (NotesSettings.tsx, in a dialog). Styles: the notes chooser's
 * (styles/door.css, `dr-ch…`).
 *
 * 1. Choose the backup file (a file input: the system's file chooser, in the app and in a
 *    browser). It is sent to the server as it is, and the server says what it holds: whose
 *    account, how many notes, when it was made, and whether this computer can open its stored
 *    passwords (`keyOpens`; the secret key is never in a backup, Jules D13).
 * 2. Where the notes go: Orrama's own folder by default; another one with the folder chooser
 *    (in the app) or typed. A folder with files in it needs a clear yes.
 * 3. Restore. The server answers with a session for the backup's account and restarts; the
 *    page waits until it answers again, then opens Today, signed in.
 */
import { useEffect, useRef, useState } from "react";
import type { BackupLook, Restored, RestoreFolder } from "@orrama/schema/responses";
import { api, ApiError, sessionFetch } from "../api.js";
import { inApp, pickFolder } from "../desktop.js";
import { Button } from "../ui/controls.js";
import { Field, Input } from "../ui/fields.js";

/** How long to wait for the restarted server to answer as the restored account. */
const RESTART_WAIT_MS = 60_000;

const n = (x: number) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "7 Nov 2026", the day a backup was made, in this computer's time. */
export function madeOn(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** What a backup holds, in one line. */
export function backupWords(look: BackupLook): string {
  const notes = `${n(look.notes)} ${look.notes === 1 ? "note" : "notes"}`;
  const when = madeOn(look.createdAt);
  return `${look.account.name}'s account and ${notes}${when ? `, made ${when}` : ""}.`;
}

/** The one sentence on what doesn't come back on another computer. */
export const OTHER_COMPUTER = "It was made on another computer, so mail and Orr's AI need connecting again afterwards, in Settings. Everything else comes back.";

/** Send the chosen file; the server keeps it for the restore and says what it holds. */
async function sendBackup(file: File): Promise<BackupLook> {
  const res = await sessionFetch("/api/backup/restore/look", { method: "POST", headers: { "content-type": "application/zip" }, body: file });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? res.statusText);
  }
  return (await res.json()) as BackupLook;
}

/** Wait until the restarted server answers as the restored account (requests fail in between). */
async function backAsRestored(): Promise<void> {
  const until = Date.now() + RESTART_WAIT_MS;
  await new Promise((r) => setTimeout(r, 400));
  for (;;) {
    try {
      // A plain fetch: a 401 from the old server mid-restart is not the session ending.
      const r = await fetch("/api/me", { credentials: "same-origin" });
      if (r.ok) return;
    } catch {
      /* restarting */
    }
    if (Date.now() > until) throw new Error("Orrama didn't come back after restarting. Open it again.");
    await new Promise((r) => setTimeout(r, 400));
  }
}

export function RestoreBackup({ place, onCancel, onDone = () => window.location.assign("/today") }: { place: "first" | "settings"; onCancel?: () => void; onDone?: () => void }) {
  const [look, setLook] = useState<BackupLook | null>(null);
  const [fileName, setFileName] = useState("");
  const [folder, setFolder] = useState("");
  const [target, setTarget] = useState<RestoreFolder | null>(null);
  const [yes, setYes] = useState(false);
  const [busy, setBusy] = useState<null | "reading" | "restoring" | "restarting">(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const asked = useRef(0);
  const [chooser, setChooser] = useState(inApp);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setLook(null);
    setFileName(file.name);
    setBusy("reading");
    try {
      const l = await sendBackup(file);
      setLook(l);
      setFolder(l.folder);
      setTarget({ folder: l.folder, problem: null, files: l.folderFiles });
      setYes(false);
    } catch (e) {
      setError(e instanceof ApiError && e.status < 500 ? e.message : "Orrama couldn't read that file. Try again.");
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  };

  // Another folder for the notes: looked at once typing pauses.
  useEffect(() => {
    if (!look || folder === look.folder) return;
    const at = ++asked.current;
    setTarget(null);
    setYes(false);
    if (!folder.trim()) return;
    const t = setTimeout(() => {
      api<RestoreFolder>("POST", "/api/backup/restore/folder", { folder })
        .then((f) => at === asked.current && setTarget(f))
        .catch(() => at === asked.current && setError("Orrama couldn't look at that folder. Try again."));
    }, 350);
    return () => clearTimeout(t);
  }, [folder, look]);

  const pickOther = async () => {
    setError("");
    try {
      const picked = await pickFolder("Where should the notes go?");
      if (picked) setFolder(picked);
    } catch {
      setChooser(false);
      setError("The folder chooser didn't open. Type the folder instead.");
    }
  };

  const ready = !busy && !!look && !!target && !target.problem && (target.files === 0 || yes);

  const restore = async () => {
    if (!ready || !look) return;
    setError("");
    setBusy("restoring");
    try {
      const res = await api<Restored>("POST", "/api/backup/restore", { folder, replace: yes });
      if (!res.restart) {
        setBusy(null);
        setError("Restored. Quit Orrama and open it again to finish.");
        return;
      }
      setBusy("restarting");
      await backAsRestored();
      onDone();
    } catch (e) {
      setBusy(null);
      setError(e instanceof ApiError && e.status < 500 ? e.message : e instanceof Error && /didn't come back/.test(e.message) ? e.message : "The backup wasn't restored. Try again in a moment.");
    }
  };

  return (
    <form
      className="dr-ch"
      onSubmit={(e) => {
        e.preventDefault();
        void restore();
      }}
      noValidate
    >
      {place === "settings" && (
        <p className="dr-ch-note">
          Restoring replaces everything Orrama holds now (accounts, settings, comments, each note's history) with the backup's. The notes folder you use now stays as it is.
        </p>
      )}
      <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={(e) => void choose(e.target.files?.[0])} aria-label="The backup file" />
      <div className="dr-ch-pick">
        {(look || busy === "reading") && (
          <p className="dr-ch-picked">
            <b>{fileName}</b>
            <span>{look ? backupWords(look) : "Reading it…"}</span>
          </p>
        )}
        <Button onClick={() => input.current?.click()} disabled={!!busy}>
          {look ? "Choose another backup…" : "Choose the backup…"}
        </Button>
      </div>
      {look?.keyOpens === false && <p className="dr-ch-note">{OTHER_COMPUTER}</p>}

      {look && (
        <>
          {chooser ? (
            <div className="dr-ch-pick">
              <p className="dr-ch-picked">
                <span>The notes go in</span>
                <b>{target?.folder || folder}</b>
                {target?.problem && <span className="bad">{target.problem}</span>}
              </p>
              <Button onClick={() => void pickOther()} disabled={!!busy}>
                Choose another folder…
              </Button>
            </div>
          ) : (
            <Field label="The notes go in" error={target?.problem ?? null} help="The whole path, like ~/Orrama. Orrama makes the folder if it isn't there.">
              <Input value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} autoCapitalize="off" autoComplete="off" disabled={!!busy} />
            </Field>
          )}
          {target && !target.problem && target.files > 0 && (
            <button type="button" role="checkbox" aria-checked={yes} className={yes ? "dr-ch-opt on" : "dr-ch-opt"} disabled={!!busy} onClick={() => setYes(!yes)}>
              <b>Put the notes in this folder anyway</b>
              <span>
                It already has {n(target.files)} {target.files === 1 ? "file" : "files"} in it. A file with the same name is replaced by the backup's. The others stay.
              </span>
            </button>
          )}
        </>
      )}

      {error && (
        <p className="dr-err" role="alert">
          {error}
        </p>
      )}
      {busy === "restarting" && (
        <p className="dr-ch-note" aria-live="polite">
          Orrama restarts with your backup…
        </p>
      )}
      <div className="dr-ch-acts">
        {onCancel && (
          <Button onClick={onCancel} disabled={busy === "restoring" || busy === "restarting"}>
            {place === "first" ? "Back" : "Cancel"}
          </Button>
        )}
        <Button kind="solid" type="submit" className={place === "first" ? "dr-go" : undefined} disabled={!ready}>
          {busy === "restoring" || busy === "restarting" ? "Restoring…" : "Restore"}
        </Button>
      </div>
    </form>
  );
}
