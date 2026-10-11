/**
 * What the door says when getting in doesn't work, in its own voice (structure.md §2.14): plain,
 * second person, one thing to do next. Orr says nothing for an error; the form says it, with a
 * small shake.
 *
 * The server's words are for logs and API clients ("invalid email or password", "too many failed
 * sign-ins — try again in 15 min"); only the status, and the wait it names, are read from them.
 */
import { ApiError } from "../api.js";

export type DoorAttempt = "signin" | "passcode" | "password" | "touchid" | "register";

export interface DoorError {
  text: string;
  /** The passcode is off until a password sign-in: show the password form. */
  passwordOnly?: boolean;
}

/** "try again in 15 min" → "15 minutes"; "try again in 42s" → "42 seconds". */
export function waitOf(message: string): string | null {
  const min = /(\d+)\s*min/.exec(message);
  if (min) return `${min[1]} minute${min[1] === "1" ? "" : "s"}`;
  const sec = /(\d+)\s*s\b/.exec(message);
  if (sec) return `${sec[1]} second${sec[1] === "1" ? "" : "s"}`;
  return null;
}

/** The server didn't answer at all (it's stopped, or this device is offline). */
const unreachable = (e: unknown) => !(e instanceof ApiError) && e instanceof TypeError;

export function doorError(e: unknown, attempt: DoorAttempt): DoorError {
  if (unreachable(e)) return { text: "Orrama's server isn't answering. Check that it's running, then try again." };
  const status = e instanceof ApiError ? e.status : 0;
  const message = e instanceof Error ? e.message : "";
  const wait = waitOf(message);
  const later = wait ? `Try again in ${wait}.` : "Wait a little, then try again.";

  if (attempt === "touchid") {
    return { text: "Touch ID didn't work. Try again, or use your password." };
  }
  if (attempt === "passcode") {
    if (status === 401) return { text: "That passcode isn't right. Try again." };
    if (status === 429) return { text: `Too many wrong passcodes. ${later}` };
    if (status === 403) return { text: "Too many wrong passcodes. Use your password to get back in.", passwordOnly: true };
  }
  if (attempt === "signin" || attempt === "password") {
    if (status === 401) {
      return { text: attempt === "signin" ? "That email and password don't match. Check them and try again." : "That password isn't right. Try again." };
    }
    if (status === 429) return { text: `Too many tries from here. ${later}` };
    if (status === 400) return { text: "That doesn't look like an email address. Check it and try again." };
  }
  if (attempt === "register") {
    if (status === 429) return { text: `Too many tries from here. ${later}` };
    if (status === 403) return { text: "Orrama is already set up on this server. Reload to sign in." };
    if (status === 400) return { text: "Check the email address, and that the password has at least 8 characters." };
  }
  return { text: "Something went wrong on Orrama's server. Try again in a moment." };
}

/** True when the browser's biometric prompt was dismissed: a normal thing to do, not an error. */
export const cancelled = (e: unknown) => /NotAllowed|abort/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e));
