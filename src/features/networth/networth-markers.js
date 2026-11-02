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
 * The values of every valuation setting right now, read the way the calculation reads them.
 *
 * `getSetting` and not `getSettingValue`: the calculation falls back to the schema default for a switch
 * nobody has touched, and `getSettingValue` answers null there. Reading with the second would turn a first
 * explicit "on" (the default) into a change from null to true.
 * @returns {Record<string, *>} setting id to value (null when unset and without a default)
 */
export function readValuationSignature() {
    const signature = {};
    for (const id of VALUATION_SETTINGS) {
        let value = null;
        try {
            value = config.getSetting(id, null);
        } catch {
            value = null;
        }
        signature[id] = value === undefined ? null : value;
    }
    return signature;
}

/**
 * What the readings hold that decides whether a setting can have changed anything. Absent fields mean
 * "not known", and an unknown reading keeps the setting relevant.
 * @param {Object} data - The calculation
 * @param {boolean} ironCow - Whether this is an Iron Cow character
 * @returns {{ironCow: boolean, guildTokenHeld?: boolean, capeHeld?: boolean}} Relevance context
 */
export function relevanceContext(data, ironCow = false) {
    const held = data?.currentAssets?.inventory?.breakdown;
    return {
        ironCow,
        ...(Array.isArray(held)
            ? { guildTokenHeld: held.some((item) => /guild_token/.test(String(item?.itemHrid))) }
            : {}),
        ...(typeof data?.valuationFacts?.capeHeld === 'boolean' ? { capeHeld: data.valuationFacts.capeHeld } : {}),
    };
}

/**
 * Whether a setting change can have moved this reading at all. A change that cannot is not a change worth
 * marking, and not worth a "not yet marked" note either.
 * @param {string} id - Setting id
 * @param {Record<string, *>} before - Settings before
 * @param {Record<string, *>} after - Settings after
 * @param {Object} context - From {@link relevanceContext}
 * @returns {boolean} False when the change is a no-op for this character and holdings
 */
export function isRelevant(id, before, after, context = {}) {
    switch (id) {
        case IRONCOW_VALUATION_SETTING:
            // Reprices nothing on a character that is not an Iron Cow
            return context.ironCow === true;
        case 'networth_highEnhancementMinLevel':
            // Only read while enhanced pieces are valued at cost
            return before.networth_highEnhancementUseCost === true || after.networth_highEnhancementUseCost === true;
        case 'networth_pricingMode':
            // Documented as ignored once the value source is the game's own market value
            return !(before.networth_valueSource === 'officialValue' && after.networth_valueSource === 'officialValue');
        case 'guildTokenCreditRate':
            // Prices held guild tokens and nothing else
            return context.guildTokenHeld !== false;
        case 'untradableCapeBaseValue':
            return context.capeHeld !== false;
        default:
            return true;
    }
}

/**
 * Settings whose value differs between two signatures and can have moved the reading.
 * @param {Record<string, *>|null} before - What was last seen (null: nothing seen yet)
 * @param {Record<string, *>} after - What the reading was valued under
 * @param {Object} [context] - From {@link relevanceContext}
 * @returns {Array<{id: string, from: *, to: *}>} Changes, in list order; empty when nothing was seen before
 */
export function diffSignatures(before, after, context = {}) {
    if (!before || typeof before !== 'object' || !after) return [];
    const changes = [];
    for (const id of VALUATION_SETTINGS) {
        if (!(id in before)) continue;
        const from = before[id] ?? null;
        const to = after[id] ?? null;
        if (from === to) continue;
        if (!isRelevant(id, before, after, context)) continue;
        changes.push({ id, from, to });
    }
    return changes;
}

const FLAG_UNPRICED = 1;
const FLAG_PARTIAL = 2;

/** A move this small, as a share of the total, is ordinary variation between two readings */
const NOISE_SHARE = 0.001;

const matching = (record, predicate) => (record?.rows || []).filter((row) => row[0] === 'h' && predicate(row[1]));
const sumValue = (rows) => rows.reduce((sum, row) => sum + row[4], 0);
const sumExcluded = (record, predicate) =>
    Object.entries(record?.ex || {}).reduce((sum, [hrid, amount]) => (predicate(hrid) ? sum + amount : sum), 0);

/**
 * The marker for a reading made under changed settings.
 *
 * Each include switch's step is the value of the rows it decides in this reading's map minus the
 * same rows in the reading before (those were valued 0 while the switch was off, and are valued
 * under the new setting now, so the difference is the switch's effect). Items excluded by name are
 * not in the rows but are in the total, so their amounts are added to the total step (`step`) and
 * left out of the non-excluded one (`stepCounted`). Anything else that changed cannot be separated
 * and is listed in `unseparated`; it is left in the growth figures.
 *
 * A step measured over a row nothing priced, or over a category exclusion that may hide more, is
 * only a floor and the marker lists the setting in `floor`: it is never read as an exact zero.
 *
 * @param {Object} params - Inputs
 * @param {Array<{id: string, from: *, to: *}>} params.changes - From {@link diffSignatures}
 * @param {Object|null} params.prevRecord - Item map of the reading before (networth-movers record), or null
 * @param {{rows: Array<Array>, ex?: Object, exOther?: boolean}} params.current - This reading's rows and exclusions
 * @param {number|null} params.prevTotal - Total of the reading before, when known
 * @param {number} params.total - Total of this reading
 * @returns {Object} `{changes, step, stepCounted, unseparated, floor, small, raw}`; `step` is null when nothing could be separated
 */
export function buildMarker({ changes, prevRecord, current, prevTotal, total }) {
    let step = 0;
    let stepCounted = 0;
    let separated = 0;
    const unseparated = [];
    const floor = [];
    for (const change of changes) {
        const predicate = SEPARABLE[change.id];
        if (TOTAL_NEUTRAL.has(change.id)) {
            separated += 1;
        } else if (predicate && prevRecord) {
            const now = matching(current, predicate);
            const was = matching(prevRecord, predicate);
            const counted = sumValue(now) - sumValue(was);
            step += counted + sumExcluded(current, predicate) - sumExcluded(prevRecord, predicate);
            stepCounted += counted;
            separated += 1;
            // The side that was valued is the one switched on: this reading when turned on, the last when off
            const valued = change.to === true ? now : was;
            const unsure = valued.some((row) => ((row[5] || 0) & (FLAG_UNPRICED | FLAG_PARTIAL)) !== 0);
            if (unsure || current?.exOther === true || prevRecord.exOther === true) floor.push(change.id);
        } else {
            unseparated.push(change.id);
        }
    }
    const raw = Number.isFinite(prevTotal) ? Math.round(total - prevTotal) : null;
    const marker = {
        changes,
        step: separated > 0 ? Math.round(step) : null,
        stepCounted: separated > 0 ? Math.round(stepCounted) : null,
        unseparated,
        raw,
    };
    if (floor.length > 0) marker.floor = floor;
    // Nothing separated and the reading barely moved: the change is on record, but "could not be
    // separated" would overstate a move that is within ordinary variation
    if (
        separated === 0 &&
        raw !== null &&
        Number.isFinite(prevTotal) &&
        Math.abs(raw) <= Math.abs(prevTotal) * NOISE_SHARE
    ) {
        marker.small = true;
    }
    return marker;
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

/** How long two markers for the same change are taken to be one change seen by two devices or tabs */
export const SAME_CHANGE_WINDOW_MS = 6 * 60 * 60 * 1000;

const changeKey = (c) => `${c.id}|${String(c.from)}|${String(c.to)}`;
const reverseKey = (c) => `${c.id}|${String(c.to)}|${String(c.from)}`;

/**
 * A marker's identity: the set of (setting, from, to) it carries.
 * @param {Object} marker - A marker
 * @returns {string} Order-independent key
 */
export function markerIdentity(marker) {
    return (marker?.changes || []).map(changeKey).sort().join('&');
}

/**
 * Merge two markers on one point (a deleted point's marker carried onto the next, or a prune carrying a
 * dropped point's). Changes are joined without repeating an identity; steps add; a null step stays null
 * only when both are.
 * @param {Object|null} a - A marker
 * @param {Object|null} b - A marker
 * @returns {Object|null} The merged marker
 */
export function mergeMarkers(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const seen = new Set();
    const changes = [];
    for (const change of [...(a.changes || []), ...(b.changes || [])]) {
        const key = changeKey(change);
        if (!seen.has(key)) {
            seen.add(key);
            changes.push(change);
        }
    }
    const add = (x, y) =>
        Number.isFinite(x) || Number.isFinite(y) ? (Number.isFinite(x) ? x : 0) + (Number.isFinite(y) ? y : 0) : null;
    const merged = {
        changes,
        step: add(a.step, b.step),
        stepCounted: add(a.stepCounted ?? a.step, b.stepCounted ?? b.step),
        unseparated: [...new Set([...(a.unseparated || []), ...(b.unseparated || [])])],
        raw: add(a.raw, b.raw),
    };
    const floor = [...new Set([...(a.floor || []), ...(b.floor || [])])];
    if (floor.length > 0) merged.floor = floor;
    if (a.small && b.small) merged.small = true;
    return merged;
}

/**
 * The marked points that count, one per change identity inside the window.
 *
 * Two markers with the same identity less than {@link SAME_CHANGE_WINDOW_MS} apart are one change that
 * two devices (or tabs) each marked before their points met; the earliest counts and the later ones do
 * not, whatever order the points were merged in. A flip and flip back is not collapsed: a marker of the
 * opposite change (same setting, from and to swapped) between two equal ones makes the later one real.
 * @param {Array<Object>} history - Points, any order
 * @returns {Set<number>} The `t` of each point whose marker counts
 */
export function countedMarkerTimes(history) {
    const marked = (history || [])
        .filter((point) => point?.marker && Number.isFinite(point.t))
        .sort((x, y) => x.t - y.t);
    const counted = new Set();
    const lastCounted = new Map();
    for (let i = 0; i < marked.length; i += 1) {
        const point = marked[i];
        const identity = markerIdentity(point.marker);
        const prior = lastCounted.get(identity);
        let duplicate = false;
        if (prior !== undefined && point.t - prior <= SAME_CHANGE_WINDOW_MS) {
            const reversed = point.marker.changes.map(reverseKey);
            duplicate = !marked.some(
                (other) =>
                    other.t > prior &&
                    other.t < point.t &&
                    other.marker.changes.some((c) => reversed.includes(changeKey(c)))
            );
        }
        if (!duplicate) {
            counted.add(point.t);
            lastCounted.set(identity, point.t);
        }
    }
    return counted;
}

/**
 * The steps in a history that growth figures leave out, after a point in time.
 * @param {Array<Object>} history - Points, any order
 * @param {number} afterT - Only markers made after this time count (the baseline already holds earlier ones)
 * @returns {{step: number, stepCounted: number, count: number, inexact: number, floor: number}} Sums of
 *   the separated steps (total, and the non-excluded part), how many markers carried one, how many carried
 *   only an unseparated change that mattered (left in), and how many steps are only a floor
 */
export function stepsAfter(history, afterT, untilT = Infinity) {
    const counted = countedMarkerTimes(history);
    let step = 0;
    let stepCounted = 0;
    let count = 0;
    let inexact = 0;
    let floor = 0;
    for (const point of history || []) {
        const marker = point?.marker;
        if (!marker || !(point.t > afterT) || point.t > untilT || !counted.has(point.t)) continue;
        if (Number.isFinite(marker.step)) {
            step += marker.step;
            stepCounted += Number.isFinite(marker.stepCounted) ? marker.stepCounted : marker.step;
            count += 1;
            if ((marker.floor || []).length > 0) floor += 1;
        }
        if ((marker.unseparated || []).length > 0 && marker.small !== true) inexact += 1;
    }
    return { step, stepCounted, count, inexact, floor };
}

/**
 * The series with each marker's step taken out of every later point, so a trend reads play and the
 * market only. Points before the first counted marker are the same objects; nothing stored is
 * changed. Fields shifted: total by the step, nonExcluded and inventory by the part that is counted.
 * @param {Array<Object>} history - Points, oldest first
 * @returns {Array<Object>} The same points, or copies shifted by the steps made so far
 */
export function withoutSteps(history) {
    if (!Array.isArray(history) || !history.some((p) => Number.isFinite(p?.marker?.step) && p.marker.step !== 0)) {
        return history;
    }
    const counted = countedMarkerTimes(history);
    let offset = 0;
    let offsetCounted = 0;
    return history.map((point) => {
        const marker = point?.marker;
        if (marker && Number.isFinite(marker.step) && counted.has(point.t)) {
            offset += marker.step;
            offsetCounted += Number.isFinite(marker.stepCounted) ? marker.stepCounted : marker.step;
        }
        if (offset === 0 && offsetCounted === 0) return point;
        const shifted = { ...point, total: point.total - offset };
        if (point.nonExcluded != null) shifted.nonExcluded = point.nonExcluded - offsetCounted;
        if (point.inventory != null) shifted.inventory = point.inventory - offsetCounted;
        return shifted;
    });
}

/**
 * The series with its steps taken out and then moved back onto the level net worth is at now, for anything that
 * reads percentage changes. Taking 900 of tokens out of a total of 1,000 leaves growth of 10 a day on 100, and
 * reading that against the old 1,000 would shrink it tenfold. A point can land at or under zero here; a reader of
 * returns skips those. Nothing stored is changed.
 * @param {Array<Object>} history - Points, oldest first
 * @returns {Array<Object>} The same points, or copies on the current level
 */
export function rebasedWithoutSteps(history) {
    const shifted = withoutSteps(history);
    if (shifted === history || !shifted.length) return history;
    const gap = history.at(-1).total - shifted.at(-1).total;
    if (!gap) return shifted;
    return shifted.map((point) => ({ ...point, total: point.total + gap }));
}

/**
 * The counted setting-change steps that landed between two times, for a table that explains a change.
 * @param {Array<Object>} history - Points, any order
 * @param {number} fromT - Exclusive start
 * @param {number} toT - Inclusive end
 * @returns {number} Sum of the separated steps
 */
export function stepBetween(history, fromT, toT) {
    const counted = countedMarkerTimes(history);
    let step = 0;
    for (const point of history || []) {
        if (
            point?.marker &&
            Number.isFinite(point.marker.step) &&
            counted.has(point.t) &&
            point.t > fromT &&
            point.t <= toT
        ) {
            step += point.marker.step;
        }
    }
    return step;
}

/**
 * The note a growth figure carries when markers were left out of it.
 * @param {{step: number, count: number, inexact: number, floor?: number}} steps - From {@link stepsAfter}
 * @param {(n: number) => string} format - Money formatter
 * @returns {string} Empty when nothing was left out or flagged
 */
export function growthNote(steps, format) {
    const parts = [];
    if (steps.count > 0) {
        const floor = steps.floor > 0 ? ' at least' : '';
        parts.push(
            `excludes ${steps.count} setting change${steps.count === 1 ? '' : 's'}:${floor} ${steps.step >= 0 ? '+' : '-'}${format(Math.abs(steps.step))}`
        );
    }
    if (steps.inexact > 0) {
        parts.push(
            `${steps.inexact} setting change${steps.inexact === 1 ? '' : 's'} could not be separated from market movement and ${steps.inexact === 1 ? 'is' : 'are'} left in`
        );
    }
    return parts.join('; ');
}
