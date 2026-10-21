/**
 * Your own accounts (`#own-accounts`): money you hold somewhere else, a broker or a savings pot.
 * A statement row that matches one is a move, whatever the bank calls it: going out it is saved,
 * not spent; coming back it is your money returning, and only what is above what you put in is
 * income (core ownAccounts.ts). A short list on the Savings page, where moves count, and a sheet
 * to add, change or remove one.
 */
import { termsCell, termsOf } from "@orrama/core/spending";
import type { FinanceData } from "@orrama/schema/responses";
import { useState } from "react";
import { Confirm, type ConfirmRequest } from "../Confirm.js";
import { Button } from "../ui/controls.js";
import { Field, Form, Input } from "../ui/fields.js";
import { Sheet } from "../ui/overlays.js";
import { Notice } from "../ui/states.js";
import { useWrite } from "../ui/writes.js";
import { plural } from "./format.js";
import { addRow, changedCells, changeRow, removeRow, rowAt, type RowAt } from "./writes.js";

/** How a word reads: `=ns` matches only a description that is exactly "ns". */
export const wordLabel = (w: string) => (w.startsWith("=") ? `${w.slice(1)} (whole name)` : w);

export function OwnAccounts({ d, onEdit, onOpenNote }: { d: FinanceData; onEdit: (line?: number) => void; onOpenNote: (id: string) => void }) {
  const t = d.tables["own-accounts"];
  const rows = t?.rows ?? [];
  return (
    <section className="mod" aria-label="Your own accounts">
      <div className="mh">
        <h2>Your own accounts</h2>
        <span className="c">{plural(rows.length, "account")}</span>
        <span className="msp" />
        <Button size="sm" icon="plus" onClick={() => onEdit()}>
          Add an account
        </Button>
      </div>
      <p className="q3">A broker, a savings pot: money moved there is saved, not spent. Coming back it is yours again, and only what is above what you put in counts as income.</p>
      {rows.map((r) => (
        <button key={r.index} type="button" className="row mline" onClick={() => onEdit(r.line)}>
          <span className="x">
            <span className="t">{r.name}</span>
            <span className="m">{termsOf(r.cells["matches"] ?? "").map(wordLabel).join(", ") || "no words yet: nothing matches it"}</span>
          </span>
        </button>
      ))}
      {t && (
        <a
          className="mquiet"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onOpenNote(t.noteId);
          }}
        >
          Open the note
        </a>
      )}
    </section>
  );
}

export function OwnAccountSheet({ d, line, onClose, onSaved }: { d: FinanceData; line?: number; onClose: () => void; onSaved: (said: string) => void }) {
  const at: RowAt | null = rowAt(d.tables["own-accounts"], line);
  const before = { account: at?.row.cells["account"] ?? "", matches: at?.row.cells["matches"] ?? "" };
  const [f, setF] = useState(before);
  const [asking, setAsking] = useState<ConfirmRequest | null>(null);
  const write = useWrite();
  const words = termsCell(termsOf(f.matches));
  const ready = f.account.trim() !== "" && words !== "" && !write.busy;
  const save = async () => {
    if (!ready) return;
    const done = await write.run(at ? "Not saved." : "Not added.", async () => {
      if (!at) return addRow("own-accounts", { account: f.account.trim(), matches: words });
      const cells = changedCells(before, { account: f.account.trim(), matches: f.matches === before.matches ? before.matches : words });
      if (Object.keys(cells).length > 0) await changeRow("own-accounts", at, cells);
    });
    if (done) onSaved(at ? `${f.account.trim()} is saved.` : `${f.account.trim()} is one of your accounts now.`);
  };
  const remove = () =>
    setAsking({
      title: `Remove ${at!.row.name}?`,
      body: "Money moved there counts as spending again.",
      confirmLabel: "Remove",
      danger: true,
      failed: `${at!.row.name} wasn't removed.`,
      onConfirm: async () => {
        await removeRow("own-accounts", at!);
        onSaved(`${at!.row.name} is removed.`);
      },
    });
  return (
    <Sheet title={at ? at.row.name : "Add an account"} onClose={onClose} className="msheet">
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
              {write.busy ? "Saving…" : at ? "Save" : "Add"}
            </Button>
          </>
        }
      >
        <Field label="Name">
          <Input data-autofocus value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} placeholder="Broker" maxLength={60} />
        </Field>
        <Field label="On your statement as" help="Part of what the bank writes, separated by commas. Start with = to match that whole name only.">
          <Input value={f.matches} onChange={(e) => setF({ ...f, matches: e.target.value })} placeholder="capital.com" maxLength={400} />
        </Field>
        {write.error && <Notice title={write.error} />}
      </Form>
      <Confirm request={asking} onClose={() => setAsking(null)} />
    </Sheet>
  );
}
