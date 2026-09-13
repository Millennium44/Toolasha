/**
 * Drink Calculator Utility
 * Calculates remaining drink time and queue coverage for non-combat skill panels.
 *
 * Total remaining time per drink =
 *   currentActivationNs (from slot.duration) +
 *   inventoryCount × buffDurationNs ÷ (1 + concentration)
 *
 * Drink Concentration strengthens buffs but consumes drinks faster, so each
 * drink covers less wall-clock time (buff duration is divided by 1 + DC).
 *
 * slot.duration is the remaining nanoseconds on the current activation as reported
 * by the server at last action completion. It is frozen while the skill is inactive
 * and refreshes each action cycle while active — accurate enough for hour-scale estimates.
 */

import dataManager from '../core/data-manager.js';
import { getDrinkConcentration } from './tea-parser.js';
import { resolveActionContext } from './action-context.js';
import { calculateActionStats } from './action-calculator.js';
import { calculateEfficiencyMultiplier } from './efficiency.js';

const FALLBACK_BUFF_DURATION_NS = 300_000_000_000; // 5 min in nanoseconds

/**
 * Calculate remaining drink time (in seconds) for each slotted drink of an action type.
 * Deduplicates slots if the same drink is slotted more than once.
 *
 * @param {string} actionTypeHrid - e.g. "/action_types/woodcutting"
 * @returns {Array<{itemHrid: string, name: string, totalSeconds: number}>}
 */
export function calculateDrinkRemainingSeconds(actionTypeHrid) {
    const gameData = dataManager.getInitClientData();
    if (!gameData) return [];

    const slots = dataManager.getActionDrinkSlots(actionTypeHrid);
    if (!slots?.length) return [];

    const { equipment } = resolveActionContext(actionTypeHrid);
    const itemDetailMap = gameData.itemDetailMap || {};
    const concentration = getDrinkConcentration(equipment, itemDetailMap);

    // One pass over the inventory for every slotted drink at once, rather than
    // a copy-and-filter per slot: this runs on every inventory update
    const slotted = new Set();
    for (const slot of slots) {
        if (slot?.itemHrid) slotted.add(slot.itemHrid);
    }
    const inventoryCounts = countInventoryByHrid(dataManager.getInventory(), slotted);

    const results = [];
    const seen = new Set();

    for (const slot of slots) {
        if (!slot?.itemHrid) continue;
        if (seen.has(slot.itemHrid)) continue;
        seen.add(slot.itemHrid);

        const itemDetails = itemDetailMap[slot.itemHrid];
        if (!itemDetails) continue;

        const buffDurationNs = itemDetails.consumableDetail?.buffs?.[0]?.duration ?? FALLBACK_BUFF_DURATION_NS;
        const effectiveDurationNs = buffDurationNs / (1 + concentration);

        const inventoryCount = inventoryCounts.get(slot.itemHrid) ?? 0;

        const currentActivationNs = slot.isActive ? slot.duration || 0 : 0;
        const totalNs = currentActivationNs + inventoryCount * effectiveDurationNs;

        results.push({
            itemHrid: slot.itemHrid,
            name: itemDetails.name,
            totalSeconds: totalNs / 1e9,
        });
    }

    return results;
}

/**
 * Whether an item carries a given buff type, e.g. Artisan Tea's material discount.
 * @param {Object|undefined} itemDetails - From `itemDetailMap`
 * @param {string} buffTypeHrid - e.g. '/buff_types/artisan'
 * @returns {boolean}
 */
function hasBuffType(itemDetails, buffTypeHrid) {
    return (itemDetails?.consumableDetail?.buffs || []).some((buff) => buff.typeHrid === buffTypeHrid);
}

/**
 * Slotted Artisan Teas whose remaining stock will run out before a run of
 * `numActions` crafts of `actionHrid` finishes — so the material discount the
 * Missing Materials panel and crafting plan billed for the whole run stops
 * applying partway through.
 *
 * Reuses `calculateDrinkRemainingSeconds` for the same wall-clock figure the
 * consumables panel shows, converted through this action's own time-per-craft —
 * the same actionTime/efficiency division `calculateQueueTimeSeconds` uses in
 * the other direction — so "runs out at craft N" and the account's own drink
 * timer never disagree about the same tea.
 *
 * A tea already fully out of stock (and no longer buffed) is left to
 * `isArtisanTeaOutOfStock` — that is a different warning ("the whole run got no
 * discount") from this one ("the run gets a discount that will not last).
 *
 * @param {string} actionHrid - Action HRID
 * @param {number} numActions - Crafts about to be entered/queued
 * @returns {Array<{itemHrid: string, name: string, craftsSustained: number, shortfall: number}>}
 *   One entry per artisan tea that will not last the run; empty when every slotted
 *   artisan tea lasts it, none is slotted, or the action's stats cannot be read
 */
export function artisanTeaShortfall(actionHrid, numActions) {
    if (!(numActions > 0)) return [];
    const gameData = dataManager.getInitClientData();
    const actionDetails = dataManager.getActionDetails(actionHrid);
    if (!gameData || !actionDetails) return [];

    const itemDetailMap = gameData.itemDetailMap || {};
    const drinks = calculateDrinkRemainingSeconds(actionDetails.type);
    if (!drinks.length) return [];

    // Only a drink still actively discounting materials right now — a fully spent,
    // no-longer-buffed slot is the out-of-stock warning's job, not this one's.
    const artisanDrinks = drinks.filter(
        (drink) => drink.totalSeconds > 0 && hasBuffType(itemDetailMap[drink.itemHrid], '/buff_types/artisan')
    );
    if (!artisanDrinks.length) return [];

    const { equipment } = resolveActionContext(actionDetails.type);
    const skills = dataManager.getSkills();
    if (!skills || !equipment) return [];

    const stats = calculateActionStats(actionDetails, {
        skills,
        equipment,
        itemDetailMap,
        includeCommunityBuff: true,
        includeBreakdown: false,
    });
    if (!stats || !(stats.actionTime > 0)) return [];

    const effMultiplier = calculateEfficiencyMultiplier(stats.totalEfficiency);
    const secondsPerCraft = stats.actionTime / effMultiplier;
    if (!(secondsPerCraft > 0)) return [];

    const runSeconds = numActions * secondsPerCraft;

    const shortfalls = [];
    for (const drink of artisanDrinks) {
        if (drink.totalSeconds >= runSeconds) continue;
        const craftsSustained = Math.max(0, Math.floor(drink.totalSeconds / secondsPerCraft));
        shortfalls.push({
            itemHrid: drink.itemHrid,
            name: drink.name,
            craftsSustained,
            shortfall: numActions - craftsSustained,
        });
    }
    return shortfalls;
}

/**
 * Sum inventory counts per item hrid, for the hrids asked about only.
 * @param {Array<{itemHrid: string, count: number}>|null} inventory - Character items
 * @param {Set<string>} hrids - The item hrids worth counting
 * @returns {Map<string, number>} hrid → total count (absent when none held)
 */
function countInventoryByHrid(inventory, hrids) {
    const counts = new Map();
    if (!inventory || hrids.size === 0) return counts;
    for (const item of inventory) {
        if (!hrids.has(item.itemHrid)) continue;
        counts.set(item.itemHrid, (counts.get(item.itemHrid) ?? 0) + (item.count || 0));
    }
    return counts;
}

/**
 * Calculate total remaining queue time in seconds for a given action type.
 * Only counts finite queued actions (infinite queues are skipped).
 *
 * @param {string} actionTypeHrid - e.g. "/action_types/woodcutting"
 * @returns {number} Total queue time in seconds, or 0 if no finite queue
 */
export function calculateQueueTimeSeconds(actionTypeHrid) {
    const gameData = dataManager.getInitClientData();
    if (!gameData) return 0;

    const skills = dataManager.getSkills();
    const { equipment } = resolveActionContext(actionTypeHrid);
    if (!skills || !equipment) return 0;

    const queuedActions = dataManager.getCurrentActions();
    let totalSeconds = 0;

    for (const queuedAction of queuedActions) {
        if (!queuedAction.hasMaxCount) continue;

        const actionDetails = dataManager.getActionDetails(queuedAction.actionHrid);
        if (!actionDetails || actionDetails.type !== actionTypeHrid) continue;

        const remaining = queuedAction.maxCount - queuedAction.currentCount;
        if (remaining <= 0) continue;

        const stats = calculateActionStats(actionDetails, {
            skills,
            equipment,
            itemDetailMap: gameData.itemDetailMap,
            includeCommunityBuff: true,
            includeBreakdown: false,
        });
        if (!stats) continue;

        const effMultiplier = calculateEfficiencyMultiplier(stats.totalEfficiency);
        totalSeconds += (remaining / effMultiplier) * stats.actionTime;
    }

    return totalSeconds;
}
