import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Me } from "./api.js";
import { IconPlus, IconSearch } from "./icons.js";
import { onWs } from "./ws.js";

interface Contact {
  id: string;
  name: string;
  path: string;
  sector: string;
  role: string;
  company: string;
  email: string;
  phone: string;
  linkedin: string;
  personal: boolean;
}

const SECTOR_SUGGESTIONS = ["Finance", "Marketing", "Leadership", "Operations", "University", "Engineering", "Other"];

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

  const q = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      q === ""
        ? contacts
        : contacts.filter((c) =>
            [c.name, c.sector, c.role, c.company, c.email].some((f) => f.toLowerCase().includes(q)),
          ),
    [contacts, q],
  );
  const sectors = useMemo(() => {
    const map = new Map<string, Contact[]>();
    for (const c of visible) {
      const list = map.get(c.sector) ?? [];
      list.push(c);
      map.set(c.sector, list);
    }
    return [...map.entries()];
  }, [visible]);

  return (
    <div className="contacts">
      <header className="view-head">
        <h1 className="contacts-title">Contacts</h1>
        <label className="ft-filter contacts-filter">
          <IconSearch />
          <input
            placeholder="Filter by name, sector, company…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter contacts"
          />
        </label>
        <span className="scope-count">{visible.length}</span>
        <button className="primary contacts-add" onClick={() => setAdding(true)}>
          <IconPlus /> Contact
        </button>
      </header>

      <div className="contacts-sectors">
        {sectors.map(([sector, list]) => (
          <section key={sector} className="contact-sector">
            <h2>
              {sector} <span className="ft-count">{list.length}</span>
            </h2>
            <div className="contact-cards">
              {list.map((c) => (
                <article key={c.id} className="contact-card" onClick={() => onOpenNote(c.id)} tabIndex={0} role="button"
                  onKeyDown={(e) => e.key === "Enter" && onOpenNote(c.id)}>
                  <span className="contact-initials" aria-hidden>
                    {c.name.split(/\s+/).slice(0, 2).map((p) => p[0]).join("")}
                  </span>
                  <div className="contact-body">
                    <span className="contact-name">
                      {c.name}
                      {c.personal && <span className="badge" title="In your personal vault">private</span>}
                    </span>
                    {(c.role || c.company) && (
                      <span className="contact-role">
                        {c.role}
                        {c.role && c.company ? " · " : ""}
                        {c.company}
                      </span>
                    )}
                    <span className="contact-links" onClick={(e) => e.stopPropagation()}>
                      {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
                      {c.phone && <a href={`tel:${c.phone.replace(/\s/g, "")}`}>{c.phone}</a>}
                      {c.linkedin && (
                        <a href={`https://${c.linkedin.replace(/^https?:\/\//, "")}`} target="_blank" rel="noreferrer">
                          linkedin
                        </a>
                      )}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
        {sectors.length === 0 && (
          <p className="empty">{q ? `No contacts match “${filter}”.` : "No contacts yet — add the first one."}</p>
        )}
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
    const content = [
      "---",
      `title: ${name}`,
      "tags: [contact]",
      `sector: ${val("sector") || "Other"}`,
      `role: ${val("role")}`,
      `company: ${val("company")}`,
      `email: "${val("email")}"`,
      `phone: "${val("phone")}"`,
      `linkedin: "${val("linkedin")}"`,
      "---",
      `# ${name}`,
      "",
    ].join("\n");
    setBusy(true);
    setError("");
    try {
      const path = priv ? `Personal/${me.username}/Contacts/${name}.md` : `Contacts/${name}.md`;
      const res = await api<{ id: string }>("PUT", "/api/vault/note", { path, content });
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
