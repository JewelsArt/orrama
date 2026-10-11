/**
 * The name dialog (§8 #12): what window.prompt and alert did for New note, in the Dialog. A
 * refusal is said under the field and the name stays there to fix.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NameDialog } from "./NameDialog.js";

const open = (onSubmit: (name: string) => Promise<void> | void, onClose = vi.fn()) => {
  render(<NameDialog title="New note" label="Path" help="A folder and a name" onSubmit={onSubmit} onClose={onClose} />);
  return onClose;
};

describe("NameDialog", () => {
  it("is a labelled dialog with the field focused, and makes nothing from an empty name", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    open(onSubmit);
    expect(screen.getByRole("dialog", { name: "New note" })).toBeTruthy();
    const field = screen.getByRole("textbox", { name: "Path" });
    expect(document.activeElement).toBe(field);
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("   {Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter makes it from the trimmed name, then closes", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClose = open(onSubmit);
    await user.keyboard("  Ideas/Reading list {Enter}");
    expect(onSubmit).toHaveBeenCalledWith("Ideas/Reading list");
    expect(onClose).toHaveBeenCalled();
  });

  it("a refusal is said under the field; the dialog and the name stay", async () => {
    const user = userEvent.setup();
    const onClose = open(async () => {
      throw new Error("A note already has that path.");
    });
    await user.keyboard("Ideas{Enter}");
    expect(screen.getByRole("alert").textContent).toBe("A note already has that path.");
    const field = screen.getByRole("textbox", { name: "Path" });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect((field as HTMLInputElement).value).toBe("Ideas");
    expect(onClose).not.toHaveBeenCalled();
    await user.type(field, "/x");
    expect(screen.queryByRole("alert")).toBeNull(); // typing clears it
  });

  it("Escape and Cancel close it", async () => {
    const user = userEvent.setup();
    const onClose = open(vi.fn());
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
