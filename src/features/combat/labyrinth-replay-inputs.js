/** Saved room inputs, independent of unrelated loadouts and the current build. */
import { deriveObserved } from './labyrinth-replay-check.js';
import { FINGERPRINT_VERSION } from './labyrinth-fingerprint.js';

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

/** Keep distinct recorded builds separate and explain every eligibility filter. */
export function replayCandidates(attempts, fingerprint) {
    const cohorts = new Map();
    const excluded = { build: 0, invalidSnapshot: 0, incomplete: 0, wounded: 0, unknown: 0, legacy: 0 };
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
        for (const group of observed) candidates.push({ group, inputs: cohort.inputs });
    }
    candidates.sort((a, b) => b.group.fights - a.group.fights);
    return { candidates, excluded };
}
