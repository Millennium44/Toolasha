/**
 * Calendar arithmetic that does not drift across a daylight saving change.
 */

/**
 * The same wall-clock moment some calendar days earlier.
 *
 * `now - days * 24h` is an hour off on either side of a clock change, because a local day is 23 or 25
 * hours long twice a year. Stepping the date keeps the wall-clock time, so "the last 7 days" still starts
 * at this time of day a week ago.
 *
 * @param {number} now - Milliseconds since the epoch
 * @param {number} days - Whole calendar days back
 * @returns {number} Milliseconds since the epoch
 */
export function calendarDaysBefore(now, days) {
    const date = new Date(now);
    date.setDate(date.getDate() - days);
    return date.getTime();
}
