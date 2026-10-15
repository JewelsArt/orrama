/**
 * A company's card, edited in place (R9): what they do, the sector, where, the links, the
 * positions seen. Front matter only, written by the server (`PATCH /api/companies/:id`). The
 * company's entity page opens it in a sheet (R11); People's sheets it lived in are gone.
 */
import { useState } from "react";
import type { Company } from "@orrama/schema/responses";
import { api, ApiError } from "../api.js";
import { Button } from "../ui/controls.js";
import { Field, Form, Input, Textarea } from "../ui/fields.js";
import { Notice } from "../ui/states.js";
import { SECTOR_SUGGESTIONS } from "./NewDialogs.js";

/** Said when a change is refused: never the server's own words unless they are the fix. */
const refusal = (e: unknown): { title: string; text: string } =>
  e instanceof ApiError && e.status === 409
    ? { title: "Not changed", text: e.message }
    : e instanceof ApiError && e.status === 403
      ? { title: "Not changed", text: "You can read this note but not edit it." }
      : { title: "Not changed", text: "The server didn't answer. Try again." };

export function CompanyEdit({ company, onDone, onSaved }: { company: Company; onDone: () => void; onSaved: () => Promise<void> | void }) {
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
