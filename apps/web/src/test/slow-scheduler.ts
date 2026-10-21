/**
 * React's scheduler made late, as on a loaded CI runner: `pnpm --dir apps/web test:slow` runs the
 * DOM tests with it (vitest.slow.config.ts; not in CI). React runs effects and the renders they
 * cause in scheduler tasks of their own, and on a busy machine those can come after Testing
 * Library's findBy has resolved. A test that reads at once what an effect renders passes here only
 * by luck at normal speed, and fails here every time (RACE, 21 Oct 2026). Check a new DOM test with it.
 *
 * It must load before react-dom does, so it is the first setup file, before dom-setup.ts.
 */
import { afterAll } from "vitest";

const late = (fn: (...a: unknown[]) => void, ...a: unknown[]) => setTimeout(fn, 30, ...a);
(globalThis as { setImmediate: unknown }).setImmediate = late;
if (globalThis.MessageChannel) (globalThis as { MessageChannel: unknown }).MessageChannel = undefined;

// The last unmount's work is a late task too: let it land before the environment goes, or it
// throws "window is not defined" from the scheduler after teardown (an artifact of the delay).
afterAll(() => new Promise((r) => setTimeout(r, 100)));
