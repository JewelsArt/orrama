import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { Company as CompanyRecord, Contact as ContactRecord } from "@orrama/schema/responses";
export type { CompanyRecord, ContactRecord };

const href = (url: string) => `https://${url.replace(/^https?:\/\//, "")}`;
export const initials = (name: string) =>
  name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");

/**
 * One shared card for a person, wherever they turn up — the contacts list, a
 * company's roster, a project's people panel. Same layout everywhere, always
 * one click from the note, and it can hand you back where you came from, which
 * is what makes moving between linked things feel like one place.
 */
export function ContactSheet({
  contact,
  onBack,
  backLabel,
  onOpenNote,
  onRemove,
  extra,
}: {
  contact: ContactRecord;
  onBack?: () => void;
  backLabel?: string;
  onOpenNote: (id: string) => void;
  /** Shown as "Remove" when this card sits inside something it belongs to. */
  onRemove?: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="sheet">
      <header className="sheet-head">
        {onBack && (
          <button className="sheet-back" onClick={onBack}>
            ← {backLabel ?? "Back"}
          </button>
        )}
      </header>
      <div className="sheet-id">
        <span className="sheet-av">{initials(contact.name)}</span>
        <div>
          <div className="sheet-name">{contact.name}</div>
          <div className="sheet-sub">
            {[contact.role, contact.company].filter(Boolean).join(" · ") || contact.sector}
          </div>
        </div>
      </div>

      <dl className="sheet-rows">
        {contact.email && (
          <Row k="Email">
            <a href={`mailto:${contact.email}`}>{contact.email}</a>
          </Row>
        )}
        {contact.phone && (
          <Row k="Phone">
            <a href={`tel:${contact.phone.replace(/\s/g, "")}`}>{contact.phone}</a>
          </Row>
        )}
        {contact.linkedin && (
          <Row k="LinkedIn">
            <a href={href(contact.linkedin)} target="_blank" rel="noreferrer">
              {contact.linkedin.replace(/^https?:\/\//, "")}
            </a>
          </Row>
        )}
        {contact.sector && <Row k="Sector">{contact.sector}</Row>}
      </dl>

      {extra}

      <div className="sheet-actions">
        <button className="ct-btn" onClick={() => onOpenNote(contact.id)}>
          Open note
        </button>
        {onRemove && (
          <button className="ct-btn danger" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="sheet-row">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Everyone in your contacts who works at `company`. The link is the `company`
 * front-matter field on contact notes — the same string the contact card shows —
 * so filing a contact under a company is all it takes to see them here.
 */
export function useColleagues(companyName: string | null): ContactRecord[] {
  const [all, setAll] = useState<ContactRecord[]>([]);
  useEffect(() => {
    if (!companyName) return;
    void api<ContactRecord[]>("GET", "/api/contacts").then(setAll);
  }, [companyName]);
  if (!companyName) return [];
  const needle = companyName.trim().toLowerCase();
  return all.filter((c) => {
    const at = c.company.trim().toLowerCase();
    return at !== "" && (at === needle || at.includes(needle) || needle.includes(at));
  });
}
