import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog } from "./dialog.js";
import { api, type Me } from "./api.js";
import { contactNote, createNote } from "./newNote.js";
import { Companies } from "./Companies.js";
import { IconPlus, IconSearch } from "./icons.js";
import { onWs } from "./ws.js";
import type { Contact } from "@basalt/schema/responses";
import { Icon } from "./ui/Icon.js";

const SECTOR_SUGGESTIONS = ["Finance", "Marketing", "Leadership", "Operations", "University", "Engineering", "Design", "Other"];
/**
 * Contacts are notes under Contacts/ tagged #contact — this page is a sector-
 * grouped view over them. Open one to keep meeting notes, [[links]], tasks;
 * keep private ones in Personal/, share with #share/<team> like any note.
 */
export function Contacts({ me, onOpenNote }: { me: Me; onOpenNote: (id: string) => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => setContacts(await api<Contact[]>("GET", "/api/contacts")), []);

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

  const [activeTag, setActiveTag] = useState("all");
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [isUpdatingTag, setIsUpdatingTag] = useState(false);

  const updateSector = async (newSector: string) => {
    if (!selectedContact) return;
    setIsUpdatingTag(true);
    try {
      // WEB-022: the server sets it with core's front-matter writer; the page never edits note text.
      await api("PATCH", `/api/contacts/${selectedContact.id}`, { sector: newSector });

      const updatedContact = { ...selectedContact, sector: newSector };
      setSelectedContact(updatedContact);
      
      await load();
    } catch (err) {
      console.error("Failed to update sector:", err);
    } finally {
      setIsUpdatingTag(false);
    }
  };

  const q = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    let list = [...contacts].sort((a, b) => a.name.localeCompare(b.name));
    if (activeTag !== "all") {
      list = list.filter((c) => c.sector.toLowerCase() === activeTag);
    }
    if (q !== "") {
      list = list.filter((c) =>
        [c.name, c.sector, c.role, c.company, c.email].some((f) => f.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [contacts, q, activeTag]);

  return (
    <div className="contacts">
      <div className="ct-top">
        <h1 className="ct-h1">Contacts</h1>
        <label className="ct-search">
          <IconSearch />
          <input
            placeholder="Search people and companies…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter contacts"
          />
        </label>
      </div>

      <div className="ct-tags">
        <span className="ct-tags-lbl">People</span>
        <button
          className={`ct-tagf ${activeTag === "all" ? "active" : ""}`}
          onClick={() => setActiveTag("all")}
          data-tag="all"
        >
          All
        </button>
        {SECTOR_SUGGESTIONS.filter((s) => s !== "Other").map((sector) => {
          const t = sector.toLowerCase();
          return (
            <button
              key={t}
              className={`ct-tagf ${activeTag === t ? "active" : ""}`}
              onClick={() => setActiveTag(t)}
              data-tag={t}
            >
              <span className="dot"></span>
              {sector}
            </button>
          );
        })}
      </div>

      <div className="ct-split">
        <section className="ct-pane">
          <header className="ct-pane-head">
            <h2>People</h2>
            <span className="ct-count">{visible.length}</span>
            <button className="ct-add" onClick={() => setAdding(true)}>
              <IconPlus /> Contact
            </button>
          </header>
          <div className="ct-pane-body">
      <div className="ct-list">
        {visible.map((c, i) => {
          const tagClass = c.sector ? c.sector.toLowerCase() : "other";
          return (
            <article
              key={c.id}
              className={`ct-card ${i === 0 ? "firstvis" : ""}`}
              onClick={() => setSelectedContact(c)}
              tabIndex={0}
              role="button"
              onKeyDown={(e) => e.key === "Enter" && setSelectedContact(c)}
            >
              <span className={`ct-av ${tagClass}`} style={tagClass !== 'other' ? { background: `var(--t-${tagClass}, var(--cat-b))` } : {}}>
                {c.name.split(/\s+/).slice(0, 2).map((p) => p[0]).join("")}
              </span>
              <span className="ct-idn">
                <span className="ct-name">
                  {c.name}
                  {c.personal && <span className="badge" style={{ marginLeft: 6 }} title="In your personal vault">private</span>}
                </span>
                <span className="ct-role">
                  {c.role} {c.role && c.company ? " · " : ""} {c.company}
                </span>
              </span>
              <span className="ct-cardtags">
                {c.sector && (
                  <span className={`tag ${tagClass}`}>
                    <span className="dot"></span>
                    {c.sector}
                  </span>
                )}
              </span>
              <span className="ct-quick">
                {c.email && (
                  <a href={`mailto:${c.email}`} title={c.email} onClick={(e) => e.stopPropagation()}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="5" width="18" height="14" rx="2" />
                      <path d="M4 7l8 6 8-6" />
                    </svg>
                  </a>
                )}
                {c.phone && (
                  <a href={`tel:${c.phone.replace(/\s/g, "")}`} title={c.phone} onClick={(e) => e.stopPropagation()}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M4 4h4l2 5-2.5 1.5a11 11 0 005 5L14 12l5 2v4a2 2 0 01-2 2A15 15 0 013 6a2 2 0 012-2z" />
                    </svg>
                  </a>
                )}
                {c.linkedin && (
                  <a href={`https://${c.linkedin.replace(/^https?:\/\//, "")}`} target="_blank" rel="noreferrer" title="LinkedIn" onClick={(e) => e.stopPropagation()}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M9 15l6-6M10 6l1-1a4 4 0 016 6l-1 1M14 18l-1 1a4 4 0 01-6-6l1-1" />
                    </svg>
                  </a>
                )}
              </span>
            </article>
          );
        })}
        {visible.length === 0 && (
          <p className="empty" style={{ padding: "20px" }}>
            {q || activeTag !== "all" ? `No contacts match your filters.` : "No contacts yet — add the first one."}
          </p>
        )}
      </div>
          </div>
        </section>

        <Companies me={me} onOpenNote={onOpenNote} query={q} />
      </div>

      {adding && (
        <AddContact
          me={me}
          onClose={() => setAdding(false)}
          onSaved={async (noteId) => {
            setAdding(false);
            await load();
            onOpenNote(noteId);
          }}
        />
      )}

      {selectedContact && (
        <div className="ct-backdrop" onClick={() => setSelectedContact(null)}>
          <Dialog label="Contact" className="ct-modal">
            <div className="ct-m-head">
              <span 
                className={`ct-m-av ${selectedContact.sector ? selectedContact.sector.toLowerCase() : "other"}`}
                style={selectedContact.sector ? { background: `var(--t-${selectedContact.sector.toLowerCase()}, var(--cat-b))` } : {}}
              >
                {selectedContact.name.split(/\s+/).slice(0, 2).map((p) => p[0]).join("")}
              </span>
              <span className="ct-m-idn">
                <div className="ct-m-name">{selectedContact.name}</div>
                <div className="ct-m-role">{selectedContact.role} {selectedContact.role && selectedContact.company ? "·" : ""} {selectedContact.company}</div>
              </span>
              <button className="ct-m-close" onClick={() => setSelectedContact(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>
            
            <div className="ct-m-tags">
              <span className={`tag ${selectedContact.sector ? selectedContact.sector.toLowerCase() : "other"}`} style={selectedContact.sector ? {} : { background: "var(--cat-b)", borderColor: "var(--cat-b)", color: "#fff" }}>
                <span className="dot" style={selectedContact.sector ? {} : { background: "#fff" }}></span>
                <select 
                  className="ct-tag-select"
                  disabled={isUpdatingTag}
                  value={selectedContact.sector || "Other"}
                  onChange={(e) => updateSector(e.target.value)}
                  style={{ color: "inherit" }}
                >
                  <option value="Other" disabled>Select Tag...</option>
                  {SECTOR_SUGGESTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </span>
            </div>

            <div className="ct-m-list">
              {selectedContact.role && (
                <div className="ct-m-row">
                  <span className="ct-m-ic">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="7" r="4"></circle><path d="M5.5 21v-2a4 4 0 0 1 4-4h5a4 4 0 0 1 4 4v2"></path>
                    </svg>
                  </span>
                  <span className="ct-m-body">
                    <div className="ct-m-k">Position</div>
                    <div className="ct-m-v">{selectedContact.role}</div>
                  </span>
                </div>
              )}
              {selectedContact.company && (
                <div className="ct-m-row">
                  <span className="ct-m-ic">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="4" y="2" width="16" height="20" rx="2" ry="2"></rect><path d="M9 22v-4h6v4"></path><path d="M8 6h.01"></path><path d="M16 6h.01"></path><path d="M12 6h.01"></path><path d="M12 10h.01"></path><path d="M12 14h.01"></path><path d="M16 10h.01"></path><path d="M16 14h.01"></path><path d="M8 10h.01"></path><path d="M8 14h.01"></path>
                    </svg>
                  </span>
                  <span className="ct-m-body">
                    <div className="ct-m-k">Company</div>
                    <div className="ct-m-v">{selectedContact.company}</div>
                  </span>
                </div>
              )}
              {selectedContact.email && (
                <div className="ct-m-row">
                  <span className="ct-m-ic">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline>
                    </svg>
                  </span>
                  <span className="ct-m-body">
                    <div className="ct-m-k">Email</div>
                    <div className="ct-m-v"><a href={`mailto:${selectedContact.email}`}>{selectedContact.email}</a></div>
                  </span>
                </div>
              )}
              {selectedContact.phone && (
                <div className="ct-m-row">
                  <span className="ct-m-ic">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
                    </svg>
                  </span>
                  <span className="ct-m-body">
                    <div className="ct-m-k">Phone</div>
                    <div className="ct-m-v"><a href={`tel:${selectedContact.phone.replace(/\s/g, "")}`}>{selectedContact.phone}</a></div>
                  </span>
                </div>
              )}
              {selectedContact.linkedin && (
                <div className="ct-m-row">
                  <span className="ct-m-ic">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"></path><rect x="2" y="9" width="4" height="12"></rect><circle cx="4" cy="4" r="2"></circle>
                    </svg>
                  </span>
                  <span className="ct-m-body">
                    <div className="ct-m-k">LinkedIn</div>
                    <div className="ct-m-v"><a href={`https://${selectedContact.linkedin.replace(/^https?:\/\//, "")}`} target="_blank" rel="noreferrer">{selectedContact.linkedin}</a></div>
                  </span>
                </div>
              )}
            </div>

            <div className="ct-m-actions">
              {selectedContact.email && (
                <a className="ct-btn pri" href={`mailto:${selectedContact.email}`}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline>
                  </svg>
                  Email
                </a>
              )}
              <button 
                className="ct-btn" 
                onClick={() => {
                  setSelectedContact(null);
                  onOpenNote(selectedContact.id);
                }}
              >
                Open note
              </button>
            </div>
          </Dialog>
        </div>
      )}
    </div>
  );
}

function AddContact({ me, onClose, onSaved }: { me: Me; onClose: () => void; onSaved: (noteId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim();
    if (!name) return;
    const val = (k: string) => String(f.get(k) ?? "").trim();
    const priv = f.get("private") === "on";
    const content = contactNote({
      name,
      sector: val("sector"),
      role: val("role"),
      company: val("company"),
      email: val("email"),
      phone: val("phone"),
      linkedin: val("linkedin"),
    });
    setBusy(true);
    setError("");
    try {
      const path = priv ? `Personal/${me.username}/Contacts/${name}.md` : `Contacts/${name}.md`;
      // Create-only: a contact with this name already there is a 409, said below, never replaced.
      const res = await createNote(path, content);
      onSaved(res.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <form className="settings contact-form" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="settings-head">
          <span>New contact</span>
        </header>
        <input name="name" placeholder="Full name" autoFocus required aria-label="Full name" />
        <div className="contact-form-row">
          <input name="sector" placeholder="Sector (Finance, Marketing…)" list="sector-list" aria-label="Sector" />
          <datalist id="sector-list">
            {SECTOR_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <input name="company" placeholder="Company" aria-label="Company" />
        </div>
        <input name="role" placeholder="Role" aria-label="Role" />
        <div className="contact-form-row">
          <input name="email" type="email" placeholder="Email" aria-label="Email" />
          <input name="phone" placeholder="Phone" aria-label="Phone" />
        </div>
        <input name="linkedin" placeholder="LinkedIn (linkedin.com/in/…)" aria-label="LinkedIn" />
        <label className="invite-team">
          <input type="checkbox" name="private" /> Private — goes in your personal vault, invisible to the team
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="cal-popup-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save contact"}
          </button>
        </div>
      </form>
    </div>
  );
}
