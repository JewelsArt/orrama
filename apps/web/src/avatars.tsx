/**
 * Your Orr: the eight avatars an account picks from (structure.md §9 #7c), replacing the eight
 * rock faces of the Basalt days (§8 #10). Each is Jules's drawing, set A, cropped to head and
 * shoulders (ui/orr/Orr.tsx). An account that still stores a rock face's id is shown that
 * face's Orr until its owner picks again.
 *
 * Kept as this module's old exports so Settings' picker and the rail need no change to show
 * them; Settings → You (R1) builds the new picker on ui/orr directly.
 */
import { Avatar, AVATAR_NAMES, avatarName } from "./ui/orr/Orr.js";

export interface Character {
  id: string;
  name: string;
  /** What he wears or carries. */
  prop: string;
}

export const CHARACTERS: Character[] = AVATAR_NAMES.map(({ id, name, prop }) => ({ id, name, prop }));

/** The Orr for a stored avatar id, head and shoulders in a circle of diameter `size`. */
export function CharacterAvatar({ id, size = 28 }: { id: string; size?: number }) {
  const who = avatarName(id);
  const name = AVATAR_NAMES.find((a) => a.id === who)!.name;
  return <Avatar name={who} size={size} label={name} />;
}
