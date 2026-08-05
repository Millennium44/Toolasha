/**
 * Experience session
 *
 * What you have earned since you started watching, rather than since the
 * character was made.
 *
 * A skill's cumulative experience answers "how far along am I". It does not
 * answer "is this setup better than the last one", which is the question you ask
 * after changing gear or zone — and that one needs a mark in the sand and a
 * clock. So a session is a baseline reading plus the time it was taken, and
 * everything else is subtraction.
 *
 * Two things this deliberately does not do. It does not guess at a rate from a
 * window too short to support one, because a rate measured over four seconds is
 * a report of the last drop rather than of the setup. And it does not treat
 * experience going backwards as negative progress — that is a character switch
 * or a reading from before a wipe, and the honest response is to re-baseline
 * rather than to show a negative rate.
 *
 * The model is GWhiz's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

/** Below this the elapsed time is too short for the division to mean anything */
const MIN_SESSION_SECONDS = 20;

/**
 * Start a session from a set of readings.
 *
 * @param {Array<{hrid: string, experience: number}>} readings - One per skill
 * @param {number} now - Milliseconds since the epoch
 * @returns {{startedAt: number, baseline: Object<string, number>}}
 */
export function beginSession(readings, now) {
    const baseline = {};
    for (const reading of readings || []) {
        if (!reading?.hrid || !Number.isFinite(reading.experience)) continue;
        baseline[reading.hrid] = reading.experience;
    }
    return { startedAt: now, baseline };
}

/**
 * What the session has earned so far.
 *
 * A skill absent from the baseline — one that appeared after the session began,
 * which happens when the game sends the skill list in pieces — is counted from
 * its first reading rather than from zero. Counting it from zero would credit
 * the session with the character's whole history in that skill.
 *
 * @param {{startedAt: number, baseline: Object}} session - From `beginSession`
 * @param {Array<{hrid: string, experience: number}>} readings - Current readings
 * @param {number} now - Milliseconds since the epoch
 * @returns {{seconds: number, total: number, perHour: number|null, bySkill: Array<Object>}}
 */
export function sessionProgress(session, readings, now) {
    const seconds = Math.max(0, (now - (session?.startedAt ?? now)) / 1000);
    const bySkill = [];
    let total = 0;

    for (const reading of readings || []) {
        if (!reading?.hrid || !Number.isFinite(reading.experience)) continue;

        const from = session?.baseline?.[reading.hrid];
        // Unknown baseline means the skill was not there when the clock started
        const gained = from === undefined ? 0 : Math.max(0, reading.experience - from);
        total += gained;

        bySkill.push({
            hrid: reading.hrid,
            gained,
            perHour: rateOver(gained, seconds),
        });
    }

    return { seconds, total, perHour: rateOver(total, seconds), bySkill };
}

/**
 * A per-hour rate, or nothing when the window cannot support one.
 *
 * @param {number} gained - Experience over the window
 * @param {number} seconds - How long the window is
 * @returns {number|null}
 */
function rateOver(gained, seconds) {
    if (!(seconds >= MIN_SESSION_SECONDS)) return null;
    return (gained / seconds) * 3600;
}

/**
 * Whether any skill has gone backwards since the baseline.
 *
 * Which means the readings are from a different character, and the session
 * should be started again rather than reported as a loss.
 *
 * @param {{baseline: Object}} session - From `beginSession`
 * @param {Array<{hrid: string, experience: number}>} readings - Current readings
 * @returns {boolean}
 */
export function sessionIsStale(session, readings) {
    for (const reading of readings || []) {
        const from = session?.baseline?.[reading?.hrid];
        if (from !== undefined && reading.experience < from) return true;
    }
    return false;
}
