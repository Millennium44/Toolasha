/**
 * Trigger Optimizer: the last finished result, remembered per character.
 *
 * A trigger search takes a while and its answer is fixed by its inputs, so the
 * last one is kept with a signature of everything that decided it. When the
 * Triggers chip opens on a setup with the same signature, the panel shows that
 * result again instead of an empty box. Only what the results box draws (and
 * Apply / Copy need) is stored; no sim samples.
 */

import { readScoped, writeScoped } from '../../utils/character-key.js';

/** Storage key, in the same character-scoped store as the chip's remembered choices */
export const TRIGGER_LAST_RESULT_KEY = 'combatSimTriggerLastResult';
const STORE = 'settings';

/** Changes beyond this many are dropped from the stored copy (the editor holds at most 4 rows × 10 slots × 5 players) */
const MAX_STORED_CHANGES = 200;

const CHANGE_FIELDS = [
    'key',
    'playerHrid',
    'playerName',
    'slotType',
    'itemHrid',
    'itemName',
    'rowIndex',
    'dependencyHrid',
    'conditionHrid',
    'comparatorHrid',
    'from',
    'to',
    'deltaScore',
    'se',
    'deltaXp',
    'deltaProfit',
    'deltaDeaths',
];
const COMBINED_FIELDS = ['deltaScore', 'se', 'deltaXp', 'deltaProfit', 'deltaDeaths', 'seeds'];
const RESULT_FIELDS = [
    'noTunables',
    'scope',
    'include',
    'objective',
    'precision',
    'minGain',
    'simCount',
    'tunableCount',
    'reliable',
    'stopped',
    'profitLeftOut',
    'unpriced',
    'valuationFailed',
];

function pick(source, fields) {
    const out = {};
    for (const field of fields) if (source?.[field] !== undefined) out[field] = source[field];
    return out;
}

/** JSON with object keys sorted, so equal values give equal text whatever order they were built in */
function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/** 53-bit string hash (cyrb53): a short fingerprint of a long signature */
function hash53(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * A fingerprint of everything that decides a trigger search's answer.
 * @param {Object} setup
 * @param {Map<string, string>|Object} setup.dtoSignatures - hrid → `buildDtoSignature` of every simulated member
 * @param {string} setup.zoneHrid - Zone
 * @param {number} setup.difficultyTier - Tier
 * @param {number} setup.playerIndex - The selected player
 * @param {string} setup.scope - 'me' or 'party'
 * @param {string} setup.include - Which rows are tuned
 * @param {string} setup.precision - Precision key
 * @param {number} setup.minGain - Minimum gain
 * @param {string} setup.objective - Objective key
 * @param {Object} [setup.communityBuffs] - Community buffs in force
 * @param {Object} [setup.pricing] - Price snapshot and pricing settings the profit figures were taken under
 * @param {string} [setup.scriptVersion] - The userscript build, so an update never replays an older algorithm
 * @param {string} [setup.gameVersion] - The game data version, so a game update never replays old stats
 * @returns {string}
 */
export function triggerRunSignature(setup) {
    const sigs =
        setup.dtoSignatures instanceof Map ? Object.fromEntries(setup.dtoSignatures) : setup.dtoSignatures || {};
    const text = stableJson({
        members: Object.keys(sigs)
            .sort()
            .map((hrid) => [hrid, sigs[hrid]]),
        zoneHrid: setup.zoneHrid ?? null,
        difficultyTier: Number(setup.difficultyTier) || 0,
        playerIndex: Number(setup.playerIndex) || 0,
        scope: setup.scope ?? null,
        include: setup.include ?? null,
        precision: setup.precision ?? null,
        minGain: Number(setup.minGain),
        objective: setup.objective ?? null,
        communityBuffs: setup.communityBuffs ?? null,
        pricing: setup.pricing ?? null,
        scriptVersion: setup.scriptVersion ?? null,
        gameVersion: setup.gameVersion ?? null,
    });
    return `${text.length}:${hash53(text)}`;
}

/**
 * The part of a result the results box and its buttons read, and nothing else.
 * @param {Object} result - From `runTriggerOptimization`
 * @returns {Object}
 */
export function compactTriggerResult(result) {
    const out = pick(result, RESULT_FIELDS);
    out.changes = (result?.changes || []).slice(0, MAX_STORED_CHANGES).map((c) => pick(c, CHANGE_FIELDS));
    if (result?.combined) out.combined = pick(result.combined, COMBINED_FIELDS);
    else out.combined = null;
    const names = (list) =>
        [...new Set((list || []).map((t) => t?.itemName).filter(Boolean))].map((itemName) => ({ itemName }));
    out.unchanged = names(result?.unchanged);
    out.unused = names(result?.unused);
    out.notPriced = names(result?.notPriced);
    return out;
}

/**
 * Remember a finished result. A stopped or missing one is not remembered.
 * @param {string} signature - From `triggerRunSignature`, taken when the run began
 * @param {Object|null} result - From `runTriggerOptimization`
 * @returns {Promise<boolean>} Whether it was stored
 */
export async function saveTriggerResult(signature, result) {
    if (!signature || !result || result.stopped) return false;
    try {
        await writeScoped(
            TRIGGER_LAST_RESULT_KEY,
            { signature, savedAt: Date.now(), result: compactTriggerResult(result) },
            STORE
        );
        return true;
    } catch (error) {
        console.error('[TriggerResultCache] Save failed:', error);
        return false;
    }
}

/** How long a remembered result is offered as the answer for an unchanged setup */
export const TRIGGER_RESULT_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * The remembered result for this signature, if the last one was for the same setup.
 * @param {string} signature - From `triggerRunSignature`
 * @returns {Promise<Object|null>} The compact result, or null
 */
export async function loadTriggerResult(signature) {
    try {
        const record = await readScoped(TRIGGER_LAST_RESULT_KEY, STORE, null);
        if (!record || typeof record !== 'object' || !signature || record.signature !== signature) return null;
        // Prices move on their own (live patches, custom overrides) without anything in the signature
        // changing, so a remembered result is only offered while it is recent
        const age = Date.now() - Number(record.savedAt);
        if (!(age >= 0 && age <= TRIGGER_RESULT_MAX_AGE_MS)) return null;
        return record.result && typeof record.result === 'object' ? record.result : null;
    } catch (error) {
        console.error('[TriggerResultCache] Load failed:', error);
        return null;
    }
}
