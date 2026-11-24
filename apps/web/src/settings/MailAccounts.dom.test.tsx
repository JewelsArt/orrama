/**
 * Settings → Mail with more than one account (N1): a row each, Rename and Make it the default
 * from its ⋯, Disconnect asking first in the words it always used, Add another account with
 * the same form, and how Mail shows them chosen on this device. With one account the part is
 * as it was (Settings.dom.test.tsx holds its Disconnect).
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailAccountRow } from "@orrama/schema/responses";
import { Confirm, type ConfirmRequest } from "../Confirm.js";
import { ACCOUNTS } from "../test/mail-fixture.js";
import { MailAccountPart } from "./MailAccounts.js";

function Part() {
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);
  return (
    <>
      <MailAccountPart ask={setAsk} />
      <Confirm request={ask} onClose={() => setAsk(null)} />
    </>
  );
}

let accounts: MailAccountRow[];
let sent: { key: string; body: unknown }[];
beforeEach(() => {
  localStorage.clear();
  accounts = ACCOUNTS.map((a) => ({ ...a }));
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      const key = `${init.method ?? "GET"} ${url}`;
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (!key.startsWith("GET ")) sent.push({ key, body });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (key === "GET /api/mail/accounts") return ok(accounts);
      const one = /^(PATCH|DELETE) \/api\/mail\/accounts\/(.+)$/.exec(key);
      if (one?.[1] === "PATCH") {
        accounts = accounts.map((a) => (a.id === one[2] ? { ...a, ...(body.label !== undefined ? { label: body.label || a.email } : {}) } : body.default ? { ...a, isDefault: false } : a)).map((a) => (body.default && a.id === one[2] ? { ...a, isDefault: true } : a));
        return ok(accounts);
      }
      if (one?.[1] === "DELETE") {
        accounts = accounts.filter((a) => a.id !== one[2]).map((a, i) => (i === 0 ? { ...a, isDefault: true } : a));
        return ok(accounts);
      }
      if (key === "POST /api/mail/account") return ok({ id: "mail-3", email: body.email, label: body.email, isDefault: false, imapHost: "imap.gmail.com", lastCheckedAt: null, lastError: null });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const rowOf = (label: string) => screen.findByText(label, { selector: ".set-item b" }).then((b) => b.closest(".set-item") as HTMLElement);

describe("Settings → Mail with two accounts", () => {
  it("a row each, the default said; Rename and Make it the default from the ⋯", async () => {
    const user = userEvent.setup();
    render(<Part />);
    const first = await rowOf("jules@orrama.dev");
    expect(first.textContent).toMatch(/new mail goes from here/);
    expect((await rowOf("Work")).textContent).toMatch(/jules@kade\.example/);

    await user.click(screen.getByRole("button", { name: "Rename or reorder Work" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename…" }));
    const dialog = screen.getByRole("dialog", { name: "Rename Work" });
    const name = within(dialog).getByRole("textbox", { name: /Name/ });
    await user.clear(name);
    await user.type(name, "Kade");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(sent).toContainEqual({ key: "PATCH /api/mail/accounts/mail-2", body: { label: "Kade" } }));
    expect((await rowOf("Kade")).textContent).toMatch(/jules@kade\.example/);

    await user.click(screen.getByRole("button", { name: "Rename or reorder Kade" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Make it the default" }));
    await waitFor(() => expect(sent).toContainEqual({ key: "PATCH /api/mail/accounts/mail-2", body: { default: true } }));
    await waitFor(async () => expect((await rowOf("Kade")).textContent).toMatch(/new mail goes from here/));
  });

  it("Disconnect asks first, does nothing on Keep it, and removes only that account", async () => {
    const user = userEvent.setup();
    render(<Part />);
    await rowOf("Work");
    await user.click(screen.getByRole("button", { name: "Disconnect Work" }));
    const ask = screen.getByRole("alertdialog");
    expect(ask.textContent).toMatch(/Disconnect Work\?/);
    expect(ask.textContent).toMatch(/Google shows an app password only once/);
    await user.click(within(ask).getByRole("button", { name: "Keep it" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Disconnect Work" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Disconnect mail" }));
    await waitFor(() => expect(sent.map((s) => s.key)).toEqual(["DELETE /api/mail/accounts/mail-2"]));
    // One account left: the part reads as it always did.
    expect(await screen.findByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("Add another account uses the same form; the new account joins the list", async () => {
    const user = userEvent.setup();
    render(<Part />);
    await rowOf("Work");
    await user.click(screen.getByRole("button", { name: "Add another account" }));
    const form = screen.getByRole("form", { name: "Add another account" });
    await user.type(within(form).getByRole("textbox", { name: "Gmail address" }), "jules@third.example");
    await user.type(within(form).getByLabelText("App password"), "abcd efgh ijkl mnop");
    await user.click(within(form).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(sent.map((s) => s.key)).toEqual(["POST /api/mail/account"]));
    expect(await rowOf("jules@third.example")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Add another account" })).toBeNull();
  });

  it("how Mail shows them is chosen here, on this device", async () => {
    const user = userEvent.setup();
    render(<Part />);
    const choice = await screen.findByRole("radiogroup", { name: "How Mail shows your accounts" });
    expect(within(choice).getByRole("radio", { checked: true }).textContent).toMatch(/One list for all accounts/);
    await user.click(within(choice).getByRole("radio", { name: /One account at a time/ }));
    expect(localStorage.getItem("orrama-mail-inbox")).toBe("single");
    expect(sent).toEqual([]);
  });
});
