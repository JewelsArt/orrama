import { useEffect, useRef } from "react";
import { Dialog } from "./dialog.js";

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
 * Enter confirms, Escape cancels, and focus lands on the confirm button so the
 * keyboard path is one key either way.
 */
export function Confirm({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      // No Enter branch, deliberately. This listener is on WINDOW, so it cannot
      // see which button has focus — it confirmed whatever the dialog asked
      // regardless, and its preventDefault() suppressed the focused button's own
      // activation. Tab to "Keep it", press Enter, and the project was deleted.
      // The confirm button is focused on open (okRef below), so Enter still
      // confirms by default; now it is the browser activating the focused
      // button, which is also what makes Tab-then-Enter mean what it says.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, onClose]);

  if (!request) return null;

  return (
    <div className="ct-backdrop" onClick={onClose}>
      <Dialog label={request.title} role="alertdialog" className="confirm">
        <h2>{request.title}</h2>
        {request.body && <p>{request.body}</p>}
        <div className="confirm-actions">
          <button className="ct-btn" onClick={onClose}>
            Keep it
          </button>
          <button
            ref={okRef}
            className={`ct-btn ${request.danger ? "danger" : "pri"}`}
            onClick={() => {
              request.onConfirm();
              onClose();
            }}
          >
            {request.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
