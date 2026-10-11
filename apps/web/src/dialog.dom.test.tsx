/**
 * The Dialog's focus rules, in a real DOM: focus moves in on open, Tab wraps inside, and focus
 * goes back to the opener on close. The pure wrap rule is in dialog.test.ts; this is the
 * component that applies it.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Dialog } from "./dialog.js";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <Dialog label="Rename">
          <input aria-label="Name" />
          <button onClick={() => setOpen(false)}>Cancel</button>
          <button>Save</button>
        </Dialog>
      )}
    </>
  );
}

describe("Dialog", () => {
  it("takes focus, keeps Tab inside, and gives focus back on close", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);

    expect(screen.getByRole("dialog", { name: "Rename" }).getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));

    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
    await user.tab(); // past the last control: around to the first, not out to the page
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
