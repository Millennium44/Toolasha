/**
 * Cheapest Viable Food Solver
 *
 * Finds the cheapest food setup that still keeps you alive and out of mana
 * trouble at a zone — without changing what *kind* of food you run. Each of your
 * equipped food slots is a template: an HP-instant slot only ever tries other
 * HP-instant foods, an MP-over-time slot only other MP-over-time drinks, and
 * buff-only foods are never touched. The search varies the tier within each
 * type, so the slot structure that made your current setup work is preserved.
 *
 * The search is anchored at what you have equipped. If the current setup
 * survives, each slot walks DOWN one tier at a time within its type until
 * survival breaks, then settles on the last tier that held — so the answer is
 * always a downgrade path from your own setup, never a rebuild from scratch. If
 * the current setup does not survive, the failing dimension's slots (HP slots
 * for deaths, mana slots for running dry) climb a tier at a time until it does;
 * only when even the top tiers can't meet the bar do the targets relax to the
 * best achievable. Slots are walked in order, each fixed before the next moves,
 * so slots feeding the same budget (two mana sources) are measured against each
 * other's real choices. The final combination is one the search itself simmed
 * and passed. Cost gets one final say: within a type, anything restoring at
 * least the settled amount is equally survivable, so the cheapest per point
 * wins, with a confirming sim guarding the swap. And keeping your current food
 * always competes — if it's viable and no more expensive, that's the answer.
 *
 * Shares the analysis seed with the rest of the upgrade run, so a tier that
 * looks survivable did not merely get a lucky sample.
 */

import { runSimulation } from './combat-sim-runner.js';
import { resolveItemPrice } from '../../utils/profit-helpers.js';

/** Food slot count for combat */
const FOOD_SLOTS = 3;

/** Out-of-mana time above this fraction of the run counts as running out */
const OOM_TOLERANCE = 0.005;

/** Deaths per hour under this count as not dying */
const DEATH_TOLERANCE = 0.005;

/**
 * Classify what a consumable restores and how it delivers it.
 * Two foods are interchangeable candidates only when they share this signature —
 * swapping an instant heal for a heal-over-time changes survival mechanics, not
 * just the amount, so tiers are only compared within a signature.
 * @param {Object} detail - consumableDetail from game data
 * @returns {string|null} e.g. 'hp_instant', 'mp_overtime', 'hpmp_instant'; null for buff-only
 */
export function restoreSignature(detail) {
    const hp = Number(detail?.hitpointRestore) > 0;
    const mp = Number(detail?.manapointRestore) > 0;
    if (!hp && !mp) return null;
    const overTime = (Number(detail?.recoveryDuration) || 0) > 0;
    return `${hp ? 'hp' : ''}${mp ? 'mp' : ''}_${overTime ? 'overtime' : 'instant'}`;
}

/**
 * Build the candidate pools from game data, one per restore signature, each
 * sorted by restore amount ascending (the axis the binary search runs on).
 * @param {Object} gameData - Game data payload (itemDetailMap)
 * @returns {Map<string, Array<Object>>} signature → sorted priced entries
 */
export function buildConsumablePools(gameData) {
    const pools = new Map();

    for (const [hrid, item] of Object.entries(gameData?.itemDetailMap || {})) {
        const detail = item?.consumableDetail;
        if (!detail) continue;
        if (!(item.categoryHrid || '').includes('food')) continue;

        const signature = restoreSignature(detail);
        if (!signature) continue;

        const { price } = resolveItemPrice(hrid, { side: 'buy' });
        if (!price || price <= 0) continue;

        const hpRestore = Number(detail.hitpointRestore) || 0;
        const mpRestore = Number(detail.manapointRestore) || 0;
        const totalRestore = hpRestore + mpRestore;

        if (!pools.has(signature)) pools.set(signature, []);
        pools.get(signature).push({
            hrid,
            name: item.name || hrid.split('/').pop().replace(/_/g, ' '),
            signature,
            hpRestore,
            mpRestore,
            totalRestore,
            price,
            pricePerPoint: price / totalRestore,
            triggers: detail.defaultCombatTriggers || null,
        });
    }

    for (const pool of pools.values()) {
        pool.sort((a, b) => a.totalRestore - b.totalRestore || a.pricePerPoint - b.pricePerPoint);
    }
    return pools;
}

/**
 * Cheapest entry (per restore point) that restores at least as much as a
 * reference, on every stat the reference restores. More restore never hurts
 * survival, so a higher tier that costs less per point is still viable — this is
 * where cost finally decides.
 * @param {Array<Object>} pool - Same-signature pool
 * @param {Object} reference - Minimum viable entry
 * @returns {Object} Chosen entry
 */
export function cheapestAtLeast(pool, reference) {
    let best = reference;
    for (const entry of pool) {
        if (entry.hpRestore < reference.hpRestore || entry.mpRestore < reference.mpRestore) continue;
        if (entry.pricePerPoint < best.pricePerPoint) best = entry;
    }
    return best;
}

/**
 * Map the player's equipped food onto searchable slots. Each restore food slot
 * becomes a template bound to its signature's pool; buff-only foods and slots
 * whose type has no priced alternatives are left exactly as equipped.
 * @param {Array<Object|null>} originalFood - The player's configured food slots
 * @param {Object} itemDetailMap - Game item details
 * @param {Map<string, Array<Object>>} pools - From buildConsumablePools
 * @returns {Array<Object>} [{ index, signature, currentHrid, pool }]
 */
export function buildSearchSlots(originalFood, itemDetailMap, pools) {
    const slots = [];
    (originalFood || []).forEach((slot, index) => {
        const detail = slot?.hrid ? itemDetailMap?.[slot.hrid]?.consumableDetail : null;
        if (!detail) return;
        const signature = restoreSignature(detail);
        if (!signature) return; // buff-only food: never touched
        const pool = pools.get(signature) || [];
        if (pool.length === 0) return; // nothing priced of this type: keep as equipped
        slots.push({ index, signature, currentHrid: slot.hrid, pool });
    });
    return slots;
}

/**
 * Read the survival verdict out of a sim result.
 * @param {Object} simResult - SimResult
 * @param {string} playerHrid - Player HRID
 * @returns {{deathsPerHour: number, oomFraction: number}}
 */
export function readViability(simResult, playerHrid) {
    const simHours = (simResult?.simulatedTime || 0) / (3600 * 1e9) || 1;
    const deathsPerHour = (simResult?.deaths?.[playerHrid] || 0) / simHours;

    const oomStat = simResult?.playerRanOutOfManaTime?.[playerHrid];
    let oomTime = oomStat?.totalTimeForOutOfMana || 0;
    if (oomStat?.isOutOfMana) {
        oomTime += (simResult.simulatedTime || 0) - (oomStat.startTimeForOutOfMana || 0);
    }
    const oomFraction = simResult?.simulatedTime > 0 ? oomTime / simResult.simulatedTime : 0;

    return { deathsPerHour, oomFraction };
}

/**
 * Consumable spend per hour implied by a sim result.
 * @param {Object} simResult - SimResult
 * @param {string} playerHrid - Player HRID
 * @param {Object} priceCache - hrid → unit price
 * @returns {number} Gold per hour
 */
function consumableCostPerHour(simResult, playerHrid, priceCache) {
    const simHours = (simResult?.simulatedTime || 0) / (3600 * 1e9) || 1;
    const used = simResult?.consumablesUsed?.[playerHrid] || {};
    let total = 0;
    for (const [hrid, count] of Object.entries(used)) {
        if (priceCache[hrid] === undefined) {
            priceCache[hrid] = resolveItemPrice(hrid, { side: 'buy' }).price || 0;
        }
        total += (count / simHours) * priceCache[hrid];
    }
    return total;
}

/**
 * Slot payload for a chosen consumable, carrying the item's default combat
 * triggers so the sim eats it the way the game would out of the box.
 * @param {Object|null} entry - Pool entry
 * @returns {Object|null} Food slot DTO
 */
function toSlot(entry) {
    if (!entry) return null;
    return { hrid: entry.hrid, triggers: entry.triggers };
}

/**
 * How many sims the food search will need, for progress accounting: the descent
 * from each equipped tier (worst case: every rung below it, plus the empty
 * rung), with slack for the repair climb and the price-swap confirmation.
 * @param {Object} gameData - Game data payload
 * @param {Array<Object|null>} [playerFood] - The player's configured food slots
 * @returns {number} Estimated sim count
 */
export function estimateFoodSimCount(gameData, playerFood = []) {
    const itemDetailMap = gameData?.itemDetailMap || {};
    const pools = buildConsumablePools(gameData);
    const slots = buildSearchSlots(playerFood, itemDetailMap, pools);
    const descentSteps = slots.reduce((sum, slot) => {
        const detail = itemDetailMap[slot.currentHrid]?.consumableDetail;
        const equippedRestore = (Number(detail?.hitpointRestore) || 0) + (Number(detail?.manapointRestore) || 0);
        const below = slot.pool.filter((entry) => entry.totalRestore < equippedRestore).length;
        return sum + below + 1;
    }, 0);
    return 2 + descentSteps;
}

/**
 * Find the cheapest food setup — keeping the player's food types per slot — that
 * avoids deaths and mana starvation.
 * @param {Object} params - { gameData, playerDTOs, playerIndex, zoneHrid, difficultyTier,
 *   hours, communityBuffs, seed, baselineResult }
 * @param {Function} [onProgress] - Called with { description }
 * @param {Object} [options] - { abortSignal: () => boolean }
 * @returns {Promise<Object|null>} Recommendation, or null when there is nothing to search
 */
export async function runFoodOptimization(params, onProgress, options = {}) {
    const { gameData, playerDTOs, playerIndex, zoneHrid, difficultyTier, hours, communityBuffs, seed, baselineResult } =
        params;
    const { abortSignal } = options;

    const playerHrid = playerDTOs[playerIndex].hrid;
    const itemDetailMap = gameData?.itemDetailMap || {};
    const originalFood = playerDTOs[playerIndex].food || [];
    const pools = buildConsumablePools(gameData);
    const searchSlots = buildSearchSlots(originalFood, itemDetailMap, pools);
    if (searchSlots.length === 0) return null;

    const priceCache = {};
    let simCount = 0;

    /**
     * Sim one assignment of the searchable slots. Untouched slots (buff foods,
     * types with no alternatives) always stay exactly as equipped.
     * @param {Map<number, Object|null>} choices - slot index → pool entry or null (slot emptied)
     * @param {string} label - Progress label
     * @returns {Promise<Object|null>} Trial record
     */
    const trial = async (choices, label) => {
        if (abortSignal?.()) return null;
        onProgress?.({ description: `Food: ${label}` });

        const dtos = JSON.parse(JSON.stringify(playerDTOs));
        const food = dtos[playerIndex].food || [];
        while (food.length < FOOD_SLOTS) food.push(null);
        for (const slot of searchSlots) {
            food[slot.index] = toSlot(choices.get(slot.index));
        }
        dtos[playerIndex].food = food;

        const simResult = await runSimulation(
            { gameData, playerDTOs: dtos, zoneHrid, difficultyTier, hours, communityBuffs, seed },
            null
        );
        simCount++;

        const { deathsPerHour, oomFraction } = readViability(simResult, playerHrid);
        return {
            label,
            deathsPerHour,
            oomFraction,
            costPerHour: consumableCostPerHour(simResult, playerHrid, priceCache),
        };
    };

    /**
     * The equipped item as a pool entry — the real entry when it's priced, or a
     * pseudo-entry (infinite price per point) when it isn't, so the search can
     * still anchor on it and any priced same-type equivalent wins the price pass.
     * @param {Object} slot - Search slot
     * @returns {Object} Entry for the equipped item
     */
    const equippedEntry = (slot) => {
        const inPool = slot.pool.find((entry) => entry.hrid === slot.currentHrid);
        if (inPool) return inPool;
        const detail = itemDetailMap[slot.currentHrid]?.consumableDetail || {};
        const hpRestore = Number(detail.hitpointRestore) || 0;
        const mpRestore = Number(detail.manapointRestore) || 0;
        return {
            hrid: slot.currentHrid,
            name: itemDetailMap[slot.currentHrid]?.name || slot.currentHrid.split('/').pop().replace(/_/g, ' '),
            signature: slot.signature,
            hpRestore,
            mpRestore,
            totalRestore: hpRestore + mpRestore,
            price: null,
            pricePerPoint: Infinity,
            triggers: detail.defaultCombatTriggers || null,
        };
    };

    // Anchor: every slot starts at exactly what's equipped
    const choices = new Map();
    for (const slot of searchSlots) choices.set(slot.index, equippedEntry(slot));

    let deathTarget = DEATH_TOLERANCE;
    let oomTarget = OOM_TOLERANCE;
    const viable = (record) => record.deathsPerHour <= deathTarget && record.oomFraction <= oomTarget;

    // Trial 0 is the current setup — free when the analysis baseline is available,
    // since the baseline sim ran this exact food on the same seed
    let record;
    if (baselineResult) {
        const viability = readViability(baselineResult, playerHrid);
        record = {
            label: 'current food',
            deathsPerHour: viability.deathsPerHour,
            oomFraction: viability.oomFraction,
            costPerHour: consumableCostPerHour(baselineResult, playerHrid, priceCache),
        };
    } else {
        record = await trial(choices, 'current food');
        if (!record) return null;
    }
    const currentRecord = record;
    const trials = [record];

    // Repair climb: if the current setup fails, raise the failing dimension's
    // slots (HP types for deaths, mana types for running dry) one tier at a time
    // until it holds. Only when nothing is left to raise do the targets relax to
    // the best this food structure can do.
    let ceilingDies = false;
    let ceilingOoms = false;
    while (!viable(record)) {
        if (abortSignal?.()) return null;
        const needHp = record.deathsPerHour > deathTarget;
        const needMp = record.oomFraction > oomTarget;
        let raised = false;
        for (const slot of searchSlots) {
            if (!((needHp && slot.signature.includes('hp')) || (needMp && slot.signature.includes('mp')))) continue;
            const current = choices.get(slot.index);
            const next = slot.pool.find((entry) => entry.totalRestore > (current?.totalRestore ?? 0));
            if (next) {
                choices.set(slot.index, next);
                raised = true;
            }
        }
        if (!raised) {
            ceilingDies = record.deathsPerHour > DEATH_TOLERANCE;
            ceilingOoms = record.oomFraction > OOM_TOLERANCE;
            deathTarget = Math.max(deathTarget, record.deathsPerHour);
            oomTarget = Math.max(oomTarget, record.oomFraction);
            break;
        }
        record = await trial(choices, 'raising tiers to survive');
        if (!record) return null;
        trials.push(record);
    }
    let finalRecord = record;

    // Descent: slot by slot, step down one tier at a time (ending at empty) until
    // survival breaks, then settle on the last tier that held. Slots are walked in
    // order and fixed as they settle, so a shared budget like mana is always
    // measured against the other slots' real choices — and every accepted step is
    // a combination that was actually simmed.
    for (const slot of searchSlots) {
        if (abortSignal?.()) break;
        const start = choices.get(slot.index);
        const ladder = [
            ...slot.pool.filter((entry) => entry.totalRestore < (start?.totalRestore ?? 0)).reverse(),
            null,
        ];
        for (const entry of ladder) {
            if (abortSignal?.()) break;
            const candidate = new Map(choices);
            candidate.set(slot.index, entry);
            const stepRecord = await trial(candidate, entry ? `trying ${entry.name}` : `slot ${slot.index + 1} empty`);
            if (!stepRecord) break;
            trials.push(stepRecord);
            if (!viable(stepRecord)) break;
            choices.set(slot.index, entry);
            finalRecord = stepRecord;
        }
    }
    if (abortSignal?.()) return null;

    // Price pass: within each slot's type, anything restoring at least the settled
    // amount is equally survivable — swap to the cheapest per point. Swaps leave
    // the proven combination, so they get one confirming sim; if that fails
    // (noise), revert to the tiers the descent actually proved.
    const provenChoices = new Map(choices);
    let swapped = false;
    for (const slot of searchSlots) {
        const entry = choices.get(slot.index);
        if (!entry) continue;
        const cheaper = cheapestAtLeast(slot.pool, entry);
        if (cheaper.hrid !== entry.hrid) {
            choices.set(slot.index, cheaper);
            swapped = true;
        }
    }

    let final = finalRecord;
    if (swapped) {
        const confirm = await trial(choices, 'cheapest viable combination');
        if (!confirm && abortSignal?.()) return null;
        if (confirm) {
            trials.push(confirm);
            if (viable(confirm)) {
                final = confirm;
            } else {
                // The cheaper same-or-better swap didn't hold up — keep the tiers
                // the descent actually proved
                for (const [index, entry] of provenChoices) choices.set(index, entry);
            }
        }
    }
    if (!final) return null;
    const finalChoices = choices;

    const slotName = (hrid) => itemDetailMap[hrid]?.name || hrid.split('/').pop().replace(/_/g, ' ');
    const currentItems = originalFood.filter(Boolean).map((slot) => slotName(slot.hrid));

    // Keeping the current food is always a candidate: if it's viable and no more
    // expensive than the searched pick, recommend leaving things alone.
    const keepCurrent =
        currentRecord.deathsPerHour <= deathTarget &&
        currentRecord.oomFraction <= oomTarget &&
        currentRecord.costPerHour <= final.costPerHour;

    const slots = searchSlots.map((slot) => {
        const choice = finalChoices.get(slot.index) ?? null;
        return {
            index: slot.index,
            fromHrid: slot.currentHrid,
            fromName: slotName(slot.currentHrid),
            hrid: choice?.hrid ?? null,
            name: choice?.name ?? null,
            hpRestore: choice?.hpRestore ?? 0,
            mpRestore: choice?.mpRestore ?? 0,
            changed: choice?.hrid !== slot.currentHrid,
        };
    });

    return {
        simCount,
        deathTarget,
        oomTarget,
        ceilingDies,
        ceilingOoms,
        keepCurrent,
        recommendation: {
            slots,
            costPerHour: final.costPerHour,
            deathsPerHour: final.deathsPerHour,
            oomFraction: final.oomFraction,
        },
        current: {
            items: currentItems,
            costPerHour: currentRecord.costPerHour,
            deathsPerHour: currentRecord.deathsPerHour,
            oomFraction: currentRecord.oomFraction,
        },
        trials,
    };
}
