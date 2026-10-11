/**
 * Capture (`c`, structure.md §2.13): one line into your inbox, as before — `POST /api/capture`
 * appends it to `Personal/<you>/Inbox.md` as a task, with a date or a project if you type them
 * (`due:2026-10-16`). Now a small sheet on the system's Dialog: centred on the desktop, a bottom
 * sheet on the phone, where Today's New (+) opens it.
 *
 * Saving closes it and says so, with a way to the inbox; a line the server refused stays in the
 * field with the reason under it, so nothing typed is lost.
 */
import { useState } from "react";
import { api } from "./api.js";
import { Button } from "./ui/controls.js";
import { Field, Form, Input } from "./ui/fields.js";
import { Dialog, toast } from "./ui/overlays.js";
import { navigate } from "./ui/router.js";

export function QuickCapture({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const line = text.trim();
    if (!line) return onClose();
    setBusy(true);
    setError(null);
    try {
      const inbox = await api<{ id: string; path: string }>("POST", "/api/capture", { text: line });
      onClose();
      toast("In your inbox.", { action: { label: "Open", run: () => navigate({ kind: "notes", path: inbox.path.replace(/\.md$/i, "") }) } });
    } catch (e) {
      setError(e instanceof Error && e.message ? `Not saved: ${e.message}` : "Not saved. Try again.");
      setBusy(false);
    }
  };

  return (
    <Dialog title="Capture" onClose={onClose} className="capture">
      <Form
        onSubmit={() => void save()}
        actions={
          <>
            <Button kind="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="solid" disabled={busy}>
              Capture
            </Button>
          </>
        }
      >
        <Field label="A task for your inbox" help="Add a date with due:2026-10-16." error={error}>
          <Input
            data-autofocus
            value={text}
            placeholder="Ask Thijs about the data agreement"
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
        </Field>
      </Form>
    </Dialog>
  );
}
