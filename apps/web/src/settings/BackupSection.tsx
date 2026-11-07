/**
 * Settings → Notes → Back up (2F), owners only: Back up now and Restore from a backup…, in
 * place of the old "In Terminal, run pnpm … export".
 *
 * Back up now: in the app the system's folder chooser says where the .zip goes and the server
 * writes it there; in a browser (or when the chooser can't open) the server makes it and the
 * browser downloads it. Either way the page says its name, its size and where it went. The
 * secret key that opens the mail password and the AI key stays on this computer (Jules, D13).
 *
 * Restore from a backup… opens door/RestoreBackup.tsx in a dialog.
 */
import { useState } from "react";
import type { BackupMade } from "@orrama/schema/responses";
import { api } from "../api.js";
import { inApp, pickFolder } from "../desktop.js";
import { RestoreBackup } from "../door/RestoreBackup.js";
import { Button } from "../ui/controls.js";
import { Dialog } from "../ui/overlays.js";
import { Notice } from "../ui/states.js";
import { useWrite } from "../ui/writes.js";
import { StateLine, SubHead } from "./parts.js";

/** "12.4 MB", "820 KB": a size as a person reads it. */
export function sizeWords(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Where the zip went, said after: the folder in the app, the browser's downloads otherwise. */
export function madeWords(made: BackupMade): string {
  return made.folder ? `${sizeWords(made.bytes)}, in ${made.folder}` : `${sizeWords(made.bytes)}, in your downloads`;
}

/** Hand a browser the download: a plain link, followed once. */
function download(href: string, name: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * `restoreHere`: false where the notes folder is set where Orrama starts (Jules's own server):
 * the server refuses a restore there, so it isn't offered.
 */
export function BackupSection({ restoreHere = true }: { restoreHere?: boolean }) {
  const [made, setMade] = useState<BackupMade | null>(null);
  const [restoring, setRestoring] = useState(false);
  const write = useWrite();

  const backUp = async () => {
    let folder: string | null = null;
    if (inApp()) {
      try {
        folder = await pickFolder("Where should the backup go?");
        if (folder === null) return; // cancelled
      } catch {
        folder = null; // no chooser: the browser's download instead
      }
    }
    setMade(null);
    await write.run("The backup wasn't made.", async () => {
      const res = await api<BackupMade>("POST", "/api/backup", { folder });
      if (res.download) download(res.download, res.name);
      setMade(res);
    });
  };

  return (
    <div>
      <SubHead>Back up</SubHead>
      <p className="set-help set-lead">
        Your notes and everything Orrama keeps beside them (your account, settings, comments, each note's history) in one .zip file. The
        key that unlocks your mail and Orr's AI stays on this computer, so a lost copy opens neither.
      </p>
      {made && <StateLine tone="ok" title={made.name} detail={madeWords(made)} />}
      {write.error && <Notice title="Not backed up" text={write.error} />}
      <div className="set-actions">
        <Button kind="solid" onClick={() => void backUp()} disabled={write.busy}>
          {write.busy ? "Backing up…" : "Back up now"}
        </Button>
        {restoreHere && (
          <Button onClick={() => setRestoring(true)} disabled={write.busy}>
            Restore from a backup…
          </Button>
        )}
      </div>
      {restoring && (
        <Dialog title="Restore from a backup" onClose={() => setRestoring(false)}>
          <RestoreBackup place="settings" onCancel={() => setRestoring(false)} />
        </Dialog>
      )}
    </div>
  );
}
