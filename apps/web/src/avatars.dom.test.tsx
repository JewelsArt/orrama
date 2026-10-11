/** The rock faces are gone: an account picks one of eight Orrs, and an old pick shows its Orr (§8 #10). */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CHARACTERS, CharacterAvatar } from "./avatars.js";

describe("avatars", () => {
  it("offers the eight Orrs, by the names that play on his", () => {
    expect(CHARACTERS.map((c) => c.name)).toEqual(["Orrpheus", "doctOrr", "bOrris", "sOrrel", "Orriginal", "snOrre", "victOrr", "Orra"]);
  });

  it("shows an account that stored a rock face as that face's Orr", () => {
    render(<CharacterAvatar id="basalt" size={32} />);
    expect(screen.getByRole("img", { name: "Orriginal" })).toBeTruthy();
  });
});
