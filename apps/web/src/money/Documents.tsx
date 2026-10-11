/**
 * Every uploaded file (`/money/documents`), newest first, grouped by the month it arrived, and
 * readable in place rather than only downloadable.
 */
import { isoLocal, monthKey } from "@basalt/core/dates";
import type { FinanceData } from "@basalt/schema/responses";
import { Button } from "../ui/controls.js";
import { EmptyState } from "../ui/states.js";
import { dayLabel, FINANCE_FILES_DIR, kb, monthLong, plural } from "./format.js";

export function DocumentsPage({ d, onRead, onUpload }: { d: FinanceData; onRead: (name: string) => void; onUpload: () => void }) {
  if (d.files.length === 0)
    return (
      <section className="mod">
        <EmptyState
          pose="carry"
          title="Nothing uploaded yet."
          text={`Bank exports and payslips you add are kept in ${FINANCE_FILES_DIR}, beside your notes.`}
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
          {plural(d.files.length, "file")} · {kb(total)} · in {FINANCE_FILES_DIR}
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
            <button key={f.name} type="button" className="row mdoc" onClick={() => onRead(f.name)}>
              <span className="lead">
                <span className="ext">{f.ext.replace(".", "") || "file"}</span>
              </span>
              <span className="x">
                <span className="t">{f.name}</span>
                <span className="m">{dayLabel(isoLocal(new Date(f.mtimeMs)))}</span>
              </span>
              <span className="r">{kb(f.size)}</span>
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}
