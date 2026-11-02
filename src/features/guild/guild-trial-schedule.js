/**
 * The guild's trial schedule hour offset.
 *
 * The game sends `guildTrialScheduleHourOffset` on `guild_updated` (and `guild.trialScheduleHourOffset`).
 * Measured on the test server, 2026-11-02, guild "SuperMoo": the value is 21, the guild's own notice says its
 * trials start at 5 AM Beijing time (= 21:00 UTC), the game's chat line "The guild trials have begun!"
 * arrived at 3:00:05 PM US Central on 11/2, 3:00:06 PM on 11/1 and 4:00:06 PM on 10/31 (21:00 UTC each time:
 * Central switched from daylight to standard time on 11/1), and the captured combat battle began at
 * 22:00:08 UTC.
 *
 * So the offset is **whole hours after the cycle's start (00:00 UTC of `currentWeekStartAt`) at which the
 * skilling trial begins**; the combat trial follows one trial hour later. 0 is a real value (the cycle's own
 * midnight), not "missing". On the test server a cycle is a day; on live it is a trial week, where the same
 * field is applied the same way but has not been measured.
 *
 * The value is held here, written by the guild XP tracker from the messages it already handles, and cleared
 * when the guild or the character changes. A missing or unreadable value is `null` and callers fall back to
 * their previous assumption.
 */

/** Hours in a day; the offset is a time of day */
const HOURS_PER_DAY = 24;

/** @type {number|null} */
let held = null;

/**
 * An offset as the game sends it: a whole number of hours, 0 through 23.
 * @param {*} raw
 * @returns {number|null} The offset (0 included), or null when missing or unreadable
 */
export function parseScheduleHourOffset(raw) {
    if (typeof raw !== 'number' && typeof raw !== 'string') return null;
    if (typeof raw === 'string' && !raw.trim()) return null;
    const hours = Number(raw);
    return Number.isInteger(hours) && hours >= 0 && hours < HOURS_PER_DAY ? hours : null;
}

/**
 * Hold the offset the game just stated; null (or anything unreadable) clears it.
 * @param {*} raw
 * @returns {number|null} What is held now
 */
export function setScheduleHourOffset(raw) {
    held = parseScheduleHourOffset(raw);
    return held;
}

/**
 * @returns {number|null} The held offset in hours, or null when the game has not stated one
 */
export function getScheduleHourOffset() {
    return held;
}
