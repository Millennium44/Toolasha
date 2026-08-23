/**
 * Dungeon party readiness
 *
 * What can honestly be checked *before* the party enters, and — just as
 * importantly — what cannot.
 *
 * ## The shape of the problem
 *
 * A dungeon run is the one combat activity where stopping halfway is expensive:
 * the entry key is already spent, and the member who ran out of food takes the
 * whole party's clear down with them. So the useful moment to check is the
 * lobby, before the key is committed. The trouble is that the lobby is also the
 * moment the client knows least.
 *
 * The pre-run payload (`characterData.partyInfo`) carries member IDs, names,
 * the selected dungeon and its tier. It carries **no** equipment, **no**
 * consumables and **no** levels for anybody. Everything richer arrives with
 * `new_battle`, which is to say after the key is spent. A cached profile — one
 * the player happened to open in game at some point — can fill in a member's
 * gear, abilities and skills, and nothing can fill in their food.
 *
 * ## So this module reports three states, never two
 *
 * Every line is `known`, `unknown` or absent, and `unknown` carries the reason.
 * The alternative — quietly treating an unknown as fine — is the failure mode
 * that makes a readiness check worse than no readiness check: a green card that
 * means "I could not see four of the five people" reads exactly like a green
 * card that means "everyone is stocked".
 *
 * Pure throughout. Party rosters, inventories, profiles and run history all
 * arrive as arguments; nothing here imports game state.
 */

import { levelGapDebuff } from './dungeon-level-gap.js';

/** Why a member's supplies could not be read */
export const UNKNOWN_CONSUMABLES = 'not in party data';

/** Why a member's level could not be read */
export const UNKNOWN_LEVEL = 'no captured profile';

/** One entry key per clear — the one dungeon quantity that needs no measuring */
export const KEYS_PER_RUN = 1;

/**
 * How many whole runs a stock covers, given how long a run takes.
 *
 * Whole runs, floored: half a run of food is not a run, and a party that stops
 * on wave six has spent the key either way.
 *
 * @param {number} secondsLeft - Until the stock runs out; `Infinity` when unused
 * @param {number|null} runSeconds - How long one run takes
 * @returns {number|null} Whole runs, or null when either side is unknown
 */
export function runsCovered(secondsLeft, runSeconds) {
    if (!(runSeconds > 0)) return null;
    if (!Number.isFinite(secondsLeft)) return null;
    if (!(secondsLeft >= 0)) return null;
    return Math.floor(secondsLeft / runSeconds);
}

/**
 * A dungeon's typical run length, from this character's own recorded runs.
 *
 * The median rather than the mean, because a run history contains disconnects
 * and afk restarts, and one four-hour "run" drags a mean far enough to make the
 * coverage figure useless.
 *
 * @param {Array<Object>} runs - Stored runs (`{dungeonName, tier, duration}`, ms)
 * @param {Object} [match] - Which runs count
 * @param {string} [match.dungeonName] - The dungeon
 * @param {number|null} [match.tier] - Its tier; runs with no tier recorded still count
 * @returns {{seconds: number, samples: number}|null} Null without usable history
 */
export function typicalRunSeconds(runs, { dungeonName, tier = null } = {}) {
    if (!dungeonName || dungeonName === 'Unknown') return null;

    const durations = [];
    for (const run of runs || []) {
        if (!run || run.dungeonName !== dungeonName) continue;
        if (tier !== null && tier !== undefined && run.tier !== null && run.tier !== undefined && run.tier !== tier) {
            continue;
        }
        const ms = Number(run.duration ?? run.totalTime);
        if (Number.isFinite(ms) && ms > 0) durations.push(ms);
    }

    if (!durations.length) return null;

    durations.sort((a, b) => a - b);
    const mid = Math.floor(durations.length / 2);
    const median = durations.length % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid];

    return { seconds: median / 1000, samples: durations.length };
}

/**
 * The key line: what is held against what the plan wants.
 *
 * @param {Object} input - The key situation
 * @param {string|null} input.itemHrid - The dungeon's entry key
 * @param {string} [input.itemName] - Its display name
 * @param {number} input.held - How many are in the inventory
 * @param {number} input.runsPlanned - How many runs the player intends
 * @returns {{itemHrid: string|null, itemName: string, held: number, runsPlanned: number,
 *   runsCovered: number, shortfall: number, enough: boolean}|null} Null outside a dungeon
 */
export function keyReadiness({ itemHrid, itemName = '', held = 0, runsPlanned = 1 } = {}) {
    if (!itemHrid) return null;

    const stock = Math.max(0, Number(held) || 0);
    const planned = Math.max(0, Math.floor(Number(runsPlanned) || 0));
    const covered = Math.floor(stock / KEYS_PER_RUN);

    return {
        itemHrid,
        itemName: itemName || itemHrid.split('/').pop(),
        held: stock,
        runsPlanned: planned,
        runsCovered: covered,
        shortfall: Math.max(0, planned * KEYS_PER_RUN - stock),
        enough: covered >= planned,
    };
}

/**
 * One party member's line.
 *
 * A member whose consumables were never visible gets `runsCovered: null` and a
 * reason, not a zero and not an optimistic blank.
 *
 * @param {Object} input - What is known about them
 * @param {string} input.name - Their name
 * @param {boolean} [input.isSelf] - Whether this is the logged-in character
 * @param {Array<Object>|null} [input.forecasts] - Their consumables as
 *   `consumable-forecast` normalised them, or null when never seen
 * @param {number|null} [input.combatLevel] - Their combat level, where known
 * @param {number|null} [input.runSeconds] - How long one run takes
 * @param {string} [input.measuredFrom] - Where the consumable reading came from
 * @returns {{name: string, isSelf: boolean, combatLevel: number|null, runsCovered: number|null,
 *   secondsLeft: number|null, limitedBy: string|null, unknown: string|null, measuredFrom: string|null}}
 */
export function memberReadiness({
    name,
    isSelf = false,
    forecasts = null,
    combatLevel = null,
    runSeconds = null,
    measuredFrom = null,
} = {}) {
    const row = {
        name: name || 'Unknown player',
        isSelf: Boolean(isSelf),
        combatLevel: Number.isFinite(combatLevel) && combatLevel > 0 ? combatLevel : null,
        runsCovered: null,
        secondsLeft: null,
        limitedBy: null,
        unknown: UNKNOWN_CONSUMABLES,
        measuredFrom: null,
    };

    if (!Array.isArray(forecasts) || !forecasts.length) return row;

    // A run ends on the first empty slot, so the member's figure is the minimum
    // over slots that are actually being consumed — a slot with no rate is not
    // "lasts forever", it is "not measured", and must not win a minimum
    let soonest = null;
    for (const entry of forecasts) {
        if (!Number.isFinite(entry?.secondsLeft)) continue;
        if (!soonest || entry.secondsLeft < soonest.secondsLeft) soonest = entry;
    }

    if (!soonest) return row;

    row.unknown = null;
    row.measuredFrom = measuredFrom;
    row.secondsLeft = soonest.secondsLeft;
    row.limitedBy = soonest.name || soonest.itemHrid || null;
    row.runsCovered = runsCovered(soonest.secondsLeft, runSeconds);
    return row;
}

/**
 * Who runs dry first, among the members whose supplies could actually be read.
 *
 * Scoped to the known ones on purpose: "you stop first" is a different claim
 * from "you stop first out of the one person I could see", and the card says
 * which by reporting how many were counted.
 *
 * @param {Array<Object>} rows - From `memberReadiness`
 * @returns {{name: string, runsCovered: number|null, secondsLeft: number,
 *   limitedBy: string|null, known: number, total: number}|null}
 */
export function whoStopsFirst(rows) {
    const list = rows || [];
    const known = list.filter((row) => row && row.unknown === null && Number.isFinite(row.secondsLeft));
    if (!known.length) return null;

    const first = known.reduce((worst, row) => (row.secondsLeft < worst.secondsLeft ? row : worst));

    return {
        name: first.name,
        runsCovered: first.runsCovered,
        secondsLeft: first.secondsLeft,
        limitedBy: first.limitedBy,
        known: known.length,
        total: list.length,
    };
}

/**
 * Level-gap warnings for the roster, in party order.
 *
 * Members whose level is unknown are excluded from the comparison rather than
 * counted as low — the top of the party decides everyone else's penalty, and an
 * absent member could be the top.
 *
 * @param {Array<Object>} rows - From `memberReadiness`
 * @returns {{warnings: Array<{name: string, debuff: number}>, unknownLevels: Array<string>}}
 */
export function levelGapWarnings(rows) {
    const list = rows || [];
    const levels = list.map((row) => row?.combatLevel).filter((level) => Number.isFinite(level) && level > 0);
    const unknownLevels = list.filter((row) => !Number.isFinite(row?.combatLevel)).map((row) => row?.name || '?');

    if (levels.length < 2) return { warnings: [], unknownLevels };

    const topLevel = Math.max(...levels);
    const warnings = [];
    for (const row of list) {
        if (!Number.isFinite(row?.combatLevel)) continue;
        const debuff = levelGapDebuff(row.combatLevel, topLevel);
        if (typeof debuff === 'number' && debuff < 0) warnings.push({ name: row.name, debuff });
    }

    return { warnings, unknownLevels };
}

/**
 * The footnotes the card is obliged to carry.
 *
 * Built from what the model actually turned out to be missing rather than
 * printed unconditionally, so a card with nothing unknown does not spend four
 * lines apologising for gaps it does not have.
 *
 * @param {Object} model - From `buildReadiness`
 * @returns {Array<string>}
 */
export function readinessFootnotes(model) {
    const notes = [];
    const members = model?.members || [];

    if (members.some((row) => row.unknown === UNKNOWN_CONSUMABLES && !row.isSelf)) {
        notes.push(
            "A party member's food and drinks are only in the battle payload, which arrives after the key is " +
                'spent — before the run there is no source for them, cached or otherwise.'
        );
    }
    if (members.some((row) => row.unknown === UNKNOWN_CONSUMABLES && row.isSelf)) {
        notes.push('Your own supplies need a measured rate: fight something with food or drinks equipped first.');
    }
    if (!model?.runSeconds) {
        notes.push(
            'Coverage is in time rather than runs — no finished run of this dungeon is on record to say how ' +
                'long one takes.'
        );
    }
    if (model?.levelGap?.unknownLevels?.length) {
        notes.push(
            `Level gap could not be checked for ${model.levelGap.unknownLevels.join(', ')} — a member's level ` +
                'is only readable from a profile you opened in game.'
        );
    }
    if (model?.lintScope) notes.push(model.lintScope);

    return notes;
}

/**
 * The whole card, assembled.
 *
 * @param {Object} input - Everything already resolved by the caller
 * @param {Object} input.dungeon - `{actionHrid, name, tier}`
 * @param {number} input.runsPlanned - The plan
 * @param {Object|null} input.keys - From `keyReadiness`
 * @param {Array<Object>} input.members - From `memberReadiness`
 * @param {Array<string>} [input.lint] - Gear/aura warnings, already worded
 * @param {string} [input.lintScope] - What the lint was allowed to look at
 * @param {{seconds: number, samples: number}|null} [input.runLength] - From `typicalRunSeconds`
 * @returns {Object} The model a renderer draws without deciding anything
 */
export function buildReadiness({
    dungeon,
    runsPlanned = 1,
    keys = null,
    members = [],
    lint = [],
    lintScope = '',
    runLength = null,
} = {}) {
    const model = {
        dungeon: dungeon || null,
        runsPlanned: Math.max(0, Math.floor(Number(runsPlanned) || 0)),
        runSeconds: runLength?.seconds ?? null,
        runSamples: runLength?.samples ?? 0,
        keys,
        members: members || [],
        lint: lint || [],
        lintScope,
        levelGap: levelGapWarnings(members),
        stopsFirst: whoStopsFirst(members),
    };

    model.footnotes = readinessFootnotes(model);
    return model;
}

export default {
    UNKNOWN_CONSUMABLES,
    UNKNOWN_LEVEL,
    KEYS_PER_RUN,
    runsCovered,
    typicalRunSeconds,
    keyReadiness,
    memberReadiness,
    whoStopsFirst,
    levelGapWarnings,
    readinessFootnotes,
    buildReadiness,
};
