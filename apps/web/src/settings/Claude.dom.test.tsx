/**
 * Settings → Connections → Claude (2M): Connect to Claude, then what the Claude app and Claude
 * Code need, each in words; a broken Claude settings file says what is wrong and the
 * connection still stands; a server that isn't the desktop app says so and offers the token
 * way. Disconnect asking first is in Settings.dom.test.tsx (WEB-017).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeConnection } from "@orrama/schema/responses";

const server = vi.hoisted(() => ({ state: null as unknown as ClaudeConnection, after: null as unknown as ClaudeConnection, sent: [] as string[], refuse: null as string | null }));
vi.mock("../api.js", async (orig) => {
  const real = await orig<typeof import("../api.js")>();
  return {
    ...real,
    api: async (method: string, url: string) => {
      if (method === "GET" && url === "/api/claude") return server.state;
      if (method === "POST" && url === "/api/claude/connect") {
        server.sent.push(`${method} ${url}`);
        if (server.refuse) throw new real.ApiError(409, server.refuse);
        return server.after;
      }
      throw new Error(`${method} ${url}`);
    },
  };
});
const { ClaudePart } = await import("./Claude.js");

const COMMAND = "claude mcp add orrama --scope user --env ORRAMA_CONNECTION='/d/claude/connection.json' -- '/A/node' '/A/mcp.mjs'";
const OFF: ClaudeConnection = { available: true, why: null, connected: null, otherAccount: false, desktop: "missing", desktopProblem: null, command: null };
const ON: ClaudeConnection = { ...OFF, connected: { since: Date.UTC(2026, 10, 18, 12), lastUsedAt: null }, desktop: "added", command: COMMAND };

beforeEach(() => {
  server.sent = [];
  server.refuse = null;
});
afterEach(cleanup);

describe("Connect to Claude", () => {
  it("connects in one click, then says what the Claude app and Claude Code need", async () => {
    server.state = OFF;
    server.after = ON;
    render(<ClaudePart ask={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect to Claude" }));
    await screen.findByText("Connected");
    expect(server.sent).toEqual(["POST /api/claude/connect"]);
    expect(screen.getByText(/Quit and reopen Claude to see Orrama there/)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "The Claude Code command" }) as HTMLInputElement).value).toBe(COMMAND);
    expect(screen.getByText(/not used yet/)).toBeTruthy();
  });

  it("offers to add Orrama to the Claude app when it isn't there, and says a broken settings file in words", async () => {
    server.state = { ...ON, desktop: "missing" };
    server.after = ON;
    render(<ClaudePart ask={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    await screen.findByText(/Quit and reopen Claude/);
    cleanup();
    server.state = { ...ON, desktop: "broken", desktopProblem: "Claude's settings file has a mistake in it (line 3), so Orrama left it alone." };
    render(<ClaudePart ask={() => {}} />);
    expect(await screen.findByText(/mistake in it \(line 3\)/)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "The Claude Code command" })).toBeTruthy();
  });

  it("without the Claude app it says so, and Claude Code still works", async () => {
    server.state = { ...ON, desktop: "absent" };
    render(<ClaudePart ask={() => {}} />);
    expect(await screen.findByText(/not on this computer/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "The Claude Code command" })).toBeTruthy();
  });

  it("a refusal is said in the server's words, and nothing looks connected", async () => {
    server.state = OFF;
    server.refuse = "Move Orrama to your Applications folder and open it from there, then connect.";
    render(<ClaudePart ask={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect to Claude" }));
    await waitFor(() => expect(screen.getByText(/Move Orrama to your Applications folder/)).toBeTruthy());
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("on a server that isn't the desktop app: why, and the token way, with no Connect button", async () => {
    server.state = { ...OFF, available: false, why: "Connect to Claude works in the Orrama app on your computer.", desktop: "absent" };
    render(<ClaudePart ask={() => {}} />);
    expect(await screen.findByText(/works in the Orrama app on your computer/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect to Claude" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Another way?" }));
    expect(screen.getByText(/claude mcp add orrama --scope user --env ORRAMA_URL=/)).toBeTruthy();
  });
});
