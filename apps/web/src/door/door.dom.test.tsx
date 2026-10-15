/**
 * The door against a stubbed server: sign-in, lock and first run, their errors in the door's
 * voice, and the two seconds of the gathered vault before the app opens.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Lock } from "../Lock.js";
import { Login } from "../Login.js";
import { Setup } from "../Setup.js";
import { HOLD_MS } from "./Door.js";

const ME = { id: "u-1", email: "ines@example.com", username: "ines", displayName: "Ines", avatar: null, isOwner: true, teams: [], appearance: null };
const IN = { token: "t-1", user: ME };

type Reply = unknown | ((body: any) => Response | Promise<Response>);
let calls: { key: string; body: any }[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** Answer the door's requests; anything else is a 404. */
function serve(routes: Record<string, Reply>) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: string } = {}) => {
    const key = `${init.method ?? "GET"} ${url.split("?")[0]}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, body });
    if (!(key in routes)) return json(404, { error: "not found" });
    const r = routes[key];
    if (typeof r === "function") return (r as (b: any) => Response)(body);
    if (r instanceof Response) return r;
    return json(200, r);
  });
}

/** Reduced motion: no animation and no hold, so a test sees the outcome at once. */
function motion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("reduced-motion") ? reduce : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
}

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => motion(true));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sign-in", () => {
  it("says a wrong password in its own words, with nothing of the server's", async () => {
    serve({ "POST /api/auth/login": json(401, { error: "invalid email or password" }) });
    const onLogin = vi.fn();
    render(<Login onLogin={onLogin} />);
    type("Email", "ines@example.com");
    type("Password", "nope");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That email and password don't match. Check them and try again.");
    expect(screen.queryByText(/invalid/)).toBeNull();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("while locked out, says how long to wait", async () => {
    serve({ "POST /api/auth/login": json(429, { error: "too many failed sign-ins — try again in 15 min" }) });
    render(<Login onLogin={vi.fn()} />);
    type("Email", "ines@example.com");
    type("Password", "right-but-too-late");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too many tries from here. Try again in 15 minutes.");
  });

  it("asks for both fields before asking the server", async () => {
    serve({});
    render(<Login onLogin={vi.fn()} />);
    type("Email", "ines@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter your email and your password.");
    expect(sent("POST /api/auth/login")).toHaveLength(0);
  });

  it("keeps the session and the address, then opens the app (at once with reduced motion)", async () => {
    serve({ "POST /api/auth/login": IN });
    const onLogin = vi.fn();
    render(<Login onLogin={onLogin} />);
    type("Email", "Ines@Example.com");
    type("Password", "orrama-demo");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(ME));
    expect(localStorage.getItem("orrama-token")).toBe("t-1");
    expect(localStorage.getItem("orrama-last-email")).toBe("ines@example.com");
  });

  it("with motion, the gathered vault shows for two seconds and no longer", async () => {
    motion(false);
    serve({ "POST /api/auth/login": IN, "GET /api/vault/tree": [], "GET /api/projects": [], "GET /api/contacts": [] });
    let opened = 0;
    const onLogin = vi.fn(() => (opened = performance.now()));
    render(<Login onLogin={onLogin} />);
    type("Email", "ines@example.com");
    type("Password", "orrama-demo");
    const t0 = performance.now();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByText("Your notes are all here.")).textContent).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    await waitFor(() => expect(onLogin).toHaveBeenCalled(), { timeout: HOLD_MS + 1000 });
    expect(opened - t0).toBeGreaterThanOrEqual(HOLD_MS - 50);
    expect(opened - t0).toBeLessThan(HOLD_MS + 400);
  }, 6000);
});

describe("lock", () => {
  beforeEach(() => localStorage.setItem("orrama-last-email", "ines@example.com"));

  it("shows the time and no name", async () => {
    serve({ "POST /api/auth/unlock/options": { passcode: true, webauthn: false } });
    render(<Lock onUnlock={vi.fn()} onUsePassword={vi.fn()} />);
    expect(await screen.findByText("Locked")).toBeTruthy();
    expect(document.querySelector(".dr-clock")?.textContent).toMatch(/^\d\d:\d\d$/);
    expect(document.body.textContent).not.toMatch(/ines/i);
  });

  it("sends a passcode typed on the keyboard once, even when React renders twice", async () => {
    serve({ "POST /api/auth/unlock/options": { passcode: true, webauthn: false }, "POST /api/auth/unlock": json(401, { error: "incorrect passcode" }) });
    render(
      <StrictMode>
        <Lock onUnlock={vi.fn()} onUsePassword={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByRole("button", { name: "5" });
    for (const k of "1234") fireEvent.keyDown(window, { key: k });
    expect((await screen.findByRole("alert")).textContent).toBe("That passcode isn't right. Try again.");
    expect(sent("POST /api/auth/unlock")).toEqual([{ key: "POST /api/auth/unlock", body: { email: "ines@example.com", passcode: "1234" } }]);
  });

  it("unlocks with the keypad", async () => {
    serve({ "POST /api/auth/unlock/options": { passcode: true, webauthn: false }, "POST /api/auth/unlock": IN });
    const onUnlock = vi.fn();
    render(<Lock onUnlock={onUnlock} onUsePassword={vi.fn()} />);
    for (const k of "4321") fireEvent.click(await screen.findByRole("button", { name: k }));
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith(ME));
  });

  it("after ten wrong passcodes, the password is the way in", async () => {
    serve({
      "POST /api/auth/unlock/options": { passcode: true, webauthn: false },
      "POST /api/auth/unlock": json(403, { error: "too many attempts — sign in with your password" }),
      "POST /api/auth/login": IN,
    });
    const onUnlock = vi.fn();
    render(<Lock onUnlock={onUnlock} onUsePassword={vi.fn()} />);
    for (const k of "0000") fireEvent.click(await screen.findByRole("button", { name: k }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too many wrong passcodes. Use your password to get back in.");
    // The keypad is gone, and with it the way back to it.
    expect(screen.queryByRole("button", { name: "5" })).toBeNull();
    expect(screen.queryByText("Use your passcode instead")).toBeNull();
    type("Password", "orrama-demo");
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith(ME));
    expect(sent("POST /api/auth/login")[0]!.body).toEqual({ email: "ines@example.com", password: "orrama-demo" });
  });

  it("says a wrong password on the lock as a password", async () => {
    serve({ "POST /api/auth/unlock/options": { passcode: true, webauthn: false }, "POST /api/auth/login": json(401, { error: "invalid email or password" }) });
    render(<Lock onUnlock={vi.fn()} onUsePassword={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use your password instead" }));
    type("Password", "nope");
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That password isn't right. Try again.");
  });

  it("with nothing to unlock with, hands over to the sign-in", async () => {
    serve({ "POST /api/auth/unlock/options": { passcode: false, webauthn: false } });
    const onUsePassword = vi.fn();
    render(<Lock onUnlock={vi.fn()} onUsePassword={onUsePassword} />);
    await waitFor(() => expect(onUsePassword).toHaveBeenCalled());
  });

  it("offers Touch ID only when this device has it, and a dismissed prompt says nothing", async () => {
    serve({ "POST /api/auth/unlock/options": { passcode: false, webauthn: true }, "POST /api/auth/webauthn/login/options": { challengeId: "c", options: { challenge: "AAAA" } } });
    vi.stubGlobal("PublicKeyCredential", { isUserVerifyingPlatformAuthenticatorAvailable: async () => true });
    vi.stubGlobal("navigator", { ...navigator, credentials: { get: async () => Promise.reject(new DOMException("not allowed", "NotAllowedError")) } });
    render(<Lock onUnlock={vi.fn()} onUsePassword={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock with Touch ID" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Unlock with Touch ID" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("first run", () => {
  const found = {
    "GET /api/vault/tree": [
      { id: "n-1", path: "a.md", folder: "", title: "a", hash: "h", mtimeMs: 0, tags: [], openTasks: 0, category: "work" },
      { id: "n-2", path: "b.md", folder: "", title: "b", hash: "h", mtimeMs: 0, tags: [], openTasks: 0, category: "school" },
      { id: "n-3", path: "c.md", folder: "", title: "c", hash: "h", mtimeMs: 0, tags: [], openTasks: 0, category: "work" },
    ],
    "GET /api/projects": [{ slug: "p", key: "project/p", name: "P", domain: null, noteId: "n-1", total: 0, done: 0, status: null, start: null, deadline: null, nextDue: null, overdue: 0 }],
    "GET /api/contacts": [{ id: "n-2" }],
    "GET /api/companies": [],
    "GET /api/vault/graph": { nodes: [], edges: [{ from: "n-1", to: "n-2" }, { from: "n-2", to: "n-3", implied: true }] },
  };

  it("asks for all three, and a password of eight", async () => {
    serve({});
    render(<Setup onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Fill in all three, so Orrama can sign you in next time.");
    // The name too: it's what Orr calls you.
    type("Email", "ines@example.com");
    type("Password", "long-enough");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Fill in all three, so Orrama can sign you in next time.");
    type("Your name", "Ines");
    type("Password", "short");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Make the password at least 8 characters.");
    expect(sent("POST /api/auth/register")).toHaveLength(0);
  });

  it("refuses an email that gives no username before the server does", async () => {
    serve({});
    render(<Setup onDone={vi.fn()} />);
    type("Your name", "Ines");
    type("Email", "i@example.com");
    type("Password", "long-enough");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Use an email with at least two letters or digits before the @.");
    expect(sent("POST /api/auth/register")).toHaveLength(0);
  });

  it("makes the account, says what it found, and opens the Orrery or Today", async () => {
    serve({ "POST /api/auth/register": IN, ...found });
    const onDone = vi.fn();
    window.history.replaceState(null, "", "/today");
    render(<Setup onDone={onDone} />);
    type("Your name", "Ines");
    type("Email", "Ines.V@example.com");
    type("Password", "long-enough");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByText("I found 3 notes.")).textContent).toBeTruthy();
    expect(screen.getByText("1 person, 1 project and 1 link between them.")).toBeTruthy();
    expect(sent("POST /api/auth/register")[0]!.body).toEqual({ email: "Ines.V@example.com", username: "ines.v", displayName: "Ines", password: "long-enough" });
    expect(localStorage.getItem("orrama-token")).toBe("t-1");
    act(() => fireEvent.click(screen.getByRole("button", { name: "Show me how they relate" })));
    expect(window.location.pathname).toBe("/orrery");
    expect(onDone).toHaveBeenCalledWith(ME);
  });

  it("on a server someone set up meanwhile, says so", async () => {
    serve({ "POST /api/auth/register": json(403, { error: "an invite is required to join this workspace" }) });
    render(<Setup onDone={vi.fn()} />);
    type("Your name", "Ines");
    type("Email", "ines@example.com");
    type("Password", "long-enough");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Orrama is already set up on this server. Reload to sign in.");
  });
});
