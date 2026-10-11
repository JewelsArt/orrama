/**
 * A name for something new: one field, then Create (§8 #12: the native prompt and alert become
 * the Dialog). `onSubmit` checks the name and makes the thing; what it throws is said under the
 * field and the dialog stays open, so the name can be fixed instead of typed again.
 */
import { useState } from "react";
import { Button } from "./controls.js";
import { Field, Form, Input } from "./fields.js";
import { Dialog } from "./overlays.js";

export function NameDialog({
  title,
  label,
  help,
  placeholder,
  confirm = "Create",
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  help?: string;
  placeholder?: string;
  confirm?: string;
  /** Make the thing. Throw to keep the dialog open with the message under the field. */
  onSubmit: (name: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Create is disabled while the name is empty or being made, and that also stops Enter: a form
  // submits on Enter only through an enabled default button.
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "That didn't work. Try again.");
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <Form
        onSubmit={() => void submit()}
        actions={
          <>
            <Button kind="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="solid" disabled={busy || !name.trim()}>
              {confirm}
            </Button>
          </>
        }
      >
        <Field label={label} help={help} error={error}>
          <Input
            data-autofocus
            value={name}
            placeholder={placeholder}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </Field>
      </Form>
    </Dialog>
  );
}
