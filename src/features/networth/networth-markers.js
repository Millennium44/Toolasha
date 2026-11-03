/**
 * Net worth valuation markers: steps caused by a setting, not by play or the market.
 *
 * Turning on "Include labyrinth tokens" adds the tokens' value to the next history point at once, and
 * nothing on the chart says why. The history now notes, at the first reading made under changed
 * settings, what changed and how big the step was, keeps the raw line as recorded, and leaves the
 * separable steps out of the figures that describe growth.
 *
 * A marker rides on the history point (`point.marker`), so it syncs with it and an older build, which
 * reads only the fields it knows, ignores it. Each change also carries its own share of the step
 * (`changes[i].step`, `.stepCounted`), so one setting marked by two devices in different batches can be counted
 * once; a marker written before that has only the sums, and is read as far as they allow. What a device last saw is a device-local state record
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

/**
 * Moves value between Inventory and Abilities and leaves the total alone. The non-excluded line moves only when the
 * Ability Books asset type is excluded: then the switch is what decides whether those books count at all.
 */
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
 * @param {{rows: Array<Array>, ex?: Object, exOther?: boolean, switchedBooks?: {value: number, partial: boolean}}}
 *   params.current - This reading's rows and exclusions, and the ability books whose counting hangs on the
 *   "Ability books as inventory" switch, valued now (the calculation's `valuationFacts`)
 * @param {number|null} params.prevTotal - Total of the reading before, when known
 * @param {number} params.total - Total of this reading
 * @returns {Object} `{changes, step, stepCounted, unseparated, floor, small, raw}`; `step` is null when nothing could
 *   be separated. A separated change carries its own share as `step` and `stepCounted`
 */
export function buildMarker({ changes, prevRecord, current, prevTotal, total }) {
    let step = 0;
    let stepCounted = 0;
    let separated = 0;
    const unseparated = [];
    const floor = [];
    const shared = [];
    for (const change of changes) {
        const predicate = SEPARABLE[change.id];
        if (TOTAL_NEUTRAL.has(change.id)) {
            const moved = current?.switchedBooks;
            const counted = Number.isFinite(moved?.value) ? (change.to === true ? moved.value : -moved.value) : 0;
            stepCounted += counted;
            separated += 1;
            shared.push({ ...change, step: 0, stepCounted: Math.round(counted) });
            if (moved?.partial === true) floor.push(change.id);
        } else if (predicate && prevRecord) {
            const now = matching(current, predicate);
            const was = matching(prevRecord, predicate);
            const counted = sumValue(now) - sumValue(was);
            const whole = counted + sumExcluded(current, predicate) - sumExcluded(prevRecord, predicate);
            step += whole;
            stepCounted += counted;
            separated += 1;
            shared.push({ ...change, step: Math.round(whole), stepCounted: Math.round(counted) });
            // The side that was valued is the one switched on: this reading when turned on, the last when off
            const valued = change.to === true ? now : was;
            const unsure = valued.some((row) => ((row[5] || 0) & (FLAG_UNPRICED | FLAG_PARTIAL)) !== 0);
            if (unsure || current?.exOther === true || prevRecord.exOther === true) floor.push(change.id);
        } else {
            unseparated.push(change.id);
            shared.push(change);
        }
    }
    const raw = Number.isFinite(prevTotal) ? Math.round(total - prevTotal) : null;
    const marker = {
        changes: shared,
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
 * What one change contributed to its marker's step, as far as can be told.
 *
 * A marker written before changes carried their own shares has only the sums. Those still answer when the change
 * is the only one on it, or was never in the sum at all; with several in the sum, nothing says how it divides.
 * @param {Object} marker - A marker
 * @param {Object} change - One of its changes
 * @returns {{step: number, stepCounted: number}|null} The share, or null when it cannot be told
 */
function changeShare(marker, change) {
    if (Number.isFinite(change.step)) {
        return {
            step: change.step,
            stepCounted: Number.isFinite(change.stepCounted) ? change.stepCounted : change.step,
        };
    }
    if (!Number.isFinite(marker.step) || (marker.unseparated || []).includes(change.id)) {
        return { step: 0, stepCounted: 0 };
    }
    if ((marker.changes || []).length !== 1) return null;
    return { step: marker.step, stepCounted: Number.isFinite(marker.stepCounted) ? marker.stepCounted : marker.step };
}

/**
 * Merge two markers on one point (a deleted point's marker carried onto the next, or a prune carrying a
 * dropped point's). Changes are joined without repeating an identity; steps add, on the marker and on a change
 * both hold; a null step stays null only when both are.
 * @param {Object|null} a - A marker
 * @param {Object|null} b - A marker
 * @returns {Object|null} The merged marker
 */
export function mergeMarkers(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const byKey = new Map();
    for (const marker of [a, b]) {
        for (const change of marker.changes || []) {
            const key = changeKey(change);
            const share = changeShare(marker, change);
            const held = byKey.get(key);
            if (!held) {
                byKey.set(key, { change, share, stated: Number.isFinite(change.step) });
                continue;
            }
            // Unseparated on one side is a known nothing, not an unknown: the other side's share is the whole
            // of what the sum holds for this change. Only a side that cannot say makes the total unknowable.
            held.share =
                held.share && share
                    ? { step: held.share.step + share.step, stepCounted: held.share.stepCounted + share.stepCounted }
                    : null;
            held.stated = held.stated || Number.isFinite(change.step);
        }
    }
    const changes = [...byKey.values()].map(({ change, share, stated }) => {
        const { step: _step, stepCounted: _stepCounted, ...plain } = change;
        if (!share) return plain;
        // A share of nothing nobody stated stays unstated: an unseparated change carries no figure
        return stated || share.step !== 0 || share.stepCounted !== 0 ? { ...plain, ...share } : plain;
    });
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
 * What each marked point counts for, one setting change at a time.
 *
 * The same change on two markers less than {@link SAME_CHANGE_WINDOW_MS} apart is one change that two devices (or
 * tabs) each marked before their points met; the earliest counts and the later ones do not, whatever order the
 * points were merged in. They need not have marked the same batch: one device can record labyrinth tokens at one
 * reading and another labyrinth tokens and cowbells at the next, and only the tokens are the same change. A flip
 * and flip back is not collapsed: the opposite change (same setting, from and to swapped) between two equal ones
 * makes the later one real.
 *
 * A repeat comes out of its marker's step by its own share, or failing that (a marker with only the sums) by the
 * share the marker it repeats carries. When neither can say, the marker counts whole, as it did before changes
 * carried shares. A marker made up entirely of repeats needs no shares and counts for nothing.
 * @param {Array<Object>} history - Points, any order
 * @returns {Map<number, {step: number|null, stepCounted: number, unseparated: Array<string>, floor: Array<string>}>}
 *   By point `t`, what each counting marker contributes; a point whose marker is all repeats is absent
 */
export function countedShares(history) {
    const marked = (history || [])
        .filter((point) => point?.marker && Number.isFinite(point.t))
        .sort((x, y) => x.t - y.t);
    const shares = new Map();
    /** Change key to the point that last counted it, and that change's share there */
    const lastCounted = new Map();
    for (const point of marked) {
        const marker = point.marker;
        const changes = marker.changes || [];
        const fresh = [];
        const repeats = [];
        for (const change of changes) {
            const prior = lastCounted.get(changeKey(change));
            const reversed = reverseKey(change);
            const repeat =
                prior !== undefined &&
                point.t - prior.t <= SAME_CHANGE_WINDOW_MS &&
                !marked.some(
                    (other) =>
                        other.t > prior.t &&
                        other.t < point.t &&
                        (other.marker.changes || []).some((c) => changeKey(c) === reversed)
                );
            if (repeat) {
                repeats.push({ change, prior });
            } else {
                fresh.push(change);
                lastCounted.set(changeKey(change), { t: point.t, share: changeShare(marker, change) });
            }
        }
        if (changes.length > 0 && fresh.length === 0) continue;

        let step = marker.step;
        let stepCounted = Number.isFinite(marker.stepCounted) ? marker.stepCounted : marker.step;
        const left = new Set(fresh.map((change) => change.id));
        for (const { change, prior } of repeats) {
            const share = changeShare(marker, change) ?? prior.share;
            if (!share) {
                left.add(change.id);
                continue;
            }
            step -= share.step;
            stepCounted -= share.stepCounted;
        }
        const repeated = new Set(repeats.map(({ change }) => change.id).filter((id) => !left.has(id)));
        const unseparated = (marker.unseparated || []).filter((id) => !repeated.has(id));
        // Only unseparated changes left: nothing of this marker's step is still this marker's to claim. A change
        // can be on that list and hold a share too, once two markers have been merged
        const anySeparated =
            changes.length === 0 ||
            changes.some(
                (change) => left.has(change.id) && (Number.isFinite(change.step) || !unseparated.includes(change.id))
            );
        shares.set(point.t, {
            step: Number.isFinite(marker.step) && anySeparated ? step : null,
            stepCounted: Number.isFinite(marker.step) && anySeparated ? stepCounted : 0,
            unseparated,
            floor: (marker.floor || []).filter((id) => !repeated.has(id)),
        });
    }
    return shares;
}

/**
 * The marked points that count at all.
 * @param {Array<Object>} history - Points, any order
 * @returns {Set<number>} The `t` of each point whose marker counts for something
 */
export function countedMarkerTimes(history) {
    return new Set(countedShares(history).keys());
}

/**
 * A marker with the changes another marker on the same point already holds taken out, so carrying one onto the
 * other does not add a shared change's step twice.
 * @param {Object} marker - The marker being carried
 * @param {Object|null} other - The marker already there
 * @returns {Object|null} What is left to carry (the same marker when nothing is shared or a share cannot be told),
 *   or null when the other holds every change
 */
export function withoutChangesHeldBy(marker, other) {
    if (!marker || !other) return marker || null;
    const held = new Map((other.changes || []).map((change) => [changeKey(change), change]));
    const changes = marker.changes || [];
    const shared = changes.filter((change) => held.has(changeKey(change)));
    if (shared.length === 0) return marker;
    if (shared.length === changes.length) return null;
    let step = marker.step;
    let stepCounted = Number.isFinite(marker.stepCounted) ? marker.stepCounted : marker.step;
    for (const change of shared) {
        const share = changeShare(marker, change) ?? changeShare(other, held.get(changeKey(change)));
        if (!share) return marker;
        step -= share.step;
        stepCounted -= share.stepCounted;
    }
    const gone = new Set(shared.map((change) => change.id));
    const rest = {
        ...marker,
        changes: changes.filter((change) => !held.has(changeKey(change))),
        step: Number.isFinite(marker.step) ? step : null,
        stepCounted: Number.isFinite(marker.step) ? stepCounted : null,
        unseparated: (marker.unseparated || []).filter((id) => !gone.has(id)),
    };
    const floor = (marker.floor || []).filter((id) => !gone.has(id));
    if (floor.length > 0) rest.floor = floor;
    else delete rest.floor;
    return rest;
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
    const shares = countedShares(history);
    let step = 0;
    let stepCounted = 0;
    let count = 0;
    let inexact = 0;
    let floor = 0;
    for (const point of history || []) {
        const marker = point?.marker;
        const share = marker ? shares.get(point.t) : null;
        if (!share || !(point.t > afterT) || point.t > untilT) continue;
        if (Number.isFinite(share.step)) {
            step += share.step;
            stepCounted += share.stepCounted;
            count += 1;
            if (share.floor.length > 0) floor += 1;
        }
        if (share.unseparated.length > 0 && marker.small !== true) inexact += 1;
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
    // A step can sit wholly in the counted part (ability books moved past an excluded asset type) with a total of 0
    const shifts = (p) =>
        (Number.isFinite(p?.marker?.step) && p.marker.step !== 0) ||
        (Number.isFinite(p?.marker?.stepCounted) && p.marker.stepCounted !== 0);
    if (!Array.isArray(history) || !history.some(shifts)) return history;
    const shares = countedShares(history);
    let offset = 0;
    let offsetCounted = 0;
    return history.map((point) => {
        const share = point?.marker ? shares.get(point.t) : null;
        if (Number.isFinite(share?.step)) {
            offset += share.step;
            offsetCounted += share.stepCounted;
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
    const shares = countedShares(history);
    let step = 0;
    for (const point of history || []) {
        const share = point?.marker ? shares.get(point.t) : null;
        if (Number.isFinite(share?.step) && point.t > fromT && point.t <= toT) step += share.step;
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
