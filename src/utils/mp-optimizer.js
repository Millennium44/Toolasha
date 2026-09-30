/**
 * MP supply optimizer
 *
 * The cheapest set of mana foods and drinks that sustains a target MP per
 * minute, and the most MP per minute the slot rules allow.
 *
 * The idea is KikiMeter's Optim tab (MIT, ZhuLiMoon) — see
 * `third-party/kikimeter/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own, and reads the game's item data where KikiMeter matched item
 * names and hard-coded durations.
 *
 * ## How an item turns into MP per minute
 *
 * The combat simulator (`combat-sim/engine/combat-simulator.js`) uses a
 * consumable whenever its trigger holds and its cooldown is up, and restores
 * `manapointRestore` per use — all at once, or spread over `recoveryDuration`,
 * which changes when the mana lands and not how much. The cooldown is divided
 * by `foodHaste` for a food and by `drinkConcentration` for a drink, and by
 * nothing else. So the steady rate of an item that is used every time it comes
 * off cooldown is
 *
 *     uses/min = 60 × (1 + haste) / cooldownSeconds
 *     MP/min   = manapointRestore × uses/min
 *     $/hour   = price × uses/min × 60
 *
 * That is a ceiling for the item, not a forecast: a default trigger such as
 * "MP below 50%" holds off a use the character does not need yet. Natural mana
 * regeneration is not subtracted either, so a target is what the items alone
 * must supply.
 *
 * ## Slot rules
 *
 * The game allows one consumable per restore type in a slot group — the same
 * rule `sim-editor.js` enforces in its picker: `hp_instant`, `hp_over_time`,
 * `mp_instant`, `mp_over_time`, and one buff family per drink. A combat
 * character has three food slots and three drink slots. So each candidate
 * belongs to one slot type and the search picks at most one per type, capped
 * by the slot count of its group.
 */

/** Combat food and drink slots, as the simulator adapter reads them */
export const DEFAULT_MAX_SLOTS = { food: 3, drink: 3 };

const NS_PER_SECOND = 1e9;
// The simulator's HOT_TICK_INTERVAL (combat-simulator.js)
const HOT_TICK_SECONDS = 5;

/**
 * The slot type a consumable occupies — one item per type per group.
 * Mirrors the picker in `sim-editor.js`, which is where the rule is enforced.
 * @param {Object} detail - `consumableDetail`
 * @returns {string|null}
 */
export function slotTypeOf(detail) {
    const hp = Number(detail?.hitpointRestore) || 0;
    const mp = Number(detail?.manapointRestore) || 0;
    const overTime = (Number(detail?.recoveryDuration) || 0) > 0;
    if (hp > 0) return overTime ? 'hp_over_time' : 'hp_instant';
    if (mp > 0) return overTime ? 'mp_over_time' : 'mp_instant';
    return null;
}

/**
 * The most MP one use can bank into a pool of `maxMana`. The simulator clamps every landing to the pool
 * (`addManapoints`): an instant restore lands once, an over-time one lands in ticks every HOT_TICK_SECONDS, each
 * tick a floored share of the total (`calculateTickValue`), so the ceiling is the sum of the per-tick amounts each
 * capped at the pool. Null or absent `maxMana` leaves the restore uncapped.
 * @param {number} restore - The item's total MP restore
 * @param {number} recoveryDuration - Nanoseconds the restore is spread over; 0 for an instant restore
 * @param {number|null} maxMana - The character's max MP
 * @returns {number} Per-use MP ceiling
 */
function capPerUse(restore, recoveryDuration, maxMana) {
    if (!(maxMana > 0)) return restore;
    if (!(recoveryDuration > 0)) return Math.min(restore, maxMana);

    const totalTicks = recoveryDuration / (HOT_TICK_SECONDS * NS_PER_SECOND);
    // Ticks run 1..ceil(totalTicks); a share past totalTicks lands the whole floored total
    const cumulative = (tick) => (tick > totalTicks ? Math.floor(restore) : Math.floor((tick * restore) / totalTicks));
    let total = 0;
    for (let tick = 1; tick <= Math.ceil(totalTicks); tick++) {
        total += Math.min(cumulative(tick) - cumulative(tick - 1), maxMana);
    }
    return total;
}

/**
 * Every priced consumable that restores mana, with its steady rate and cost.
 *
 * @param {Object} itemDetailMap - The game's `itemDetailMap`
 * @param {Object} options
 * @param {(hrid: string) => (number|null)} options.priceOf - Price to buy one; null or 0 leaves the item out
 * @param {number} [options.foodHaste] - The character's food haste, as a fraction
 * @param {number} [options.drinkConcentration] - The character's drink concentration, as a fraction
 * @param {number|null} [options.maxMana] - The character's max MP; no landing can bank more than the pool
 *   holds (the simulator's `addManapoints` clamps), so an instant restore, and each tick of an over-time one, is
 *   capped. Null or absent leaves every restore uncapped.
 * @returns {Array<Object>} Candidates, best MP per coin first
 */
export function buildMpCandidates(itemDetailMap, { priceOf, foodHaste = 0, drinkConcentration = 0, maxMana = null }) {
    const candidates = [];

    for (const [hrid, item] of Object.entries(itemDetailMap || {})) {
        const detail = item?.consumableDetail;
        if (!detail) continue;

        const restore = Number(detail.manapointRestore) || 0;
        if (restore <= 0) continue;
        const mpPerUse = capPerUse(restore, Number(detail.recoveryDuration) || 0, maxMana);
        const capped = mpPerUse < restore;

        const category = item.categoryHrid || '';
        const kind = category.includes('drink') ? 'drink' : category.includes('food') ? 'food' : null;
        if (!kind) continue;

        const cooldownSeconds = (Number(detail.cooldownDuration) || 0) / NS_PER_SECOND;
        if (cooldownSeconds <= 0) continue;

        const price = priceOf(hrid);
        if (!(price > 0)) continue;

        const haste = Math.max(0, (kind === 'food' ? foodHaste : drinkConcentration) || 0);
        const usesPerMinute = (60 * (1 + haste)) / cooldownSeconds;
        const hpPerUse = Number(detail.hitpointRestore) || 0;

        candidates.push({
            hrid,
            name: item.name || hrid.split('/').pop().replace(/_/g, ' '),
            kind,
            slotType: `${kind}:${slotTypeOf(detail)}`,
            mpPerUse,
            cappedAtMaxMana: capped,
            alsoHeals: hpPerUse > 0,
            price,
            usesPerMinute,
            mpPerMinute: mpPerUse * usesPerMinute,
            costPerHour: price * usesPerMinute * 60,
        });
    }

    return candidates.sort(
        (a, b) => b.mpPerMinute / b.costPerHour - a.mpPerMinute / a.costPerHour || a.hrid.localeCompare(b.hrid)
    );
}

/**
 * Every allocation the slot rules allow — one candidate or none per slot type,
 * no more items in a group than it has slots — passed to `visit` one at a time.
 * @param {Array<Object>} candidates - From `buildMpCandidates`
 * @param {{food: number, drink: number}} maxSlots - Slots per group
 * @param {(items: Array<Object>, mpPerMinute: number, costPerHour: number) => void} visit
 */
function forEachAllocation(candidates, maxSlots, visit) {
    const byType = new Map();
    for (const candidate of candidates) {
        if (!byType.has(candidate.slotType)) byType.set(candidate.slotType, []);
        byType.get(candidate.slotType).push(candidate);
    }
    const groups = [...byType.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, items]) => items);
    const used = { food: 0, drink: 0 };
    const chosen = [];

    const walk = (index, mp, cost) => {
        if (index === groups.length) {
            visit(chosen, mp, cost);
            return;
        }
        walk(index + 1, mp, cost);
        for (const candidate of groups[index]) {
            if (used[candidate.kind] >= (maxSlots[candidate.kind] ?? 0)) continue;
            used[candidate.kind]++;
            chosen.push(candidate);
            walk(index + 1, mp + candidate.mpPerMinute, cost + candidate.costPerHour);
            chosen.pop();
            used[candidate.kind]--;
        }
    };
    walk(0, 0, 0);
}

/**
 * The cheapest allocation that reaches a target MP per minute.
 *
 * Ties in cost go to the allocation with more MP, then to fewer items, then to
 * the lexically first hrids, so the answer does not depend on map order.
 *
 * @param {Array<Object>} candidates - From `buildMpCandidates`
 * @param {number} targetMpPerMinute - MP per minute the items must supply
 * @param {Object} [options]
 * @param {{food: number, drink: number}} [options.maxSlots] - Slots per group
 * @returns {{items: Array<Object>, mpPerMinute: number, costPerHour: number}|null}
 *   null when the target is out of reach, or nothing is needed and nothing is priced
 */
export function findBestOptimAllocation(candidates, targetMpPerMinute, { maxSlots = DEFAULT_MAX_SLOTS } = {}) {
    const target = Math.max(0, Number(targetMpPerMinute) || 0);
    let best = null;

    forEachAllocation(candidates || [], maxSlots, (items, mp, cost) => {
        if (mp + 1e-9 < target) return;
        if (target > 0 && items.length === 0) return;
        if (best && compareAllocations(best, items, mp, cost) <= 0) return;
        best = { items: items.slice(), mpPerMinute: mp, costPerHour: cost };
    });

    return best;
}

/**
 * The allocation that reaches the most MP per minute.
 * The answer for a target no allocation reaches, and the ceiling for one that is.
 *
 * @param {Array<Object>} candidates - From `buildMpCandidates`
 * @param {Object} [options]
 * @param {{food: number, drink: number}} [options.maxSlots] - Slots per group
 * @param {number} [options.maxCostPerHour] - Budget; 0 or absent is no budget
 * @returns {{items: Array<Object>, mpPerMinute: number, costPerHour: number}|null}
 */
export function findMaxMpAllocation(candidates, { maxSlots = DEFAULT_MAX_SLOTS, maxCostPerHour = 0 } = {}) {
    let best = null;

    forEachAllocation(candidates || [], maxSlots, (items, mp, cost) => {
        if (items.length === 0) return;
        if (maxCostPerHour > 0 && cost > maxCostPerHour) return;
        if (best) {
            if (mp < best.mpPerMinute - 1e-9) return;
            if (Math.abs(mp - best.mpPerMinute) <= 1e-9) {
                if (cost > best.costPerHour + 1e-9) return;
                if (Math.abs(cost - best.costPerHour) <= 1e-9 && compareItems(best.items, items) <= 0) return;
            }
        }
        best = { items: items.slice(), mpPerMinute: mp, costPerHour: cost };
    });

    return best;
}

/**
 * Order two items by hrid, item by item — the last tiebreak.
 * @param {Array<Object>} a
 * @param {Array<Object>} b
 * @returns {number} Negative when `a` sorts first
 */
function compareItems(a, b) {
    const left = a.map((item) => item.hrid).sort();
    const right = b.map((item) => item.hrid).sort();
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        if (left[i] !== right[i]) return left[i].localeCompare(right[i]);
    }
    return left.length - right.length;
}

/**
 * Whether a held allocation beats a new one: negative keeps it, positive takes the new one.
 * @param {Object} held - Best so far
 * @param {Array<Object>} items - The new allocation
 * @param {number} mp - Its MP per minute
 * @param {number} cost - Its cost per hour
 * @returns {number}
 */
function compareAllocations(held, items, mp, cost) {
    if (Math.abs(held.costPerHour - cost) > 1e-9) return held.costPerHour - cost;
    if (Math.abs(held.mpPerMinute - mp) > 1e-9) return mp - held.mpPerMinute;
    if (held.items.length !== items.length) return held.items.length - items.length;
    return compareItems(held.items, items);
}
