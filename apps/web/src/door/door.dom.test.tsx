/**
 * The door against a stubbed server: sign-in, lock and first run, their errors in the door's
 * voice, and the two seconds of the gathered vault before the app opens.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Lock } from "../Lock.js";
import { Login } from "../Login.js";
import { Setup } from "../Setup.js";
import { api, SESSION_ENDED, sessionOver } from "../api.js";
import { HOLD_MS } from "./Door.js";

const ME = { id: "u-1", email: "ines@example.com", username: "ines", displayName: "Ines", avatar: null, isOwner: true, teams: [], appearance: null };
/** What every way in answers: the account. The session is a cookie the page never sees (WEB-013). */
const IN = { user: ME };

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

/**
 * Does the app now count itself signed in: does a 401 from an ordinary request end the session?
 * The door has nothing else to keep: the session is the cookie the server set.
 */
async function holdsSession(): Promise<boolean> {
  vi.stubGlobal("fetch", async () => json(401, { error: "this session has ended — sign in again" }));
  let ended = false;
  const on = () => (ended = true);
  window.addEventListener(SESSION_ENDED, on);
  await api("GET", "/api/vault/tree").catch(() => {});
  window.removeEventListener(SESSION_ENDED, on);
  sessionOver();
  return ended;
}

/** Nothing that could sign anyone in is where a script on the page can read it. */
function nothingReadable() {
  expect(Object.keys(localStorage).filter((k) => k !== "orrama-last-email")).toEqual([]);
  expect(Object.keys(sessionStorage)).toEqual([]);
  expect(document.cookie).toBe("");
}

beforeEach(() => {
  motion(true);
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup(); // before the stubs go: a late request from the page must not reach happy-dom's real fetch
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
    expect(localStorage.getItem("orrama-last-email")).toBe("ines@example.com");
    nothingReadable();
    expect(await holdsSession()).toBe(true);
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
    nothingReadable();
    expect(await holdsSession()).toBe(true);
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

  it("unlocks with Touch ID", async () => {
    serve({
      "POST /api/auth/unlock/options": { passcode: false, webauthn: true },
      "POST /api/auth/webauthn/login/options": { challengeId: "c", options: { challenge: "AAAA" } },
      "POST /api/auth/webauthn/login/verify": IN,
    });
    const bytes = () => new Uint8Array([1, 2, 3]).buffer;
    vi.stubGlobal("PublicKeyCredential", { isUserVerifyingPlatformAuthenticatorAvailable: async () => true });
    vi.stubGlobal("navigator", {
      ...navigator,
      credentials: {
        get: async () => ({
          id: "cred-1",
          rawId: bytes(),
          type: "public-key",
          getClientExtensionResults: () => ({}),
          response: { clientDataJSON: bytes(), authenticatorData: bytes(), signature: bytes(), userHandle: null },
        }),
      },
    });
    const onUnlock = vi.fn();
    render(<Lock onUnlock={onUnlock} onUsePassword={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock with Touch ID" }));
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith(ME));
    expect(sent("POST /api/auth/webauthn/login/verify")[0]!.body.response.id).toBe("cred-1");
    nothingReadable();
    expect(await holdsSession()).toBe(true);
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
      // Orrama's own note that says what things are: not counted among the person's notes.
      { id: "n-4", path: "Orrama/What things are.md", folder: "Orrama", title: "What things are", hash: "h", mtimeMs: 0, tags: ["vault-ontology"], openTasks: 0, category: "work" },
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

  /** Orr's AI not set up: the third step offers it, and these tests answer Later. */
  const AI_OFF = { provider: null, model: null, configured: false, instructions: "", baseUrl: "", chatgpt: { connected: false, email: null, manageUsage: "x" } };
  const later = async () => {
    fireEvent.click(await screen.findByRole("radio", { name: /^Later/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  };

  /** The folder read now (Orrama's own, nothing set where it starts) and what a look at another says. */
  const OWN = { notesFolder: "~/Orrama/vault", notes: 0, version: "0.1.0", fixed: false, own: true, example: 0 };
  const LOOK = { folder: "~/Notes", problem: null, notes: 3, more: false, unstamped: 3, ontology: false, current: false };
  const signUp = () => {
    type("Your name", "Ines");
    type("Email", "Ines.V@example.com");
    type("Password", "long-enough");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  };

  it("makes the account, asks where the notes are, reads the folder chosen, and opens the Orrery or Today", async () => {
    // The server reads Orrama's own folder until the choice restarts it on ~/Notes.
    let reading = OWN;
    serve({
      "POST /api/auth/register": IN,
      "GET /api/settings/server": () => json(200, reading),
      "POST /api/settings/notes-folder/look": (b: { folder: string | null }) => json(200, b.folder === null ? { ...LOOK, folder: OWN.notesFolder, notes: 0, unstamped: 0, current: true } : LOOK),
      "PUT /api/settings/notes-folder": () => {
        reading = { ...OWN, notesFolder: "~/Notes", notes: 3, own: false };
        return json(200, { folder: "~/Notes", restart: true });
      },
      "POST /api/settings/start": { ontology: "written", example: 0 },
      "GET /api/admin/ai": AI_OFF,
      ...found,
    });
    const onDone = vi.fn();
    window.history.replaceState(null, "", "/today");
    render(<Setup onDone={onDone} />);
    signUp();
    await screen.findByRole("heading", { name: "Where are your notes?" });
    expect(sent("POST /api/auth/register")[0]!.body).toEqual({ email: "Ines.V@example.com", username: "ines.v", displayName: "Ines", password: "long-enough" });
    fireEvent.click(await screen.findByRole("radio", { name: /Use notes I already have/ }));
    type("Folder", "~/Notes");
    // Before anything is chosen, the page says what is there and what Orrama adds, in words.
    expect(
      await screen.findByText("3 notes. Orrama adds a short id line at the top of each, once, so links keep working when a note is renamed. It also adds one note, What things are, that tells it who is a person, a company or a project."),
    ).toBeTruthy();
    expect(sent("PUT /api/settings/notes-folder")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "How should Orr think?" }, { timeout: 3000 });
    // The notes are counted once Orr's step is answered, not behind it.
    expect(sent("GET /api/vault/tree")).toHaveLength(0);
    await later();
    expect((await screen.findByText("I found 3 notes.", undefined, { timeout: 3000 })).textContent).toBeTruthy();
    expect(sent("POST /api/admin/ai")).toHaveLength(0);
    expect(screen.getByText("1 person, 1 project and 1 link between them.")).toBeTruthy();
    expect(sent("PUT /api/settings/notes-folder").map((c) => c.body)).toEqual([{ folder: "~/Notes" }]);
    expect(sent("POST /api/settings/start").map((c) => c.body)).toEqual([{ example: false }]);
    nothingReadable();
    act(() => fireEvent.click(screen.getByRole("button", { name: "Show me how they relate" })));
    expect(window.location.pathname).toBe("/orrery");
    expect(onDone).toHaveBeenCalledWith(ME);
    expect(await holdsSession()).toBe(true);
  });

  it("starts with the example in Orrama's own folder: no folder change, no restart", async () => {
    serve({ "POST /api/auth/register": IN, "GET /api/settings/server": OWN, "POST /api/settings/notes-folder/look": { ...LOOK, notes: 0, unstamped: 0, current: true }, "POST /api/settings/start": { ontology: "written", example: 4 }, "GET /api/admin/ai": AI_OFF, ...found });
    render(<Setup onDone={vi.fn()} />);
    signUp();
    expect((await screen.findByRole("radio", { name: /Start with an example/ })).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await later();
    expect(await screen.findByText("Your example is ready.")).toBeTruthy();
    expect(sent("PUT /api/settings/notes-folder")).toHaveLength(0);
    expect(sent("POST /api/settings/start").map((c) => c.body)).toEqual([{ example: true }]);
  });

  it("starts empty: no example, and Today is the one way on", async () => {
    serve({ "POST /api/auth/register": IN, "GET /api/settings/server": OWN, "POST /api/settings/notes-folder/look": { ...LOOK, notes: 0, unstamped: 0, current: true }, "POST /api/settings/start": { ontology: "written", example: 0 }, "GET /api/admin/ai": AI_OFF, ...found });
    render(<Setup onDone={vi.fn()} />);
    signUp();
    fireEvent.click(await screen.findByRole("radio", { name: /Start empty/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await later();
    expect(await screen.findByText("Your notes start here.")).toBeTruthy();
    expect(sent("POST /api/settings/start").map((c) => c.body)).toEqual([{ example: false }]);
    expect(screen.queryByRole("button", { name: "Show me how they relate" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start with today" })).toBeTruthy();
  });

  it("a folder that can't be used is said beside the field, and nothing goes on", async () => {
    serve({ "POST /api/auth/register": IN, "GET /api/settings/server": OWN, "POST /api/settings/notes-folder/look": { ...LOOK, problem: "There is no folder there.", notes: 0 } });
    render(<Setup onDone={vi.fn()} />);
    signUp();
    fireEvent.click(await screen.findByRole("radio", { name: /Use notes I already have/ }));
    type("Folder", "~/Nope");
    expect(await screen.findByText("There is no folder there.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a folder set where Orrama starts is shown as fixed: its notes are used as they are", async () => {
    serve({
      "POST /api/auth/register": IN,
      "GET /api/settings/server": { ...OWN, notesFolder: "~/Orrama Vault", notes: 3, fixed: true, own: false },
      "POST /api/settings/notes-folder/look": { ...LOOK, folder: "~/Orrama Vault", ontology: true, current: true },
      "POST /api/settings/start": { ontology: "there", example: 0 },
      "GET /api/admin/ai": AI_OFF,
      ...found,
    });
    render(<Setup onDone={vi.fn()} />);
    signUp();
    expect((await screen.findByText(/That folder is set where Orrama starts/)).textContent).toContain("~/Orrama Vault");
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use these notes" }));
    await later();
    expect(await screen.findByText("I found 3 notes.")).toBeTruthy();
    expect(sent("PUT /api/settings/notes-folder")).toHaveLength(0);
  });

  it("asks again when the founder signs in before choosing (resume): no account form", async () => {
    serve({ "GET /api/settings/server": OWN, "POST /api/settings/notes-folder/look": { ...LOOK, notes: 0, unstamped: 0, current: true } });
    render(<Setup onDone={vi.fn()} resume={ME as never} />);
    expect(await screen.findByRole("heading", { name: "Where are your notes?" })).toBeTruthy();
    expect(screen.queryByLabelText("Your name")).toBeNull();
  });

  it("on a server someone set up meanwhile, says so", async () => {
    serve({ "POST /api/auth/register": json(403, { error: "an invite is required to join this workspace" }) });
    render(<Setup onDone={vi.fn()} />);
    type("Your name", "Ines");
    type("Email", "ines@example.com");
    type("Password", "long-enough");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Orrama is already set up here. Reload to sign in.");
  });
});
