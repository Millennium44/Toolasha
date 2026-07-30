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
 * Rather than pricing every combination (a full sim each), it leans on a
 * monotonic fact: within one food type, a higher tier never makes you die more
 * or run dry sooner. That turns "which tier does this slot actually need" into a
 * binary search over restore amount, run slot by slot — each slot is fixed at
 * its proven minimum before the next is searched, so slots that feed the same
 * budget (two mana sources) are minimized against each other, not against a
 * top-tier partner they won't actually have. The final combination is one the
 * search itself simmed and passed. Only then does cost enter: within a type,
 * anything restoring at least the proven amount is equally survivable, so the
 * cheapest per point wins, with one confirming sim guarding the swap. The final
 * answer is never worse than simply keeping what you have: if your current food
 * is viable and cheaper, the recommendation is to keep it.
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
 * How many sims the food search will need, for progress accounting: a ceiling
 * probe, a binary search per equipped restore slot (with an extra "empty slot"
 * rung), and a confirmation.
 * @param {Object} gameData - Game data payload
 * @param {Array<Object|null>} [playerFood] - The player's configured food slots
 * @returns {number} Estimated sim count
 */
export function estimateFoodSimCount(gameData, playerFood = []) {
    const pools = buildConsumablePools(gameData);
    const slots = buildSearchSlots(playerFood, gameData?.itemDetailMap || {}, pools);
    const searchSteps = slots.reduce((sum, slot) => sum + Math.ceil(Math.log2(slot.pool.length + 2)), 0);
    return 2 + searchSteps;
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
     * Choice map with every slot at its pool's top tier.
     * @returns {Map<number, Object|null>}
     */
    const ceilingChoices = () => {
        const choices = new Map();
        for (const slot of searchSlots) {
            choices.set(slot.index, slot.pool[slot.pool.length - 1]);
        }
        return choices;
    };

    // Ceiling probe: every slot at the top tier of its own type. This is the best
    // the player's structure can do — if it still dies or runs dry, no tier choice
    // fixes the zone and the targets relax to "no worse than this".
    const ceiling = await trial(ceilingChoices(), 'best tiers of your food types');
    if (!ceiling) return null;

    const deathTarget = Math.max(DEATH_TOLERANCE, ceiling.deathsPerHour);
    const oomTarget = Math.max(OOM_TOLERANCE, ceiling.oomFraction);
    const viable = (record) => record.deathsPerHour <= deathTarget && record.oomFraction <= oomTarget;

    const trials = [ceiling];

    // Sequential per-slot minimization. Slots are searched in order, and each
    // slot is FIXED at its proven minimum before the next slot is searched —
    // never left at ceiling. This matters when two slots feed the same budget
    // (a gummy and a yogurt both supplying mana): minimizing each against a
    // top-tier partner would prove two minima that fail together, and the old
    // fallback then jumped to top tiers of everything. Searched sequentially,
    // every passing trial contains all the already-fixed choices, so the last
    // slot's passing trial IS the final combination, already proven.
    const finalChoices = ceilingChoices();
    let finalRecord = null; // trial record matching finalChoices exactly, when one exists
    for (const slot of searchSlots) {
        if (abortSignal?.()) break;
        const rungs = [null, ...slot.pool];
        let low = 0;
        let high = rungs.length - 1;
        let foundRung = null;
        let foundRecord = null;
        while (low <= high) {
            if (abortSignal?.()) break;
            const mid = Math.floor((low + high) / 2);
            const entry = rungs[mid];
            const candidate = new Map(finalChoices);
            candidate.set(slot.index, entry);
            const record = await trial(
                candidate,
                entry ? `${entry.name} in slot ${slot.index + 1}` : `slot ${slot.index + 1} empty`
            );
            if (!record) break;
            trials.push(record);
            if (viable(record)) {
                foundRung = mid;
                foundRecord = record;
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }

        if (foundRung === null) {
            // Nothing passed below (or at) the top; the slot stays at ceiling and
            // the running combination is no longer a simmed one
            finalRecord = null;
        } else {
            finalChoices.set(slot.index, foundRung === 0 ? null : rungs[foundRung]);
            finalRecord = foundRecord;
        }
    }
    if (abortSignal?.()) return null;

    // Price pass: within each slot's type, anything restoring at least the proven
    // amount is equally survivable — swap to the cheapest per point. Swaps leave
    // the proven combination, so they get one confirming sim; if that fails
    // (noise), revert to the proven tiers rather than escalating.
    const provenChoices = new Map(finalChoices);
    let swapped = false;
    for (const slot of searchSlots) {
        const entry = finalChoices.get(slot.index);
        if (!entry) continue;
        const cheaper = cheapestAtLeast(slot.pool, entry);
        if (cheaper.hrid !== entry.hrid) {
            finalChoices.set(slot.index, cheaper);
            swapped = true;
        }
    }

    let final = finalRecord;
    if (swapped || !final) {
        final = await trial(finalChoices, 'cheapest viable combination');
        if (final) trials.push(final);
        if (final && !viable(final) && finalRecord) {
            // The cheaper same-or-better swap didn't hold up — keep the tiers the
            // search actually proved
            for (const [index, entry] of provenChoices) finalChoices.set(index, entry);
            final = finalRecord;
        }
    }
    if (!final) return null;

    const slotName = (hrid) => itemDetailMap[hrid]?.name || hrid.split('/').pop().replace(/_/g, ' ');
    const currentItems = originalFood.filter(Boolean).map((slot) => slotName(slot.hrid));
    const currentViability = baselineResult ? readViability(baselineResult, playerHrid) : null;
    const currentCost = baselineResult ? consumableCostPerHour(baselineResult, playerHrid, priceCache) : null;

    // Keeping the current food is always a candidate: if it's viable and no more
    // expensive than the searched pick, recommend leaving things alone.
    const currentViable =
        currentViability !== null &&
        currentViability.deathsPerHour <= deathTarget &&
        currentViability.oomFraction <= oomTarget;
    const keepCurrent = currentViable && currentCost !== null && currentCost <= final.costPerHour;

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
        ceilingDies: ceiling.deathsPerHour > DEATH_TOLERANCE,
        ceilingOoms: ceiling.oomFraction > OOM_TOLERANCE,
        keepCurrent,
        recommendation: {
            slots,
            costPerHour: final.costPerHour,
            deathsPerHour: final.deathsPerHour,
            oomFraction: final.oomFraction,
        },
        current: {
            items: currentItems,
            costPerHour: currentCost,
            deathsPerHour: currentViability?.deathsPerHour ?? null,
            oomFraction: currentViability?.oomFraction ?? null,
        },
        trials,
    };
}
