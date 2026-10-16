/**
 * WEB-017: Settings ran irreversible actions on one click of a small ✕ beside harmless buttons:
 * disconnecting mail (Google shows an app password once), turning off or changing the published
 * planning link (every subscribed calendar stops), revoking an API token (the MCP server stops),
 * deleting a webhook, removing a calendar, a Touch ID device or a signed-in device. Each now asks
 * through Confirm, says what will happen, and does nothing on "Keep it".
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "./api.js";
import { Settings } from "./Settings.js";
import type { SettingsSection } from "./ui/router.js";

const ME = {
  id: "u-1",
  email: "jules@orrama.dev",
  username: "jules",
  displayName: "Jules",
  avatar: "victorr",
  isOwner: true,
  teams: [],
  appearance: null,
} as unknown as Me;

const ROUTES: Record<string, unknown> = {
  "GET /api/members": [{ id: "u-1", username: "jules", displayName: "Jules", isOwner: true, avatar: "victorr" }],
  "GET /api/settings/server": { notesFolder: "~/Notes", notes: 12, version: "0.1.0" },
  "GET /api/calendar/feeds": [{ id: "f1", label: "School", host: "example.edu", createdAt: 1, lastSyncedAt: null, lastError: null }],
  "GET /api/mail/account": { connected: true, email: "jules@example.com", imapHost: "imap.gmail.com", lastCheckedAt: null, lastError: null },
  "GET /api/me/ics-token": { token: "tok123" },
  "POST /api/me/ics-token": { token: "tok456" },
  "GET /api/tokens": [{ id: "t1", label: "Claude Code", prefix: "bslt_ab", createdAt: 1, lastUsedAt: null }],
  "GET /api/webhooks": [{ id: "h1", url: "https://hooks.example.com/x", events: ["task.completed"], active: true, createdAt: 1, lastStatus: null, lastFiredAt: null }],
  "GET /api/auth/webauthn/credentials": [{ id: "k1", label: "This Mac", createdAt: 1, lastUsedAt: null }],
  "POST /api/auth/unlock/options": { passcode: true, webauthn: true },
  "GET /api/auth/sessions": [
    { id: "s1", label: "Mac · Chrome", createdAt: 1, lastSeenAt: 2, current: true },
    { id: "s2", label: "iPhone · Safari", createdAt: 1, lastSeenAt: 2, current: false },
  ],
  "GET /api/admin/ai": { provider: "chatgpt", model: "gpt-5", configured: true, instructions: "", baseUrl: "", chatgpt: { connected: true, email: null, manageUsage: "https://chatgpt.com/#settings" } },
  "GET /api/admin/ai/chatgpt/models": [{ slug: "gpt-5", name: "GPT-5" }],
  "GET /api/vault/tree": [],
  "GET /api/graph/schema": { notes: 0, types: [], relations: [], derived: [], statuses: [], mostConnected: [], warnings: [] },
};

/** Every request that is not a read, in order. */
let sent: string[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: { method?: string } = {}) => {
    const key = `${init.method ?? "GET"} ${url.split("?")[0]}`;
    if (!key.startsWith("GET ") && key !== "POST /api/auth/unlock/options") sent.push(key);
    const body = key in ROUTES ? ROUTES[key] : { ok: true };
    return new Response(JSON.stringify(body), { status: 200 });
  });
});
afterEach(() => {
  cleanup(); // before the stubs go: a late request from the page must not reach happy-dom's real fetch
  vi.unstubAllGlobals();
});

function open(section: SettingsSection, extra: Partial<Parameters<typeof Settings>[0]> = {}) {
  render(
    <Settings
      me={ME}
      section={section}
      theme="light"
      shown="light"
      onTheme={() => {}}
      vision="none"
      onVision={() => {}}
      profiles={[]}
      onProfiles={() => {}}
      onUpdate={() => {}}
      onSignOut={() => {}}
      {...extra}
    />,
  );
}

const CASES: { what: string; section: SettingsSection; button: string; confirm: string; request: string }[] = [
  { what: "removing a calendar", section: "connections", button: "Remove School", confirm: "Remove calendar", request: "DELETE /api/calendar/feeds/f1" },
  { what: "disconnecting mail", section: "connections", button: "Disconnect", confirm: "Disconnect mail", request: "DELETE /api/mail/account" },
  { what: "a new planning link", section: "connections", button: "New link", confirm: "Make a new link", request: "POST /api/me/ics-token" },
  { what: "turning the planning link off", section: "connections", button: "Stop publishing", confirm: "Stop publishing", request: "DELETE /api/me/ics-token" },
  { what: "revoking an API token", section: "developer", button: "Revoke Claude Code", confirm: "Revoke token", request: "DELETE /api/tokens/t1" },
  { what: "deleting a webhook", section: "developer", button: "Delete the webhook to https://hooks.example.com/x", confirm: "Delete webhook", request: "DELETE /api/webhooks/h1" },
  { what: "removing a Touch ID device", section: "device", button: "Remove This Mac", confirm: "Remove", request: "DELETE /api/auth/webauthn/credentials/k1" },
  { what: "signing another device out", section: "sessions", button: "Sign out iPhone · Safari", confirm: "Sign out", request: "DELETE /api/auth/sessions/s2" },
  { what: "signing out everywhere", section: "sessions", button: "Sign out everywhere", confirm: "Sign out everywhere", request: "POST /api/auth/revoke-all" },
  { what: "disconnecting ChatGPT", section: "ai", button: "Disconnect ChatGPT", confirm: "Disconnect", request: "POST /api/admin/ai/chatgpt/disconnect" },
];

describe("WEB-017: what can't be undone asks first", () => {
  it.each(CASES)("$what: asks, does nothing on Keep it, and acts on confirm", async ({ section, button, confirm, request }) => {
    const user = userEvent.setup();
    open(section);
    const trigger = await screen.findByRole("button", { name: button });

    await user.click(trigger);
    const ask = screen.getByRole("alertdialog");
    expect(ask.textContent).toMatch(/\w/);
    expect(sent).toEqual([]);
    await user.click(within(ask).getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);

    await user.click(screen.getByRole("button", { name: button }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: confirm }));
    await waitFor(() => expect(sent).toEqual([request]));
  });

  it("deleting a colour profile asks too, and Keep it keeps it", async () => {
    const user = userEvent.setup();
    const onProfiles = vi.fn();
    const profile = { id: "p1", name: "Mine", colors: Array.from({ length: 7 }, () => "#336699") };
    open("appearance", { profiles: [profile], onProfiles });
    await user.click(screen.getByRole("button", { name: "Edit Mine" }));
    await user.click(within(screen.getByRole("dialog", { name: "Edit colour profile" })).getByRole("button", { name: "Delete" }));
    const ask = screen.getByRole("alertdialog");
    await user.click(within(ask).getByRole("button", { name: "Keep it" }));
    expect(onProfiles).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog", { name: "Edit colour profile" })).getByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete profile" }));
    expect(onProfiles).toHaveBeenCalledWith([]);
  });
});

/** Requests that are not reads, with their bodies. */
function bodies() {
  const out: { key: string; body: unknown }[] = [];
  const base = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: string } = {}) => {
    const key = `${init.method ?? "GET"} ${url.split("?")[0]}`;
    if (!key.startsWith("GET ") && key !== "POST /api/auth/unlock/options") out.push({ key, body: init.body ? JSON.parse(init.body) : undefined });
    return base(url, init);
  });
  return out;
}
const answer = (over: Record<string, unknown>) => {
  const base = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init: { method?: string } = {}) => {
    const key = `${init.method ?? "GET"} ${url.split("?")[0]}`;
    if (key in over) return new Response(JSON.stringify(over[key]), { status: 200 });
    return base(url, init);
  });
};
const navLinks = () => [...screen.getByRole("navigation", { name: "Settings" }).querySelectorAll(".set-ni")].map((a) => a.textContent);

describe("the Settings page (structure.md §3)", () => {
  it("lists the eight sections in order; Access only with a second account", async () => {
    open("you");
    await screen.findByText(/^Orrama 0\.1\.0/); // the server has answered: the accounts are known too
    await new Promise((r) => setTimeout(r, 20));
    expect(navLinks()).toEqual(["You", "Appearance", "Orr & AI", "Notes", "Connections", "This device", "Signed in", "Developer"]);
  });

  it("shows Access when the server has more than one account, and no team words otherwise", async () => {
    answer({
      "GET /api/members": [
        { id: "u-1", username: "jules", displayName: "Jules", isOwner: true, avatar: "victorr" },
        { id: "u-2", username: "erin", displayName: "Erin", isOwner: false, avatar: "orra" },
      ],
    });
    open("access");
    await waitFor(() => expect(navLinks()).toContain("Access"));
    expect(await screen.findByText("Erin")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/workspace owner|your vault/i);
  });

  it("Orr & AI is the owner's: someone else doesn't see it", async () => {
    render(
      <Settings
        me={{ ...ME, isOwner: false } as Me}
        section="you"
        theme="light"
        shown="light"
        onTheme={() => {}}
        vision="none"
        onVision={() => {}}
        profiles={[]}
        onProfiles={() => {}}
        onUpdate={() => {}}
        onSignOut={() => {}}
      />,
    );
    await waitFor(() => expect(navLinks()).toContain("Developer"));
    expect(navLinks()).not.toContain("Orr & AI");
  });

  it("every section says where it lives", async () => {
    for (const [section, where] of [
      ["you", "Your account"],
      ["appearance", "Your account"],
      ["ai", "This server"],
      ["notes", "This server"],
      ["connections", "Your account"],
      ["device", "This device"],
      ["sessions", "Your account"],
      ["developer", "This server"],
    ] as const) {
      const { unmount } = render(
        <Settings me={ME} section={section} theme="light" shown="light" onTheme={() => {}} vision="none" onVision={() => {}} profiles={[]} onProfiles={() => {}} onUpdate={() => {}} onSignOut={() => {}} />,
      );
      const head = await screen.findByRole("heading", { level: 2 });
      expect(head.querySelector(".set-where")?.textContent).toBe(where);
      unmount();
    }
  });

  it("Find a setting narrows the list and Enter opens the first match", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/settings/you");
    open("you");
    await user.type(screen.getByRole("searchbox", { name: "Find a setting" }), "passcode");
    expect(navLinks()).toEqual(["PasscodeThis device"]);
    await user.keyboard("{Enter}");
    expect(location.pathname).toBe("/settings/device");
  });

  it("the theme offers Light, Dark and Match this device", async () => {
    const user = userEvent.setup();
    const onTheme = vi.fn();
    open("appearance", { onTheme });
    await user.click(screen.getByRole("radio", { name: /Match this device/ }));
    expect(onTheme).toHaveBeenLastCalledWith("match");
    await user.click(screen.getByRole("radio", { name: /^Dark/ }));
    expect(onTheme).toHaveBeenLastCalledWith("dark");
  });

  it("picking your Orr saves it to the account", async () => {
    const user = userEvent.setup();
    const sent2 = bodies();
    const onUpdate = vi.fn();
    open("you", { onUpdate });
    await user.click(screen.getByRole("radio", { name: /^Orra/ }));
    await waitFor(() => expect(sent2).toEqual([{ key: "PATCH /api/me", body: { avatar: "orra" } }]));
    expect(onUpdate).toHaveBeenCalled();
  });

  it("Orr & AI: the key never shows, Replace asks for a new one, and one Save sends what changed", async () => {
    const user = userEvent.setup();
    answer({ "GET /api/admin/ai": { provider: "anthropic", model: "claude-sonnet-5", configured: true, instructions: "Be brief.", baseUrl: "", chatgpt: { connected: false, email: null, manageUsage: "x" } } });
    const sent2 = bodies();
    open("ai");
    expect(await screen.findByText("A key is stored on this server")).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true); // nothing changed yet

    const instr = screen.getByLabelText("How Orr should work for you");
    await user.clear(instr);
    await user.type(instr, "Push me on deadlines.");
    expect(screen.getByRole("status").textContent).toBe("You changed the instructions.");
    await user.click(save);
    await waitFor(() => expect(sent2).toEqual([{ key: "POST /api/admin/ai/instructions", body: { instructions: "Push me on deadlines." } }]));

    sent2.length = 0;
    await user.click(screen.getByRole("button", { name: "Replace" }));
    await user.type(screen.getByLabelText("API key"), "sk-new-key-0123456789");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sent2).toEqual([{ key: "POST /api/admin/ai", body: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "sk-new-key-0123456789", baseUrl: "" } }]),
    );
  });

  it("Orr & AI with nothing set up still saves the instructions alone", async () => {
    const user = userEvent.setup();
    answer({ "GET /api/admin/ai": { provider: null, model: null, configured: false, instructions: "", baseUrl: "", chatgpt: { connected: false, email: null, manageUsage: "x" } } });
    const sent2 = bodies();
    open("ai");
    await user.type(await screen.findByLabelText("How Orr should work for you"), "Be direct.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent2).toEqual([{ key: "POST /api/admin/ai/instructions", body: { instructions: "Be direct." } }]));
  });

  it("the phone's list: your Orr, the sections with where each stands, and Sign out", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    open(undefined as unknown as SettingsSection, { section: undefined, onSignOut });
    const list = document.querySelector(".set-list")!;
    expect(list.querySelector(".set-pme")?.textContent).toMatch(/Jules.*victOrr · Your account/);
    await waitFor(() => expect(list.textContent).toMatch(/Connections.*Gmail, 1 calendar/));
    expect(list.textContent).toMatch(/This device.*Passcode on/);
    expect(list.textContent).toMatch(/Signed in.*2 devices/);
    expect(list.textContent).toMatch(/Orr & AI.*gpt-5/);
    await user.click(within(list as HTMLElement).getByRole("button", { name: "Sign out of this device" }));
    expect(onSignOut).toHaveBeenCalled();
  });
});
