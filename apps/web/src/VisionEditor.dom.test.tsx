/**
 * The colour profile editor opens inside Settings. In the overlay stack (WEB-018) Escape closes
 * it and leaves Settings open; it used to listen on the window, under the stack.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PALETTE_SLOTS } from "./palette.js";
import { Layer } from "./ui/overlays.js";
import { VisionEditor } from "./VisionEditor.js";

describe("the colour profile editor", () => {
  it("closes on Escape, and Settings around it stays open", async () => {
    const user = userEvent.setup();
    const closeEditor = vi.fn();
    const closeSettings = vi.fn();
    render(
      <Layer kind="sheet" label="Settings" role={null} trap={false} onClose={closeSettings}>
        <VisionEditor
          profile={{ id: "p1", name: "Mine", colors: PALETTE_SLOTS.map(() => "#336699") }}
          surface="#ffffff"
          mode="light"
          pinned={{ ok: "#2e7d32", warn: "#b26a00", danger: "#c62828" }}
          heroFallback="#6f49ca"
          onSave={() => {}}
          onDelete={null}
          onClose={closeEditor}
        />
      </Layer>,
    );
    expect(screen.getByRole("dialog", { name: "Edit colour profile" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(closeEditor).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();
  });
});
