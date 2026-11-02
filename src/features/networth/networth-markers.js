/**
 * Net worth valuation markers: steps caused by a setting, not by play or the market.
 *
 * Turning on "Include labyrinth tokens" adds the tokens' value to the next history point at once, and
 * nothing on the chart says why. The history now notes, at the first reading made under changed
 * settings, what changed and how big the step was, keeps the raw line as recorded, and leaves the
 * separable steps out of the figures that describe growth.
 *
 * A marker rides on the history point (`point.marker`), so it syncs with it and an older build, which
 * reads only the fields it knows, ignores it. What a device last saw is a device-local state record
 * (`networthMarkerState_<id>`, see sync-ownership.js), compared at every reading, so a change made
 * while the page was closed is found at the next reading and a change is found once.
 *
 * What can be separated: the include switches (task, labyrinth and guild tokens, guild credits,
 * cowbells) act on whole rows that were valued 0 and now are not (or the reverse), so the step is
 * those rows' value in the two readings' item maps, an exact answer for unchanged holdings. A setting
 * that reprices many items at once (pricing side, value source, the enhancement and cape rules, Iron
 * Cow valuation) cannot be told apart from market movement with what is stored, and the marker says so
 * rather than inventing a figure.
 */

import config from '../../core/config.js';
import { IRONCOW_VALUATION_SETTING } from '../../utils/ironcow-valuation.js';
import { GUILD_CREDIT_HRIDS } from '../../utils/guild-credit-hrids.js';

/**
 * Every setting the net worth calculation reads. The feature recalculates when any of them changes.
 * Covered by markers: all of them. Steps are separable for the include switches only.
 */
export const VALUATION_SETTINGS = [
    'networth_pricingMode',
    'networth_valueSource',
    'networth_highEnhancementUseCost',
    'networth_highEnhancementMinLevel',
    'networth_includeCowbells',
    'networth_includeTaskTokens',
    'networth_includeLabyrinthTokens',
    'networth_includeGuildTokens',
    'networth_includeGuildCredits',
    'networth_abilityBooksAsInventory',
    // The guild token exchange rate stand-in prices held guild tokens
    'guildTokenCreditRate',
    // Labyrinth tokens are priced through the profit calculator's pricing settings
    'profitCalc_pricingMode',
    'profitCalc_patientTickSell',
    // A base item can be priced at its craft cost, which moves every enhanced piece valued by cost
    'enhanceSim_baseItemCraftingCost',
    IRONCOW_VALUATION_SETTING,
    // What an unrefined untradable cape is assumed to be worth
    'untradableCapeBaseValue',
];

/** Which held rows each include switch decides; the rows are the whole of its effect */
const SEPARABLE = {
    networth_includeTaskTokens: (hrid) => hrid === '/items/task_token',
    networth_includeLabyrinthTokens: (hrid) => hrid === '/items/labyrinth_token',
    // Same test as isGuildTokenHrid (guild-token-value.js), kept here so the history does not load the guild feature
    networth_includeGuildTokens: (hrid) => /guild_token/.test(String(hrid || '')),
    networth_includeGuildCredits: (hrid) => GUILD_CREDIT_HRIDS.has(hrid),
    networth_includeCowbells: (hrid) => hrid === '/items/cowbell',
};

/** Moves value between Inventory and Abilities and leaves the total alone */
const TOTAL_NEUTRAL = new Set(['networth_abilityBooksAsInventory']);

const LABELS = {
    networth_pricingMode: 'Net worth pricing side',
    networth_valueSource: 'Net worth value source',
    networth_highEnhancementUseCost: 'Value high enhancements at cost',
    networth_highEnhancementMinLevel: 'High enhancement level',
    networth_includeCowbells: 'Include cowbells',
    networth_includeTaskTokens: 'Include task tokens',
    networth_includeLabyrinthTokens: 'Include labyrinth tokens',
    networth_includeGuildTokens: 'Include guild tokens',
    networth_includeGuildCredits: 'Value guild credits',
    networth_abilityBooksAsInventory: 'Ability books as inventory',
    guildTokenCreditRate: 'Guild token credit rate',
    profitCalc_pricingMode: 'Profit pricing mode',
    profitCalc_patientTickSell: 'Patient tick on sells',
    enhanceSim_baseItemCraftingCost: 'Base item crafting cost',
    [IRONCOW_VALUATION_SETTING]: 'Iron Cow valuation',
    untradableCapeBaseValue: 'Untradable cape base value',
};

/**
 * The values of every valuation setting right now.
 * @returns {Record<string, *>} setting id to value (null when unset)
 */
export function readValuationSignature() {
    const signature = {};
    for (const id of VALUATION_SETTINGS) {
        let value = null;
        try {
            value = config.getSettingValue(id, null);
        } catch {
            value = null;
        }
        signature[id] = value === undefined ? null : value;
    }
    return signature;
}

/**
 * Settings whose value differs between two signatures.
 * @param {Record<string, *>|null} before - What was last seen (null: nothing seen yet)
 * @param {Record<string, *>} after - What the reading was valued under
 * @param {{ironCow?: boolean}} [options] - Whether this is an Iron Cow character
 * @returns {Array<{id: string, from: *, to: *}>} Changes, in list order; empty when nothing was seen before
 */
export function diffSignatures(before, after, { ironCow = false } = {}) {
    if (!before || typeof before !== 'object' || !after) return [];
    const changes = [];
    for (const id of VALUATION_SETTINGS) {
        // Iron Cow valuation reprices nothing on a character that is not one
        if (id === IRONCOW_VALUATION_SETTING && !ironCow) continue;
        if (!(id in before)) continue;
        const from = before[id] ?? null;
        const to = after[id] ?? null;
        if (from !== to) changes.push({ id, from, to });
    }
    return changes;
}

const sumRows = (record, matches) =>
    (record?.rows || []).reduce((sum, row) => (row[0] === 'h' && matches(row[1]) ? sum + row[4] : sum), 0);

/**
 * The marker for a reading made under changed settings.
 *
 * Each include switch's step is the value of the rows it decides in this reading's map minus the
 * same rows in the reading before (those were valued 0 while the switch was off, and are valued
 * under the new setting now, so the difference is the switch's effect). Anything else that changed
 * cannot be separated and is listed in `unseparated`; it is left in the growth figures.
 *
 * @param {Object} params - Inputs
 * @param {Array<{id: string, from: *, to: *}>} params.changes - From {@link diffSignatures}
 * @param {Object|null} params.prevRecord - Item map of the reading before (networth-movers record), or null
 * @param {Array<Array>} params.rows - This reading's rows
 * @param {number|null} params.prevTotal - Total of the reading before, when known
 * @param {number} params.total - Total of this reading
 * @returns {Object} `{changes, step, unseparated, raw}`; `step` is null when nothing could be separated
 */
export function buildMarker({ changes, prevRecord, rows, prevTotal, total }) {
    const current = { rows };
    let step = 0;
    let separated = 0;
    const unseparated = [];
    for (const change of changes) {
        const matches = SEPARABLE[change.id];
        if (TOTAL_NEUTRAL.has(change.id)) {
            separated += 1;
        } else if (matches && prevRecord) {
            step += sumRows(current, matches) - sumRows(prevRecord, matches);
            separated += 1;
        } else {
            unseparated.push(change.id);
        }
    }
    return {
        changes,
        step: separated > 0 ? Math.round(step) : null,
        unseparated,
        raw: Number.isFinite(prevTotal) ? Math.round(total - prevTotal) : null,
    };
}

/**
 * How a marker's value reads: on/off for switches.
 * @param {*} value - A setting value
 * @returns {string} Display text
 */
export function formatSettingValue(value) {
    if (value === true) return 'on';
    if (value === false) return 'off';
    return value == null ? 'unset' : String(value);
}

/**
 * One line naming what a marker's changes were.
 * @param {Object} marker - A history point's marker
 * @returns {string} For example "Include labyrinth tokens: off to on"
 */
export function describeChanges(marker) {
    return (marker?.changes || [])
        .map((c) => `${LABELS[c.id] || c.id}: ${formatSettingValue(c.from)} to ${formatSettingValue(c.to)}`)
        .join('; ');
}

/**
 * The steps in a history that growth figures leave out, after a point in time.
 * @param {Array<Object>} history - Points, any order
 * @param {number} afterT - Only markers made after this time count (the baseline already holds earlier ones)
 * @returns {{step: number, count: number, inexact: number}} Sum of separated steps, how many markers
 *   carried one, and how many markers carried only an unseparated change (left in)
 */
export function stepsAfter(history, afterT) {
    let step = 0;
    let count = 0;
    let inexact = 0;
    for (const point of history || []) {
        const marker = point?.marker;
        if (!marker || !(point.t > afterT)) continue;
        if (Number.isFinite(marker.step)) {
            step += marker.step;
            count += 1;
        }
        if ((marker.unseparated || []).length > 0) inexact += 1;
    }
    return { step, count, inexact };
}

/**
 * The series with each marker's step taken out of every later point, so a trend reads play and the
 * market only. Points without markers before the first one are the same objects; nothing stored is
 * changed. Fields shifted: total, nonExcluded and inventory (the include switches act on inventory).
 * @param {Array<Object>} history - Points, oldest first
 * @returns {Array<Object>} The same points, or copies shifted by the steps made so far
 */
export function withoutSteps(history) {
    if (!Array.isArray(history) || !history.some((p) => Number.isFinite(p?.marker?.step) && p.marker.step !== 0)) {
        return history;
    }
    let offset = 0;
    return history.map((point) => {
        if (Number.isFinite(point?.marker?.step)) offset += point.marker.step;
        if (offset === 0) return point;
        const shifted = { ...point, total: point.total - offset };
        if (point.nonExcluded != null) shifted.nonExcluded = point.nonExcluded - offset;
        if (point.inventory != null) shifted.inventory = point.inventory - offset;
        return shifted;
    });
}

/**
 * The note a growth figure carries when markers were left out of it.
 * @param {{step: number, count: number, inexact: number}} steps - From {@link stepsAfter}
 * @param {(n: number) => string} format - Money formatter
 * @returns {string} Empty when nothing was left out or flagged
 */
export function growthNote(steps, format) {
    const parts = [];
    if (steps.count > 0) {
        parts.push(
            `excludes ${steps.count} setting change${steps.count === 1 ? '' : 's'}: ${steps.step >= 0 ? '+' : '-'}${format(Math.abs(steps.step))}`
        );
    }
    if (steps.inexact > 0) {
        parts.push(
            `${steps.inexact} setting change${steps.inexact === 1 ? '' : 's'} could not be separated from market movement and ${steps.inexact === 1 ? 'is' : 'are'} left in`
        );
    }
    return parts.join('; ');
}
