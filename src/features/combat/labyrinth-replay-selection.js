/**
 * Which recorded cohorts a calibration replay spends its simulations on.
 *
 * A replay runs at most {@link MAX_REPLAY_GROUPS} cohorts because each one
 * costs a full simulation, and by default it spends them on the best-sampled
 * cohorts — `replayCandidates` sorts by fight count, so the top three run and
 * the rest are reported as deferred. That default is right when nothing is
 * known about which cohort matters, and wrong exactly when something is: a
 * build worn since yesterday has the fewest fights and therefore sorts last,
 * so the cohort a player most wants checked is the one that never runs.
 *
 * This module is the choice, kept out of both the cache and the panel: the
 * stable key a cohort is picked by, the description the picker draws, the
 * rule that turns a stored selection into the cohorts actually run, and the
 * per-character storage it survives in.
 */

import { replayBuildSummary, replayBuildKey, replayBuildIdFor, MAX_REPLAY_GROUPS } from './labyrinth-replay-inputs.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';
import { DISCARD_LEGACY } from './labyrinth-outcomes.js';

/** Per-character key holding the chosen cohort keys, as an array of strings. */
export const REPLAY_SELECTION_KEY = 'labyrinthReplayCohorts';

/** Store the selection shares with the rest of the labyrinth's persisted state. */
const REPLAY_SELECTION_STORE = 'labyrinth';

/** What a cohort with no saved inputs is keyed and labelled under. */
const LEGACY_BUILD_ID = 'current';

/**
 * A stable identity for one replay candidate, for storing a choice against.
 *
 * Built from the cohort's build and the *bucket* its fights pool into, never
 * from `roomLevel`: the bucket is `deriveObserved`'s own group identity and
 * does not move, while `roomLevel` is the median of the levels recorded so far
 * and shifts with every new fight — a key built on it would go stale on its
 * own, for a cohort that never changed.
 *
 * The build half is `replayBuildIdFor` over the full canonical build string,
 * not the 8-hex hash `replayBuildSummary` shows beside every comparison. That
 * hash is a display label and is short enough to collide — two realistic
 * builds differing only in a few levels do, and the test beside this pins a
 * pair that does — and here the id is identity, not decoration. A collision
 * either loses the pick to the stale fallback (both cohorts match one key, so
 * the count check refuses it) or, once one of the two colliding cohorts leaves
 * the pool, silently replays the other in its place.
 *
 * No `itemDetailMap` is taken: the display hash never depended on one either —
 * game data only ever supplied the weapon's *name* — so passing it here was
 * always a promise the key could not keep.
 *
 * @param {{group: Object, inputs: Object|null}} candidate - One `replayCandidates` entry
 * @returns {string} A key equal across replays for the same cohort
 */
export function replayCohortKey(candidate) {
    const buildId = candidate?.inputs ? replayBuildIdFor(replayBuildKey(candidate.inputs)) : LEGACY_BUILD_ID;
    const group = candidate?.group || {};
    const bucket = Number.isFinite(group.bucket) ? group.bucket : group.roomLevel;
    return `${buildId}|${group.monsterHrid}|${bucket}`;
}

/**
 * The eligible cohorts, described for a picker.
 *
 * Deliberately raw: the monster's hrid and the level span are handed over
 * rather than a formatted sentence, because the panel already knows how to
 * word both and a second naming scheme here would drift from the one the
 * comparisons are drawn under.
 *
 * @param {Array<Object>} candidates - From `replayCandidates`
 * @param {Object} [itemDetailMap] - Game item details, for build labels
 * @returns {Array<{key: string, buildLabel: string, monsterHrid: string, monsterName: string|null,
 *   roomLevel: number, levelLow: number, levelHigh: number, fights: number, exploratory: boolean,
 *   inputSource: string}>}
 */
export function describeReplayCohorts(candidates, itemDetailMap = {}) {
    return (candidates || []).map((candidate) => {
        const group = candidate.group || {};
        return {
            key: replayCohortKey(candidate),
            buildLabel: candidate.inputs
                ? replayBuildSummary(candidate.inputs, itemDetailMap).label
                : 'Current build (no saved inputs)',
            monsterHrid: group.monsterHrid,
            monsterName: group.monsterName || null,
            roomLevel: group.roomLevel,
            levelLow: Number.isFinite(group.levelLow) ? group.levelLow : group.roomLevel,
            levelHigh: Number.isFinite(group.levelHigh) ? group.levelHigh : group.roomLevel,
            fights: group.fights,
            exploratory: candidate.exploratory === true,
            inputSource: candidate.inputs ? 'recorded' : 'current',
        };
    });
}

/**
 * Turn a stored selection into the cohorts a replay actually runs.
 *
 * Three ways a selection does not apply, and all three fall back to the
 * default top-`MAX_REPLAY_GROUPS` rather than running something partial:
 *
 *   - **Empty.** Nothing was chosen, which is every user who never opened the
 *     picker. The default must be bit-for-bit what it was before this existed.
 *   - **Over the cap.** Refused outright rather than truncated: silently
 *     dropping the cohorts past the third would run something the player did
 *     not ask for while looking like it honoured the choice.
 *   - **Stale.** Cohorts are derived from the pool and regroup as fights
 *     accumulate — a build can be evicted, and a bucket can stop existing. A
 *     selection naming a cohort that is no longer a candidate is not a smaller
 *     selection; it is a choice about a pool that no longer exists, so the
 *     whole thing is dropped rather than running whatever happens to remain.
 *
 * The chosen cohorts keep `candidates` order (fight count descending), not the
 * order they were picked in, so the report reads the same either way.
 *
 * @param {Array<Object>} candidates - From `replayCandidates`
 * @param {Array<string>|null} selection - Stored cohort keys, if any
 * @returns {{chosen: Array<Object>, selection: {applied: boolean, requested: number,
 *   reason: 'empty'|'overCap'|'stale'|null}}}
 */
export function applyReplayCohortSelection(candidates, selection) {
    const list = Array.isArray(candidates) ? candidates : [];
    const wanted = [...new Set((Array.isArray(selection) ? selection : []).filter((key) => typeof key === 'string'))];
    const fallback = (reason) => ({
        chosen: list.slice(0, MAX_REPLAY_GROUPS),
        selection: { applied: false, requested: wanted.length, reason },
    });

    if (!wanted.length) return fallback('empty');
    if (wanted.length > MAX_REPLAY_GROUPS) return fallback('overCap');

    const keys = new Set(wanted);
    const chosen = list.filter((candidate) => keys.has(replayCohortKey(candidate)));
    if (chosen.length !== wanted.length) return fallback('stale');

    return { chosen, selection: { applied: true, requested: wanted.length, reason: null } };
}

/**
 * The cohort keys this character last chose, or an empty array.
 *
 * Persisted rather than held for one press: a player picking a cohort is
 * usually watching one build settle down, and presses Replay again after more
 * fights land. Re-picking every time would make the control cost more than the
 * default it exists to escape. It is per character because the cohorts are —
 * they come from that character's recorded fights.
 *
 * @returns {Promise<Array<string>>} Stored cohort keys, newest write wins
 */
export async function readReplayCohortSelection() {
    try {
        const stored = await readScoped(REPLAY_SELECTION_KEY, REPLAY_SELECTION_STORE, null, DISCARD_LEGACY);
        if (!Array.isArray(stored)) return [];
        // Not trimmed to the cap here: an over-cap stored value has to reach
        // `applyReplayCohortSelection` whole so it is refused and reported,
        // rather than quietly becoming a choice of its first three entries.
        return stored.filter((key) => typeof key === 'string' && key);
    } catch (error) {
        console.error('[LabyrinthReplaySelection] Reading the cohort selection failed:', error);
        return [];
    }
}

/**
 * Store this character's cohort choice, or clear it back to the default.
 *
 * Refuses an over-cap write instead of trimming it, for the reason
 * {@link applyReplayCohortSelection} refuses to run one.
 *
 * @param {Array<string>} keys - Cohort keys, or an empty array for the default
 * @returns {Promise<boolean>} Whether the selection was stored
 */
export async function writeReplayCohortSelection(keys) {
    const wanted = [...new Set((Array.isArray(keys) ? keys : []).filter((key) => typeof key === 'string' && key))];
    if (wanted.length > MAX_REPLAY_GROUPS) return false;
    try {
        await writeScoped(REPLAY_SELECTION_KEY, wanted, REPLAY_SELECTION_STORE);
        return true;
    } catch (error) {
        console.error('[LabyrinthReplaySelection] Storing the cohort selection failed:', error);
        return false;
    }
}
