/** Saved room inputs, independent of unrelated loadouts and the current build. */
import { deriveObserved, MIN_LAB_FIGHTS } from './labyrinth-replay-check.js';
import { FINGERPRINT_VERSION } from './labyrinth-fingerprint.js';

/**
 * A recorded cohort needs at least this many fights before a replay is worth a sim.
 *
 * Saved builds made it possible to replay a cohort the current gear no longer
 * matches, which is a real gain — but it is not a reason to spend a full
 * simulation on a cohort that cannot say anything when it finishes. One fight
 * has no rate: every metric comes back `insufficient` and the diagnosis is the
 * sentence asking for more fights, after the worker has run for as long as the
 * stop rule allows. Three is where a cohort starts to be worth the sim, which
 * is the bar this had before saved builds arrived.
 *
 * Above this bar and below {@link MIN_LAB_FIGHTS} a cohort is *exploration*: the
 * comparison runs and is shown, flagged as exploratory, and no metric in it
 * states a verdict. Five clean fights is what this repo's combat validation
 * treats as the threshold for an accuracy verdict, and that is what
 * `compareMetric` already enforces per metric; the flag is so the panel says so
 * rather than leaving the reader to infer it from four `insufficient` rows.
 */
export const MIN_REPLAY_FIGHTS = 3;

/** Copy plain simulation inputs at the fight boundary; never retain live references. */
export function copyReplayInputs(value) {
    if (
        value?.version !== 1 ||
        !value.playerDTO?.hrid ||
        !Array.isArray(value.crates) ||
        !Array.isArray(value.labyrinthCombatBuffs) ||
        typeof value.fullAbilities !== 'boolean' ||
        !value.communityBuffs ||
        typeof value.communityBuffs !== 'object'
    )
        return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

/** Stable equality for JSON inputs, without making object insertion order significant. */
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])])
    );
}

/**
 * Ignore fields the labyrinth engine does not use when comparing saved builds.
 *
 * Exported because the recorder interns saved inputs by this key: consecutive
 * fights in a run share a build exactly, and storing the whole build on each of
 * them multiplied the pool's size by fifteen. The key is the full canonical
 * string, never a hash — two builds that compare equal here are the same build
 * to the simulator, and nothing downstream can mistake one for another.
 *
 * @param {Object} inputs - Saved replay inputs, as {@link copyReplayInputs} returns
 * @returns {string} A canonical string equal for builds the engine cannot tell apart
 */
export function replayBuildKey(inputs) {
    return buildKey(inputs);
}

/** Ignore fields the labyrinth engine does not use when comparing saved builds. */
function buildKey(inputs) {
    const playerDTO = { ...inputs.playerDTO };
    // The worker explicitly removes these in labyrinth mode; crate buffs replace them.
    delete playerDTO.food;
    delete playerDTO.drinks;
    // These support the skilling simulator or build editor. The combat worker
    // consumes neither tokenUpgrades nor these level maps: shared community
    // buffs arrive separately, and guildCombatBuffs already carries the resolved
    // combat effects. Keep those actual buffs in the key.
    delete playerDTO.tokenUpgrades;
    delete playerDTO.communityBuffLevels;
    delete playerDTO.guildShrineLevels;
    // Recorded labyrinth replays leave task damage off. Normal combat between
    // room visits can change task progress without changing the replayed build.
    delete playerDTO.taskMonsterHrids;
    delete playerDTO.taskMonsterRemaining;
    // Player.createFromDTO reads only the seven combat levels.
    for (const skill of [
        'woodcutting',
        'foraging',
        'milking',
        'cooking',
        'brewing',
        'cheesesmithing',
        'crafting',
        'tailoring',
        'alchemy',
        'enhancing',
    ])
        delete playerDTO[`${skill}Level`];
    return JSON.stringify(stable({ ...inputs, playerDTO }));
}

/**
 * A concise reference for matching a comparison to its saved build. The short
 * hash is only a display label; cohorts still use the full key, so a hash
 * collision cannot combine fights. Names come from the current game data.
 */
export function replayBuildSummary(inputs, itemDetailMap = {}) {
    const key = buildKey(inputs);
    let hash = 5381;
    for (let i = 0; i < key.length; i++) hash = (Math.imul(hash, 33) ^ key.charCodeAt(i)) >>> 0;
    const id = hash.toString(16).padStart(8, '0');
    const equipment = inputs.playerDTO.equipment;
    const weapon = equipment?.['/equipment_types/main_hand'] || equipment?.['/equipment_types/two_hand'];
    const name = weapon ? itemDetailMap?.[weapon.hrid]?.name || 'Equipped weapon' : 'Unarmed';
    const enhancement = Math.max(0, Math.floor(Number(weapon?.enhancementLevel) || 0));
    return { id, label: `Build ${id} · ${name}${enhancement > 0 ? ` +${enhancement}` : ''}` };
}

/**
 * Keep distinct recorded builds separate and explain every eligibility filter.
 *
 * A cohort under {@link MIN_REPLAY_FIGHTS} is not a candidate at all — its
 * fights are counted into `excluded.tooFew` so the panel can say how much is
 * waiting rather than dropping them silently. A cohort over that bar but under
 * {@link MIN_LAB_FIGHTS} is a candidate flagged `exploratory`.
 *
 * @param {Array<Object>} attempts - Recorded attempts, newest last
 * @param {string|null} [fingerprint] - The current build's fingerprint, which is
 *   what a record with no saved inputs has to match to be replayable at all
 * @returns {{candidates: Array<{group: Object, inputs: Object|null, exploratory: boolean}>,
 *   excluded: Object}}
 */
export function replayCandidates(attempts, fingerprint) {
    const cohorts = new Map();
    const excluded = { build: 0, invalidSnapshot: 0, incomplete: 0, wounded: 0, unknown: 0, legacy: 0, tooFew: 0 };
    for (const attempt of attempts) {
        const inputs = copyReplayInputs(attempt.replayInputs);
        if (attempt.replayInputs && !inputs) {
            excluded.invalidSnapshot++;
            continue;
        }
        if (!inputs && (!fingerprint || attempt.fingerprint !== fingerprint)) {
            excluded.build++;
            continue;
        }
        const key = inputs ? buildKey(inputs) : 'legacy-current-build';
        if (!cohorts.has(key)) cohorts.set(key, { inputs, attempts: [] });
        cohorts.get(key).attempts.push(attempt);
    }
    const candidates = [];
    for (const cohort of cohorts.values()) {
        // Saved-input equality replaces global fingerprint equality. Its schema
        // is validated above, so an unrelated fingerprint migration is harmless.
        const observed = deriveObserved(
            cohort.inputs
                ? cohort.attempts.map((attempt) => ({ ...attempt, fingerprintVersion: FINGERPRINT_VERSION }))
                : cohort.attempts
        );
        excluded.incomplete += observed.droppedIncomplete;
        excluded.wounded += observed.droppedNotCleanStart;
        excluded.unknown += observed.droppedUnknownOutcome;
        excluded.legacy += observed.droppedLegacyFingerprint;
        for (const group of observed) {
            // A cohort that cannot support a rate is not worth a simulation: it
            // would run to its stop rule and come back with every metric
            // `insufficient`. Its fights are reported, not discarded — they keep
            // accumulating and the cohort becomes a candidate once it clears the bar.
            if (group.fights < MIN_REPLAY_FIGHTS) {
                excluded.tooFew += group.fights;
                continue;
            }
            candidates.push({ group, inputs: cohort.inputs, exploratory: group.fights < MIN_LAB_FIGHTS });
        }
    }
    candidates.sort((a, b) => b.group.fights - a.group.fights);
    return { candidates, excluded };
}
