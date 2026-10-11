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

export const IconSignOut = () => (
  <svg {...base}>
    <path d="M6.5 2.5 H3 V13.5 H6.5" />
    <path d="M10 5 L13 8 L10 11 M13 8 H6" />
  </svg>
);

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
