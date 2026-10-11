/**
 * Colour maths for hand-built palettes.
 *
 * The built-in palettes (tokens.css, vision.css) were solved offline in oklab
 * against a recipe: keep the hue, then take the most chromatic colour on it that
 * still clears 4.5:1 on the card surface, inside a lightness band narrow enough
 * that the set reads as one family. A profile someone builds by hand deserves
 * the same treatment, so that recipe lives here and runs in the browser.
 *
 * What that buys: a person picks SEVEN colours — the fills, where they are free
 * to choose anything — and the ink family those fills imply is derived, so text
 * wearing a category colour stays legible even if the fill they chose is not.
 * Picking fourteen colours by hand, half of them under a contrast constraint, is
 * not a thing to ask of anyone.
 */

const s2l = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export const rgbToHex = ([r, g, b]: [number, number, number]) =>
  "#" + [r, g, b].map((c) => Math.round(clamp01(c) * 255).toString(16).padStart(2, "0")).join("");

function rgbToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const R = s2l(r), G = s2l(g), B = s2l(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, a, b]: [number, number, number]): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    l2s(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    l2s(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    l2s(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** [lightness 0-1, chroma, hue degrees] */
export function toLch(hex: string): [number, number, number] {
  const [L, a, b] = rgbToOklab(hexToRgb(hex));
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

const fromLch = (L: number, C: number, h: number): [number, number, number] =>
  oklabToRgb([L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)]);

/** A colour at these oklch coordinates, pulled back into sRGB if it overshoots. */
export const lchToHex = (L: number, C: number, h: number): string =>
  rgbToHex(fromLch(Math.max(0, Math.min(1, L)), Math.min(C, maxChroma(Math.max(0, Math.min(1, L)), h)), h));

const inGamut = (rgb: number[]) => rgb.every((c) => c >= -0.0005 && c <= 1.0005);

/** The most chroma this hue can carry at this lightness and stay inside sRGB. */
function maxChroma(L: number, h: number): number {
  let lo = 0, hi = 0.45;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(fromLch(L, mid, h))) lo = mid;
    else hi = mid;
  }
  return lo;
}

const luminance = (hex: string) => {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * s2l(r) + 0.7152 * s2l(g) + 0.0722 * s2l(b);
};

/** WCAG contrast ratio, 1–21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Where the ink family may sit, per theme. Dark inks are light and vice versa. */
const INK_BAND = {
  dark: { lo: 0.62, hi: 0.84 },
  light: { lo: 0.48, hi: 0.62 },
};
const INK_MIN_CONTRAST = 4.5;
const INK_CAP = 0.24;

/**
 * The text-safe sibling of a fill colour: same hue, re-solved for chroma and
 * lightness so it clears 4.5:1 on `surface`. Falls back to the most contrasting
 * colour on that hue when the band cannot reach 4.5 — a hue with almost no
 * chroma left (a near-grey pick) has nowhere to go, and a slightly-too-low
 * result still beats returning the unreadable fill.
 */
export function deriveInk(fill: string, surface: string, mode: "light" | "dark"): string {
  const [, , h] = toLch(fill);
  const band = INK_BAND[mode];
  let best: { hex: string; c: number } | null = null;
  let fallback: { hex: string; ratio: number } | null = null;
  for (let L = band.lo; L <= band.hi; L += 0.004) {
    const C = Math.min(maxChroma(L, h) * 0.985, INK_CAP);
    const hex = rgbToHex(fromLch(L, C, h));
    const ratio = contrast(hex, surface);
    if (!fallback || ratio > fallback.ratio) fallback = { hex, ratio };
    if (ratio < INK_MIN_CONTRAST) continue;
    if (!best || C > best.c) best = { hex, c: C };
  }
  return (best ?? fallback!).hex;
}

/** Perceptual distance in oklab — the same measure the built-in palettes were
 *  solved against, so "far enough apart" means the same thing everywhere. */
export function deltaE(a: string, b: string): number {
  const A = rgbToOklab(hexToRgb(a));
  const B = rgbToOklab(hexToRgb(b));
  return 100 * Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

/**
 * The two colours in a set that are hardest to tell apart.
 *
 * A palette fails at its closest pair, not on average, so that is the only pair
 * worth reporting. For reference: the muddy set this app shipped with sat at
 * 5.3, the solved one at 9.6.
 */
export function closestPair(colors: string[]): { delta: number; a: number; b: number } {
  let worst = { delta: Infinity, a: 0, b: 1 };
  for (let i = 0; i < colors.length; i++)
    for (let j = i + 1; j < colors.length; j++) {
      const delta = deltaE(colors[i]!, colors[j]!);
      if (delta < worst.delta) worst = { delta, a: i, b: j };
    }
  return worst;
}

/** The seven fill slots a profile sets, labelled by what they actually colour. */
export const PALETTE_SLOTS = [
  { token: "cyan", label: "School", hint: "vault category" },
  { token: "pink", label: "Work", hint: "vault category" },
  { token: "green", label: "Knowledge", hint: "vault category" },
  { token: "lilac", label: "Claude & tools", hint: "vault category" },
  { token: "amber", label: "Personal", hint: "vault category" },
  { token: "azure", label: "Projects", hint: "dashboard card" },
  { token: "magenta", label: "Spending", hint: "dashboard card" },
] as const;

/**
 * Basalt's own colour: the logo, the accent, and the big gradient card on the
 * Finance page, which is the one surface in the app that is a colour rather than
 * a colour on something. Kept out of PALETTE_SLOTS because it is not a category
 * — it never appears in a legend beside the seven, and it should not be dragged
 * into their separation check.
 */
export const BRAND_SLOT = { label: "Basalt", hint: "logo, links, balance card" } as const;

export interface VisionProfile {
  id: string;
  name: string;
  /** One hex per PALETTE_SLOTS entry, same order. */
  colors: string[];
  /** Optional: profiles saved before the brand slot existed do not have one. */
  brand?: string;
}

/** How much lighter the top of the balance-card gradient sits, in oklch L. The
 *  built-in card is one hue two steps apart — a third hue put a visible seam
 *  down the middle of it (see tokens.css). */
const HERO_LIFT = 0.111;
/** --accent-deep is a step DOWN on paper and a step UP on near-black: it means
 *  "more prominent than accent", which is darker or lighter depending on ground. */
const DEEP_STEP = { light: -0.059, dark: 0.067 };
const ACCENT_ALPHA = { light: { soft: 10, dim: 14 }, dark: { soft: 14, dim: 18 } };

/** Everything Basalt's own colour drives, from the one hex someone picked. */
function brandVars(brand: string, surface: string, mode: "light" | "dark"): Record<string, string> {
  const [L, C, h] = toLch(brand);
  const accent = deriveInk(brand, surface, mode);
  const [aL, aC] = toLch(accent);
  const alpha = ACCENT_ALPHA[mode];
  return {
    // The card is the pick itself, not a normalised version of it: the well and
    // the card have to be the same colour or the preview is lying.
    "--fin-hero-a": brand,
    "--fin-hero-b": lchToHex(L + HERO_LIFT, C * 0.9, h),
    "--accent": accent,
    "--logo": accent,
    "--focus": accent,
    "--cat-a": accent,
    "--accent-deep": lchToHex(aL + DEEP_STEP[mode], aC, h),
    "--accent-soft": `color-mix(in srgb, ${accent} ${alpha.soft}%, transparent)`,
    "--accent-wash": `color-mix(in srgb, ${accent} ${alpha.soft}%, transparent)`,
    "--accent-dim": `color-mix(in srgb, ${accent} ${alpha.dim}%, transparent)`,
  };
}

/**
 * The CSS custom properties a profile resolves to.
 *
 * Status is deliberately absent, and `pinned` is how it stays that way. --ok and
 * --warn are declared as `var(--ink-green)` / `var(--ink-amber)`, so overriding
 * the ink family would drag "money in" and "over budget" along with a category
 * choice — a palette edit silently changing what red means. The caller reads
 * those three off the document with the profile NOT applied and passes them back
 * in, which pins them to whatever the theme and vision mode say they are.
 */
export function profileVars(
  profile: VisionProfile,
  surface: string,
  mode: "light" | "dark",
  pinned: { ok: string; warn: string; danger: string },
): Record<string, string> {
  const vars: Record<string, string> = {};
  PALETTE_SLOTS.forEach(({ token }, i) => {
    const fill = profile.colors[i] ?? "#888888";
    vars[`--v-${token}`] = fill;
    vars[`--ink-${token}`] = deriveInk(fill, surface, mode);
  });
  // Finance's own ramp yields to the profile, as it does in every vision mode:
  // its donut is the one place colour alone carries the meaning.
  vars["--cat-cyan"] = vars["--v-cyan"]!;
  vars["--cat-pink"] = vars["--v-pink"]!;
  vars["--cat-azure"] = vars["--v-azure"]!;
  vars["--cat-magenta"] = vars["--v-magenta"]!;
  vars["--cat-lilac"] = vars["--v-lilac"]!;
  vars["--cat-purple"] = vars["--v-lilac"]!;
  // Orrama's five life areas (tokens.css --c1…--c5) follow the profile's area fills, in the
  // same order the vault's categories used them.
  vars["--c1"] = vars["--v-pink"]!; // Work
  vars["--c2"] = vars["--v-amber"]!; // Personal
  vars["--c3"] = vars["--v-cyan"]!; // School
  vars["--c4"] = vars["--v-lilac"]!; // Claude & tools
  vars["--c5"] = vars["--v-green"]!; // Knowledge
  vars["--ok"] = pinned.ok;
  vars["--warn"] = pinned.warn;
  vars["--danger"] = pinned.danger;
  vars["--late"] = pinned.danger;
  if (profile.brand) Object.assign(vars, brandVars(profile.brand, surface, mode));
  return vars;
}

/** Every property profileVars can set, so switching profiles clears cleanly. */
export const PROFILE_VAR_NAMES = [
  ...PALETTE_SLOTS.flatMap(({ token }) => [`--v-${token}`, `--ink-${token}`]),
  "--cat-cyan", "--cat-pink", "--cat-azure", "--cat-magenta", "--cat-lilac", "--cat-purple",
  "--c1", "--c2", "--c3", "--c4", "--c5",
  "--ok", "--warn", "--danger", "--late",
  "--fin-hero-a", "--fin-hero-b", "--accent", "--logo", "--focus", "--cat-a",
  "--accent-deep", "--accent-soft", "--accent-dim", "--accent-wash",
];

export const CUSTOM_PREFIX = "custom:";
export const isCustom = (vision: string) => vision.startsWith(CUSTOM_PREFIX);
export const customId = (vision: string) => vision.slice(CUSTOM_PREFIX.length);
