/** The socket follows who is signed in, not the user object (WEB-015). */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLiveSync } from "./ws.js";

class FakeSocket {
  static opened = 0;
  closed = false;
  onopen = null;
  onmessage = null;
  onclose = null;
  constructor() {
    FakeSocket.opened++;
  }
  send() {}
  close() {
    this.closed = true;
  }
}

afterEach(() => {
  cleanup(); // before the stubs go: a late socket from the page must not reach happy-dom's real one
  vi.unstubAllGlobals();
});

describe("useLiveSync", () => {
  it("keeps one socket while the same person is signed in, whatever their profile does", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    FakeSocket.opened = 0;
    const me = { id: "u-1", displayName: "Jules" };
    const { rerender, unmount } = renderHook(({ user }) => useLiveSync(user?.id), { initialProps: { user: me as typeof me | null } });
    expect(FakeSocket.opened).toBe(1);
    rerender({ user: { ...me, displayName: "Jules T." } }); // saved a new display name
    expect(FakeSocket.opened).toBe(1);
    rerender({ user: { id: "u-2", displayName: "Erin" } }); // someone else signed in
    expect(FakeSocket.opened).toBe(2);
    rerender({ user: null }); // signed out
    unmount();
    expect(FakeSocket.opened).toBe(2);
  });
});
