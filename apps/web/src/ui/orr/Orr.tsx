/**
 * Orr, Orrama's mascot: Jules's drawings, set A (the vector set approved 10–11 October).
 *
 *   <Orr pose="sit" size={48} />   a pose, standing on the bottom edge of its box
 *   <Avatar name="victorr" size={38} />        your Orr, head and shoulders in a circle
 *   <Avatar name="victorr" size={112} full />  your Orr, standing
 *   <HeadMark size={16} />          the logo's O, his mark on his own work
 *
 * `size` is Hello's height in px (orrsprite.py's `body`). Poses need room: below 48 px he is
 * Hello whatever the pose, and below 20 px only the head mark is left, which stays vector and
 * sharp (structure.md §5, §6 #11). He never appears in an error.
 *
 * Motion: one pose at a time. A new pose cross-fades in over 150 ms; nothing loops; with
 * reduced motion he just changes.
 *
 * The drawings are one SVG per figure and theme, whose viewBox is exactly the figure's cell on
 * the boards' sprite sheets, so the box maths are the sheets' (geometry.ts) and only the figure
 * shown is downloaded. Light and night are both declared and the stylesheet picks one by the
 * page's data-theme, so a theme change needs no re-render.
 */
import { useEffect, useId, useState, type CSSProperties } from "react";
import { avatarBox, avatarCrop, poseBox } from "./geometry.js";
import { AVATARS, POSES } from "./sprites.js";

const FILES = import.meta.glob<string>("./assets/*.svg", { eager: true, query: "?url", import: "default" });
const art = (file: string): string => {
  const url = FILES[`./assets/${file}`];
  if (!url) throw new Error(`no Orr drawing ${file}`);
  return url;
};

export type OrrPose =
  | "hello" | "wave" | "point" | "read" | "think" | "juggle" | "telescope" | "write"
  | "carry" | "search" | "shrug" | "mail" | "sit" | "doze" | "jump" | "peek";
export const ORR_POSES = POSES.names as OrrPose[];

export type AvatarName = "orrpheus" | "doctorr" | "borris" | "sorrel" | "orriginal" | "snorre" | "victorr" | "orra";

/** The eight avatars, with the names that play on his (structure.md §9 #7c). */
export const AVATAR_NAMES: { id: AvatarName; name: string; prop: string }[] = [
  { id: "orrpheus", name: "Orrpheus", prop: "headphones" },
  { id: "doctorr", name: "doctOrr", prop: "graduation cap" },
  { id: "borris", name: "bOrris", prop: "beanie and scarf" },
  { id: "sorrel", name: "sOrrel", prop: "sprout" },
  { id: "orriginal", name: "Orriginal", prop: "the old Basalt cube" },
  { id: "snorre", name: "snOrre", prop: "nightcap and moon" },
  { id: "victorr", name: "victOrr", prop: "race medal" },
  { id: "orra", name: "Orra", prop: "coffee" },
];

/**
 * Accounts made before Orrama chose one of eight rock faces. Each becomes an Orr of a related
 * temperament; the stored value only changes when its owner picks again.
 */
const FROM_ROCK: Record<string, AvatarName> = {
  basalt: "orriginal", // he carries the old Basalt cube
  magma: "victorr",
  moss: "sorrel",
  tide: "orrpheus",
  ash: "snorre",
  quartz: "doctorr",
  ember: "orra",
  fog: "borris",
};

/** The avatar a stored value means: one of the eight, a rock face's Orr, or Orriginal. */
export function avatarName(stored: string | null | undefined): AvatarName {
  if (stored && AVATARS.heads[stored]) return stored as AvatarName;
  return FROM_ROCK[stored ?? ""] ?? "orriginal";
}

const px = (n: number) => `${Math.round(n * 10) / 10}px`;
const layer = (file: (theme: "light" | "dark") => string) =>
  ({ "--orr-l": `url("${art(file("light"))}")`, "--orr-d": `url("${art(file("dark"))}")` }) as CSSProperties;

/** How long the cross-fade between two poses runs (ms). */
export const POSE_FADE_MS = 150;

export function Orr({ pose = "hello", size = 48, label, className }: { pose?: OrrPose; size?: number; label?: string; className?: string }) {
  // Hooks first: the size rules below decide what is drawn, not which hooks run.
  const shown: OrrPose = size < 48 ? "hello" : pose;
  // The pose he had and the one he takes, set during render (React's "previous value" pattern)
  // so the new pose is on screen in the same frame and the old one fades out over it.
  const [now, setNow] = useState(shown);
  const [was, setWas] = useState<OrrPose | null>(null);
  if (now !== shown) {
    setWas(now);
    setNow(shown);
  }
  useEffect(() => {
    if (!was) return;
    const t = setTimeout(() => setWas(null), POSE_FADE_MS);
    return () => clearTimeout(t);
  }, [was, now]);

  if (size < 20) return <HeadMark size={size} label={label} className={className} />;
  const box = poseBox(size);
  const draw = (p: OrrPose, cls: string) => (
    <span
      key={p}
      data-figure={p}
      className={`orrsp ${cls}`}
      style={{ width: px(box.width), height: px(box.height), ...layer((t) => `poses-a-${p}-${t}.svg`) }}
    />
  );
  return (
    <span
      className={className ? `orrw ${className}` : "orrw"}
      style={{ width: px(box.width), height: px(box.ground) }}
      data-pose={now}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {was && was !== now && draw(was, "out")}
      {draw(now, was ? "in" : "")}
    </span>
  );
}

export function Avatar({
  name,
  size = 38,
  full = false,
  label,
  className,
}: {
  /** One of the eight, or whatever an account stored (an old rock face is mapped). */
  name: string;
  size?: number;
  /** Standing, at Hello's height `size`, instead of the head in a circle of diameter `size`. */
  full?: boolean;
  label?: string;
  className?: string;
}) {
  const who = avatarName(name);
  const aria = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  if (full) {
    const box = avatarBox(size);
    return (
      <span className={className ? `orrw ${className}` : "orrw"} style={{ width: px(box.width), height: px(box.ground) }} {...aria}>
        <span className="orrsp" style={{ width: px(box.width), height: px(box.height), ...layer((t) => `avatars-a-${who}-${t}.svg`) }} />
      </span>
    );
  }
  const c = avatarCrop(who, size);
  return (
    <span className={className ? `avc ${className}` : "avc"} style={{ width: size, height: size }} {...aria}>
      <span
        className="orrsp"
        style={{ width: px(c.width), height: px(c.height), left: px(c.left), top: px(c.top), ...layer((t) => `avatars-a-${who}-${t}.svg`) }}
      />
    </span>
  );
}

/** The logo's O (~/orrama-logo/upright, the mark's head), with its nine-stop gradient. */
const HEAD_D =
  "M430.88 142.85C430.88 186.64 395.38 222.13 351.6 222.13C307.82 222.13 272.32 186.64 272.32 142.85C272.32 99.07 307.82 63.58 351.6 63.58C395.38 63.58 430.88 99.07 430.88 142.85ZM389.92 142.85C389.92 121.69 372.77 104.53 351.6 104.53C330.44 104.53 313.28 121.69 313.28 142.85C313.28 164.02 330.44 181.17 351.6 181.17C372.77 181.17 389.92 164.02 389.92 142.85Z";
const HEAD_STOPS = ["#FEE28C", "#FED884", "#FEC97B", "#FEB56F", "#FEA267", "#FD8E66", "#FE7867", "#FE6668", "#FD5968"];

export function HeadMark({ size = 16, label, className }: { size?: number; label?: string; className?: string }) {
  const id = `oh${useId().replace(/:/g, "")}`;
  return (
    <svg
      className={className ? `hd ${className}` : "hd"}
      width={size}
      height={size}
      viewBox="271.3 62.6 160.6 160.6"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="294.27" y1="94.31" x2="410.06" y2="190.38">
          {HEAD_STOPS.map((c, i) => (
            <stop key={c} offset={i / 8} stopColor={c} />
          ))}
        </linearGradient>
      </defs>
      <path fill={`url(#${id})`} fillRule="evenodd" d={HEAD_D} />
    </svg>
  );
}
