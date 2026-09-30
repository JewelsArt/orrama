/**
 * Date arithmetic for the Planning calendar, kept apart from the component so
 * it can be tested without the API client.
 */

/** The Monday of `d`'s week, at noon (noon keeps DST shifts from moving the day). */
export const mondayOf = (d: Date) => {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(12, 0, 0, 0);
  return x;
};

/**
 * The anchor Monday for the month `delta` months from the one `weekStart` is in.
 *
 * The month view shows the month its anchor Monday falls in, and the arrows
 * used to add 28 days: from Monday 2 March that is 30 March, so "next" did
 * nothing, and elsewhere it skipped a month. The Monday of the week holding
 * the 8th always lies inside the month (between the 2nd and the 8th), unlike
 * the Monday of the 1st, which is often the month before.
 */
export const shiftMonth = (weekStart: Date, delta: number) =>
  mondayOf(new Date(weekStart.getFullYear(), weekStart.getMonth() + delta, 8, 12));
