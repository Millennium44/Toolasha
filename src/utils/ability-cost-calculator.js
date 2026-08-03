/**
 * Ability Cost Calculator Utility
 * Calculates the cost to reach a specific ability level
 * Extracted from ability-book-calculator.js for reuse in combat score
 */

import dataManager from '../core/data-manager.js';
import marketAPI from '../api/marketplace.js';

/**
 * List of starter abilities that give 50 XP per book (others give 500)
 */
const STARTER_ABILITIES = [
    'poke',
    'scratch',
    'smack',
    'quick_shot',
    'water_strike',
    'fireball',
    'entangle',
    'minor_heal',
];

/**
 * Check if an ability is a starter ability (50 XP per book)
 * @param {string} abilityHrid - Ability HRID
 * @returns {boolean} True if starter ability
 */
export function isStarterAbility(abilityHrid) {
    return STARTER_ABILITIES.some((skill) => abilityHrid.includes(skill));
}

/**
 * Calculate the cost to reach a specific ability level from level 0
 * @param {string} abilityHrid - Ability HRID (e.g., '/abilities/fireball')
 * @param {number} targetLevel - Target level to reach
 * @returns {number} Total cost in coins
 */
export function calculateAbilityCost(abilityHrid, targetLevel) {
    const gameData = dataManager.getInitClientData();
    if (!gameData) return 0;

    const levelXpTable = gameData.levelExperienceTable;
    if (!levelXpTable) return 0;

    // Get XP needed to reach target level from level 0
    const targetXp = levelXpTable[targetLevel] || 0;

    // Determine XP per book (50 for starters, 500 for advanced)
    const xpPerBook = isStarterAbility(abilityHrid) ? 50 : 500;

    // Calculate books needed
    let booksNeeded = targetXp / xpPerBook;
    booksNeeded += 1; // +1 book to learn the ability initially

    // Get market price for ability book
    const itemHrid = abilityHrid.replace('/abilities/', '/items/');
    const prices = marketAPI.getPrice(itemHrid, 0);

    if (!prices) return 0;

    // Match MCS behavior: if only one side of the order book exists, use it for both
    // (getPrice normalizes missing sides to null)
    let ask = prices.ask;
    let bid = prices.bid;

    if (ask != null && bid == null) {
        bid = ask;
    }
    if (bid != null && ask == null) {
        ask = bid;
    }
    if (ask == null && bid == null) {
        return 0;
    }

    // Use weighted average
    const weightedPrice = (ask + bid) / 2;

    return booksNeeded * weightedPrice;
}

/**
 * Calculate the cost to level up an ability from current level to target level
 * @param {string} abilityHrid - Ability HRID
 * @param {number} currentLevel - Current ability level
 * @param {number} currentXp - Current ability XP
 * @param {number} targetLevel - Target ability level
 * @returns {number} Cost in coins
 */
export function calculateAbilityLevelUpCost(abilityHrid, currentLevel, currentXp, targetLevel) {
    return explainAbilityLevelUpCost(abilityHrid, currentLevel, currentXp, targetLevel).total ?? 0;
}

/**
 * The same cost, itemised: which book, how many, at what price.
 *
 * An ability is levelled by reading books, not by buying a copy of itself at an
 * enhancement level — so a breakdown built from `resolveUpgradeBuyPrice` asks the
 * market for something that does not exist and comes back with "no price found"
 * for an ability anyone can buy books for today. This is what an ability upgrade
 * actually costs, in the terms it is actually paid in.
 *
 * @param {string} abilityHrid - Ability HRID, e.g. `/abilities/fireball`
 * @param {number} currentLevel - Level it is at now (0 = not learned)
 * @param {number} currentXp - XP it has now
 * @param {number} targetLevel - Level being priced
 * @returns {Object} `{ bookHrid, bookName, books, xpPerBook, bookPrice, total, learnBook }`,
 *   with `bookPrice` and `total` null when the book has no market listing
 */
export function explainAbilityLevelUpCost(abilityHrid, currentLevel, currentXp, targetLevel) {
    const gameData = dataManager.getInitClientData();
    const bookHrid = String(abilityHrid || '').replace('/abilities/', '/items/');
    const bookName =
        gameData?.itemDetailMap?.[bookHrid]?.name || bookHrid.split('/').pop().replace(/_/g, ' ') || 'ability book';
    const blank = { bookHrid, bookName, books: 0, xpPerBook: 0, bookPrice: null, total: null, learnBook: false };

    const levelXpTable = gameData?.levelExperienceTable;
    if (!levelXpTable) return blank;

    const targetXp = levelXpTable[targetLevel] || 0;
    const xpPerBook = isStarterAbility(abilityHrid) ? 50 : 500;

    let books = (targetXp - currentXp) / xpPerBook;
    // A book is spent learning the ability before any of them count as levels
    const learnBook = currentLevel === 0;
    if (learnBook) books += 1;

    const prices = marketAPI.getPrice(bookHrid, 0);
    // Match MCS behavior: if only one side of the order book exists, use it for both
    // (getPrice normalizes missing sides to null)
    let ask = prices?.ask ?? null;
    let bid = prices?.bid ?? null;
    if (ask != null && bid == null) bid = ask;
    if (bid != null && ask == null) ask = bid;
    if (ask == null || bid == null) return { ...blank, books, xpPerBook, learnBook };

    const bookPrice = (ask + bid) / 2;
    return { bookHrid, bookName, books, xpPerBook, bookPrice, total: books * bookPrice, learnBook };
}
