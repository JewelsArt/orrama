/**
 * A failed write is never silent (WEB-010): the one shared way the app says a change didn't
 * land. `attempt` for one-click writes says it in a toast with Retry when that could help;
 * `useWrite` for forms gives the sentence and always ends busy; the net says any failed write
 * nobody caught. `api()` remembers which errors came from a write so the net can tell.
 */
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, isFailedWrite } from "../api.js";
import { Toaster } from "./overlays.js";
import { attempt, failureText, installWriteNet, useWrite, worthRetrying } from "./writes.js";

const toasts = () => [...document.querySelectorAll(".toast")].map((t) => t.querySelector("span")?.textContent ?? "");
const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  render(<Toaster />);
});
afterEach(() => {
  for (const b of screen.queryAllByRole("button", { name: "Dismiss" })) fireEvent.click(b);
  vi.unstubAllGlobals();
});

describe("failureText: what didn't happen, then why, in words", () => {
  it("the server didn't answer", () => {
    expect(failureText(new TypeError("Failed to fetch"), "The step wasn't ticked.")).toBe("The step wasn't ticked. The server didn't answer. Check it's running, then try again.");
  });
  it("the server broke: no exception text, just what to do", () => {
    expect(failureText(new ApiError(500, "Internal Server Error"), "The step wasn't ticked.")).toBe("The step wasn't ticked. Try again in a moment.");
  });
  it("the server refused, and said why: its reason as a sentence", () => {
    expect(failureText(new ApiError(409, "that task is not in the note as it is now — reload and try again"), "The step wasn't ticked.")).toBe(
      "The step wasn't ticked. That task is not in the note as it is now — reload and try again.",
    );
  });
  it("no edit access is said plainly", () => {
    expect(failureText(new ApiError(403, "no edit access to this note"), "The goals weren't saved.")).toBe("The goals weren't saved. You can read this but not change it.");
  });
  it("Retry is offered when trying again could help, not for a refusal", () => {
    expect(worthRetrying(new TypeError("Failed to fetch"))).toBe(true);
    expect(worthRetrying(new ApiError(503, "x"))).toBe(true);
    expect(worthRetrying(new ApiError(409, "x"))).toBe(false);
    expect(worthRetrying(new ApiError(400, "x"))).toBe(false);
  });
});

describe("attempt: a one-click write", () => {
  it("landed: true and nothing said", async () => {
    let ok: boolean | undefined;
    await act(async () => {
      ok = await attempt("The step wasn't ticked.", async () => {});
    });
    expect(ok).toBe(true);
    expect(toasts()).toEqual([]);
  });

  it("didn't land: false, a toast says what and why, and Retry runs the write again", async () => {
    const run = vi.fn().mockRejectedValueOnce(new ApiError(500, "")).mockResolvedValueOnce(undefined);
    let ok: boolean | undefined;
    await act(async () => {
      ok = await attempt("The step wasn't ticked.", run);
    });
    expect(ok).toBe(false);
    expect(toasts()).toEqual(["The step wasn't ticked. Try again in a moment."]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(toasts()).toEqual([]);
  });

  it("a refusal is said without Retry", async () => {
    await act(async () => {
      await attempt("The step wasn't ticked.", () => Promise.reject(new ApiError(409, "that task is not in the note as it is now")));
    });
    expect(toasts()).toEqual(["The step wasn't ticked. That task is not in the note as it is now."]);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("a cancelled request is not a failure", async () => {
    let ok: boolean | undefined;
    await act(async () => {
      ok = await attempt("The step wasn't ticked.", () => Promise.reject(new DOMException("superseded", "AbortError")));
    });
    expect(ok).toBe(false);
    expect(toasts()).toEqual([]);
  });
});

describe("useWrite: a form", () => {
  it("busy while it runs, the sentence when it fails, and busy always ends", async () => {
    const { result } = renderHook(() => useWrite());
    let finish!: (e: unknown) => void;
    let done!: Promise<boolean>;
    act(() => {
      done = result.current.run("The goals weren't saved.", () => new Promise((_, reject) => (finish = reject)));
    });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      finish(new TypeError("Failed to fetch"));
      expect(await done).toBe(false);
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe("The goals weren't saved. The server didn't answer. Check it's running, then try again.");
    await act(async () => {
      expect(await result.current.run("The goals weren't saved.", async () => {})).toBe(true);
    });
    expect(result.current.error).toBeNull();
  });
});

describe("the net: a failed write nobody caught", () => {
  const reject = (reason: unknown) => {
    const ev = Object.assign(new Event("unhandledrejection", { cancelable: true }), { reason, promise: Promise.resolve() });
    act(() => {
      window.dispatchEvent(ev);
    });
    return ev;
  };

  it("api() marks an error from a write, never from a read or a cancel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(500, { error: "internal error" })));
    const write = await api("POST", "/api/tasks/check", {}).catch((e: unknown) => e);
    const read = await api("GET", "/api/tasks").catch((e: unknown) => e);
    expect(isFailedWrite(write)).toBe(true);
    expect(isFailedWrite(read)).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(isFailedWrite(await api("DELETE", "/api/x").catch((e: unknown) => e))).toBe(true);
    const ac = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => (ac.abort(), answer(200))));
    expect(isFailedWrite(await api("POST", "/api/x", {}, { signal: ac.signal }).catch((e: unknown) => e))).toBe(false);
  });

  it("is said in a toast; anything else is left to the console", async () => {
    const off = installWriteNet();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => answer(500, { error: "internal error" })));
      const write = await api("PATCH", "/api/projects/thesis", {}).catch((e: unknown) => e);
      const read = await api("GET", "/api/projects").catch((e: unknown) => e);
      expect(reject(read).defaultPrevented).toBe(false);
      expect(toasts()).toEqual([]);
      expect(reject(write).defaultPrevented).toBe(true);
      expect(toasts()).toEqual(["That change didn't save. Try again in a moment."]);
    } finally {
      off();
    }
  });
});
