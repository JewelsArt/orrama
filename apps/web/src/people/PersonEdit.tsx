/**
 * A person's facts, edited in place (stage 1, 1F), the company card's twin (CompanyEdit): role,
 * email, phone, LinkedIn and sector, picked from the ones in use or typed new. Front matter only,
 * written by the server (`PATCH /api/contacts/:id`, a 409 with its sentence when the note's
 * properties can't be read). Where they work and their projects are picked on the page itself;
 * their name is the page's ⋯ → Rename, so its links follow.
 */
import { useState } from "react";
import type { Contact } from "@orrama/schema/responses";
import { api } from "../api.js";
import { Button } from "../ui/controls.js";
import { Field, Form, Input } from "../ui/fields.js";
import { Notice } from "../ui/states.js";
import { SECTOR_SUGGESTIONS } from "./NewDialogs.js";
import { refusalText } from "./pickers.js";
import { sameSector } from "./model.js";

export function PersonEdit({ person, sectors, onDone, onSaved }: { person: Contact; sectors: string[]; onDone: () => void; onSaved: () => Promise<void> | void }) {
  const [f, setF] = useState({ role: person.role, email: person.email, phone: person.phone, linkedin: person.linkedin, sector: person.sector });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  // The sectors offered: those in use first, then the usual ones, each once.
  const offered = [...sectors, ...SECTOR_SUGGESTIONS].filter((s, i, all) => all.findIndex((x) => sameSector(x, s)) === i);
  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api("PATCH", `/api/contacts/${person.id}`, {
        role: f.role.trim(),
        email: f.email.trim(),
        phone: f.phone.trim(),
        linkedin: f.linkedin.trim(),
        sector: f.sector.trim() || "Other",
      });
      await onSaved();
      onDone();
    } catch (e) {
      setFailure(refusalText(e));
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
      <Field label="Role">
        <Input data-autofocus value={f.role} onChange={set("role")} placeholder="Thesis supervisor" />
      </Field>
      <div className="pp-pair">
        <Field label="Email">
          <Input type="email" value={f.email} onChange={set("email")} />
        </Field>
        <Field label="Phone">
          <Input type="tel" value={f.phone} onChange={set("phone")} />
        </Field>
      </div>
      <Field label="LinkedIn">
        <Input value={f.linkedin} onChange={set("linkedin")} placeholder="linkedin.com/in/…" />
      </Field>
      <Field label="Sector" help="Pick one, or type a new one.">
        <Input value={f.sector} onChange={set("sector")} list="pp-person-sectors" />
      </Field>
      <datalist id="pp-person-sectors">
        {offered.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {failure && <Notice title="Not changed" text={failure} />}
    </Form>
  );
}
