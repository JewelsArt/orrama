/**
 * Every uploaded file (`/money/documents`), newest first, grouped by the month it arrived, and
 * readable in place rather than only downloadable.
 */
import { isoLocal, monthKey } from "@orrama/core/dates";
import type { FinanceData } from "@orrama/schema/responses";
import { useRef, useState } from "react";
import { Button } from "../ui/controls.js";
import { Menu } from "../ui/overlays.js";
import { EmptyState } from "../ui/states.js";
import { dayLabel, kb, monthLong, plural } from "./format.js";

export function DocumentsPage({ d, onRead, onUpload, onTrash }: { d: FinanceData; onRead: (name: string) => void; onUpload: () => void; onTrash: (name: string) => void }) {
  if (d.files.length === 0)
    return (
      <section className="mod">
        <EmptyState
          pose="carry"
          title="Nothing uploaded yet."
          text="Bank exports and payslips you add are kept with your notes, on this computer."
          actions={
            <Button kind="solid" icon="upload" onClick={onUpload}>
              Add a bank export
            </Button>
          }
        />
      </section>
    );
  const groups = new Map<string, FinanceData["files"]>();
  for (const f of d.files) {
    // The month the file arrived, on the local clock: in UTC an upload at 00:30 on the 1st was filed under the month before.
    const key = monthKey(new Date(f.mtimeMs));
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const total = d.files.reduce((a, f) => a + f.size, 0);

  return (
    <section className="mod" aria-label="Documents">
      <div className="mh">
        <h2>Documents</h2>
        <span className="c">
          {plural(d.files.length, "file")} · {kb(total)}
        </span>
      </div>
      {[...groups].map(([month, files]) => (
        <div key={month} className="mday">
          <div className="mmonth static">
            <b>{monthLong(month)}</b>
            <span>{plural(files.length, "file")}</span>
            <b className="amt">{kb(files.reduce((a, f) => a + f.size, 0))}</b>
          </div>
          {files.map((f) => (
            <DocRow key={f.name} f={f} onRead={onRead} onTrash={onTrash} />
          ))}
        </div>
      ))}
    </section>
  );
}

/**
 * One file: its name opens it, and the ⋯ beside it (there on a phone too, never hover-only)
 * holds Open and Move to the trash. The two sit side by side, never one inside the other.
 */
function DocRow({ f, onRead, onTrash }: { f: FinanceData["files"][number]; onRead: (name: string) => void; onTrash: (name: string) => void }) {
  const [menu, setMenu] = useState(false);
  const at = useRef<HTMLButtonElement>(null);
  return (
    <div className="row mdoc">
      <button type="button" className="mdoc-open" onClick={() => onRead(f.name)}>
        <span className="lead">
          <span className="ext">{f.ext.replace(".", "") || "file"}</span>
        </span>
        <span className="x">
          <span className="t">{f.name}</span>
          <span className="m">{dayLabel(isoLocal(new Date(f.mtimeMs)))}</span>
        </span>
        <span className="r">{kb(f.size)}</span>
      </button>
      <Button ref={at} kind="quiet" size="sm" icon="dots" aria-label={`More for ${f.name}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} />
      {menu && (
        <Menu
          anchor={at}
          align="end"
          label={f.name}
          onClose={() => setMenu(false)}
          items={[
            { label: "Open", onSelect: () => onRead(f.name) },
            { label: "Move to the trash", danger: true, onSelect: () => onTrash(f.name) },
          ]}
        />
      )}
    </div>
  );
}
