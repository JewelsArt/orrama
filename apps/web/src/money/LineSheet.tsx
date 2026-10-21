/**
 * One commitment or one income line, in a sheet: add it, or change its name, amount, rhythm, next
 * date and note, or remove it. The same sheet opens from the Subscriptions and Income pages, from
 * a found charge ("Looks recurring → Add", prefilled), and from Today's New menu
 * (`today/AddMoneyRow.tsx`). What it writes is a row of the ledger's table, through the server;
 * the first one on an empty vault makes the note.
 */
import { isoLocal } from "@orrama/core/dates";
import { readCadence, type Cadence } from "@orrama/core/subscriptions";
import { useState } from "react";
import { Confirm, type ConfirmRequest } from "../Confirm.js";
import { Button, NameLink } from "../ui/controls.js";
import { Field, Form, Input, Select } from "../ui/fields.js";
import { Sheet } from "../ui/overlays.js";
import { navigate } from "../ui/router.js";
import { Notice } from "../ui/states.js";
import { useWrite } from "../ui/writes.js";
import { link, to } from "./links.js";
import { addRow, CADENCE_WORDS, CADENCES, changedCells, changeRow, removeRow, type RowAt } from "./writes.js";

export type LineKind = "subscriptions" | "income";

/** What the form holds: the cells of a row, as text. */
export interface LineValues {
  service: string;
  amount: string;
  cadence: Cadence | "";
  next: string;
  note: string;
}

const TITLE = { subscriptions: "Add a subscription", income: "Add income" } as const;

/** The form's starting values: the row as written, its rhythm read the way the figures read it. */
export function lineValues(at: RowAt | null, prefill?: Partial<LineValues>): LineValues {
  if (!at) return { service: "", amount: "", cadence: "monthly", next: isoLocal(), note: "", ...prefill };
  const c = at.row.cells;
  return { service: c["service"] ?? "", amount: c["amount"] ?? "", cadence: readCadence(c["cadence"] ?? "") ?? "", next: c["next"] ?? "", note: c["note"] ?? "" };
}

export function LineSheet({
  kind,
  at,
  prefill,
  shop,
  onClose,
  onSaved,
}: {
  kind: LineKind;
  /** The row to change; absent to add one. */
  at?: RowAt | null;
  /** What a new line starts from (a charge that looks recurring). */
  prefill?: Partial<LineValues>;
  /** The shop the bank calls this line, when the statement has seen it. */
  shop?: string | null;
  onClose: () => void;
  /** After a change landed: the sentence to say. */
  onSaved: (said: string) => void;
}) {
  const income = kind === "income";
  const start = lineValues(at ?? null, prefill);
  const [f, setF] = useState<LineValues>(start);
  const [asking, setAsking] = useState<ConfirmRequest | null>(null);
  const write = useWrite();
  // A table without a column for something does not get a field for it: there is nowhere to write it.
  const has = (field: string) => !at || at.table.fields.includes(field);
  const set = (k: keyof LineValues) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const ready = f.service.trim() !== "" && f.amount.trim() !== "" && f.cadence !== "" && !write.busy;
  const name = f.service.trim() || at?.row.name || "";

  const save = async () => {
    if (!ready) return;
    const done = await write.run(at ? "Not saved." : "Not added.", async () => {
      if (!at) return addRow(kind, { service: f.service.trim(), amount: f.amount.trim(), cadence: f.cadence, next: f.next, note: f.note.trim() });
      const before = { ...start } as unknown as Record<string, string>;
      const after = { service: f.service.trim(), amount: f.amount.trim(), cadence: f.cadence, next: f.next, note: f.note.trim() };
      const set = changedCells(before, Object.fromEntries(Object.entries(after).filter(([k]) => has(k))));
      if (Object.keys(set).length > 0) await changeRow(kind, at, set);
    });
    if (done) onSaved(at ? `${name} is saved.` : income ? `${name} is in your income.` : `${name} is in your commitments.`);
  };
  const remove = () =>
    setAsking({
      title: `Remove ${at!.row.name}?`,
      body: income ? "It leaves your income and the calendar. Money already received is still on your statements." : "It leaves your commitments and the calendar. Past charges stay on your statements.",
      confirmLabel: "Remove",
      danger: true,
      failed: `${at!.row.name} wasn't removed.`,
      onConfirm: async () => {
        await removeRow(kind, at!);
        onSaved(`${at!.row.name} is removed.`);
      },
    });

  return (
    <Sheet title={at ? at.row.name.replace(/^\*+|\*+$/g, "") : TITLE[kind]} onClose={onClose} className="msheet">
      <Form
        onSubmit={() => void save()}
        actions={
          <>
            {at && (
              <Button kind="quiet" danger icon="trash" onClick={remove} className="mleft">
                Remove
              </Button>
            )}
            <Button kind="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="solid" disabled={!ready}>
              {write.busy ? (at ? "Saving…" : "Adding…") : at ? "Save" : "Add"}
            </Button>
          </>
        }
      >
        <Field label={income ? "Source" : "Name"}>
          <Input data-autofocus value={f.service} onChange={set("service")} placeholder={income ? "Your employer" : "Spotify"} maxLength={80} />
        </Field>
        <div className="mform-row">
          {/* Free text, so "€10.99", "10,99" and "30 USD" all work: the ledger reads all three. */}
          <Field label="Amount" help="A bare number is euros.">
            <Input value={f.amount} onChange={set("amount")} placeholder="10.99" inputMode="decimal" maxLength={24} />
          </Field>
          {has("cadence") && (
            <Field label="Every">
              <Select value={f.cadence} onChange={set("cadence")}>
                {f.cadence === "" && <option value="">Pick one</option>}
                {CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {CADENCE_WORDS[c].replace(/^every /, "")}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {has("next") && (
            <Field label={income ? "Next payment" : "Next charge"}>
              <Input type="date" value={f.next} onChange={set("next")} />
            </Field>
          )}
        </div>
        {has("note") && (
          <Field label="Note">
            <Input value={f.note} onChange={set("note")} placeholder="optional" maxLength={140} />
          </Field>
        )}
        {shop && (
          <p className="q3">
            On your statement as{" "}
            <NameLink
              href={link(to.merchant(shop)).href}
              onOpen={() => {
                onClose();
                navigate(to.merchant(shop));
              }}
            >
              {shop}
            </NameLink>
            .
          </p>
        )}
        {write.error && <Notice title={write.error} />}
      </Form>
      <Confirm request={asking} onClose={() => setAsking(null)} />
    </Sheet>
  );
}
