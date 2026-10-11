/** The small parts behave as their roles promise: keys, states, names. */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Checkbox, initials, Segmented, Tabs } from "./controls.js";
import { Field, Input, Switch } from "./fields.js";
import { Row, RowList } from "./layout.js";

describe("Tabs", () => {
  it("is a tablist: one tab stop, arrow keys move and choose, wrapping", async () => {
    const user = userEvent.setup();
    function T() {
      const [v, setV] = useState<"overview" | "timeline" | "documents" | "todo">("overview");
      return (
        <Tabs
          label="Project"
          value={v}
          onChange={setV}
          items={[
            { id: "overview", label: "Overview" },
            { id: "timeline", label: "Timeline" },
            { id: "documents", label: "Documents", count: 4 },
            { id: "todo", label: "To-do" },
          ]}
        />
      );
    }
    render(<T />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    tabs[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Timeline");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("To-do");
    expect(document.activeElement).toBe(screen.getByRole("tab", { selected: true }));
  });

  it("as links: a plain click is the app's navigation, a ⌘-click is the browser's", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Tabs label="Money" value="spending" onChange={onChange} items={[{ id: "spending", label: "Spending", href: "/money/spending" }, { id: "income", label: "Income", href: "/money/income" }]} />);
    await user.click(screen.getByRole("tab", { name: "Income" }));
    expect(onChange).toHaveBeenCalledWith("income");
  });
});

describe("Segmented", () => {
  it("is a radio group the arrow keys move through", async () => {
    const user = userEvent.setup();
    function S() {
      const [v, setV] = useState<"lanes" | "hours">("lanes");
      return <Segmented label="Show the week as" value={v} onChange={setV} items={[{ id: "lanes", label: "Lanes" }, { id: "hours", label: "Hours" }]} />;
    }
    render(<S />);
    screen.getByRole("radio", { name: "Lanes" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Hours" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("Checkbox", () => {
  it("says its four states, and ticking it does not open the row it sits in", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const toggle = vi.fn();
    const { rerender } = render(<Row lead={<Checkbox state="open" label="Draft chapter 3" onToggle={toggle} />} title="Draft chapter 3" onOpen={open} />);
    const cb = screen.getByRole("checkbox", { name: "Draft chapter 3" });
    expect(cb.getAttribute("aria-checked")).toBe("false");
    await user.click(cb);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    rerender(<Checkbox state="progress" label="x" />);
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("mixed");
    rerender(<Checkbox state="done" label="x" />);
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    rerender(<Checkbox state="blocked" label="x" />);
    expect(screen.getByRole("checkbox", { name: "x (blocked)" })).toBeTruthy();
  });
});

describe("Row", () => {
  it("opens with Enter, and the arrow keys move between rows", async () => {
    const user = userEvent.setup();
    const opened: string[] = [];
    render(
      <RowList label="Due">
        {["Interview Ines", "Draft chapter 3", "Send to Thijs"].map((t) => (
          <Row key={t} title={t} onOpen={() => opened.push(t)} trailing="Fri" />
        ))}
      </RowList>,
    );
    const rows = screen.getAllByRole("button");
    rows[0]!.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(opened).toEqual(["Send to Thijs"]);
    await user.keyboard("{ArrowUp} ");
    expect(opened).toEqual(["Send to Thijs", "Draft chapter 3"]);
  });
});

describe("Field", () => {
  it("labels its control and ties its help and error to it", () => {
    render(
      <Field label="Name" help="As the rail shows it." error="Say something">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("Name");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent);
    expect(described).toEqual(["As the rail shows it.", "Say something"]);
  });

  it("a switch is a switch", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch label="Show reviews" checked={false} onChange={onChange} />);
    await user.click(screen.getByRole("switch", { name: "Show reviews" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("initials", () => {
  it("takes the first word and the last real one: 'de' names give BW, not Bd (§2.7)", () => {
    expect(initials("Bas de Wit")).toBe("BW");
    expect(initials("Ines Vermaat")).toBe("IV");
    expect(initials("Noor El Amrani")).toBe("NA");
    expect(initials("[[Kade Social]]")).toBe("KS");
    expect(initials("Westerdok")).toBe("W");
    expect(initials("jan van der berg")).toBe("JB");
    expect(initials("de Vries")).toBe("V"); // a surname alone keeps its own letter, not the particle's
    expect(initials("")).toBe("?");
  });
});
