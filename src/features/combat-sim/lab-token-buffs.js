/**
 * Labyrinth token buffs as something a simulation can be *given*.
 *
 * The Configure tab's Labyrinth Buffs section used to be a readout: it printed
 * whatever the live character had bought, in three groups, and nothing could be
 * done with it. That is the wrong shape for a simulator — the question people
 * bring to the Lab Sim is "what would this fight look like if I had Damage 8",
 * and the only way to answer it was to go and buy Damage 8.
 *
 * So the levels are editable, and this module owns the arithmetic behind them,
 * free of the DOM so it can be tested as the small pure thing it is:
 *
 * - what the live run has (`readLiveTokenLevels`),
 * - what has been typed over it (`sanitizeTokenLevels`, `resolveTokenLevels`),
 * - and the buff array a simulation actually takes (`buildLabyrinthCombatBuffs`),
 *   in the same shape `labyrinthClearRate.getLabyrinthCombatBuffs()` produces,
 *   because everything downstream of it already reads that shape.
 *
 * Only the four *combat* tokens become simulation arguments. The skilling and
 * utility tokens are levels the combat engine has no reader for — the Skilling
 * tab edits its own copies of those in Player Setup — so they are carried here
 * as a readout and deliberately not offered as an override that would do
 * nothing.
 */

import { UPGRADE_STEP, UPGRADE_MAX_LEVEL } from '../combat/labyrinth-formulas.js';

/** Every labyrinth token caps at the same level; the game calls it max. */
export const MAX_LAB_TOKEN_LEVEL = UPGRADE_MAX_LEVEL;

/**
 * The section's own grouping, kept exactly as the readout had it.
 *
 * A `buff` entry carrying `uniqueKey`/`typeHrid`/`valueKey` is one the combat
 * engine reads — those, and only those, are editable and reach a simulation.
 */
export const LAB_TOKEN_BUFF_GROUPS = [
    {
        label: 'Combat',
        buffs: [
            {
                key: 'labyrinthCombatDamageLevel',
                name: 'Damage',
                uniqueKey: 'combat_damage',
                typeHrid: '/buff_types/damage',
                valueKey: 'ratioBoost',
            },
            {
                key: 'labyrinthAttackSpeedLevel',
                name: 'Atk Speed',
                uniqueKey: 'attack_speed',
                typeHrid: '/buff_types/attack_speed',
                valueKey: 'ratioBoost',
            },
            {
                key: 'labyrinthCastSpeedLevel',
                name: 'Cast Speed',
                uniqueKey: 'cast_speed',
                typeHrid: '/buff_types/cast_speed',
                valueKey: 'flatBoost',
            },
            {
                key: 'labyrinthCriticalRateLevel',
                name: 'Crit Rate',
                uniqueKey: 'critical_rate',
                typeHrid: '/buff_types/critical_rate',
                valueKey: 'flatBoost',
            },
        ],
    },
    {
        label: 'Skilling',
        buffs: [
            { key: 'labyrinthSkillActionSpeedLevel', name: 'Speed' },
            { key: 'labyrinthSkillingEfficiencyLevel', name: 'Efficiency' },
            { key: 'labyrinthSkillingSuccessLevel', name: 'Success' },
            { key: 'labyrinthSkillingDoubleProgressLevel', name: 'Double' },
        ],
    },
    {
        label: 'Other',
        buffs: [
            { key: 'labyrinthExperienceLevel', name: 'Experience' },
            { key: 'labyrinthCooldownLevel', name: 'Cooldown' },
            { key: 'labyrinthTorchLevel', name: 'Torch' },
            { key: 'labyrinthShroudLevel', name: 'Shroud' },
            { key: 'labyrinthBeaconLevel', name: 'Beacon' },
            { key: 'labyrinthAutomationLevel', name: 'Automation' },
        ],
    },
];

/** Every token, flattened, in the order the section draws them. */
export const LAB_TOKEN_BUFF_DEFS = LAB_TOKEN_BUFF_GROUPS.flatMap((group) => group.buffs);

/** The tokens a combat simulation actually reads. */
export const LAB_TOKEN_COMBAT_DEFS = LAB_TOKEN_BUFF_DEFS.filter((def) => Boolean(def.uniqueKey));

/** characterInfo key → its definition, for the readers below. */
const DEFS_BY_KEY = new Map(LAB_TOKEN_BUFF_DEFS.map((def) => [def.key, def]));

/**
 * Whether a token level reaches a combat simulation at all.
 * @param {string} key - characterInfo key, e.g. `labyrinthCastSpeedLevel`
 * @returns {boolean}
 */
export function isCombatTokenBuff(key) {
    return Boolean(DEFS_BY_KEY.get(key)?.uniqueKey);
}

/**
 * Clamp anything to a level this game accepts.
 * @param {*} value - Whatever was typed, stored or received
 * @returns {number} 0…MAX_LAB_TOKEN_LEVEL
 */
function clampLevel(value) {
    const level = Math.floor(Number(value) || 0);
    return Math.min(MAX_LAB_TOKEN_LEVEL, Math.max(0, level));
}

/**
 * The levels the live run is carrying.
 * @param {Object} [characterInfo] - `dataManager.characterData.characterInfo`
 * @returns {Object} buffKey → level, every key present
 */
export function readLiveTokenLevels(characterInfo) {
    const levels = {};
    for (const def of LAB_TOKEN_BUFF_DEFS) {
        levels[def.key] = clampLevel(characterInfo?.[def.key]);
    }
    return levels;
}

/**
 * Keep only the overrides that mean something: a known token, a level in range.
 *
 * A stored map survives game updates that rename or retire a token, so an
 * unknown key is dropped rather than carried into a simulation that would read
 * it as nothing anyway.
 * @param {Object} [raw] - Whatever came back from storage or an input
 * @returns {Object} buffKey → level, only for keys that were actually set
 */
export function sanitizeTokenLevels(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const levels = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!DEFS_BY_KEY.has(key)) continue;
        if (value === null || value === undefined || value === '') continue;
        if (!Number.isFinite(Number(value))) continue;
        levels[key] = clampLevel(value);
    }
    return levels;
}

/**
 * The levels a simulation should run under: live, with the overrides on top.
 * @param {Object} live - From `readLiveTokenLevels`
 * @param {Object} [overrides] - From `sanitizeTokenLevels`
 * @returns {Object} buffKey → level, every key present
 */
export function resolveTokenLevels(live, overrides) {
    const resolved = { ...readLiveTokenLevels(live) };
    for (const [key, value] of Object.entries(sanitizeTokenLevels(overrides))) {
        resolved[key] = value;
    }
    return resolved;
}

/**
 * The combat buff array these levels come to.
 *
 * Same shape, same order and the same "a level of zero grants nothing" rule as
 * `labyrinthClearRate.getLabyrinthCombatBuffs()`, so a caller can hand this to
 * the simulator anywhere that one was accepted.
 * @param {Object} levels - buffKey → level, e.g. from `resolveTokenLevels`
 * @returns {Array<Object>} Buff objects in the shape the server sends
 */
export function buildLabyrinthCombatBuffs(levels) {
    const buffs = [];
    for (const def of LAB_TOKEN_COMBAT_DEFS) {
        const level = clampLevel(levels?.[def.key]);
        if (level <= 0) continue;
        const buff = {
            uniqueHrid: `/buff_uniques/labyrinth_upgrade_${def.uniqueKey}`,
            typeHrid: def.typeHrid,
            ratioBoost: 0,
            ratioBoostLevelBonus: 0,
            flatBoost: 0,
            flatBoostLevelBonus: 0,
            startTime: '0001-01-01T00:00:00Z',
            duration: 0,
        };
        buff[def.valueKey] = level * UPGRADE_STEP;
        buffs.push(buff);
    }
    return buffs;
}

/**
 * Which tokens are being simulated at something other than what is owned.
 *
 * The panel says this out loud — a sim run under invented buffs and reported as
 * if it were the live character is the one failure mode this whole feature can
 * produce.
 * @param {Object} live - From `readLiveTokenLevels`
 * @param {Object} [overrides] - From `sanitizeTokenLevels`
 * @returns {Array<Object>} `[{ key, name, live, chosen }]`, in section order
 */
export function tokenLevelDifferences(live, overrides) {
    const liveLevels = readLiveTokenLevels(live);
    const chosen = sanitizeTokenLevels(overrides);
    const differences = [];
    for (const def of LAB_TOKEN_BUFF_DEFS) {
        if (!(def.key in chosen)) continue;
        if (chosen[def.key] === liveLevels[def.key]) continue;
        differences.push({ key: def.key, name: def.name, live: liveLevels[def.key], chosen: chosen[def.key] });
    }
    return differences;
}

/**
 * A one-line summary of those differences, for the collapsed section header.
 * @param {Object} live - From `readLiveTokenLevels`
 * @param {Object} [overrides] - From `sanitizeTokenLevels`
 * @returns {string} Empty when the simulation is running on the live levels
 */
export function describeTokenOverrides(live, overrides) {
    const differences = tokenLevelDifferences(live, overrides);
    if (!differences.length) return '';
    return differences.map((entry) => `${entry.name} ${entry.live}→${entry.chosen}`).join(', ');
}
