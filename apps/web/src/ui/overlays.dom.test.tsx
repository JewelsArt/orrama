/**
 * The overlay stack (structure.md §1.4, WEB-018): palette over dialog over sheet over panel;
 * one of a kind at a time; Escape closes the top one only; modal layers hold focus and give it
 * back.
 */
import fs from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { anyLayerOpen, Dialog, Layer, Menu, Palette, Sheet, topLayer, toast, Toaster } from "./overlays.js";

describe("the stack", () => {
  it("puts a palette over a dialog over a sheet, and Escape closes from the top", async () => {
    const user = userEvent.setup();
    const closed: string[] = [];
    function Page() {
      const [open, setOpen] = useState({ sheet: true, dialog: true, palette: true });
      const shut = (k: keyof typeof open) => () => {
        closed.push(k);
        setOpen((o) => ({ ...o, [k]: false }));
      };
      return (
        <>
          {open.sheet && <Sheet title="Task" onClose={shut("sheet")}>sheet body</Sheet>}
          {open.dialog && <Dialog title="Delete?" onClose={shut("dialog")} />}
          {open.palette && (
            <Palette label="Find" onClose={shut("palette")}>
              <input aria-label="Find" />
            </Palette>
          )}
        </>
      );
    }
    render(<Page />);
    expect(topLayer()?.kind).toBe("palette");
    await user.keyboard("{Escape}");
    expect(closed).toEqual(["palette"]);
    expect(topLayer()?.kind).toBe("dialog");
    await user.keyboard("{Escape}");
    await user.keyboard("{Escape}");
    expect(closed).toEqual(["palette", "dialog", "sheet"]);
    expect(topLayer()).toBeUndefined();
  });

  it("is ranked by kind, not by which opened last", () => {
    const { rerender } = render(<Dialog title="A" onClose={() => {}} />);
    rerender(
      <>
        <Dialog title="A" onClose={() => {}} />
        <Sheet title="B" onClose={() => {}} />
      </>,
    );
    expect(topLayer()?.kind).toBe("dialog");
  });

  it("lets one of a kind open at a time: a new sheet replaces the open one", () => {
    const closedA = vi.fn();
    const { rerender } = render(<Sheet title="A" onClose={closedA} />);
    rerender(
      <>
        <Sheet title="A" onClose={closedA} />
        <Sheet title="B" onClose={() => {}} />
      </>,
    );
    expect(closedA).toHaveBeenCalledTimes(1);
  });

  it("draws the kinds in the order Escape closes them", () => {
    const css = fs.readFileSync(path.join(import.meta.dirname, "ui.css"), "utf8");
    const z = (kind: string) => Number(new RegExp(`\\.ui-layer\\[data-kind="${kind}"\\]\\s*\\{[^}]*z-index:\\s*(\\d+)`).exec(css)?.[1]);
    const order = ["panel", "sheet", "dialog", "palette", "popover"];
    const drawn = order.map(z);
    expect(drawn.every(Number.isFinite)).toBe(true);
    expect([...drawn].sort((a, b) => a - b)).toEqual(drawn);
    expect(new Set(drawn).size).toBe(order.length);
  });

  it("stops Escape from reaching the page underneath", async () => {
    const user = userEvent.setup();
    const page = vi.fn();
    window.addEventListener("keydown", page);
    const onClose = vi.fn();
    render(<Dialog title="Rename" onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();
    window.removeEventListener("keydown", page);
  });
});

describe("a modal layer", () => {
  it("is a labelled modal dialog that takes focus, keeps Tab inside and gives focus back", async () => {
    const user = userEvent.setup();
    function Page() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Delete project</button>
          {open && (
            <Dialog
              title="Delete Atlas?"
              onClose={() => setOpen(false)}
              actions={
                <>
                  <button onClick={() => setOpen(false)}>Keep it</button>
                  <button onClick={() => setOpen(false)}>Delete</button>
                </>
              }
            />
          )}
        </>
      );
    }
    render(<Page />);
    const opener = screen.getByRole("button", { name: "Delete project" });
    await user.click(opener);
    const dlg = screen.getByRole("dialog", { name: "Delete Atlas?" });
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep it" }));
    await user.tab();
    await user.tab(); // past the last control: back to the first, never out to the page
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep it" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on a click on the scrim", async () => {
    const onClose = vi.fn();
    render(<Sheet title="Task" onClose={onClose} />);
    fireEvent.click(document.querySelector(".ui-scrim")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("can wrap an overlay that draws its own box, giving it the stack's Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Layer kind="dialog" label="Settings" role={null} onClose={onClose}>
        <div role="dialog" aria-label="Settings">
          <input aria-label="Name" />
        </div>
      </Layer>,
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1); // no dialog inside a dialog
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("a panel", () => {
  it("sits beside the page: it does not stand the shell's keys down, and Escape is its own only from inside it", () => {
    const onClose = vi.fn();
    render(
      <>
        <button>On the page</button>
        <Layer kind="panel" label="Ask Orr" role={null} modal={false} focus={false} onClose={onClose}>
          <aside>
            <input aria-label="Ask" />
          </aside>
        </Layer>
      </>,
    );
    expect(topLayer()?.kind).toBe("panel");
    expect(anyLayerOpen()).toBe(false);
    const page = screen.getByRole("button", { name: "On the page" });
    page.focus();
    fireEvent.keyDown(page, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    const ask = screen.getByRole("textbox", { name: "Ask" });
    ask.focus();
    fireEvent.keyDown(ask, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("goes under a dialog, which still stands the keys down", () => {
    render(
      <>
        <Layer kind="panel" label="Ask Orr" role={null} modal={false} onClose={() => {}}>
          <aside />
        </Layer>
        <Dialog title="Delete?" onClose={() => {}} />
      </>,
    );
    expect(topLayer()?.kind).toBe("dialog");
    expect(anyLayerOpen()).toBe(true);
  });
});

describe("Menu", () => {
  it("moves with the arrow keys, picks with Enter, and closes", async () => {
    const user = userEvent.setup();
    const picked: string[] = [];
    function Page() {
      const [open, setOpen] = useState(false);
      const at = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={at} onClick={() => setOpen(true)}>
            Status
          </button>
          {open && (
            <Menu
              anchor={at}
              label="Status"
              onClose={() => setOpen(false)}
              items={["on track", "at risk", "paused"].map((s) => ({ label: s, onSelect: () => picked.push(s) }))}
            />
          )}
        </>
      );
    }
    render(<Page />);
    await user.click(screen.getByRole("button", { name: "Status" }));
    expect(document.activeElement?.textContent).toBe("on track");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(picked).toEqual(["paused"]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Status" }));
  });
});

describe("toast", () => {
  it("says it politely, offers its action, and goes away on its own", () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    render(<Toaster />);
    act(() => void toast("Moved to Friday", { action: { label: "Undo", run: undo }, ms: 3000 }));
    expect(screen.getByRole("status").textContent).toContain("Moved to Friday");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalled();
    act(() => void toast("Saved", { ms: 3000 }));
    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.getByRole("status").textContent).toBe("");
    vi.useRealTimers();
  });
});
