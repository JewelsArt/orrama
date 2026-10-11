/**
 * The entity pages and Orr noticed at their addresses (structure.md §1.2): a person, a company,
 * a conversation and a document open the entity page, `/notes/health` opens Orr noticed, and
 * each entity page is a page of its own (moving between two people starts the second afresh).
 */
import "../test/app-harness.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { at, serve } from "../test/app-harness.js";
import { navigate } from "../ui/router.js";

beforeEach(() => serve());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view = () => screen.getByTestId("view");

describe("addresses", () => {
  it.each(["/people/ines-vermaat", "/companies/kade-social", "/conversations/scoping-the-question", "/documents/04-Projects/graduation-thesis/files/Research%20plan.pdf"])(
    "%s is the entity page",
    async (href) => {
      at(href);
      render(<App />);
      await screen.findByTestId("view");
      expect(view().getAttribute("data-view")).toBe("entity");
      expect(view().textContent).toBe(href);
    },
  );

  it("/notes/health is Orr noticed", async () => {
    at("/notes/health");
    render(<App />);
    await screen.findByTestId("view");
    expect(view().getAttribute("data-view")).toBe("noticed");
  });

  it("People's list and a person are two pages", async () => {
    at("/people");
    render(<App />);
    await screen.findByTestId("view");
    expect(view().getAttribute("data-view")).toBe("contacts");
    act(() => navigate("/people/ines-vermaat"));
    expect(view().getAttribute("data-view")).toBe("entity");
    act(() => navigate("/people"));
    expect(view().getAttribute("data-view")).toBe("contacts");
  });
});
