/**
 * Enter does what the focused button says (REG-015). A window-level Enter branch once confirmed
 * whatever the dialog asked: Tab to "Keep it", press Enter, and the project was deleted.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Confirm } from "./Confirm.js";

const ask = (onConfirm: () => void, onClose: () => void) =>
  render(<Confirm request={{ title: "Delete Atlas?", confirmLabel: "Delete", danger: true, onConfirm }} onClose={onClose} />);

describe("Confirm", () => {
  it("Enter on Keep it keeps it", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    ask(onConfirm, onClose);
    screen.getByRole("button", { name: "Keep it" }).focus();
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("the confirm button has focus, so Enter alone confirms", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    ask(onConfirm, vi.fn());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));
    await user.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    ask(onConfirm, onClose);
    await user.keyboard("{Escape}");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("a write that fails keeps the dialog open and says why; confirming again retries (WEB-010)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onConfirm = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(undefined);
    render(<Confirm request={{ title: "Delete plan.pdf?", confirmLabel: "Delete", danger: true, failed: "plan.pdf wasn't deleted.", onConfirm }} onClose={onClose} />);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("plan.pdf wasn't deleted. The server didn't answer. Check it's running, then try again.");
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
