import { useState } from "react";
import { Button } from "./ui/controls.js";
import { Dialog } from "./ui/overlays.js";
import { Notice } from "./ui/states.js";
import { failureText } from "./ui/writes.js";

export interface ConfirmRequest {
  title: string;
  body?: string;
  /** Label for the destructive/primary action. */
  confirmLabel?: string;
  danger?: boolean;
  /** May be a write. Until it settles the dialog stays, its buttons wait; if it fails, the
   *  dialog says so and stays, so confirming again is the retry (WEB-010). */
  onConfirm: () => void | Promise<unknown>;
  /** What didn't happen, for that message ("The file wasn't deleted."). */
  failed?: string;
}

/**
 * An in-app confirmation, because `window.confirm` is not reliable everywhere we
 * run: the desktop shell's webview treats it as a no-op, so a native-dialog
 * guard silently swallows the action instead of asking. Anything destructive
 * asks through this component, which is plain DOM and behaves the same in the
 * browser and in the app.
 *
 * It is the system's Dialog (ui/overlays.tsx): a modal layer above any sheet or
 * panel, Escape cancels, focus comes back to whatever asked. Focus lands on the
 * confirm button, so Enter confirms; Tab to "Keep it" and Enter keeps it. There
 * is deliberately no window-level Enter handler: one once confirmed whatever the
 * dialog asked regardless of focus, and deleted a project from "Keep it".
 */
export function Confirm({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  if (!request) return null;
  return <Asking key={request.title} request={request} onClose={onClose} />;
}

function Asking({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const proceed = async () => {
    const done = request.onConfirm();
    // A plain action closes at once, as it always did.
    if (!(done instanceof Promise)) return onClose();
    setBusy(true);
    setFailure(null);
    try {
      await done;
      onClose();
    } catch (e) {
      setFailure(failureText(e, request.failed ?? "That didn't go through."));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={request.title}
      role="alertdialog"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button kind={request.danger ? "default" : "solid"} danger={request.danger} data-autofocus disabled={busy} onClick={() => void proceed()}>
            {request.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      {request.body && <p>{request.body}</p>}
      {failure && <Notice title={failure} />}
    </Dialog>
  );
}
