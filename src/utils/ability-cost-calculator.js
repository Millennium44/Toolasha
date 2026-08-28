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
 * What it costs to own an ability at a level, from nothing.
 *
 * The books to learn it plus the books to level it, at the book's market price —
 * which is what `explainAbilityLevelUpCost` already answers, starting from level
 * zero with zero XP.
 *
 * There used to be a `calculateAbilityCost` here that returned this number and
 * `0` when the book had no listing, so an unpriced ability was reported as free.
 * It is gone: `null` is the honest answer to "what does the market say", and
 * every caller now has to decide what to draw for it. See
 * `explainAbilityLevelUpCost` below.
 *
 * @param {string} abilityHrid - Ability HRID, e.g. `/abilities/fireball`
 * @param {number} targetLevel - Level being priced
 * @returns {Object} Same shape as `explainAbilityLevelUpCost`; `total` is null when unpriced
 */
export function explainAbilityCost(abilityHrid, targetLevel) {
    return explainAbilityLevelUpCost(abilityHrid, 0, 0, targetLevel);
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

    // Books are bought whole — a leftover 480 XP out of 500 still costs a full
    // book. Rounding down here (as a plain division does whenever `currentXp`
    // is not an exact book boundary, which is the common case once XP has
    // accumulated from real play) undercounts both the book total shown to the
    // player and every `total` gold figure derived from it (networth, combat
    // score, tooltip cost).
    let books = Math.max(0, Math.ceil((targetXp - currentXp) / xpPerBook));
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
