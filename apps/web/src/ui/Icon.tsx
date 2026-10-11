import { createElement, type SVGProps } from "react";
import { ICON_PATHS, type IconName } from "./icon-paths.js";

export type { IconName };

/**
 * One of the system's line icons. Decorative by default (aria-hidden); pass `label` when the
 * icon is the only thing saying what a control does and there is no text beside it.
 *
 * Without `size` the stylesheet decides (20 px; 16 in a button; 22 in the phone's tabs), as on
 * the boards; with it, that size wins.
 */
export function Icon({
  name,
  size,
  label,
  className,
  style,
  ...rest
}: { name: IconName; size?: number; label?: string } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      className={className ? `i ${className}` : "i"}
      style={size ? { width: size, height: size, ...style } : style}
      viewBox="0 0 20 20"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      {...rest}
    >
      {ICON_PATHS[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];
