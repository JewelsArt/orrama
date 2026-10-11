/**
 * Spending categories and their colours (structure.md §2.9): the five categorical colours of the
 * system, `--c1` … `--c5`, given in the order the spending-categories note lists its categories,
 * and `--c-other` for everything after the fifth and for what no rule caught. Spending categories
 * are not life areas, so they keep their own order (the note's), but they wear the same five
 * colours as everything else — never a palette of Money's own, never cycled, never green (green
 * is status only).
 *
 * The note's old Colour column (pink, cyan, …) named Finance's own ramp, which is gone; it is
 * no longer read. The order of the rows is what decides now.
 */
import { createElement, type ReactNode } from "react";
import { IconBoulder, IconCash, IconEating, IconGoingOut, IconGroceries, IconHealth, IconOther, IconShopping, IconSoftware, IconTransport } from "../icons.js";

/** What the rules did not catch. Mirrors UNCATEGORISED in packages/core/src/spending.ts. */
export const UNCATEGORISED = "Other";
/** How many categories get a colour of their own; the rest are "other". */
export const COLOURED = 5;
export const OTHER_COLOUR = "var(--c-other)";

/** The categories that get a colour, in the note's order (first mention wins). */
export function colouredCategories(rules: { category: string }[]): string[] {
  const seen: string[] = [];
  for (const r of rules) if (r.category !== UNCATEGORISED && !seen.includes(r.category)) seen.push(r.category);
  return seen.slice(0, COLOURED);
}

/** One colour function per rules note: `--c1` … `--c5` by the note's order, `--c-other` for the rest. */
export function paletteFor(rules: { category: string; colour?: string | null }[]): (name: string) => string {
  const order = colouredCategories(rules);
  return (name) => {
    const i = order.indexOf(name);
    return i >= 0 ? `var(--c${i + 1})` : OTHER_COLOUR;
  };
}

/**
 * Pictogram per category, matched loosely so a renamed category still finds one. Money itself
 * draws swatches now (the boards); the colour-vision editor still shows these.
 */
const CATEGORY_ICONS: [RegExp, () => ReactNode][] = [
  [/grocer|super|food shop/i, IconGroceries],
  [/eat|restaur|dining|takeaway|lunch/i, IconEating],
  [/transp|travel|commut/i, IconTransport],
  [/boulder|climb/i, IconBoulder],
  [/sport|health|fitness|medic/i, IconHealth],
  [/software|subscri|tech|tool/i, IconSoftware],
  [/shop|cloth|retail/i, IconShopping],
  [/going out|entertain|culture|leisure/i, IconGoingOut],
  [/cash|atm|withdraw/i, IconCash],
];
export const iconFor = (name: string): ReactNode => createElement(CATEGORY_ICONS.find(([re]) => re.test(name))?.[1] ?? IconOther);
