/**
 * The app's older icon exports. Those with a twin in Orrama's line set (ui/icon-paths.ts) now
 * draw it; the rest (Finance's category pictograms, send, reply, sign-out, promote, wand) keep
 * their drawings until their screens move to the system. No emoji in the chrome.
 */
import { createElement } from "react";
import { ICON_PATHS, type IconName } from "./ui/icon-paths.js";

/**
 * A line icon from the system set, drawn the way these exports always were: a 16 px SVG with
 * its stroke in attributes and no class, so the older stylesheets that size and colour these
 * icons inside their own buttons keep doing so.
 */
const drawn = (name: IconName, extra: Record<string, unknown> = {}) => (
  <svg width={16} height={16} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...extra}>
    {ICON_PATHS[name].map(([tag, all], i) => {
      const { className, ...attrs } = all as Record<string, string>;
      return createElement(tag, { key: i, ...attrs, ...(className === "fill" ? { fill: "currentColor", stroke: "none" } : {}) });
    })}
  </svg>
);

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Basalt mark: three interlocking columns, like the causeway. */
/**
 * Three basalt columns seen from above — the Giant's Causeway view — each drawn
 * as a cube.
 *
 * There is not a single stroke in here. Every edge is the seam where two fills
 * meet, which is why it stays clean at 18px: an outline plus internal edges
 * clogs the interiors long before the silhouette gives out.
 *
 * ONE HUE, THREE LIGHTNESSES (oklch 280 degrees, the brand violet). Every cube
 * wears the same three tones in the same places, because one light source lights
 * every cube the same way. Do not grade the cubes front-to-back on top of this —
 * an earlier version did, the two systems of shading fought, and the third cube
 * all but disappeared.
 *
 * The cells are pulled very slightly apart on purpose. Sharing walls makes them
 * a honeycomb, which reads as bees before it reads as rock; a hair of gap turns
 * them back into separate columns that happen to pack, which is the actual
 * claim. Do not close the gaps to "tidy" it.
 *
 * It fills more of the 16 box than the nav icons around it (roughly 1.2 units
 * of margin against their 2). That is deliberate: those sit in a row and need
 * matching optical weight, this one sits alone above the rule and was reading
 * small next to the wordmark.
 *
 * These are fixed hex values, so unlike the rest of icons.tsx the mark does NOT
 * follow currentColor or --logo. That is deliberate: a brand mark that changes
 * colour is not much of a brand mark. The cost is that it no longer tracks a
 * custom palette — swap the six literals for color-mix() over currentColor if
 * that trade is ever worth reversing.
 */
const FACE = { top: "#8c90ff", left: "#6760ed", right: "#493eb9" };

export const IconMark = ({ size = 18 }: { size?: number }) => (
  <svg {...base} width={size} height={size} stroke="none">
    {/* top cell */}
    <path d="M4.92 3 L8 1.22 L11.08 3 L8 4.78 Z" fill={FACE.top} />
    <path d="M4.92 6.55 L4.92 3 L8 4.78 L8 8.33 Z" fill={FACE.left} />
    <path d="M11.08 3 L11.08 6.55 L8 8.33 L8 4.78 Z" fill={FACE.right} />
    {/* lower-left cell */}
    <path d="M1.2 9.45 L4.28 7.67 L7.36 9.45 L4.28 11.22 Z" fill={FACE.top} />
    <path d="M1.2 13 L1.2 9.45 L4.28 11.22 L4.28 14.78 Z" fill={FACE.left} />
    <path d="M7.36 9.45 L7.36 13 L4.28 14.78 L4.28 11.22 Z" fill={FACE.right} />
    {/* lower-right cell */}
    <path d="M8.64 9.45 L11.72 7.67 L14.8 9.45 L11.72 11.22 Z" fill={FACE.top} />
    <path d="M8.64 13 L8.64 9.45 L11.72 11.22 L11.72 14.78 Z" fill={FACE.left} />
    <path d="M14.8 9.45 L14.8 13 L11.72 14.78 L11.72 11.22 Z" fill={FACE.right} />
  </svg>
);

export const IconDashboard = () => drawn("sunrise");

export const IconArchitecture = () => drawn("notes");

export const IconPlanning = () => drawn("calendar");

export const IconOverview = () => drawn("projects");

export const IconSearch = () => drawn("search");

export const IconAsk = () => drawn("ask");

export const IconPlus = () => drawn("plus");

export const IconX = () => drawn("x");

export const IconGear = () => drawn("settings");

export const IconSun = () => drawn("sun");

export const IconMoon = () => drawn("moon");

/* Spending-category pictograms. Same 16px stroke family as the rail icons —
   a category is recognised by its shape first and its colour second, which also
   means the chart stays readable to anyone who cannot separate the hues. */
export const IconGroceries = () => (
  <svg {...base}><path d="M2 5h12l-1.2 7.5a1 1 0 0 1-1 .5H4.2a1 1 0 0 1-1-.5Z" /><path d="M5.5 5 7 2M10.5 5 9 2" /></svg>
);
export const IconEating = () => (
  <svg {...base}><path d="M4 2v5.5a1.5 1.5 0 0 0 3 0V2M5.5 7.5V14" /><path d="M11.5 2c-1 1.2-1.5 2.6-1.5 4 0 1 .6 1.8 1.5 2V14" /></svg>
);
export const IconTransport = () => (
  <svg {...base}><rect x="3.5" y="2.5" width="9" height="8.5" rx="2" /><path d="M3.5 8h9M5.5 13.5l-1 1M10.5 13.5l1 1" /><circle cx="6" cy="10" r=".6" fill="currentColor" /><circle cx="10" cy="10" r=".6" fill="currentColor" /></svg>
);
export const IconBoulder = () => (
  <svg {...base}><path d="M1.5 13 6 4l3 5.5L10.5 7l4 6Z" /><circle cx="10" cy="3.5" r="1.2" /></svg>
);
export const IconHealth = () => (
  <svg {...base}><path d="M8 13.5S2 10 2 6.2A3.2 3.2 0 0 1 8 4.6 3.2 3.2 0 0 1 14 6.2C14 10 8 13.5 8 13.5Z" /></svg>
);
export const IconSoftware = () => (
  <svg {...base}><rect x="1.5" y="3" width="13" height="10" rx="1.5" /><path d="M4.5 7 6.5 9l-2 2M8.5 11h3" /></svg>
);
export const IconShopping = () => (
  <svg {...base}><path d="M3 5h10l-.8 8.5H3.8Z" /><path d="M5.8 5V3.6a2.2 2.2 0 0 1 4.4 0V5" /></svg>
);
export const IconGoingOut = () => (
  <svg {...base}><path d="M2 6.5V4.5h12v2a1.5 1.5 0 0 0 0 3v2H2v-2a1.5 1.5 0 0 0 0-3Z" /><path d="M8 5v1.5M8 8v1.5M8 11v1" /></svg>
);
export const IconCash = () => (
  <svg {...base}><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><circle cx="8" cy="8" r="1.8" /></svg>
);
export const IconOther = () => (
  <svg {...base}><circle cx="4" cy="8" r="1.1" /><circle cx="8" cy="8" r="1.1" /><circle cx="12" cy="8" r="1.1" /></svg>
);

/** Finance: a banknote — money as an object, not a chart or a currency sign. */
export const IconFinance = () => drawn("money");

/** Back: a plain left arrow — the same glyph every browser and OS uses. */
export const IconBack = () => drawn("back");

/** Reload: a full circular arrow, so it reads as "again", not "undo". */
export const IconRefresh = () => (
  <svg {...base}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.97" />
    <path d="M13.5 2.5v3.2h-3.2" />
  </svg>
);

export const IconSignOut = () => (
  <svg {...base}>
    <path d="M6.5 2.5 H3 V13.5 H6.5" />
    <path d="M10 5 L13 8 L10 11 M13 8 H6" />
  </svg>
);

export const IconContacts = () => drawn("people");

export const IconMail = () => drawn("mail");

export const IconSend = () => (
  <svg {...base}>
    <path d="M14 2 L7 9" />
    <path d="M14 2 L9.5 14 L7 9 L2 6.5 Z" />
  </svg>
);

export const IconReply = () => (
  <svg {...base}>
    <path d="M6 3.5 L2 7 L6 10.5" />
    <path d="M2 7 h6.5 c3 0 5 2 5 5" />
  </svg>
);

export const IconChevron = ({ open = false }: { open?: boolean }) =>
  drawn("chev-r", { style: { transform: open ? "rotate(90deg)" : undefined, transition: "transform .12s" } });

export const IconLock = () => drawn("lock");

export const IconPromote = () => (
  <svg {...base}>
    <path d="M8 2.5 L13 8 L8 13.5 L3 8 Z" />
  </svg>
);

/** Auto-plan: a wand with two sparks — the one place the app fills the calendar for you. */
export const IconWand = () => (
  <svg {...base}>
    <path d="M2.5 13.5 L9.5 6.5" />
    <path d="M8.4 5.4 L10.6 7.6" />
    <path d="M11.5 2.2 v2.2 M12.6 3.3 h-2.2" />
    <path d="M13.6 7.4 v1.8 M14.5 8.3 h-1.8" />
  </svg>
);
