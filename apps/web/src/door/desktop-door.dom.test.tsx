/**
 * First run and the sign-in in the desktop app and in a browser (2C): the AI step's three
 * ways, the system's folder chooser, ChatGPT's sign-in in the system browser, and "Forgot your
 * password?". The app is told apart by the shell's mark (desktop.ts), never the user agent.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Login } from "../Login.js";
import { RESET_PATH, takeResetTicket } from "../desktop.js";
import { AiStep } from "./AiStep.js";
import { DoorFoot } from "./Door.js";
import { NotesChoice } from "./NotesChoice.js";
import { Reset } from "./Reset.js";

const ME = { id: "u-1", email: "ines@example.com", username: "ines", displayName: "Ines", avatar: null, isOwner: true, teams: [], appearance: null };
const AI_OFF = { provider: null, model: null, configured: false, instructions: "", baseUrl: "", chatgpt: { connected: false, email: null, manageUsage: "x" } };
const AI_PLAN = { ...AI_OFF, provider: "chatgpt", model: "gpt-plan", configured: true, chatgpt: { connected: true, email: "ines@example.com", manageUsage: "x" } };

type Reply = unknown | ((body: any) => Response | Promise<Response>);
let calls: { key: string; body: any }[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function serve(routes: Record<string, Reply>) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: string } = {}) => {
    const key = `${init.method ?? "GET"} ${url.split("?")[0]}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, body });
    if (!(key in routes)) return json(404, { error: "not found" });
    const r = routes[key];
    if (typeof r === "function") return (r as (b: any) => Response)(body);
    return json(200, r);
  });
}
const sent = (key: string) => calls.filter((c) => c.key === key);
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** The shell's mark on the window, and the dialog plugin's one command. */
function inTheApp(invoke: (cmd: string, args?: any) => Promise<unknown> = async () => null) {
  window.__ORRAMA_DESKTOP__ = { shell: 1 };
  window.__TAURI_INTERNALS__ = { invoke: vi.fn(invoke) };
}
let assigned: string[] = [];

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduced-motion"), media: q, addEventListener() {}, removeEventListener() {} }));
  localStorage.clear();
  assigned = [];
  vi.spyOn(window.location, "assign").mockImplementation((u: string | URL) => void assigned.push(String(u)));
});
afterEach(() => {
  cleanup();
  delete window.__ORRAMA_DESKTOP__;
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("first run's AI step", () => {
  it("Later goes on, and nothing is saved or sent anywhere", async () => {
    serve({ "GET /api/admin/ai": AI_OFF });
    const onDone = vi.fn();
    render(<AiStep onDone={onDone} />);
    fireEvent.click(await screen.findByRole("radio", { name: /^Later/ }));
    expect(screen.getByText(/Orr stays off, and nothing is sent anywhere/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onDone).toHaveBeenCalled();
    expect(calls.filter((c) => c.key !== "GET /api/admin/ai")).toEqual([]);
  });

  it("Use a key: the guide and its link, the key checked, then saved, then on", async () => {
    serve({ "GET /api/admin/ai": AI_OFF, "POST /api/admin/ai/check": { ok: true }, "POST /api/admin/ai": { ok: true } });
    const onDone = vi.fn();
    render(<AiStep onDone={onDone} />);
    fireEvent.click(await screen.findByRole("radio", { name: /^Use a key/ }));
    expect(await screen.findByText(/Make a key in Anthropic's console, under API keys, and paste it here\. Anthropic bills you for what Orr asks/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Anthropic's console" }).getAttribute("href")).toBe("https://console.anthropic.com/settings/keys");
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("claude-sonnet-5-5");
    type("API key", "sk-ant-0123456789");
    fireEvent.click(screen.getByRole("button", { name: "Check the key and continue" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls.filter((c) => c.key.startsWith("POST")).map((c) => [c.key, c.body])).toEqual([
      ["POST /api/admin/ai/check", { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "sk-ant-0123456789" }],
      ["POST /api/admin/ai", { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "sk-ant-0123456789", baseUrl: "" }],
    ]);
  });

  it("a key the provider refuses is said, nothing is saved, and the step stays", async () => {
    serve({ "GET /api/admin/ai": AI_OFF, "POST /api/admin/ai/check": () => json(400, { error: "Anthropic didn't accept that key. Check that you copied all of it." }) });
    const onDone = vi.fn();
    render(<AiStep onDone={onDone} />);
    fireEvent.click(await screen.findByRole("radio", { name: /^Use a key/ }));
    await screen.findByLabelText("API key");
    type("API key", "sk-ant-wrong-0123");
    fireEvent.click(screen.getByRole("button", { name: "Check the key and continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Anthropic didn't accept that key. Check that you copied all of it.");
    expect(sent("POST /api/admin/ai")).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("ChatGPT in the app: the sign-in goes to the system browser, the step waits, then moves on once it lands", async () => {
    inTheApp();
    let connected = false;
    serve({ "GET /api/admin/ai": () => json(200, connected ? AI_PLAN : AI_OFF), "POST /api/admin/ai/chatgpt/start": { url: "https://auth.openai.com/api/accounts/authorize?x=1" } });
    const onDone = vi.fn();
    render(<AiStep onDone={onDone} />);
    expect((await screen.findByRole("radio", { name: /^Sign in with ChatGPT/ })).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    expect(await screen.findByText("Finish signing in in your browser, then come back here.")).toBeTruthy();
    expect(sent("POST /api/admin/ai/chatgpt/start").map((c) => c.body)).toEqual([{ wait: true }]);
    expect(assigned).toEqual(["https://auth.openai.com/api/accounts/authorize?x=1"]);
    expect(onDone).not.toHaveBeenCalled();
    // Signed in, in the browser; the window comes back to the front.
    connected = true;
    await waitFor(() => {
      act(() => void window.dispatchEvent(new Event("focus")));
      expect(onDone).toHaveBeenCalled();
    });
  });

  it("ChatGPT in a browser tab: the tab itself goes to OpenAI, as before", async () => {
    serve({ "GET /api/admin/ai": AI_OFF, "POST /api/admin/ai/chatgpt/start": { url: "https://auth.openai.com/x" } });
    render(<AiStep onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue with ChatGPT" }));
    await waitFor(() => expect(assigned).toEqual(["https://auth.openai.com/x"]));
    expect(sent("POST /api/admin/ai/chatgpt/start").map((c) => c.body)).toEqual([undefined]);
    expect(screen.queryByText("Finish signing in in your browser, then come back here.")).toBeNull();
  });
});

describe("Use notes I already have", () => {
  const SERVER = { notesFolder: "~/Orrama", notes: 0, version: "0.1.0", fixed: false, own: false, example: 0 };
  const LOOK = { folder: "~/Notes", problem: null, notes: 3, more: false, unstamped: 3, ontology: true, current: false };

  it("in the app, opens the system's folder chooser and uses the folder picked", async () => {
    inTheApp(async () => "/Users/ines/Notes");
    serve({ "POST /api/settings/notes-folder/look": (b: { folder: string | null }) => json(200, b.folder === null ? { ...LOOK, folder: "~/Orrama", notes: 0 } : LOOK) });
    render(<NotesChoice server={SERVER} place="first" onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Use notes I already have/ }));
    expect(screen.queryByLabelText("Folder")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Choose the folder…" }));
    expect(await screen.findByText("~/Notes")).toBeTruthy();
    expect(await screen.findByText(/^3 notes\. Orrama adds a short id line/)).toBeTruthy();
    expect(sent("POST /api/settings/notes-folder/look").map((c) => c.body)).toContainEqual({ folder: "/Users/ines/Notes" });
    expect(window.__TAURI_INTERNALS__!.invoke).toHaveBeenCalledWith("plugin:dialog|open", { options: expect.objectContaining({ directory: true, multiple: false }) });
    expect(screen.getByRole("button", { name: "Choose another folder…" })).toBeTruthy();
  });

  it("a chooser that can't open hands over to the typed path", async () => {
    inTheApp(async () => {
      throw new Error("dialog.open not allowed");
    });
    serve({ "POST /api/settings/notes-folder/look": LOOK });
    render(<NotesChoice server={SERVER} place="first" onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Use notes I already have/ }));
    fireEvent.click(screen.getByRole("button", { name: "Choose the folder…" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The folder chooser didn't open. Type the folder instead.");
    expect(screen.getByLabelText("Folder")).toBeTruthy();
  });

  it("in a browser, the folder is typed as before", () => {
    serve({ "POST /api/settings/notes-folder/look": LOOK });
    render(<NotesChoice server={SERVER} place="first" onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Use notes I already have/ }));
    expect(screen.getByLabelText("Folder")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Choose the folder…" })).toBeNull();
  });
});

describe("Forgot your password?", () => {
  it("in the app, on the server it started, asks the shell for a reset", () => {
    inTheApp();
    render(<Login onLogin={vi.fn()} resetHere />);
    fireEvent.click(screen.getByRole("button", { name: "Forgot your password?" }));
    expect(assigned).toEqual([RESET_PATH]);
  });

  it("in a browser, says where the reset is done", () => {
    render(<Login onLogin={vi.fn()} resetHere />);
    fireEvent.click(screen.getByRole("button", { name: "Forgot your password?" }));
    expect(screen.getByRole("status").textContent).toBe("Reset it on the computer Orrama runs on: open Orrama there and choose Forgot your password? on its sign-in screen.");
    expect(assigned).toEqual([]);
  });

  it("on a server the app didn't start, says only that", () => {
    inTheApp();
    render(<Login onLogin={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Forgot your password?" }));
    expect(screen.getByRole("status").textContent).toBe("Reset it on the computer Orrama runs on.");
    expect(assigned).toEqual([]);
  });

  it("the shell's ticket is read from /reset once, and the address no longer holds it", () => {
    window.history.replaceState(null, "", "/reset#ticket=abc_DEF-123");
    expect(takeResetTicket()).toEqual({ ticket: "abc_DEF-123" });
    expect(window.location.pathname + window.location.hash).toBe("/");
    window.history.replaceState(null, "", "/reset#failed");
    expect(takeResetTicket()).toEqual({ failed: true });
    window.history.replaceState(null, "", "/today");
    expect(takeResetTicket()).toBeNull();
    expect(window.location.pathname).toBe("/today");
  });

  it("the reset form spends the ticket and signs you in", async () => {
    localStorage.setItem("orrama-last-email", "ines@example.com");
    serve({ "POST /api/auth/reset": { user: ME } });
    const onDone = vi.fn();
    render(<Reset ticket="t-1" onDone={onDone} onBack={vi.fn()} />);
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("ines@example.com");
    type("New password", "a new long one");
    fireEvent.click(screen.getByRole("button", { name: "Set the new password" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(ME));
    expect(sent("POST /api/auth/reset").map((c) => c.body)).toEqual([{ ticket: "t-1", email: "ines@example.com", password: "a new long one" }]);
  });

  it("an expired ticket and a wrong email are said in the door's words", async () => {
    let status = 403;
    serve({ "POST /api/auth/reset": () => json(status, { error: status === 403 ? "expired" : "There's no account with that email on this computer." }) });
    render(<Reset ticket="t-1" onDone={vi.fn()} onBack={vi.fn()} />);
    type("Email", "ines@example.com");
    type("New password", "a new long one");
    fireEvent.click(screen.getByRole("button", { name: "Set the new password" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This reset has expired. Start it again from the sign-in screen.");
    status = 400;
    fireEvent.click(screen.getByRole("button", { name: "Set the new password" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("There's no account with that email on this computer. Check it and try again."));
  });

  it("when the shell couldn't get a ticket, says so and offers the way back", () => {
    const onBack = vi.fn();
    render(<Reset ticket={null} onDone={vi.fn()} onBack={onBack} />);
    expect(screen.getByRole("alert").textContent).toBe("Orrama couldn't start the reset. Try again from the sign-in screen.");
    expect(screen.queryByLabelText("New password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(onBack).toHaveBeenCalled();
  });
});

describe("the door's words", () => {
  it("say this computer in the app, and where Orrama runs elsewhere; never the server", () => {
    const { unmount } = render(<DoorFoot />);
    expect(screen.getByText(/stay where Orrama runs/)).toBeTruthy();
    unmount();
    inTheApp();
    render(<DoorFoot />);
    expect(screen.getByText(/stay on this computer/).textContent).not.toMatch(/server/);
  });
});
