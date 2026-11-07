/**
 * Back up now and Restore (2F) against a stubbed server: Settings → Notes says no terminal
 * any more and says where the backup went; the restore reads the file, asks before a folder
 * with files in it, says the one thing that doesn't come back on another computer, and lands
 * on Today once the server is back; first run's "I have a backup" makes no account.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Setup } from "../Setup.js";
import { BackupSection, sizeWords } from "../settings/BackupSection.js";
import { OTHER_COMPUTER, RestoreBackup } from "./RestoreBackup.js";

type Reply = unknown | ((body: unknown) => Response);
let calls: { key: string; body: unknown }[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function serve(routes: Record<string, Reply>) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const key = `${init.method ?? "GET"} ${url.split("?")[0]}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ key, body });
    if (!(key in routes)) return json(404, { error: "not found" });
    const r = routes[key];
    return typeof r === "function" ? (r as (b: unknown) => Response)(body) : json(200, r);
  });
}
const sent = (key: string) => calls.filter((c) => c.key === key);

const LOOK = {
  createdAt: "2026-11-07T14:29:00.000Z",
  version: "0.1.0",
  notes: 1240,
  files: 1302,
  account: { name: "Ines", email: "ines@example.com" },
  keyOpens: true,
  folder: "~/Orrama",
  folderFiles: 0,
};
const MADE = { name: "Orrama backup 2026-11-07.zip", bytes: 13_002_342, notes: 1240, files: 1302, ms: 900 };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.__ORRAMA_DESKTOP__;
  delete window.__TAURI_INTERNALS__;
});

describe("Settings → Notes → Back up", () => {
  it("in a browser: Back up now makes it, downloads it, and says its size; no terminal lesson", async () => {
    const user = userEvent.setup();
    serve({ "POST /api/backup": { ...MADE, folder: null, download: "/api/backup/download/Orrama%20backup%202026-11-07.zip" } });
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.getAttribute("href")!);
    });
    const { container } = render(<BackupSection />);
    expect(container.textContent).not.toMatch(/Terminal|pnpm|export/i);
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("Orrama backup 2026-11-07.zip")).toBeTruthy();
    expect(container.textContent).toContain("12.4 MB, in your downloads");
    expect(sent("POST /api/backup").map((c) => c.body)).toEqual([{ folder: null }]);
    expect(clicked).toEqual(["/api/backup/download/Orrama%20backup%202026-11-07.zip"]);
  });

  it("in the app: the folder chooser says where, and the page says it went there", async () => {
    const user = userEvent.setup();
    window.__ORRAMA_DESKTOP__ = { shell: 1 };
    const invoke = vi.fn(async () => "/Users/ines/Backups");
    window.__TAURI_INTERNALS__ = { invoke };
    serve({ "POST /api/backup": { ...MADE, folder: "~/Backups", download: null } });
    const { container } = render(<BackupSection />);
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    await screen.findByText("Orrama backup 2026-11-07.zip");
    expect(container.textContent).toContain("12.4 MB, in ~/Backups");
    expect(sent("POST /api/backup").map((c) => c.body)).toEqual([{ folder: "/Users/ines/Backups" }]);
    expect(invoke).toHaveBeenCalledWith("plugin:dialog|open", expect.objectContaining({ options: expect.objectContaining({ directory: true }) }));
  });

  it("in the app: cancelling the chooser makes nothing", async () => {
    const user = userEvent.setup();
    window.__ORRAMA_DESKTOP__ = { shell: 1 };
    window.__TAURI_INTERNALS__ = { invoke: async () => null };
    serve({});
    render(<BackupSection />);
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent("POST /api/backup")).toEqual([]);
  });

  it("says why when it fails, in words", async () => {
    const user = userEvent.setup();
    serve({ "POST /api/backup": () => json(400, { error: "There is no folder there." }) });
    render(<BackupSection />);
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    expect(await screen.findByText(/The backup wasn't made\. There is no folder there\./)).toBeTruthy();
  });

  it("offers no restore where the notes folder is set where Orrama starts", () => {
    serve({});
    render(<BackupSection restoreHere={false} />);
    expect(screen.getByRole("button", { name: "Back up now" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore from a backup…" })).toBeNull();
  });

  it("sizes read the way a person reads them", () => {
    expect(sizeWords(820 * 1024)).toBe("820 KB");
    expect(sizeWords(13_002_342)).toBe("12.4 MB");
    expect(sizeWords(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});

const zip = () => new File([new Uint8Array([0x50, 0x4b, 3, 4])], "Orrama backup 2026-11-07.zip", { type: "application/zip" });
const choose = async () => fireEvent.change(screen.getByLabelText("The backup file"), { target: { files: [zip()] } });

describe("Restore a backup", () => {
  it("reads the file, then restores into Orrama's own folder and opens Today once the server is back", async () => {
    const user = userEvent.setup();
    let back = false;
    serve({
      "POST /api/backup/restore/look": LOOK,
      "POST /api/backup/restore": () => ((back = true), json(200, { folder: "~/Orrama", dropped: [], restart: true })),
      "GET /api/me": () => (back ? json(200, { id: "u-1" }) : json(503, {})),
    });
    const done = vi.fn();
    render(<RestoreBackup place="first" onDone={done} />);
    const restore = screen.getByRole("button", { name: "Restore" }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    await choose();
    expect(await screen.findByText("Ines's account and 1,240 notes, made 7 Nov 2026.")).toBeTruthy();
    expect(sent("POST /api/backup/restore/look")[0]!.body).toBeInstanceOf(File);
    expect(screen.getByLabelText("The notes go in")).toHaveProperty("value", "~/Orrama");
    expect(screen.queryByText(OTHER_COMPUTER)).toBeNull();
    await waitFor(() => expect(restore.disabled).toBe(false));
    await user.click(restore);
    await waitFor(() => expect(done).toHaveBeenCalled(), { timeout: 3000 });
    // Opened only once the restarted server answered as the restored account.
    expect(sent("GET /api/me").length).toBeGreaterThan(0);
    expect(sent("POST /api/backup/restore").map((c) => c.body)).toEqual([{ folder: "~/Orrama", replace: false }]);
  });

  it("asks before a folder with files in it, and sends the yes", async () => {
    const user = userEvent.setup();
    serve({
      "POST /api/backup/restore/look": { ...LOOK, folderFiles: 3 },
      "POST /api/backup/restore": { folder: "~/Orrama", dropped: [], restart: true },
      "GET /api/me": { id: "u-1" },
    });
    render(<RestoreBackup place="first" onDone={() => {}} />);
    await choose();
    const yes = await screen.findByRole("checkbox", { name: /Put the notes in this folder anyway/ });
    expect(yes.textContent).toContain("It already has 3 files in it.");
    const restore = screen.getByRole("button", { name: "Restore" }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    await user.click(yes);
    expect(restore.disabled).toBe(false);
    await user.click(restore);
    await waitFor(() => expect(sent("POST /api/backup/restore").map((c) => c.body)).toEqual([{ folder: "~/Orrama", replace: true }]));
  });

  it("says in one sentence what doesn't come back on another computer", async () => {
    serve({ "POST /api/backup/restore/look": { ...LOOK, keyOpens: false } });
    render(<RestoreBackup place="first" onDone={() => {}} />);
    await choose();
    expect(await screen.findByText(OTHER_COMPUTER)).toBeTruthy();
  });

  it("says the server's reason when the file is not a backup", async () => {
    serve({ "POST /api/backup/restore/look": () => json(400, { error: "That .zip isn't an Orrama backup. Pick a file made with Back up now." }) });
    render(<RestoreBackup place="first" onDone={() => {}} />);
    await choose();
    expect((await screen.findByRole("alert")).textContent).toBe("That .zip isn't an Orrama backup. Pick a file made with Back up now.");
  });

  it("in Settings, says first that it replaces what Orrama holds now", () => {
    serve({});
    const { container } = render(<RestoreBackup place="settings" onDone={() => {}} onCancel={() => {}} />);
    expect(container.textContent).toMatch(/replaces everything Orrama holds now/);
  });
});

describe("first run: I have a backup", () => {
  it("restores instead of making an account", async () => {
    const user = userEvent.setup();
    serve({});
    render(<Setup onDone={() => {}} />);
    await user.click(screen.getByRole("button", { name: "I have a backup" }));
    const card = screen.getByRole("heading", { name: "Restore a backup" }).closest(".dr-card") as HTMLElement;
    expect(within(card).getByRole("button", { name: "Choose the backup…" })).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Welcome to Orrama" })).toBeTruthy();
    expect(sent("POST /api/auth/register")).toEqual([]);
  });
});
