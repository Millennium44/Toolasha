/**
 * Notification Predicates
 *
 * The "has something actually happened" half of each notification, kept apart
 * from the feature that observes it.
 *
 * Every producer watches a value that is recomputed constantly — the finished
 * listing count refreshes on each market message, the drink panel redraws on
 * each inventory change — so "the value is bad" is never the question. The
 * question is always "is it *newly* bad", and that is a two-argument function
 * over the previous observation and the current one. Written as such it can be
 * tested without a DOM, a websocket or a clock, which is the only reason these
 * are separate files at all.
 */

/**
 * Whether more listings have finished than last time we looked.
 *
 * Only an increase. Collecting the spoils takes the count *down*, and being
 * told about that is being told about something you just did yourself. The
 * first observation of a session is not a change either: the count was already
 * whatever it was before the page loaded, and announcing it on load would fire
 * on every refresh.
 *
 * @param {number|null} previous - Count at the last observation; null on the first
 * @param {number} current - Count now
 * @returns {boolean} True when this is a rise from a known previous count
 */
export function listingsNewlyFinished(previous, current) {
    if (previous === null || previous === undefined) return false;
    return Number(current) > Number(previous);
}

/**
 * Whether a countdown has just fallen below its warning threshold.
 *
 * A state machine with one bit, because the interesting event is the *crossing*
 * and the value crosses once but is observed thousands of times. `armed` means
 * "the last thing seen was healthy, so a dip below counts as news"; going back
 * above the threshold — a restock — re-arms it, which is what makes the second
 * time you run low as loud as the first.
 *
 * The initial state is armed on purpose: opening the game to a supply that is
 * already below the threshold is worth one message. The service's cooldown is
 * what stops that becoming a message per redraw.
 *
 * @param {Object} input - Current observation
 * @param {boolean} input.armed - Whether a dip would count as news
 * @param {number} input.secondsLeft - Time remaining on the soonest consumable
 * @param {number} input.thresholdSeconds - Where the warning starts
 * @returns {{fire: boolean, armed: boolean}} Whether to say something, and the next state
 */
export function thresholdCrossing({ armed, secondsLeft, thresholdSeconds }) {
    // An unmeasurable countdown is not a crossing in either direction — leave
    // the state exactly as it was rather than re-arming on a missing reading
    if (!Number.isFinite(secondsLeft) || !(thresholdSeconds > 0)) {
        return { fire: false, armed };
    }

    if (secondsLeft > thresholdSeconds) {
        return { fire: false, armed: true };
    }
    return { fire: armed === true, armed: false };
}

/**
 * Whether a snapshotted queue has run out by now.
 *
 * A snapshot is taken when you switch *away* from a character, and never
 * updated while you are elsewhere — so this cannot observe that character
 * stopping. It projects: the queue held so many seconds of work at the moment
 * of the switch, and that many seconds have since gone by. Anything the
 * character did that we did not capture, or anything added to its queue from
 * another device, is invisible to it.
 *
 * A queue with an unbounded action in it never runs out and is excluded rather
 * than guessed at. A snapshot with no actions at all was already empty when you
 * left, which counts immediately.
 *
 * @param {Object} snapshot - From queue-snapshot.js
 * @param {number} now - Epoch ms
 * @returns {boolean} True when the queue is projected to be exhausted
 */
export function isQueueExhausted(snapshot, now) {
    if (!snapshot || snapshot.hasInfiniteAction) return false;
    if (!snapshot.timestamp) return false;

    const actions = Array.isArray(snapshot.actions) ? snapshot.actions : [];
    if (!actions.length) return true;

    const elapsedSeconds = (now - snapshot.timestamp) / 1000;
    return elapsedSeconds >= (Number(snapshot.totalQueueSeconds) || 0);
}

/**
 * What a `labyrinth_updated` payload says about whether a run is going.
 *
 * Three answers rather than two, and the third is the important one. A run
 * *finishing* is a transition, so it can only be read off a pair of
 * observations — and a payload that simply does not describe the run's state
 * must not be allowed to look like the end of one. Announcing "your run
 * finished" in the middle of a run is the failure this exists to prevent, so
 * anything short of the server saying so reads as `unknown` and changes
 * nothing.
 *
 * `isActive` is the server's own flag and is believed outright when present.
 * Without it the grid and the queued path stand in: both exist only while a run
 * does, which is the same test the supplies planner uses. A payload with
 * neither the flag nor either of them is not evidence of anything.
 *
 * @param {Object|null} labyrinth - A `labyrinth_updated` payload's `labyrinth`,
 *   or `characterData.characterLabyrinth`
 * @returns {'active'|'ended'|'unknown'} What can be said about the run
 */
export function labyrinthRunState(labyrinth) {
    if (!labyrinth || typeof labyrinth !== 'object') return 'unknown';
    if (typeof labyrinth.isActive === 'boolean') return labyrinth.isActive ? 'active' : 'ended';

    const filled = (value) =>
        (Array.isArray(value) && value.length > 0) || (typeof value === 'string' && value.length > 2);
    if (filled(labyrinth.roomData) || filled(labyrinth.pathData)) return 'active';
    return 'unknown';
}

/**
 * How many deaths have happened since the last look.
 *
 * The server's `deathCount` is a running total for the combat session, so the
 * event is the *rise* and never the value. Two things make a rise the only
 * usable reading: the count is republished on every battle whether or not
 * anything died, and starting a new session takes it back down — a fall is a
 * fresh session rather than a resurrection, and is worth no message at all.
 *
 * The first observation is not a rise either. Whatever the count was when the
 * page loaded, it was already that before anybody was watching.
 *
 * @param {number|null} previous - Count at the last observation; null on the first
 * @param {number} current - Count now
 * @returns {number} Deaths newly seen; 0 when there is no rise to report
 */
export function newDeaths(previous, current) {
    const now = Number(current);
    if (!Number.isFinite(now)) return 0;
    if (previous === null || previous === undefined) return 0;

    const before = Number(previous);
    if (!Number.isFinite(before)) return 0;
    return now > before ? now - before : 0;
}

/**
 * Which characters have gone idle since the last look.
 *
 * Edge-triggered against what was already announced, keyed by the snapshot's
 * own timestamp: a character stays "announced" until a *newer* snapshot appears
 * for it, which is exactly when you last switched away from it again.
 *
 * @param {Array<Object>} snapshots - Other characters' snapshots
 * @param {number} now - Epoch ms
 * @param {Map<string, number>} announced - characterId → the snapshot timestamp already announced
 * @returns {Array<{characterId: string, characterName: string, timestamp: number}>} Newly idle
 */
export function newlyIdleCharacters(snapshots, now, announced) {
    const results = [];

    for (const snapshot of snapshots || []) {
        if (!snapshot?.characterId) continue;
        if (!isQueueExhausted(snapshot, now)) continue;
        if (announced?.get(snapshot.characterId) === snapshot.timestamp) continue;

        results.push({
            characterId: snapshot.characterId,
            characterName: snapshot.characterName || 'A character',
            timestamp: snapshot.timestamp,
        });
    }
    return results;
}
