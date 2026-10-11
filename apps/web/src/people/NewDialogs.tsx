/**
 * New person and New company: each a note, made create-only (S04, WEB-001) — a name that is
 * already there is refused and said, never replaced. A failure is a Notice under the fields:
 * what failed in plain words, and the fix; the dialog stays open with what was typed.
 */
import { useState } from "react";
import { ApiError, type Me } from "../api.js";
import { companyNote, contactNote, createNote } from "../newNote.js";
import { Button } from "../ui/controls.js";
import { Field, Form, Input, Switch, Textarea } from "../ui/fields.js";
import { Dialog } from "../ui/overlays.js";
import { Notice } from "../ui/states.js";

/** The sectors offered when typing one; any other word is fine too. */
export const SECTOR_SUGGESTIONS = ["Finance", "Marketing", "Leadership", "Operations", "University", "Engineering", "Design", "Other"];

/** A failure said for a person: a name already taken, or the server not answering. */
export function failureOf(err: unknown, what: "person" | "company"): { title: string; text: string } {
  if (err instanceof ApiError && err.status === 409)
    return { title: `There's already a note with this name`, text: `${err.message} Open it from People, or give this ${what} a fuller name.` };
  if (err instanceof ApiError && (err.status === 400 || err.status === 403))
    return { title: "Not saved", text: "This name can't be a note's file name here. Leave out slashes and try again." };
  return { title: "Not saved", text: "The server didn't answer. Check that Orrama is running, then try again." };
}

function Sectors({ id }: { id: string }) {
  return (
    <datalist id={id}>
      {SECTOR_SUGGESTIONS.map((s) => (
        <option key={s} value={s} />
      ))}
    </datalist>
  );
}

function useSave() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ title: string; text: string } | null>(null);
  const run = async (what: "person" | "company", job: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await job();
    } catch (e) {
      setFailure(failureOf(e, what));
      setBusy(false);
    }
  };
  return { busy, failure, run };
}

export function NewPerson({ me, onClose, onSaved }: { me: Me; onClose: () => void; onSaved: (noteId: string) => void }) {
  const [f, setF] = useState({ name: "", sector: "", role: "", company: "", email: "", phone: "", linkedin: "" });
  const [priv, setPriv] = useState(false);
  const { busy, failure, run } = useSave();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const name = f.name.trim();
  const save = () =>
    run("person", async () => {
      const t = (s: string) => s.trim();
      const content = contactNote({ name, sector: t(f.sector), role: t(f.role), company: t(f.company), email: t(f.email), phone: t(f.phone), linkedin: t(f.linkedin) });
      const path = priv ? `Personal/${me.username}/Contacts/${name}.md` : `Contacts/${name}.md`;
      const res = await createNote(path, content);
      onSaved(res.id);
    });
  return (
    <Dialog title="New person" onClose={onClose} className="pp-new">
      <Form
        onSubmit={() => void save()}
        actions={
          <>
            <Button kind="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="solid" disabled={busy || !name}>
              {busy ? "Saving…" : "Add person"}
            </Button>
          </>
        }
      >
        <Field label="Name">
          <Input data-autofocus value={f.name} onChange={set("name")} placeholder="Full name" />
        </Field>
        <div className="pp-pair">
          <Field label="Role">
            <Input value={f.role} onChange={set("role")} placeholder="Thesis supervisor" />
          </Field>
          <Field label="Company">
            <Input value={f.company} onChange={set("company")} placeholder="Where they work" />
          </Field>
        </div>
        <div className="pp-pair">
          <Field label="Email">
            <Input type="email" value={f.email} onChange={set("email")} />
          </Field>
          <Field label="Phone">
            <Input value={f.phone} onChange={set("phone")} />
          </Field>
        </div>
        <div className="pp-pair">
          <Field label="Sector">
            <Input value={f.sector} onChange={set("sector")} list="pp-sectors" placeholder="Finance, Marketing…" />
          </Field>
          <Field label="LinkedIn">
            <Input value={f.linkedin} onChange={set("linkedin")} placeholder="linkedin.com/in/…" />
          </Field>
        </div>
        <Sectors id="pp-sectors" />
        <Field label="Private" help={priv ? `Saved in Personal/${me.username}/Contacts, for you only.` : "Saved in Contacts."}>
          <Switch checked={priv} onChange={setPriv} label="Private" />
        </Field>
        {failure && <Notice title={failure.title} text={failure.text} />}
      </Form>
    </Dialog>
  );
}

export function NewCompany({ me, name: initial = "", onClose, onSaved }: { me: Me; name?: string; onClose: () => void; onSaved: (noteId: string) => void }) {
  const [f, setF] = useState({ name: initial, description: "", sector: "", location: "", linkedin: "", website: "", careers: "", positions: "" });
  const [priv, setPriv] = useState(false);
  const { busy, failure, run } = useSave();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const name = f.name.trim();
  const save = () =>
    run("company", async () => {
      const t = (s: string) => s.trim();
      const content = companyNote({
        name,
        sector: t(f.sector),
        description: t(f.description),
        linkedin: t(f.linkedin),
        website: t(f.website),
        careers: t(f.careers),
        location: t(f.location),
        positions: f.positions.split(",").map((p) => p.trim()).filter(Boolean),
      });
      const path = priv ? `Personal/${me.username}/Companies/${name}.md` : `Contacts/Companies/${name}.md`;
      const res = await createNote(path, content);
      onSaved(res.id);
    });
  return (
    <Dialog title="New company" onClose={onClose} className="pp-new">
      <Form
        onSubmit={() => void save()}
        actions={
          <>
            <Button kind="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="solid" disabled={busy || !name}>
              {busy ? "Saving…" : "Add company"}
            </Button>
          </>
        }
      >
        <Field label="Name">
          <Input data-autofocus value={f.name} onChange={set("name")} placeholder="Company name" />
        </Field>
        <Field label="What they do">
          <Textarea rows={2} value={f.description} onChange={set("description")} placeholder="One line" />
        </Field>
        <div className="pp-pair">
          <Field label="Sector">
            <Input value={f.sector} onChange={set("sector")} list="pp-co-sectors" placeholder="Finance, Marketing…" />
          </Field>
          <Field label="Location">
            <Input value={f.location} onChange={set("location")} />
          </Field>
        </div>
        <Sectors id="pp-co-sectors" />
        <div className="pp-pair">
          <Field label="LinkedIn">
            <Input value={f.linkedin} onChange={set("linkedin")} placeholder="linkedin.com/company/…" />
          </Field>
          <Field label="Website">
            <Input value={f.website} onChange={set("website")} />
          </Field>
        </div>
        <Field label="Jobs page">
          <Input value={f.careers} onChange={set("careers")} placeholder="careers.…" />
        </Field>
        <Field label="Positions seen there" help="Separate them with commas.">
          <Input value={f.positions} onChange={set("positions")} placeholder="Data analyst, Marketing intern" />
        </Field>
        <Field label="Private" help={priv ? `Saved in Personal/${me.username}/Companies, for you only.` : "Saved in Contacts/Companies."}>
          <Switch checked={priv} onChange={setPriv} label="Private" />
        </Field>
        {failure && <Notice title={failure.title} text={failure.text} />}
      </Form>
    </Dialog>
  );
}
