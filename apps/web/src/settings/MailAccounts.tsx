/**
 * Settings → Connections → Mail: your mail accounts (N1, "my other addresses"). With one, it
 * reads as it always did: the address, how it's doing, Disconnect. With more, a row each: its
 * name (a label, else the address), whether it's the default for new mail, and a ⋯ with Rename,
 * Make it the default and Move up or down; Disconnect asks first, in the words it always used
 * (Google shows an app password only once). Add another account is the same form as the first.
 *
 * How Mail reads several accounts is chosen here, on this device (Jules, 24 Nov: both, by
 * choice): one list for all of them, or one account at a time (mail/accounts.ts).
 */
import { useEffect, useRef, useState } from "react";
import type { MailAccountRow } from "@orrama/schema/responses";
import { api } from "../api.js";
import type { ConfirmRequest } from "../Confirm.js";
import { readView, writeView, type InboxView } from "../mail/accounts.js";
import { Button } from "../ui/controls.js";
import { Field, Form, Input, RadioGroup } from "../ui/fields.js";
import { RowList } from "../ui/layout.js";
import { Dialog, Menu, toast, type MenuItem } from "../ui/overlays.js";
import { StateLine, SubHead, WhereMark, said } from "./parts.js";

type Ask = (r: ConfirmRequest) => void;

const DISCONNECT_BODY =
  "The app password is deleted from this server. Google shows an app password only once, so connecting again means making a new one.";

export function MailAccountPart({ ask }: { ask: Ask }) {
  const [accounts, setAccounts] = useState<MailAccountRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<MailAccountRow | null>(null);
  const [renaming, setRenaming] = useState<MailAccountRow | null>(null);
  const menuAt = useRef<HTMLElement | null>(null);
  const [view, setView] = useState<InboxView>(readView);

  useEffect(() => {
    api<MailAccountRow[]>("GET", "/api/mail/accounts")
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  const change = async (
    a: MailAccountRow,
    patch: { label?: string | null; default?: true; position?: number },
  ) => {
    setAccounts(
      await api<MailAccountRow[]>("PATCH", `/api/mail/accounts/${a.id}`, patch),
    );
  };
  const changeOr = (
    a: MailAccountRow,
    patch: { default?: true; position?: number },
    failed: string,
  ) => void change(a, patch).catch((e) => toast(said(e, failed)));

  const list = accounts ?? [];
  const one = list.length === 1 ? list[0]! : null;

  const disconnectOne = () =>
    ask({
      title: "Disconnect mail?",
      body: DISCONNECT_BODY,
      confirmLabel: "Disconnect mail",
      danger: true,
      onConfirm: () =>
        void api("DELETE", "/api/mail/account")
          .then(() => setAccounts([]))
          .catch((e) => toast(said(e, "Mail couldn't be disconnected."))),
    });
  const disconnect = (a: MailAccountRow) =>
    ask({
      title: `Disconnect ${a.label}?`,
      body: `${DISCONNECT_BODY}${a.isDefault ? " New mail will go from your next account." : ""}`,
      confirmLabel: "Disconnect mail",
      danger: true,
      onConfirm: () =>
        void api<MailAccountRow[]>("DELETE", `/api/mail/accounts/${a.id}`)
          .then(setAccounts)
          .catch((e) => toast(said(e, `${a.label} couldn't be disconnected.`))),
    });

  const menuItems = (a: MailAccountRow): (MenuItem | "-")[] => {
    const i = list.findIndex((x) => x.id === a.id);
    return [
      { label: "Rename…", onSelect: () => setRenaming(a) },
      {
        label: "Make it the default",
        checked: a.isDefault,
        disabled: a.isDefault,
        onSelect: () =>
          changeOr(a, { default: true }, `${a.label} wasn't made the default.`),
      },
      "-",
      {
        label: "Move up",
        disabled: i <= 0,
        onSelect: () =>
          changeOr(a, { position: i - 1 }, `${a.label} wasn't moved.`),
      },
      {
        label: "Move down",
        disabled: i >= list.length - 1,
        onSelect: () =>
          changeOr(a, { position: i + 1 }, `${a.label} wasn't moved.`),
      },
    ];
  };

  return (
    <>
      <div>
        <SubHead>Mail</SubHead>
        {one ? (
          <StateLine
            tone={one.lastError ? "bad" : "ok"}
            title={one.email}
            detail={
              one.lastError
                ? `Couldn't connect: ${one.lastError}`
                : "read and reply in Mail"
            }
            action={
              <Button size="sm" danger onClick={disconnectOne}>
                Disconnect
              </Button>
            }
          />
        ) : list.length > 1 ? (
          <RowList label="Mail accounts">
            {list.map((a) => (
              <div key={a.id} className="set-item mailacct">
                <span
                  className={a.lastError ? "set-dot bad" : "set-dot ok"}
                  aria-hidden="true"
                />
                <span className="set-item-x">
                  <b>{a.label}</b>
                  <small>
                    {[
                      a.label !== a.email ? a.email : null,
                      a.isDefault ? "new mail goes from here" : null,
                      a.lastError ? `couldn't connect: ${a.lastError}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </span>
                <Button
                  size="sm"
                  kind="quiet"
                  icon="dots"
                  aria-label={`Rename or reorder ${a.label}`}
                  tip="Name, default and order"
                  data-tip-at="top"
                  aria-haspopup="menu"
                  onClick={(e) => {
                    menuAt.current = e.currentTarget;
                    setMenu(a);
                  }}
                />
                <Button
                  size="sm"
                  kind="quiet"
                  icon="trash"
                  danger
                  aria-label={`Disconnect ${a.label}`}
                  tip="Disconnect"
                  data-tip-at="top"
                  onClick={() => disconnect(a)}
                />
              </div>
            ))}
          </RowList>
        ) : null}
        {menu && (
          <Menu
            anchor={menuAt}
            label={`${menu.label}: name, default and order`}
            items={menuItems(menu)}
            align="end"
            onClose={() => setMenu(null)}
          />
        )}
        {renaming && (
          <RenameAccount
            account={renaming}
            onClose={() => setRenaming(null)}
            onSave={(label) => change(renaming, { label })}
          />
        )}
        {accounts && (list.length === 0 || adding) && (
          <ConnectForm
            first={list.length === 0}
            onConnected={(row) => {
              setAccounts((all) => [
                ...(all ?? []).filter((x) => x.id !== row.id),
                row,
              ]);
              setAdding(false);
            }}
            onCancel={list.length ? () => setAdding(false) : undefined}
          />
        )}
        {list.length > 0 && !adding && (
          <p className="set-help">
            <button
              type="button"
              className="set-how"
              onClick={() => setAdding(true)}
            >
              Add another account
            </button>
          </p>
        )}
      </div>
      {list.length > 1 && (
        <div>
          <SubHead aside={<WhereMark where="device" />}>
            How Mail shows your accounts
          </SubHead>
          <div className="set-opts">
            <RadioGroup<InboxView>
              label="How Mail shows your accounts"
              value={view}
              onChange={(v) => {
                writeView(v);
                setView(v);
              }}
              options={[
                {
                  id: "merged",
                  label: "One list for all accounts",
                  help: "Each message says which account it came to. A menu at the top of Mail shows one account.",
                },
                {
                  id: "single",
                  label: "One account at a time",
                  help: "Switch between them at the top of Mail.",
                },
              ]}
            />
          </div>
        </div>
      )}
    </>
  );
}

/** The connect form: the address and an app password, checked with the mail server before it's kept. */
function ConnectForm({
  first,
  onConnected,
  onCancel,
}: {
  first: boolean;
  onConnected: (row: MailAccountRow) => void;
  onCancel?: () => void;
}) {
  const [email, setEmail] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [how, setHow] = useState(false);
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      onConnected(
        await api<MailAccountRow>("POST", "/api/mail/account", {
          email: email.trim(),
          appPassword,
        }),
      );
      setEmail("");
      setAppPassword("");
    } catch (e) {
      setError(
        said(
          e,
          "Gmail didn't accept that. Check the address and the app password.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <form
        className="set-add"
        aria-label={first ? "Connect mail" : "Add another account"}
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim() && appPassword.trim() && !busy) void connect();
        }}
      >
        <Field label="Gmail address">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@gmail.com"
            autoComplete="email"
            autoFocus={!first}
          />
        </Field>
        <Field label="App password" error={error}>
          <Input
            type="password"
            value={appPassword}
            onChange={(e) => setAppPassword(e.target.value)}
            placeholder="16 letters"
            autoComplete="off"
          />
        </Field>
        <Button
          type="submit"
          kind="solid"
          disabled={busy || !email.trim() || !appPassword.trim()}
        >
          {busy ? "Connecting…" : "Connect"}
        </Button>
        {onCancel && (
          <Button kind="quiet" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </form>
      <p className="set-help">
        An app password, not your Google password. It stays encrypted on this
        Mac; mail never leaves your server.{" "}
        <button
          type="button"
          className="set-how"
          aria-expanded={how}
          onClick={() => setHow(!how)}
        >
          How?
        </button>
      </p>
      {how && (
        <p className="set-help">
          Turn on 2-Step Verification, then Google Account, Security,{" "}
          <em>App passwords</em>: make one for Mail and paste it here.
        </p>
      )}
    </>
  );
}

/** What an account is called in Mail; empty is its address again. */
function RenameAccount({
  account,
  onClose,
  onSave,
}: {
  account: MailAccountRow;
  onClose: () => void;
  onSave: (label: string) => Promise<void>;
}) {
  const [label, setLabel] = useState(
    account.label === account.email ? "" : account.label,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(label.trim());
      onClose();
    } catch (e) {
      setError(said(e, "That name wasn't saved."));
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Rename ${account.label}`} onClose={onClose}>
      <Form
        onSubmit={() => void save()}
        actions={
          <>
            <Button kind="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="solid" disabled={busy}>
              Rename
            </Button>
          </>
        }
      >
        <Field
          label="Name"
          help={`Left empty, it's called ${account.email}.`}
          error={error}
        >
          <Input
            data-autofocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={40}
            placeholder="Work, Home…"
          />
        </Field>
      </Form>
    </Dialog>
  );
}
