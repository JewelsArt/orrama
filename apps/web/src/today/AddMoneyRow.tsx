/**
 * Add one row to a money ledger from Today's New menu: a subscription, or income. It is Money's
 * own sheet (`money/LineSheet.tsx`), so there is one form for a ledger line, wherever it opens.
 * `noteMissing` is kept for the menu's call and no longer changes anything: the first add makes
 * the note.
 */
import { LineSheet } from "../money/LineSheet.js";

export function AddMoneyRow({
  kind,
  onClose,
  onSaved,
}: {
  kind: "income" | "subscriptions";
  /** Unused: the first add makes the ledger's note. */
  noteMissing?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  return <LineSheet kind={kind} onClose={onClose} onSaved={onSaved} />;
}
