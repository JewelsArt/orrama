/**
 * Relations picked from lists, never typed as properties (stage 1, 1F): where someone works (a
 * company, or a new one made in place) and the projects they supervise or are in. The
 * ontology decides what each list offers (companies for "works at", projects for "supervises");
 * the words stay plain. The server writes what a person would type: `company:
 * "[[<path>|<title>]]"`, `supervises:`, a `## People` link.
 *
 * The company field lives inside other dialogs (New person) as well as its own, and a dialog
 * replaces any other dialog (overlays.tsx: one of a kind), so it is a field with its matches
 * under it, as the project's People picker is, never a second dialog.
 */
import { useEffect, useMemo, useState } from "react";
import type { Company, Contact, ProjectRow } from "@orrama/schema/responses";
import { api, ApiError, isAbort } from "../api.js";
import { companyNote, createNote } from "../newNote.js";
import { Button, Square } from "../ui/controls.js";
import { SearchField } from "../ui/fields.js";
import { Icon } from "../ui/Icon.js";
import { Row, RowList } from "../ui/layout.js";
import { Dialog, toast } from "../ui/overlays.js";
import { Notice } from "../ui/states.js";
import { matches } from "./model.js";

/** A company as a picker hands it on. */
export interface PickedCompany {
  id: string;
  name: string;
  path: string;
}

/** Said when a pick is refused: the server's sentence when it is the fix (a 409), else plain words. */
export function refusalText(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) return e.message;
  if (e instanceof ApiError && e.status === 403) return "You can read this note but not edit it.";
  return "The server didn't answer. Try again.";
}

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();

/** Every company you can read, once asked. */
export function useCompanies(): Company[] | null {
  const [list, setList] = useState<Company[] | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    api<Company[]>("GET", "/api/companies", undefined, { signal: ac.signal })
      .then(setList)
      .catch((e) => !isAbort(e) && setList([]));
    return () => ac.abort();
  }, []);
  return list;
}

/** A company note made with its name alone, where People's New company would put it. */
export async function makeCompany(name: string): Promise<PickedCompany> {
  const n = name.trim();
  const res = await createNote(`Contacts/Companies/${n}.md`, companyNote({ name: n, sector: "", description: "", linkedin: "", website: "", careers: "", location: "", positions: [] }));
  return { id: res.id, name: n, path: res.path };
}

/**
 * Where someone works, picked: the company chosen (with Change), or a search over the
 * companies with "New company" for a name that has none. `start` is what the search begins
 * with (a company named in words that has no note yet).
 */
export function CompanyField({ value, onChange, start = "", autoFocus }: { value: PickedCompany | null; onChange: (c: PickedCompany | null) => void; start?: string; autoFocus?: boolean }) {
  const companies = useCompanies();
  const [searching, setSearching] = useState(!value);
  const [q, setQ] = useState(start);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const found = useMemo(() => (companies ?? []).filter((c) => q.trim() && matches(q, [c.name, c.description, c.location])).slice(0, 6), [companies, q]);
  const exact = (companies ?? []).some((c) => fold(c.name) === fold(q));
  const pick = (c: PickedCompany) => {
    onChange(c);
    setQ("");
    setSearching(false);
  };
  const make = async () => {
    setBusy(true);
    setFailure(null);
    try {
      pick(await makeCompany(q));
    } catch (e) {
      setFailure(e instanceof ApiError && e.status === 409 ? `There's already a note called “${q.trim()}”. Pick it from the list, or give the company a fuller name.` : e instanceof ApiError && e.status === 400 ? "This name can't be a note's file name. Leave out slashes and try again." : refusalText(e));
    } finally {
      setBusy(false);
    }
  };
  if (value && !searching)
    return (
      <div className="pp-picked">
        <Square name={value.name} small />
        <b>{value.name}</b>
        <Button size="sm" kind="quiet" onClick={() => setSearching(true)}>
          Change
        </Button>
      </div>
    );
  return (
    <div className="pp-picker">
      <SearchField label="Company" placeholder="Search your companies…" value={q} onChange={(e) => setQ(e.target.value)} data-autofocus={autoFocus ? "" : undefined} />
      {q.trim() && (
        <RowList label="Companies">
          {found.map((c) => (
            <Row key={c.id} lead={<Square name={c.name} small />} title={c.name} meta={c.description || c.location || undefined} trailing="Pick" onOpen={() => pick({ id: c.id, name: c.name, path: c.path })} />
          ))}
          {!exact && <Row lead={<Icon name="plus" size={16} />} title={`New company “${q.trim()}”`} meta={busy ? "Making it…" : "Made with its name; add the rest on its page"} onOpen={() => void (!busy && make())} />}
        </RowList>
      )}
      {failure && <Notice title="Not made" text={failure} />}
    </div>
  );
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * "Where does Ana work?": the company field in a dialog of its own, writing as soon as one is
 * picked (`PATCH /api/contacts/:id` with `companyId`). Remove empties `company:`. The person's
 * page opens it from Works at, and Orr noticed from "has no company".
 */
export function WorksAtDialog({ person, companies, onClose, onSaved }: { person: Pick<Contact, "id" | "name" | "company" | "companyId">; companies: Company[]; onClose: () => void; onSaved: () => void }) {
  const current = person.companyId ? companies.find((c) => c.id === person.companyId) : undefined;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const write = async (company: PickedCompany | null) => {
    setBusy(true);
    setFailure(null);
    try {
      await api("PATCH", `/api/contacts/${person.id}`, { companyId: company?.id ?? null });
      toast(company ? `${firstName(person.name)} works at ${company.name}.` : `${person.name} has no company now.`);
      onSaved();
      onClose();
    } catch (e) {
      setFailure(refusalText(e));
      setBusy(false);
    }
  };
  // A company named in words with no note yet: the search starts with its name, so New company is one click.
  const start = current ? "" : person.company.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1").split("/").pop()!.trim();
  return (
    <Dialog
      title={`Where does ${firstName(person.name)} work?`}
      onClose={onClose}
      className="pp-new pp-pick"
      actions={
        <>
          {current && (
            <Button kind="quiet" danger disabled={busy} onClick={() => void write(null)}>
              Remove
            </Button>
          )}
          <Button kind="quiet" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <CompanyField value={null} onChange={(c) => c && void write(c)} start={start} autoFocus />
      {current && <p className="q3 pp-now">Now: {current.name}</p>}
      {failure && <Notice title="Not changed" text={failure} />}
    </Dialog>
  );
}

/** Every project you can read, once asked. */
function useProjects(): ProjectRow[] | null {
  const [list, setList] = useState<ProjectRow[] | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    api<ProjectRow[]>("GET", "/api/projects", undefined, { signal: ac.signal })
      .then(setList)
      .catch((e) => !isAbort(e) && setList([]));
    return () => ac.abort();
  }, []);
  return list;
}

/**
 * A project picked from the list, for "involved in" or "supervises": every project with a note,
 * less the ones `taken`. `pick` writes; what it throws is said here and the dialog stays.
 */
export function ProjectPicker({ title, taken, pick, onClose }: { title: string; taken: Set<string>; pick: (p: ProjectRow) => Promise<unknown>; onClose: () => void }) {
  const projects = useProjects();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const list = (projects ?? []).filter((p) => p.noteId && !taken.has(p.noteId) && matches(q, [p.name])).sort((a, b) => a.name.localeCompare(b.name));
  const run = async (p: ProjectRow) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await pick(p);
      onClose();
    } catch (e) {
      setFailure(refusalText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      className="pp-new pp-pick"
      actions={
        <Button kind="quiet" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <SearchField label="Project" placeholder="Search your projects…" value={q} onChange={(e) => setQ(e.target.value)} data-autofocus="" />
      {projects && list.length > 0 && (
        <RowList label="Projects">
          {list.slice(0, 8).map((p) => (
            <Row key={p.slug} lead={<Icon name="projects" size={16} />} title={p.name} trailing="Pick" onOpen={() => void run(p)} />
          ))}
        </RowList>
      )}
      {projects && list.length === 0 && <p className="q3 pp-none">{q.trim() ? "No project by that name that isn't here already." : "No other projects yet. Make one from New → Project."}</p>}
      {failure && <Notice title="Not changed" text={failure} />}
    </Dialog>
  );
}
