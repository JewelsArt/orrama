/**
 * The entity page's header (structure.md §2.5–2.6, §6 #28): the breadcrumb, a lead (a project's
 * progress ring, a person's ring, a company's square, a document's type), the title, one line
 * of meta, and the actions. One row on the desktop; on the phone the meta wraps under the title
 * and the actions leave for the top bar's ⋯ (the page passes them to `phoneActions` too, or
 * keeps them in its own menu).
 *
 * Built for the project page first; R11's person, company, conversation and document pages use
 * the same header with their own lead, meta and actions.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useWrite } from "../ui/writes.js";
import { Crumbs, type Crumb } from "../ui/layout.js";

export function EntityHeader({
  crumbs,
  lead,
  title,
  meta,
  actions,
}: {
  crumbs?: Crumb[];
  /** 44 px on the desktop, 36 on the phone. */
  lead?: ReactNode;
  title: ReactNode;
  /** The quiet line under the title: status, dates, area, counts. Items wrap. */
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="ent-head">
      {crumbs && crumbs.length > 0 && <Crumbs items={crumbs} />}
      <div className={`ent-id${lead ? "" : " no-lead"}`}>
        {lead && <span className="ent-lead">{lead}</span>}
        <div className="ent-x">
          <h1>{title}</h1>
          {meta && <div className="ent-meta">{meta}</div>}
        </div>
        {actions && <div className="ent-acts">{actions}</div>}
      </div>
    </header>
  );
}

/**
 * A title you can rename in place (the project page's, 1E): the title is a button that turns
 * into a field. Enter or leaving the field saves; Escape puts the name back. A refusal stays
 * under the field with the words typed. `editing` is the page's, so its ⋯ → Rename… opens the
 * same field.
 */
export function EditableTitle({
  value,
  canEdit,
  editing,
  onEditing,
  onSave,
}: {
  value: string;
  canEdit: boolean;
  editing: boolean;
  onEditing: (on: boolean) => void;
  /** Write the new name; throw to keep the field open with the reason. */
  onSave: (name: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(value);
  const save = useWrite();
  const settled = useRef(false);
  useEffect(() => {
    if (editing) {
      setDraft(value);
      save.clear();
      settled.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the field opens
  }, [editing]);
  if (!canEdit) return <>{value}</>;
  if (!editing)
    return (
      <button type="button" className="ent-title-btn" aria-label={`${value}. Rename it`} onClick={() => onEditing(true)}>
        {value}
      </button>
    );
  const commit = () => {
    if (settled.current) return;
    const name = draft.replace(/\s+/g, " ").trim();
    if (!name || name === value) {
      settled.current = true;
      onEditing(false);
      return;
    }
    settled.current = true;
    void save.run("The project wasn't renamed.", () => onSave(name)).then((ok) => {
      if (ok) onEditing(false);
      else settled.current = false;
    });
  };
  return (
    <span className="ent-title-edit">
      <input
        className="ent-title-input"
        autoFocus
        aria-label="Name"
        value={draft}
        maxLength={120}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            settled.current = true;
            onEditing(false);
          }
        }}
      />
      {save.error && (
        <span className="ent-title-err" role="alert">
          {save.error}
        </span>
      )}
    </span>
  );
}
