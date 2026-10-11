/** An entity page names its thing for the window and the phone's top bar (the address has only a slug). */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePageTitle, usePageTitleFor } from "./title.js";

function Page({ href, title }: { href: string; title: string | null }) {
  usePageTitle(href, title);
  return null;
}
function Bar({ href }: { href: string }) {
  return <h1>{usePageTitleFor(href) ?? "slug words"}</h1>;
}

describe("the page's own title", () => {
  it("is the page's name for its own address only, and goes when the page goes", () => {
    const { rerender, unmount } = render(
      <>
        <Page href="/people/ines-vermaat" title="Ines Vermaat" />
        <Bar href="/people/ines-vermaat" />
      </>,
    );
    expect(screen.getByRole("heading").textContent).toBe("Ines Vermaat");
    rerender(
      <>
        <Page href="/people/ines-vermaat" title="Ines Vermaat" />
        <Bar href="/people/thijs-brouwer" />
      </>,
    );
    expect(screen.getByRole("heading").textContent).toBe("slug words");
    unmount();
    render(<Bar href="/people/ines-vermaat" />);
    expect(screen.getByRole("heading").textContent).toBe("slug words");
  });

  it("says nothing until the page knows its name", () => {
    render(
      <>
        <Page href="/companies/kade-social" title={null} />
        <Bar href="/companies/kade-social" />
      </>,
    );
    expect(screen.getByRole("heading").textContent).toBe("slug words");
  });
});
