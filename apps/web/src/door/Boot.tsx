import { HeadMark } from "../ui/orr/Orr.js";

/**
 * The first thing drawn, before the server has said who you are (structure.md §2.14 and §5): Orr
 * rises over the horizon, a sunrise of 600 ms, on the door's ground, so the door that follows
 * doesn't flash. With reduced motion he is simply there. It never waits for itself: the door or
 * the app replaces it the moment the server answers.
 */
export function Boot() {
  return (
    <div className="boot" role="img" aria-label="Orrama">
      <div className="boot-sky">
        <HeadMark size={88} className="boot-sun" />
      </div>
      <span className="boot-horizon" aria-hidden="true" />
    </div>
  );
}
