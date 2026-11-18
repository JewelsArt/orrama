/**
 * Settings' foot says how many notes the server reads, and says it again when the notes change
 * (2L, from Z-wave1's small list: it was read once, so it went on saying the count the page
 * opened with after a note was made or the example removed).
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "./api.js";

type Msg = { type: "note-changed"; noteId: string; path: string; authorId: string | null } | { type: "presence" };
const ws = { listeners: new Set<(m: Msg) => void>() };
vi.mock("./ws.js", () => ({
  onWs: (l: (m: Msg) => void) => (ws.listeners.add(l), () => ws.listeners.delete(l)),
  sendEditing: () => {},
}));
const { Settings } = await import("./Settings.js");

const ME = { id: "u-1", email: "jules@orrama.dev", username: "jules", displayName: "Jules", avatar: "victorr", isOwner: true, teams: [], appearance: null } as unknown as Me;
let notes = 12;
let asked = 0;

beforeEach(() => {
  notes = 12;
  asked = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("fetch", async (url: string) => {
    const path = url.split("?")[0];
    if (path === "/api/settings/server") asked++;
    const body =
      path === "/api/settings/server"
        ? { notesFolder: "~/Orrama", notes, version: "0.1.0", fixed: false, own: false, example: 0 }
        : path === "/api/health"
          ? { ok: true, notes, build: null, source: null, launch: null }
          : path === "/api/members"
            ? []
            : {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  ws.listeners.clear();
});

const open = () =>
  render(<Settings me={ME} section="appearance" theme="light" shown="light" onTheme={() => {}} look="paper" onLook={() => {}} vision="none" onVision={() => {}} profiles={[]} onProfiles={() => {}} onUpdate={() => {}} onSignOut={() => {}} />);
const settle = () => act(async () => {});

describe("Settings' foot", () => {
  it("is asked again a second after the notes change, once for a burst", async () => {
    open();
    await settle();
    expect(screen.getByText(/reading 12 notes in ~\/Orrama/)).toBeTruthy();
    notes = 13;
    for (let i = 0; i < 3; i++) act(() => ws.listeners.forEach((l) => l({ type: "note-changed", noteId: `n${i}`, path: `New ${i}.md`, authorId: "u-1" })));
    // Presence pings are not a change.
    act(() => ws.listeners.forEach((l) => l({ type: "presence" })));
    expect(asked).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await settle();
    expect(asked).toBe(2);
    expect(screen.getByText(/reading 13 notes in ~\/Orrama/)).toBeTruthy();
  });

  it("stops listening when the page goes", async () => {
    const view = open();
    await settle();
    view.unmount();
    expect(ws.listeners.size).toBe(0);
  });
});
