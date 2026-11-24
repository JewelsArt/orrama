/**
 * "Make a project" on a note (N2; Jules, 10 Nov 2026: "Notes: make a project from a note"): a
 * small dialog prefilled from the note — its title as the name, its life area, a group from
 * the ones the projects already use, an optional due date — and where the note goes, left
 * where it is unless asked. Its open tasks are said, not switched: once the note carries the
 * project's tag they count for it, and nothing is copied (Jules, 24 Nov 2026).
 */
import { useState } from "react";
import { useAreas } from "../categories.js";
import { useTypedDate } from "../create/New.js";
import { groupNames, useProjectGroups } from "../projectGroup.js";
import { makeProjectFromNote, type MadeFromNote } from "../projectFromNote.js";
import { Button } from "../ui/controls.js";
import { Field, Form, Input, RadioGroup, Select } from "../ui/fields.js";
import { Dialog } from "../ui/overlays.js";
import { Notice } from "../ui/states.js";
import { useWrite } from "../ui/writes.js";
import { folderWords } from "./actions.js";

export interface MakeProjectNote {
  id: string;
  title: string;
  path: string;
  /** Open checkboxes in the note. */
  openTasks: number;
  /** The life area the note is in (the tree's `category`), the dialog's first choice. */
  category?: string;
}

const NEW_GROUP = "\u0000new";

/** "1 open task" / "4 open tasks". */
const tasksWord = (n: number) => (n === 1 ? "1 open task" : `${n} open tasks`);

export function MakeProjectDialog({
  note,
  leaving,
  onClose,
  onMade,
}: {
  note: MakeProjectNote;
  /** The project the note is in now: making another takes it out ("Make a new project anyway"). */
  leaving?: { name: string } | null;
  onClose: () => void;
  onMade: (made: MadeFromNote, name: string) => void;
}) {
  const areas = useAreas();
  const groups = groupNames(useProjectGroups(note.id));
  const [name, setName] = useState(note.title);
  const [area, setArea] = useState(note.category && areas.some((a) => a.id === note.category) ? note.category : "");
  const [group, setGroup] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const due = useTypedDate();
  const [where, setWhere] = useState<"stay" | "move">("stay");
  const write = useWrite();
  const folder = note.path.includes("/") ? note.path.slice(0, note.path.lastIndexOf("/")) : "";
  // The area list can arrive after the dialog opens: the note's area is chosen once it is there,
  // else the catch-all, so what the menu shows is always what is sent.
  const chosenArea = area || (note.category && areas.some((a) => a.id === note.category) ? note.category : (areas.find((a) => a.catchAll) ?? areas[0])?.id ?? "");
  const groupValue = group === NEW_GROUP ? newGroup.trim() : group;

  const submit = () => {
    const named = name.replace(/\s+/g, " ").trim();
    if (!named || due.value === null || write.busy) return;
    void write.run("The project wasn't made.", async () => {
      const made = await makeProjectFromNote({
        noteId: note.id,
        name: named,
        ...(chosenArea ? { area: chosenArea } : {}),
        ...(groupValue ? { group: groupValue } : {}),
        ...(due.value ? { deadline: due.value } : {}),
        ...(where === "move" ? { move: true } : {}),
        ...(leaving ? { anyway: true } : {}),
      });
      onMade(made, named);
    });
  };

  return (
    <Dialog title={leaving ? "Make a new project" : "Make a project"} onClose={onClose} className="new-dlg mkp-dlg">
      <Form
        onSubmit={submit}
        actions={
          <>
            <Button kind="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="solid" disabled={write.busy || !name.trim() || due.value === null}>
              Make the project
            </Button>
          </>
        }
      >
        {leaving && <Notice title={`It leaves ${leaving.name}.`} text="A note is in one project at a time. Undo puts it back." />}
        <Field label="Name">
          <Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <div className="mkp-row">
          <Field label="Life area">
            <Select value={chosenArea} onChange={(e) => setArea(e.target.value)}>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Group (optional)">
            <Select value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">No group</option>
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
              <option value={NEW_GROUP}>New group…</option>
            </Select>
          </Field>
        </div>
        {group === NEW_GROUP && (
          <Field label="New group" help="Projects in one area are split by group on the Projects page.">
            <Input autoFocus value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="Websites" maxLength={60} />
          </Field>
        )}
        <Field label="Due (optional)" help={due.help} error={due.error}>
          <Input value={due.text} onChange={(e) => due.setText(e.target.value)} placeholder="e.g. Fri 16 Oct" />
        </Field>
        <RadioGroup
          label="Where the note goes"
          value={where}
          onChange={setWhere}
          options={[
            { id: "stay", label: "Leave it where it is", help: folderWords(folder) },
            { id: "move", label: "Move it into the project's folder", help: "With the project's own notes and files." },
          ]}
        />
        <p className="q3 new-where">
          {note.openTasks > 0 ? `Its ${tasksWord(note.openTasks)} will count for the project.` : "It has no open tasks, so the project starts with a first step."}
        </p>
        {write.error && (
          <p className="new-err" role="alert">
            {write.error}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
