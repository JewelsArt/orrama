/**
 * The spending categories, in one sheet: add, rename, remove and reorder them, and the words that
 * file a shop under each. The rules are a property of the categories, not a screen of their own:
 * a shop goes to the category with the longest word its name contains, and `=word` matches only a
 * shop named exactly that. The order is the colours' order (money/palette.ts): the first five
 * categories with words get one each, the rest are grey.
 *
 * And the way to put one shop in a category (ShopMove), from the shop's page or its row: every row
 * of that shop moves, and the dialog says so before it does.
 */
import { termsCell, termsOf } from "@orrama/core/spending";
import type { FinanceData } from "@orrama/schema/responses";
import { useRef, useState } from "react";
import { Confirm, type ConfirmRequest } from "../Confirm.js";
import { Button } from "../ui/controls.js";
import { Field, Form, Input, Select } from "../ui/fields.js";
import { Icon } from "../ui/Icon.js";
import { NameDialog } from "../ui/NameDialog.js";
import { Dialog, Menu, Sheet } from "../ui/overlays.js";
import { Notice } from "../ui/states.js";
import { attempt, failureText, useWrite } from "../ui/writes.js";
import { wordLabel } from "./OwnAccounts.js";
import { colouredCategories, OTHER_COLOUR, paletteFor } from "./palette.js";
import { addRow, changeRow, fileShop, moveCategory, removeRow, type RowAt } from "./writes.js";

export function CategoriesSheet({
  d,
  focus,
  onClose,
  onChanged,
  onOpenNote,
}: {
  d: FinanceData;
  /** The category to bring into view. */
  focus?: string;
  onClose: () => void;
  /** Reload the figures after a change; resolves once they are in. */
  onChanged: () => Promise<void>;
  onOpenNote: (id: string) => void;
}) {
  const table = d.tables.categories;
  const rows = table?.rows ?? [];
  const rules = d.spending.categories.rules;
  const colourOf = paletteFor(rules);
  const coloured = colouredCategories(rules);
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState<Record<number, string>>({});
  const [menu, setMenu] = useState<RowAt | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState<RowAt | null>(null);
  const [naming, setNaming] = useState(false);
  const [asking, setAsking] = useState<ConfirmRequest | null>(null);
  const atOf = (i: number): RowAt => ({ table: table!, row: rows[i]! });
  // Categories the commitments file their charges under, which no row here names.
  const fromCommitments = [...new Set(rules.map((r) => r.category))].filter((c) => !rows.some((r) => r.name === c));

  /** One click, one write, then the figures again; a failure is said in a toast. */
  const run = async (what: string, job: () => Promise<unknown>) => {
    setBusy(true);
    try {
      if (await attempt(what, job)) await onChanged();
    } finally {
      setBusy(false);
    }
  };
  const addWord = (i: number) => {
    const word = (words[i] ?? "").trim().replace(/,/g, " ");
    const r = rows[i]!;
    const now = termsOf(r.cells["matches"] ?? "");
    if (!word) return;
    if (now.some((w) => w.toLowerCase() === word.toLowerCase())) return setWords({ ...words, [i]: "" });
    void run(`“${word}” wasn't added.`, async () => {
      await changeRow("categories", atOf(i), { matches: termsCell([...now, word]) });
      setWords((w) => ({ ...w, [i]: "" }));
    });
  };
  const dropWord = (i: number, word: string) => {
    const now = termsOf(rows[i]!.cells["matches"] ?? "");
    void run(`“${word}” wasn't removed.`, () => changeRow("categories", atOf(i), { matches: termsCell(now.filter((w) => w !== word)) }));
  };
  const move = (i: number, by: -1 | 1) => void run(`${rows[i]!.name} wasn't moved.`, () => moveCategory(atOf(i), rows[i + by]!.index));
  const remove = (at: RowAt) =>
    setAsking({
      title: `Remove ${at.row.name}?`,
      body: "Its shops go to Other. Your statements are not changed.",
      confirmLabel: "Remove",
      danger: true,
      failed: `${at.row.name} wasn't removed.`,
      onConfirm: async () => {
        await removeRow("categories", at);
        await onChanged();
      },
    });

  return (
    <Sheet title="Categories" onClose={onClose} className="msheet mcats-sheet">
      <p className="q3">
        A shop goes to the category with the longest word its name contains. The first five categories get a colour each, in this order; the rest are grey.
      </p>
      {rows.length === 0 && <p className="q3">No categories yet. Add one, then the words that bring shops into it.</p>}
      <ul className="mcatedit">
        {rows.map((r, i) => {
          const list = termsOf(r.cells["matches"] ?? "");
          const colour = list.length > 0 ? colourOf(r.name) : OTHER_COLOUR;
          return (
            <li key={`${r.index}-${r.name}`} className={focus === r.name ? "on" : undefined} ref={focus === r.name ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}>
              <div className="mce-head" style={{ ["--cc" as string]: colour }}>
                <i className="sw" />
                <b>{r.name}</b>
                <span className="m">{list.length === 0 ? "no words yet" : coloured.includes(r.name) ? "" : "grey"}</span>
                <span className="msp" />
                <Button size="sm" kind="quiet" icon="up" aria-label={`Move ${r.name} up`} tip="Move up" data-tip-at="top" disabled={busy || i === 0} onClick={() => move(i, -1)} />
                <Button size="sm" kind="quiet" icon="down" aria-label={`Move ${r.name} down`} tip="Move down" data-tip-at="top" disabled={busy || i === rows.length - 1} onClick={() => move(i, 1)} />
                <Button
                  size="sm"
                  kind="quiet"
                  icon="dots"
                  aria-label={`More for ${r.name}`}
                  disabled={busy}
                  onClick={(e) => {
                    anchor.current = e.currentTarget;
                    setMenu(atOf(i));
                  }}
                />
              </div>
              <div className="mce-words">
                {list.map((w) => (
                  <span key={w} className="mword">
                    {wordLabel(w)}
                    <button type="button" aria-label={`Remove the word ${w} from ${r.name}`} disabled={busy} onClick={() => dropWord(i, w)}>
                      <Icon name="x" size={14} />
                    </button>
                  </span>
                ))}
                <form
                  className="mce-add"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addWord(i);
                  }}
                >
                  <Input aria-label={`Add a word to ${r.name}`} placeholder="Add a word" value={words[i] ?? ""} onChange={(e) => setWords({ ...words, [i]: e.target.value })} maxLength={80} />
                  <Button size="sm" type="submit" disabled={busy || !(words[i] ?? "").trim()}>
                    Add
                  </Button>
                </form>
              </div>
            </li>
          );
        })}
        {fromCommitments.map((c) => (
          <li key={`c-${c}`}>
            <div className="mce-head" style={{ ["--cc" as string]: colourOf(c) }}>
              <i className="sw" />
              <b>{c}</b>
              <span className="m">filled by your commitments</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="mce-foot">
        <Button icon="plus" disabled={busy} onClick={() => setNaming(true)}>
          Add a category
        </Button>
        <span className="msp" />
        {table && (
          <a
            className="mquiet"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onOpenNote(table.noteId);
            }}
          >
            Open the note
          </a>
        )}
      </div>
      <p className="q3">Start a word with = to match a shop with exactly that name, for short names like “ns”.</p>

      {menu && (
        <Menu
          anchor={anchor}
          label={`More for ${menu.row.name}`}
          align="end"
          onClose={() => setMenu(null)}
          items={[
            { label: "Rename…", icon: <Icon name="pen" size={16} />, onSelect: () => setRenaming(menu) },
            { label: "Remove…", icon: <Icon name="trash" size={16} />, danger: true, onSelect: () => remove(menu) },
          ]}
        />
      )}
      {renaming && <RenameDialog at={renaming} onClose={() => setRenaming(null)} onDone={onChanged} />}
      {naming && (
        <NameDialog
          title="New category"
          label="Name"
          placeholder="Groceries"
          confirm="Add"
          onClose={() => setNaming(false)}
          onSubmit={async (name) => {
            try {
              await addRow("categories", { category: name });
            } catch (e) {
              throw new Error(failureText(e, "Not added."));
            }
            await onChanged();
          }}
        />
      )}
      <Confirm request={asking} onClose={() => setAsking(null)} />
    </Sheet>
  );
}

function RenameDialog({ at, onClose, onDone }: { at: RowAt; onClose: () => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState(at.row.name);
  const write = useWrite();
  const ready = name.trim() !== "" && name.trim() !== at.row.name && !write.busy;
  const save = async () => {
    if (!ready) return;
    if (await write.run("Not renamed.", () => changeRow("categories", at, { category: name.trim() }))) {
      await onDone();
      onClose();
    }
  };
  return (
    <Dialog title={`Rename ${at.row.name}`} onClose={onClose}>
      <Form
        onSubmit={() => void save()}
        actions={
          <>
            <Button kind="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="solid" disabled={!ready}>
              Rename
            </Button>
          </>
        }
      >
        <Field label="Name" error={write.error}>
          <Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </Field>
      </Form>
    </Dialog>
  );
}

const NEW = "\u0000new";

/** Put one shop in a category: every row of it moves, said before it happens. */
export function ShopMove({
  shop,
  current,
  categories,
  onClose,
  onMoved,
}: {
  shop: string;
  /** Where its rows are filed now. */
  current: string;
  /** The categories there are, in their order. */
  categories: string[];
  onClose: () => void;
  onMoved: (said: string) => Promise<void> | void;
}) {
  const first = categories.find((c) => c !== current) ?? NEW;
  const [pick, setPick] = useState(first);
  const [fresh, setFresh] = useState("");
  const write = useWrite();
  const target = pick === NEW ? fresh.trim() : pick;
  const ready = target !== "" && target.toLowerCase() !== current.toLowerCase() && !write.busy;
  const save = async () => {
    if (!ready) return;
    let said = "";
    const done = await write.run(`${shop} wasn't moved.`, async () => {
      const res = await fileShop(shop, target);
      said = `Every ${shop} row is in ${res.to} now.`;
    });
    if (done) {
      await onMoved(said);
      onClose();
    }
  };
  return (
    <Dialog title={`Put ${shop} in a category`} onClose={onClose}>
      <Form
        onSubmit={() => void save()}
        actions={
          <>
            <Button kind="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="solid" disabled={!ready}>
              Move
            </Button>
          </>
        }
      >
        <Field label="Category">
          <Select data-autofocus value={pick} onChange={(e) => setPick(e.target.value)}>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
                {c === current ? " (now)" : ""}
              </option>
            ))}
            <option value={NEW}>New category…</option>
          </Select>
        </Field>
        {pick === NEW && (
          <Field label="Name of the new category">
            <Input autoFocus value={fresh} onChange={(e) => setFresh(e.target.value)} placeholder="A name" maxLength={60} />
          </Field>
        )}
        {ready && (
          <p className="q3">
            Every <b>{shop}</b> row moves from {current} to <b>{target}</b>, in every month.
          </p>
        )}
        {write.error && <Notice title={write.error} />}
      </Form>
    </Dialog>
  );
}
