import { Button } from "./ui/controls.js";
import { Dialog } from "./ui/overlays.js";

export interface ConfirmRequest {
  title: string;
  body?: string;
  /** Label for the destructive/primary action. */
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
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
  return (
    <Dialog
      title={request.title}
      role="alertdialog"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button
            kind={request.danger ? "default" : "solid"}
            danger={request.danger}
            data-autofocus
            onClick={() => {
              request.onConfirm();
              onClose();
            }}
          >
            {request.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      {request.body && <p>{request.body}</p>}
    </Dialog>
  );
}
