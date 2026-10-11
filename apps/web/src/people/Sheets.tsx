/**
 * A person's and a company's detail view, at their addresses (`/people/<slug>`,
 * `/companies/<slug>`). Entity pages replace these in wave D (structure.md §2.6, R11); until
 * then they are today's cards, in the system's Sheet: everything the old ones did — contact
 * links, the sector, a company's fields and its edit, the people you know there — and Back
 * returns to where you were.
 */
import { useState, type ReactNode } from "react";
import type { Company, Contact } from "@basalt/schema/responses";
import { api, ApiError } from "../api.js";
import { Button, LinkButton, Ring, Square } from "../ui/controls.js";
import { Field, Form, Input, Select, Textarea } from "../ui/fields.js";
import { RowList } from "../ui/layout.js";
import { Sheet } from "../ui/overlays.js";
import { Notice } from "../ui/states.js";
import { type Route } from "../ui/router.js";
import { linkText, sameSector } from "./model.js";
import { SECTOR_SUGGESTIONS } from "./NewDialogs.js";
import { Name, PersonRow, type RouteOf } from "./rows.js";

const href = (url: string) => `https://${url.replace(/^https?:\/\//, "")}`;
const bare = (url: string) => url.replace(/^https?:\/\//, "");

function Facts({ children }: { children: ReactNode }) {
  return <dl className="pp-facts">{children}</dl>;
}
function Fact({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Said when a change is refused: never the server's own words unless they are the fix. */
const refusal = (e: unknown): { title: string; text: string } =>
  e instanceof ApiError && e.status === 409
    ? { title: "Not changed", text: e.message }
    : e instanceof ApiError && e.status === 403
      ? { title: "Not changed", text: "You can read this note but not edit it." }
      : { title: "Not changed", text: "The server didn't answer. Try again." };

export function PersonSheet({
  person,
  company,
  onClose,
  onOpenNote,
  onChanged,
}: {
  person: Contact;
  company: { name: string; route: Route } | null;
  onClose: () => void;
  onOpenNote: (id: string) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [sector, setSector] = useState(person.sector);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ title: string; text: string } | null>(null);
  const at = linkText(person.company);
  // The note's own sector stays in the list even when it is not one of the suggestions.
  const options = SECTOR_SUGGESTIONS.some((s) => sameSector(s, sector)) ? SECTOR_SUGGESTIONS : [sector, ...SECTOR_SUGGESTIONS];

  /** WEB-022: the server sets it with core's front-matter writer; the page never edits note text. */
  const changeSector = async (next: string) => {
    const was = sector;
    setSector(next);
    setBusy(true);
    setFailure(null);
    try {
      await api("PATCH", `/api/contacts/${person.id}`, { sector: next });
      await onChanged();
    } catch (e) {
      setSector(was);
      setFailure(refusal(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={person.name} onClose={onClose} className="pp-sheet">
      <div className="pp-id">
        <Ring name={person.name} />
        <div>
          <b>{person.role || "No role yet"}</b>
          {at && (
            <span>
              at <Name to={company?.route ?? null}>{at}</Name>
            </span>
          )}
        </div>
      </div>
      <Facts>
        {person.email && (
          <Fact k="Email">
            <a href={`mailto:${person.email}`}>{person.email}</a>
          </Fact>
        )}
        {person.phone && (
          <Fact k="Phone">
            <a href={`tel:${person.phone.replace(/\s/g, "")}`}>{person.phone}</a>
          </Fact>
        )}
        {person.linkedin && (
          <Fact k="LinkedIn">
            <a href={href(person.linkedin)} target="_blank" rel="noreferrer">
              {bare(person.linkedin)}
            </a>
          </Fact>
        )}
      </Facts>
      <Field label="Sector">
        <Select value={options.find((s) => sameSector(s, sector)) ?? sector} disabled={busy} onChange={(e) => void changeSector(e.target.value)}>
          {options.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </Field>
      {failure && <Notice title={failure.title} text={failure.text} />}
      <div className="pp-acts">
        {person.email && (
          <LinkButton icon="mail" href={`mailto:${person.email}`}>
            Email
          </LinkButton>
        )}
        <Button icon="notes" onClick={() => onOpenNote(person.id)}>
          Open note
        </Button>
      </div>
    </Sheet>
  );
}

export function CompanySheet({
  company,
  people,
  routeOf,
  onClose,
  onOpenNote,
  onChanged,
}: {
  company: Company;
  /** Who you know here. */
  people: (Contact & { slug: string })[];
  routeOf: RouteOf;
  onClose: () => void;
  onOpenNote: (id: string) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <Sheet title={company.name} onClose={onClose} className="pp-sheet">
      <div className="pp-id">
        <Square name={company.name} />
        <div>
          <b>{company.sector}</b>
          {company.location && <span>{company.location}</span>}
        </div>
      </div>
      {editing ? (
        <CompanyEdit company={company} onDone={() => setEditing(false)} onSaved={onChanged} />
      ) : (
        <>
          <Facts>
            <Fact k="What they do">{company.description || <span className="pp-quiet">Nothing yet. Edit to add a line about what they do.</span>}</Fact>
            {company.positions.length > 0 && (
              <Fact k="Positions seen">
                <span className="pp-chips">
                  {company.positions.map((p) => (
                    <span key={p} className="chip">
                      {p}
                    </span>
                  ))}
                </span>
              </Fact>
            )}
            {company.linkedin && (
              <Fact k="LinkedIn">
                <a href={href(company.linkedin)} target="_blank" rel="noreferrer">
                  {bare(company.linkedin)}
                </a>
              </Fact>
            )}
            {company.careers && (
              <Fact k="Jobs page">
                <a href={href(company.careers)} target="_blank" rel="noreferrer">
                  {bare(company.careers)}
                </a>
              </Fact>
            )}
            {company.website && (
              <Fact k="Website">
                <a href={href(company.website)} target="_blank" rel="noreferrer">
                  {bare(company.website)}
                </a>
              </Fact>
            )}
          </Facts>
          <section className="pp-here" aria-label="People you know here">
            <h3>People you know here</h3>
            {people.length === 0 ? (
              <p className="pp-quiet">
                Nobody yet. Set <code>company: {company.name}</code> on a person and they appear here.
              </p>
            ) : (
              <RowList label="People you know here">
                {people.map((p) => (
                  <PersonRow key={p.id} person={p} company={null} entry={undefined} routeOf={routeOf} />
                ))}
              </RowList>
            )}
          </section>
          <div className="pp-acts">
            {company.linkedin && (
              <LinkButton icon="ext" href={href(company.linkedin)} target="_blank" rel="noreferrer">
                LinkedIn
              </LinkButton>
            )}
            {company.careers && (
              <LinkButton icon="ext" href={href(company.careers)} target="_blank" rel="noreferrer">
                Jobs
              </LinkButton>
            )}
            <Button icon="pen" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button icon="notes" onClick={() => onOpenNote(company.id)}>
              Open note
            </Button>
          </div>
        </>
      )}
    </Sheet>
  );
}

function CompanyEdit({ company, onDone, onSaved }: { company: Company; onDone: () => void; onSaved: () => Promise<void> | void }) {
  const [f, setF] = useState({
    description: company.description,
    sector: company.sector,
    location: company.location,
    linkedin: company.linkedin,
    website: company.website,
    careers: company.careers,
    positions: company.positions.join(", "),
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ title: string; text: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api("PATCH", `/api/companies/${company.id}`, {
        description: f.description.trim(),
        sector: f.sector.trim() || "Other",
        location: f.location.trim(),
        linkedin: f.linkedin.trim(),
        website: f.website.trim(),
        careers: f.careers.trim(),
        positions: f.positions.split(",").map((p) => p.trim()).filter(Boolean),
      });
      await onSaved();
      onDone();
    } catch (e) {
      setFailure(refusal(e));
      setBusy(false);
    }
  };
  return (
    <Form
      onSubmit={() => void save()}
      actions={
        <>
          <Button kind="quiet" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" kind="solid" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <Field label="What they do">
        <Textarea data-autofocus rows={3} value={f.description} onChange={set("description")} />
      </Field>
      <div className="pp-pair">
        <Field label="Sector">
          <Input value={f.sector} onChange={set("sector")} list="pp-edit-sectors" />
        </Field>
        <Field label="Location">
          <Input value={f.location} onChange={set("location")} />
        </Field>
      </div>
      <datalist id="pp-edit-sectors">
        {SECTOR_SUGGESTIONS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <Field label="LinkedIn">
        <Input value={f.linkedin} onChange={set("linkedin")} placeholder="linkedin.com/company/…" />
      </Field>
      <Field label="Website">
        <Input value={f.website} onChange={set("website")} />
      </Field>
      <Field label="Jobs page">
        <Input value={f.careers} onChange={set("careers")} />
      </Field>
      <Field label="Positions seen there" help="Separate them with commas.">
        <Input value={f.positions} onChange={set("positions")} />
      </Field>
      {failure && <Notice title={failure.title} text={failure.text} />}
    </Form>
  );
}

/** An address that names no one: said plainly, with the way back. */
export function NotFound({ kind, onClose }: { kind: "person" | "company"; onClose: () => void }) {
  return (
    <Sheet title={kind === "person" ? "No one here" : "No company here"} onClose={onClose} className="pp-sheet">
      <Notice
        title={kind === "person" ? "There's no person at this address." : "There's no company at this address."}
        text="Their note may have been renamed, moved or made private. Find them in People."
        actions={
          <Button size="sm" onClick={onClose}>
            Back to People
          </Button>
        }
      />
    </Sheet>
  );
}
