/**
 * Cheapest Viable Food Solver
 *
 * Finds the cheapest food-slot setup that still keeps you alive and out of mana
 * trouble at a zone. Rather than pricing every combination (a full sim each), it
 * leans on two monotonic facts: a food that restores more HP per eat never makes
 * you die more often, and a drink that restores more MP never makes you run dry
 * sooner. That turns "which tier do I actually need" into a binary search over
 * restore amount, and only then does cost enter — among everything that restores
 * at least the needed amount, the cheapest per point wins.
 *
 * Shares the analysis seed with the rest of the upgrade run, so a tier that looks
 * survivable did not merely get a lucky sample.
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
 * Build the HP and MP restore pools from game data, cheapest-per-point first.
 * @param {Object} gameData - Game data payload (itemDetailMap)
 * @returns {{hp: Array<Object>, mp: Array<Object>}} Priced candidate pools
 */
export function buildConsumablePools(gameData) {
    const hp = [];
    const mp = [];

    for (const [hrid, item] of Object.entries(gameData?.itemDetailMap || {})) {
        const detail = item?.consumableDetail;
        if (!detail) continue;
        if (!(item.categoryHrid || '').includes('food')) continue;

        const hpRestore = Number(detail.hitpointRestore) || 0;
        const mpRestore = Number(detail.manapointRestore) || 0;
        if (hpRestore <= 0 && mpRestore <= 0) continue;

        const { price } = resolveItemPrice(hrid, { side: 'buy' });
        if (!price || price <= 0) continue;

        const entry = {
            hrid,
            name: item.name || hrid.split('/').pop().replace(/_/g, ' '),
            hpRestore,
            mpRestore,
            price,
            overTime: (Number(detail.recoveryDuration) || 0) > 0,
            triggers: detail.defaultCombatTriggers || null,
        };

        if (hpRestore > 0) hp.push({ ...entry, restore: hpRestore, pricePerPoint: price / hpRestore });
        if (mpRestore > 0) mp.push({ ...entry, restore: mpRestore, pricePerPoint: price / mpRestore });
    }

    const byRestore = (a, b) => a.restore - b.restore || a.pricePerPoint - b.pricePerPoint;
    hp.sort(byRestore);
    mp.sort(byRestore);
    return { hp, mp };
}

/**
 * Cheapest item (per restore point) that restores at least as much as a reference.
 * A higher tier that costs less per point is still viable — more restore never
 * hurts survival — so this is where cost finally decides.
 * @param {Array<Object>} pool - Sorted pool
 * @param {Object} reference - Minimum viable entry
 * @returns {Object} Chosen entry
 */
export function cheapestAtLeast(pool, reference) {
    let best = reference;
    for (const entry of pool) {
        if (entry.restore < reference.restore) continue;
        if (entry.pricePerPoint < best.pricePerPoint) best = entry;
    }
    return best;
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
 * Fill the food slots with the chosen HP and MP items, deduplicated — one item may
 * cover both roles. Any buff-only food the player already had stays equipped: it
 * isn't part of what's being optimized, and silently dropping it would change the
 * damage taken and skew every trial.
 * @param {Object|null} hpEntry - HP choice
 * @param {Object|null} mpEntry - MP choice
 * @param {Array<Object|null>} originalFood - The player's configured food slots
 * @param {Object} itemDetailMap - Game item details
 * @returns {Array<Object|null>} Food array
 */
export function buildFoodSlots(hpEntry, mpEntry, originalFood = [], itemDetailMap = {}) {
    const buffOnly = (originalFood || []).filter((slot) => {
        const detail = slot?.hrid ? itemDetailMap?.[slot.hrid]?.consumableDetail : null;
        if (!detail) return false;
        return !(Number(detail.hitpointRestore) > 0 || Number(detail.manapointRestore) > 0);
    });

    const slots = [];
    if (hpEntry) slots.push(toSlot(hpEntry));
    if (mpEntry && mpEntry.hrid !== hpEntry?.hrid) slots.push(toSlot(mpEntry));
    for (const slot of buffOnly) {
        if (slots.length >= FOOD_SLOTS) break;
        slots.push(slot);
    }
    while (slots.length < FOOD_SLOTS) slots.push(null);
    return slots.slice(0, FOOD_SLOTS);
}

/**
 * How many sims the food search will need, for progress accounting: two probes,
 * a binary search per pool, a mana probe and a confirmation.
 * @param {Object} gameData - Game data payload
 * @returns {number} Estimated sim count
 */
export function estimateFoodSimCount(gameData) {
    const pools = buildConsumablePools(gameData);
    const steps = (n) => (n > 0 ? Math.ceil(Math.log2(n + 1)) : 0);
    return 2 + steps(pools.hp.length) + 1 + steps(pools.mp.length) + 1;
}

/**
 * Find the cheapest food setup that avoids deaths and mana starvation.
 * @param {Object} params - { gameData, playerDTOs, playerIndex, zoneHrid, difficultyTier,
 *   hours, communityBuffs, seed, baselineResult }
 * @param {Function} [onProgress] - Called with { description }
 * @param {Object} [options] - { abortSignal: () => boolean }
 * @returns {Promise<Object|null>} Recommendation, or null when no priced food exists
 */
export async function runFoodOptimization(params, onProgress, options = {}) {
    const { gameData, playerDTOs, playerIndex, zoneHrid, difficultyTier, hours, communityBuffs, seed, baselineResult } =
        params;
    const { abortSignal } = options;

    const playerHrid = playerDTOs[playerIndex].hrid;
    const pools = buildConsumablePools(gameData);
    if (pools.hp.length === 0 && pools.mp.length === 0) return null;

    const priceCache = {};
    let simCount = 0;

    /**
     * Sim one food setup.
     * @param {Object|null} hpEntry - HP choice
     * @param {Object|null} mpEntry - MP choice
     * @param {string} label - Progress label
     * @returns {Promise<Object|null>} Trial record
     */
    const trial = async (hpEntry, mpEntry, label) => {
        if (abortSignal?.()) return null;
        onProgress?.({ description: `Food: ${label}` });

        const dtos = JSON.parse(JSON.stringify(playerDTOs));
        dtos[playerIndex].food = buildFoodSlots(
            hpEntry,
            mpEntry,
            playerDTOs[playerIndex].food,
            gameData?.itemDetailMap
        );

        const simResult = await runSimulation(
            { gameData, playerDTOs: dtos, zoneHrid, difficultyTier, hours, communityBuffs, seed },
            null
        );
        simCount++;

        const { deathsPerHour, oomFraction } = readViability(simResult, playerHrid);
        return {
            label,
            hpEntry,
            mpEntry,
            deathsPerHour,
            oomFraction,
            costPerHour: consumableCostPerHour(simResult, playerHrid, priceCache),
        };
    };

    const bestHp = pools.hp[pools.hp.length - 1] || null;
    const bestMp = pools.mp[pools.mp.length - 1] || null;

    // Ceiling probe: the most restorative setup available. If this still dies, no
    // food choice fixes the zone and the target relaxes to "no worse than this".
    const ceiling = await trial(bestHp, bestMp, 'best available');
    if (!ceiling) return null;

    const deathTarget = Math.max(DEATH_TOLERANCE, ceiling.deathsPerHour);
    const oomTarget = Math.max(OOM_TOLERANCE, ceiling.oomFraction);
    const survivable = (record) => record.deathsPerHour <= deathTarget;
    const manaOk = (record) => record.oomFraction <= oomTarget;

    const trials = [ceiling];

    // Floor probe: nothing equipped. Settles whether food is needed at all, and
    // gives the search a known-bad end when it is.
    const empty = await trial(null, null, 'no food');
    if (!empty) return null;
    trials.push(empty);

    /**
     * Smallest pool entry that satisfies the check, by binary search over restore
     * amount. Assumes the check is monotonic in restore, which is why the pools
     * are sorted by restore rather than by price.
     * @param {Array<Object>} pool - Sorted pool
     * @param {Function} makeTrial - (entry) => Promise<Object|null>
     * @param {Function} check - (record) => boolean
     * @returns {Promise<Object|null>} Minimum viable entry
     */
    const searchMinimum = async (pool, makeTrial, check) => {
        let low = 0;
        let high = pool.length - 1;
        let found = null;
        while (low <= high) {
            if (abortSignal?.()) return found;
            const mid = Math.floor((low + high) / 2);
            const record = await makeTrial(pool[mid]);
            if (!record) return found;
            trials.push(record);
            if (check(record)) {
                found = pool[mid];
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }
        return found;
    };

    // HP: does anything need eating, and if so how much per eat?
    let hpChoice = null;
    if (!survivable(empty) && pools.hp.length > 0) {
        const minimum = await searchMinimum(
            pools.hp,
            (entry) => trial(entry, bestMp, `${entry.name} + best drink`),
            survivable
        );
        hpChoice = minimum ? cheapestAtLeast(pools.hp, minimum) : bestHp;
    }

    // MP: same question for mana, now holding the chosen food fixed
    let mpChoice = null;
    const emptyMana = hpChoice ? await trial(hpChoice, null, `${hpChoice.name} only`) : empty;
    if (emptyMana) {
        if (hpChoice) trials.push(emptyMana);
        if (!manaOk(emptyMana) && pools.mp.length > 0) {
            const minimum = await searchMinimum(
                pools.mp,
                (entry) => trial(hpChoice, entry, `${entry.name}${hpChoice ? ` + ${hpChoice.name}` : ''}`),
                manaOk
            );
            mpChoice = minimum ? cheapestAtLeast(pools.mp, minimum) : bestMp;
        }
    }

    // Confirm the priced-down pick actually holds up; fall back to the tier the
    // search proved if the cheaper same-or-better item somehow does not.
    let final = await trial(hpChoice, mpChoice, 'cheapest viable');
    if (final && (!survivable(final) || !manaOk(final))) {
        trials.push(final);
        final = await trial(bestHp, bestMp, 'fallback: best available');
        if (final) {
            hpChoice = bestHp;
            mpChoice = bestMp;
        }
    }
    if (!final) return null;
    trials.push(final);

    const baselineFood = (playerDTOs[playerIndex].food || [])
        .filter(Boolean)
        .map((slot) => gameData.itemDetailMap?.[slot.hrid]?.name || slot.hrid.split('/').pop().replace(/_/g, ' '));
    const baselineViability = baselineResult ? readViability(baselineResult, playerHrid) : null;

    return {
        simCount,
        deathTarget,
        oomTarget,
        ceilingDies: ceiling.deathsPerHour > DEATH_TOLERANCE,
        recommendation: {
            hp: hpChoice ? { hrid: hpChoice.hrid, name: hpChoice.name, restore: hpChoice.hpRestore } : null,
            mp: mpChoice ? { hrid: mpChoice.hrid, name: mpChoice.name, restore: mpChoice.mpRestore } : null,
            costPerHour: final.costPerHour,
            deathsPerHour: final.deathsPerHour,
            oomFraction: final.oomFraction,
        },
        current: {
            items: baselineFood,
            costPerHour: baselineResult ? consumableCostPerHour(baselineResult, playerHrid, priceCache) : null,
            deathsPerHour: baselineViability?.deathsPerHour ?? null,
            oomFraction: baselineViability?.oomFraction ?? null,
        },
        trials,
    };
}
