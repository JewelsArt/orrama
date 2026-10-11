import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "./dialog.js";
import { api, type Me } from "./api.js";
import { companyNote, createNote } from "./newNote.js";
import { ContactSheet, initials as sheetInitials, useColleagues, type ContactRecord } from "./cards.js";
import { IconPlus } from "./icons.js";
import { onWs } from "./ws.js";
import type { Company } from "@basalt/schema/responses";
import { Icon } from "./ui/Icon.js";
export type { Company };

const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"];
const SECTOR_SUGGESTIONS = ["Finance", "Marketing", "Leadership", "Operations", "University", "Engineering", "Design", "Other"];
const SWATCHES = ["--blue", "--green", "--orange", "--purple", "--pink", "--t-university"];

/** A-Z bucket: anything that isn't a latin letter lands in "#", like a phone app drawer. */
const bucketOf = (name: string) => {
  const c = name.trim().charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
};

const initials = (name: string) =>
  name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");

/** Sector colour when the sector is a known one, else a stable per-name swatch. */
const swatchOf = (c: Company) => {
  const s = c.sector.toLowerCase();
  if (SECTOR_SUGGESTIONS.some((x) => x.toLowerCase() === s && s !== "other")) return `var(--t-${s})`;
  let h = 0;
  for (const ch of c.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(${SWATCHES[h % SWATCHES.length]})`;
};

const href = (url: string) => `https://${url.replace(/^https?:\/\//, "")}`;

/**
 * Companies: the orgs behind the contacts — the right half of the Contacts view,
 * cards in one alphabetical run with an OxygenOS-style letter rail down the left
 * (tap or drag it to jump). Each card is a note tagged #company — click it for the
 * description, the LinkedIn page and the kind of positions found there, or open
 * the note to write the rest. Search and the sector filter are the page's, shared
 * with the people list, so one query narrows both halves at once.
 */
export function Companies({
  me,
  onOpenNote,
  query,
}: {
  me: Me;
  onOpenNote: (id: string) => void;
  query: string;
}) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Company | null>(null);
  const [active, setActive] = useState("");
  const [scrubbing, setScrubbing] = useState<string | null>(null);

  const sections = useRef(new Map<string, HTMLElement>());
  const railRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const load = useCallback(async () => setCompanies(await api<Company[]>("GET", "/api/companies")), []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const off = onWs((msg) => {
      if (msg.type !== "note-changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 500);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [load]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    let list = [...companies].sort((a, b) => a.name.localeCompare(b.name));
    if (q !== "") {
      list = list.filter((c) =>
        [c.name, c.description, c.sector, c.location, ...c.positions].some((f) => f.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [companies, q]);

  const groups = useMemo(() => {
    const map = new Map<string, Company[]>();
    for (const c of visible) {
      const b = bucketOf(c.name);
      const bucket = map.get(b);
      if (bucket) bucket.push(c);
      else map.set(b, [c]);
    }
    return LETTERS.filter((l) => map.has(l)).map((l) => ({ letter: l, items: map.get(l)! }));
  }, [visible]);

  // Highlight the letter whose section is at the top of the scroller.
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.getAttribute("data-letter") ?? "");
      },
      { root: scrollerRef.current, rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );
    for (const el of sections.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [groups]);

  /** Jump to a letter, or to the nearest section after it (empty letters never dead-end). */
  const jumpTo = useCallback(
    (letter: string, smooth: boolean) => {
      const from = LETTERS.indexOf(letter);
      const target =
        groups.find((g) => LETTERS.indexOf(g.letter) >= from) ?? [...groups].reverse()[0];
      if (!target) return;
      sections.current.get(target.letter)?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
      setActive(target.letter);
    },
    [groups],
  );

  /** Drag down the rail to scrub through the alphabet — the phone-contacts gesture.
   *  A plain click is left to the letter buttons, so it can scroll smoothly. */
  const scrubAt = useCallback(
    (clientY: number, jump: boolean) => {
      const rect = railRef.current?.getBoundingClientRect();
      if (!rect) return;
      const i = Math.floor(((clientY - rect.top) / rect.height) * LETTERS.length);
      const letter = LETTERS[Math.max(0, Math.min(LETTERS.length - 1, i))]!;
      setScrubbing(letter);
      if (jump) jumpTo(letter, false);
    },
    [jumpTo],
  );

  return (
    <section className="ct-pane">
      <header className="ct-pane-head">
        <h2>Companies</h2>
        <span className="ct-count">{visible.length}</span>
        <button className="ct-add" onClick={() => setAdding(true)}>
          <IconPlus /> Company
        </button>
      </header>

      <div className="ct-pane-body co-body" ref={scrollerRef}>
        <div
          className="co-alpha"
          ref={railRef}
          role="navigation"
          aria-label="Jump to letter"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            dragging.current = true;
            scrubAt(e.clientY, false);
          }}
          onPointerMove={(e) => {
            if (dragging.current) scrubAt(e.clientY, true);
          }}
          onPointerUp={() => {
            dragging.current = false;
            setScrubbing(null);
          }}
          onPointerCancel={() => {
            dragging.current = false;
            setScrubbing(null);
          }}
        >
          {LETTERS.map((l) => {
            const has = groups.some((g) => g.letter === l);
            return (
              <button
                key={l}
                type="button"
                className={`co-alpha-l ${active === l ? "active" : ""} ${has ? "" : "empty"}`}
                onClick={() => jumpTo(l, true)}
                tabIndex={has ? 0 : -1}
                aria-label={`Jump to ${l}`}
              >
                {l}
              </button>
            );
          })}
          {scrubbing && <span className="co-bubble">{scrubbing}</span>}
        </div>

        <div className="co-sections">
          {groups.map((g) => (
            <section
              key={g.letter}
              data-letter={g.letter}
              ref={(el) => {
                if (el) sections.current.set(g.letter, el);
                else sections.current.delete(g.letter);
              }}
            >
              <h2 className="co-letter">
                {g.letter}
                <span className="co-letter-rule" />
                <span className="co-letter-n">{g.items.length}</span>
              </h2>
              <div className="co-grid">
                {g.items.map((c) => (
                  <article
                    key={c.id}
                    className="co-card"
                    tabIndex={0}
                    role="button"
                    aria-label={c.name}
                    onClick={() => setSelected(c)}
                    onKeyDown={(e) => e.key === "Enter" && setSelected(c)}
                  >
                    <span className="co-logo" style={{ background: swatchOf(c) }}>
                      {initials(c.name)}
                    </span>
                    <div className="co-main">
                      <div className="co-name">
                        {c.name}
                        {c.personal && (
                          <span className="badge" title="In your personal vault">
                            private
                          </span>
                        )}
                      </div>
                      <p className="co-desc">{c.description || "No description yet."}</p>
                      {c.positions.length > 0 && (
                        <div className="co-pos">
                          {c.positions.slice(0, 2).map((p) => (
                            <span key={p} className="co-chip">
                              {p}
                            </span>
                          ))}
                          {c.positions.length > 2 && <span className="co-chip more">+{c.positions.length - 2}</span>}
                        </div>
                      )}
                    </div>
                    <span className="co-links">
                      {c.linkedin && (
                        <a
                          className="co-in"
                          href={href(c.linkedin)}
                          target="_blank"
                          rel="noreferrer"
                          title="LinkedIn"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <IconLinkedIn />
                        </a>
                      )}
                      {c.careers && (
                        <a
                          className="co-in"
                          href={href(c.careers)}
                          target="_blank"
                          rel="noreferrer"
                          title="Jobs / programme page"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <IconBriefcase />
                        </a>
                      )}
                    </span>
                  </article>
                ))}
              </div>
            </section>
          ))}
          {groups.length === 0 && (
            <p className="empty" style={{ padding: "20px" }}>
              {q ? "No companies match your search." : "No companies yet — add the first one."}
            </p>
          )}
        </div>
      </div>

      {adding && (
        <AddCompany
          me={me}
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await load();
          }}
        />
      )}

      {selected && (
        <CompanyModal
          company={selected}
          onClose={() => setSelected(null)}
          onOpenNote={(id) => {
            setSelected(null);
            onOpenNote(id);
          }}
          onSaved={async (next) => {
            setSelected(next);
            await load();
          }}
        />
      )}
    </section>
  );
}

function CompanyModal({
  company,
  onClose,
  onOpenNote,
  onSaved,
}: {
  company: Company;
  onClose: () => void;
  onOpenNote: (id: string) => void;
  onSaved: (next: Company) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  // Who you know here — the card opens onto their card and back again.
  const colleagues = useColleagues(company.name);
  const [person, setPerson] = useState<ContactRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const val = (k: string) => String(f.get(k) ?? "").trim();
    const next: Company = {
      ...company,
      description: val("description"),
      sector: val("sector") || "Other",
      linkedin: val("linkedin"),
      website: val("website"),
      careers: val("careers"),
      location: val("location"),
      positions: val("positions").split(",").map((p) => p.trim()).filter(Boolean),
    };
    setBusy(true);
    setError("");
    try {
      await api("PATCH", `/api/companies/${company.id}`, {
        description: next.description,
        sector: next.sector,
        linkedin: next.linkedin,
        website: next.website,
        careers: next.careers,
        location: next.location,
        positions: next.positions,
      });
      await onSaved(next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  if (person) {
    return (
      <div className="ct-backdrop" onClick={onClose}>
        <Dialog label="Contact" className="ct-modal">
          <ContactSheet
            contact={person}
            onBack={() => setPerson(null)}
            backLabel={company.name}
            onOpenNote={(id) => {
              onClose();
              onOpenNote(id);
            }}
          />
        </Dialog>
      </div>
    );
  }

  return (
    <div className="ct-backdrop" onClick={onClose}>
      <Dialog label="Company" className="ct-modal">
        <div className="ct-m-head">
          <span className="ct-m-av" style={{ background: swatchOf(company), borderRadius: 16 }}>
            {initials(company.name)}
          </span>
          <span className="ct-m-idn">
            <div className="ct-m-name">{company.name}</div>
            <div className="ct-m-role">
              {company.sector}
              {company.location ? ` · ${company.location}` : ""}
            </div>
          </span>
          <button className="ct-m-close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        {editing ? (
          <form className="co-edit" onSubmit={save}>
            <textarea name="description" rows={3} defaultValue={company.description} placeholder="Short description" aria-label="Description" />
            <div className="contact-form-row">
              <input name="sector" defaultValue={company.sector} placeholder="Sector" list="co-sector-list" aria-label="Sector" />
              <input name="location" defaultValue={company.location} placeholder="Location" aria-label="Location" />
            </div>
            <datalist id="co-sector-list">
              {SECTOR_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <input name="linkedin" defaultValue={company.linkedin} placeholder="LinkedIn (linkedin.com/company/…)" aria-label="LinkedIn" />
            <input name="website" defaultValue={company.website} placeholder="Website" aria-label="Website" />
            <input name="careers" defaultValue={company.careers} placeholder="Jobs / programme page" aria-label="Jobs page" />
            <input
              name="positions"
              defaultValue={company.positions.join(", ")}
              placeholder="Positions found (Data Analyst, Marketing Intern…)"
              aria-label="Positions"
            />
            {error && <p className="form-error">{error}</p>}
            <div className="ct-m-actions">
              <button type="button" className="ct-btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="ct-btn pri" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="ct-m-list">
              <Row label="Description" icon={<IconInfo />}>
                {company.description || <span className="co-muted">Nothing yet — add a line about what they do.</span>}
              </Row>
              {company.positions.length > 0 && (
                <Row label="Positions found" icon={<IconBriefcase />}>
                  <div className="co-pos">
                    {company.positions.map((p) => (
                      <span key={p} className="co-chip">
                        {p}
                      </span>
                    ))}
                  </div>
                </Row>
              )}
              {company.linkedin && (
                <Row label="LinkedIn" icon={<IconLinkedIn />}>
                  <a href={href(company.linkedin)} target="_blank" rel="noreferrer">
                    {company.linkedin.replace(/^https?:\/\//, "")}
                  </a>
                </Row>
              )}
              {company.careers && (
                <Row label="Jobs / programme" icon={<IconBriefcase />}>
                  <a href={href(company.careers)} target="_blank" rel="noreferrer">
                    {company.careers.replace(/^https?:\/\//, "")}
                  </a>
                </Row>
              )}
              {company.website && (
                <Row label="Website" icon={<IconGlobe />}>
                  <a href={href(company.website)} target="_blank" rel="noreferrer">
                    {company.website.replace(/^https?:\/\//, "")}
                  </a>
                </Row>
              )}
            </div>

            <div className="co-roster">
              <div className="ct-m-k">People you know here</div>
              {colleagues.length === 0 ? (
                <p className="co-muted">
                  Nobody yet — set <code>company: {company.name}</code> on a contact and they appear here.
                </p>
              ) : (
                <ul>
                  {colleagues.map((c) => (
                    <li key={c.id}>
                      <button onClick={() => setPerson(c)}>
                        <span className="sheet-av sm">{sheetInitials(c.name)}</span>
                        <span>
                          <b>{c.name}</b>
                          <i>{c.role || c.sector}</i>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="ct-m-actions">
              {company.linkedin && (
                <a className="ct-btn pri" href={href(company.linkedin)} target="_blank" rel="noreferrer">
                  <IconLinkedIn />
                  LinkedIn
                </a>
              )}
              {company.careers && (
                <a className="ct-btn" href={href(company.careers)} target="_blank" rel="noreferrer">
                  <IconBriefcase />
                  Jobs
                </a>
              )}
              <button className="ct-btn" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button className="ct-btn" onClick={() => onOpenNote(company.id)}>
                Open note
              </button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}

function Row({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="ct-m-row">
      <span className="ct-m-ic">{icon}</span>
      <span className="ct-m-body">
        <div className="ct-m-k">{label}</div>
        <div className="ct-m-v">{children}</div>
      </span>
    </div>
  );
}

function AddCompany({ me, onClose, onSaved }: { me: Me; onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim();
    if (!name) return;
    const val = (k: string) => String(f.get(k) ?? "").trim();
    const positions = val("positions").split(",").map((p) => p.trim()).filter(Boolean);
    const priv = f.get("private") === "on";
    const content = companyNote({
      name,
      sector: val("sector"),
      description: val("description"),
      linkedin: val("linkedin"),
      website: val("website"),
      careers: val("careers"),
      location: val("location"),
      positions,
    });
    setBusy(true);
    setError("");
    try {
      const path = priv ? `Personal/${me.username}/Companies/${name}.md` : `Contacts/Companies/${name}.md`;
      // Create-only: a company with this name already there is a 409, said below, never replaced.
      await createNote(path, content);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <form className="settings contact-form" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="settings-head">
          <span>New company</span>
        </header>
        <input name="name" placeholder="Company name" autoFocus required aria-label="Company name" />
        <textarea name="description" rows={2} placeholder="Short description — what they do" aria-label="Description" />
        <div className="contact-form-row">
          <input name="sector" placeholder="Sector (Finance, Marketing…)" list="add-co-sector-list" aria-label="Sector" />
          <datalist id="add-co-sector-list">
            {SECTOR_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <input name="location" placeholder="Location" aria-label="Location" />
        </div>
        <input name="linkedin" placeholder="LinkedIn (linkedin.com/company/…)" aria-label="LinkedIn" />
        <input name="website" placeholder="Website" aria-label="Website" />
        <input name="careers" placeholder="Jobs / programme page (careers.…)" aria-label="Jobs page" />
        <input name="positions" placeholder="Positions found (Data Analyst, Marketing Intern…)" aria-label="Positions" />
        <label className="invite-team">
          <input type="checkbox" name="private" /> Private — goes in your personal vault, invisible to the team
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="cal-popup-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save company"}
          </button>
        </div>
      </form>
    </div>
  );
}

const IconLinkedIn = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"></path>
    <rect x="2" y="9" width="4" height="12"></rect>
    <circle cx="4" cy="4" r="2"></circle>
  </svg>
);

const IconGlobe = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="9"></circle>
    <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"></path>
  </svg>
);

const IconBriefcase = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="2" y="7" width="20" height="14" rx="2"></rect>
    <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>
  </svg>
);

const IconInfo = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="9"></circle>
    <path d="M12 11v5M12 8h.01"></path>
  </svg>
);
