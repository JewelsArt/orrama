/**
 * One payslip's figures, in a sheet: typed for a payslip that was stored but not read (its
 * layout was unfamiliar, or there is no PDF at all), or changed and removed like any other row.
 * Withheld is gross less net, worked out by the server as it is for a payslip it reads.
 */
import { parseMoney } from "@orrama/core/money";
import { useState } from "react";
import { Confirm, type ConfirmRequest } from "../Confirm.js";
import { Button } from "../ui/controls.js";
import { Field, Form, Input } from "../ui/fields.js";
import { Sheet } from "../ui/overlays.js";
import { Notice } from "../ui/states.js";
import { useWrite } from "../ui/writes.js";
import { monthName } from "./format.js";
import { addRow, changedCells, changeRow, removeRow, type RowAt } from "./writes.js";

/** A figure as the ledger keeps it: two decimals, or nothing. Null when it is not one number. */
const figure = (typed: string): string | null => {
  if (typed.trim() === "") return "";
  const n = parseMoney(typed);
  return n === null || n < 0 ? null : n.toFixed(2);
};

export function PayslipSheet({
  at,
  start,
  onRead,
  onClose,
  onSaved,
}: {
  /** The row to change; absent to type a new one. */
  at?: RowAt | null;
  /** For a new one: the month and the stored file, when known. */
  start?: { month?: string | null; file?: string | null };
  onRead: (file: string) => void;
  onClose: () => void;
  onSaved: (said: string) => void;
}) {
  const before = at ? { month: at.row.cells["month"] ?? "", gross: at.row.cells["gross"] ?? "", net: at.row.cells["net"] ?? "" } : { month: start?.month ?? "", gross: "", net: "" };
  const [f, setF] = useState(before);
  const [asking, setAsking] = useState<ConfirmRequest | null>(null);
  const write = useWrite();
  const file = at ? (at.row.cells["file"] ?? "") : (start?.file ?? "");
  const gross = figure(f.gross);
  const net = figure(f.net);
  const wrong = gross === null ? "The gross is not one amount." : net === null ? "The net is not one amount." : null;
  const ready = /^\d{4}-(0[1-9]|1[0-2])$/.test(f.month) && !wrong && (gross !== "" || net !== "") && !write.busy;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!ready) return;
    const done = await write.run(at ? "Not saved." : "Not filed.", async () => {
      if (!at) return addRow("payslips", { month: f.month, gross: gross === "" ? null : Number(gross), net: net === "" ? null : Number(net), file });
      // A figure left as written is not sent, so a hand-typed "2.600,00" stays as it is.
      const typed = { month: f.month, gross: f.gross === before.gross ? before.gross : gross!, net: f.net === before.net ? before.net : net! };
      const cells = changedCells(before, typed);
      if (Object.keys(cells).length > 0) await changeRow("payslips", at, cells);
    });
    if (done) onSaved(at ? `${monthName(f.month)} is saved.` : `The payslip for ${monthName(f.month)} is filed.`);
  };
  const remove = () =>
    setAsking({
      title: `Remove ${monthName(at!.row.name)}?`,
      body: file ? `Its figures leave your income. The document ${file} stays in Documents.` : "Its figures leave your income.",
      confirmLabel: "Remove",
      danger: true,
      failed: "The payslip wasn't removed.",
      onConfirm: async () => {
        await removeRow("payslips", at!);
        onSaved(`${monthName(at!.row.name)} is removed.`);
      },
    });

  return (
    <Sheet title={at && /^\d{4}-\d{2}$/.test(at.row.name) ? `Payslip, ${monthName(at.row.name)}` : "A payslip's figures"} onClose={onClose} className="msheet">
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
              {write.busy ? "Saving…" : at ? "Save" : "File it"}
            </Button>
          </>
        }
      >
        {!at && <p className="q3">Type what the payslip says. Withheld is worked out from the two.</p>}
        <Field label="Month it pays for">
          <Input type="month" data-autofocus={!at && !start?.month ? true : undefined} value={f.month} onChange={set("month")} />
        </Field>
        <div className="mform-row two">
          <Field label="Gross" help="Before tax.">
            <Input data-autofocus={!at && start?.month ? true : undefined} value={f.gross} onChange={set("gross")} inputMode="decimal" placeholder="2600.00" maxLength={20} />
          </Field>
          <Field label="Net" help="What you received.">
            <Input value={f.net} onChange={set("net")} inputMode="decimal" placeholder="2000.00" maxLength={20} />
          </Field>
        </div>
        {wrong && <p className="q3">{wrong}</p>}
        {file && (
          <p className="q3">
            From {file}.{" "}
            <Button size="sm" kind="quiet" icon="doc" onClick={() => onRead(file)}>
              Open it
            </Button>
          </p>
        )}
        {write.error && <Notice title={write.error} />}
      </Form>
      <Confirm request={asking} onClose={() => setAsking(null)} />
    </Sheet>
  );
}
