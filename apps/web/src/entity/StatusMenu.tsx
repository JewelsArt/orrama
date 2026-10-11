/**
 * Status as a menu (structure.md §2.5): the dot and the word, and a click lists the
 * vocabulary's seven words. It replaces the native `<select>` of hyphenated ids. Read-only, it
 * is the word alone. A status outside the vocabulary shows as the note has it, so nothing is
 * hidden, and picking a word replaces it.
 */
import { useRef, useState } from "react";
import { Menu } from "../ui/overlays.js";
import { STATUS_IDS, STATUS_WORD, statusOf, type StatusId } from "./status.js";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The dot-and-word for a raw `status:`; "no status" with a hollow dot when there is none. */
export function statusLook(raw: string | null | undefined): { cls: string; word: string } {
  const id = statusOf(raw);
  if (id) return { cls: id, word: STATUS_WORD[id] };
  const text = (raw ?? "").trim();
  return text ? { cls: "other", word: text } : { cls: "none", word: "no status" };
}

export function StatusMenu({
  value,
  canEdit,
  onPick,
  capital,
}: {
  value: string | null | undefined;
  canEdit: boolean;
  onPick: (id: StatusId) => void;
  /** "On track" at the head of a page; "on track" in a row. */
  capital?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const at = useRef<HTMLButtonElement>(null);
  const look = statusLook(value);
  const word = capital ? cap(look.word) : look.word;
  if (!canEdit) return <span className={`status ${look.cls}`}>{word}</span>;
  const current = statusOf(value);
  return (
    <>
      <button
        ref={at}
        type="button"
        className={`status ${look.cls} ent-status`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Status: ${look.word}. Change it`}
        onClick={() => setOpen((v) => !v)}
      >
        {word}
      </button>
      {open && (
        <Menu
          anchor={at}
          label="Status"
          onClose={() => setOpen(false)}
          items={STATUS_IDS.map((id) => ({
            label: cap(STATUS_WORD[id]),
            checked: id === current,
            icon: <span className={`status ${id} ent-status-dot`} aria-hidden="true" />,
            onSelect: () => id !== current && onPick(id),
          }))}
        />
      )}
    </>
  );
}
