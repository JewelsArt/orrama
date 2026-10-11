/**
 * Add one row to a money ledger: a subscription, or income (Today's New menu).
 *
 * It posts to the server rather than editing Markdown in the browser: the note is a shared file
 * that Obsidian may have changed since this tab loaded it, so the append has to happen against
 * whatever is on disk at that moment. The server re-reads, appends and writes through the store,
 * the same path every other mutation takes, ACL and note id included.
 */
import { useState } from "react";
import { isoLocal } from "@basalt/core/dates";
import { api } from "../api.js";
import { Button } from "../ui/controls.js";
import { Field, Form, Input, Select } from "../ui/fields.js";
import { Dialog } from "../ui/overlays.js";
import { Notice } from "../ui/states.js";

const CADENCES = ["weekly", "monthly", "quarterly", "yearly"] as const;

export function AddMoneyRow({
  kind,
  noteMissing,
  onClose,
  onSaved,
}: {
  kind: "income" | "subscriptions";
  /** No note carries the ledger's tag yet: say how to make one instead of offering a form. */
  noteMissing: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isIncome = kind === "income";
  const [service, setService] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<(typeof CADENCES)[number]>("monthly");
  const [next, setNext] = useState(isoLocal());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const canSave = service.trim().length > 0 && amount.trim().length > 0 && !saving;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setFailed(false);
    try {
      await api("POST", `/api/finance/${kind}`, { service, amount, cadence, next, note });
      onSaved();
    } catch {
      setFailed(true);
      setSaving(false);
    }
  };
  const title = isIncome ? "Add income" : "Add a subscription";

  return (
    <Dialog title={title} onClose={onClose} className="td-add">
      {noteMissing ? (
        <>
          <Notice
            title={`No note is tagged #${kind} yet.`}
            text={`Make one with a table of ${isIncome ? "Source" : "Service"}, Amount, Every and Next columns, and this adds rows to it.`}
          />
          <div className="acts">
            <Button kind="quiet" onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      ) : (
        <Form
          onSubmit={() => void save()}
          actions={
            <>
              <Button kind="quiet" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" kind="solid" disabled={!canSave}>
                {saving ? "Adding…" : "Add"}
              </Button>
            </>
          }
        >
          <p className="q3">Goes straight into the table in your {isIncome ? "income" : "subscriptions"} note, and stays editable in Obsidian.</p>
          <Field label={isIncome ? "Source" : "Name"}>
            <Input data-autofocus value={service} onChange={(e) => setService(e.target.value)} placeholder={isIncome ? "Scooperz" : "Spotify"} maxLength={80} />
          </Field>
          <div className="td-add-row">
            {/* Free text, so "€10.99", "10,99" and "30 USD" all work: the parser reads all three. */}
            <Field label="Amount" help="A bare number is euros.">
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10.99" inputMode="decimal" maxLength={24} />
            </Field>
            <Field label="Every">
              <Select value={cadence} onChange={(e) => setCadence(e.target.value as (typeof CADENCES)[number])}>
                {CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={isIncome ? "Next payment" : "Next charge"}>
              <Input type="date" value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
          </div>
          <Field label="Note">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" maxLength={140} />
          </Field>
          {failed && <Notice title="That row wasn't added." text="Nothing changed in the note. Check the amount, then try again." />}
        </Form>
      )}
    </Dialog>
  );
}
