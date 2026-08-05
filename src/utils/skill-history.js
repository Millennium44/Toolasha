/**
 * Skill history
 *
 * Two readings of a skill's experience, far enough apart to divide.
 *
 * A rate needs a memory, and a memory needs three decisions that each have a
 * wrong answer looking exactly like the right one: how often to read, how far
 * back to keep, and what to do when a reading makes no sense against the last.
 * That last one is where the bugs are, and it is why this is one module rather
 * than a loop copied into every feature that wants a rate.
 *
 * ## The two readings that are not progress
 *
 * **Experience below the previous reading** is a different character, not a
 * loss. A test server beside a live one is an ordinary thing to have, and the
 * difference between two characters' totals is a large negative number that
 * would otherwise be reported as a rate.
 *
 * **A clock that has gone backwards** — an NTP correction, a resume from sleep —
 * leaves readings stamped in the future. Nothing can be measured against those:
 * the window between them is negative, so every rate reads as unmeasurable until
 * real time catches up with the stale stamps, which after a long sleep is hours
 * of a panel quietly saying nothing. Starting again costs one window and is the
 * only answer that recovers.
 *
 * Each caller makes its own, so opening or closing one panel cannot reset
 * another's measurement.
 */

import { experiencePerHour } from './skill-progress.js';

/** Ten minutes back is long enough to be a measurement and short enough to be current */
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

/** No point re-reading the skill list faster than anything redraws */
const DEFAULT_SAMPLE_MS = 5000;

/**
 * A private record of how fast each skill is going up.
 *
 * @param {Object} [options] - Tuning
 * @param {number} [options.windowMs] - How far back to measure over
 * @param {number} [options.sampleMs] - How often to take a reading
 * @returns {{sample: Function, rateFor: Function, rates: Function, readings: Function, clear: Function}}
 */
export function createSkillHistory({ windowMs = DEFAULT_WINDOW_MS, sampleMs = DEFAULT_SAMPLE_MS } = {}) {
    /** skillHrid → [{t, xp}], oldest first */
    const history = new Map();

    // Null rather than zero for "never read": zero is a real time, and against
    // it the first reading of a session looks like one taken a moment ago and
    // is refused. Under a real clock that is invisible, which is exactly the
    // kind of edge that survives to bite a test that sets its own time.
    let lastSampleAt = null;

    /**
     * Take a reading of every skill, if one is due.
     *
     * @param {Array<{skillHrid: string, experience: number}>} skills - The game's list
     * @param {number} [now] - Milliseconds since the epoch
     */
    function sample(skills, now = Date.now()) {
        if (lastSampleAt !== null) {
            if (now < lastSampleAt) history.clear();
            else if (now - lastSampleAt < sampleMs) return;
        }
        lastSampleAt = now;

        for (const skill of skills || []) {
            if (!skill?.skillHrid || !Number.isFinite(skill.experience)) continue;

            let readings = history.get(skill.skillHrid) || [];
            if (readings.length && skill.experience < readings[readings.length - 1].xp) readings = [];

            readings.push({ t: now, xp: skill.experience });
            // Drop everything that has fallen out of the window, but never the
            // last one before it — that reading is the far end of the measurement
            while (readings.length > 2 && readings[1].t < now - windowMs) readings.shift();
            history.set(skill.skillHrid, readings);
        }
    }

    /**
     * @param {string} skillHrid - Which skill
     * @returns {number|null} Experience per hour, or null when unmeasurable
     */
    function rateFor(skillHrid) {
        const readings = history.get(skillHrid) || [];
        return experiencePerHour(readings[0], readings[readings.length - 1]);
    }

    /**
     * Every skill that has a measurable rate.
     * @returns {Object<string, number>} Skill hrid → experience per hour
     */
    function rates() {
        const result = {};
        for (const skillHrid of history.keys()) {
            const rate = rateFor(skillHrid);
            if (rate) result[skillHrid] = rate;
        }
        return result;
    }

    /**
     * @param {string} skillHrid - Which skill
     * @returns {Array<{t: number, xp: number}>} Its readings, oldest first
     */
    function readings(skillHrid) {
        return history.get(skillHrid) || [];
    }

    /** Forget everything and start the measurement again */
    function clear() {
        history.clear();
        lastSampleAt = null;
    }

    return { sample, rateFor, rates, readings, clear };
}
