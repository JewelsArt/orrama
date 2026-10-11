/**
 * The colour profile editor opens over Settings → Appearance. It is a sheet in the overlay stack
 * (WEB-018): Escape closes it, and what it asks (Delete's confirm, a dialog) goes over it
 * instead of replacing it. It used to listen on the window, under the stack.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PALETTE_SLOTS } from "./palette.js";
import { VisionEditor } from "./VisionEditor.js";

describe("the colour profile editor", () => {
  it("is a labelled sheet in the stack, and closes on Escape", async () => {
    const user = userEvent.setup();
    const closeEditor = vi.fn();
    render(
        <VisionEditor
          profile={{ id: "p1", name: "Mine", colors: PALETTE_SLOTS.map(() => "#336699") }}
          surface="#ffffff"
          mode="light"
          pinned={{ ok: "#2e7d32", warn: "#b26a00", danger: "#c62828" }}
          heroFallback="#6f49ca"
          onSave={() => {}}
          onDelete={null}
          onClose={closeEditor}
        />,
    );
    const box = screen.getByRole("dialog", { name: "Edit colour profile" });
    expect(box.closest(".ui-layer")?.getAttribute("data-kind")).toBe("sheet");
    await user.keyboard("{Escape}");
    expect(closeEditor).toHaveBeenCalledTimes(1);
  });
});
