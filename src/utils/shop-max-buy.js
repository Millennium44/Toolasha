/**
 * Shop Max Buy Helper
 * Pure functions for resolving a buy dialog's cost line(s) to item hrids and computing the
 * most affordable quantity. Used by shop-max-buy-button.js's "Max" button.
 *
 * Cost lines are found structurally (the cost row is the quantity input container's next
 * sibling) and currencies are identified by their icon sprite first, so a client running in
 * another language still resolves. The displayed item name is only a fallback for rows that
 * draw no icon.
 */

import dataManager from '../core/data-manager.js';
import { getIconHref, getItemHridFromIconHref, getItemHridFromName } from './game-lookups.js';

const INVENTORY_LOCATION = '/item_locations/inventory';
const AMOUNT_RE = /\d[\d.,\s]*\d|\d/;

/**
 * Owned count of an item in the inventory, summed across enhancement levels.
 * @param {string} itemHrid
 * @returns {number}
 */
function getOwnedCount(itemHrid) {
    const inventory = dataManager.getInventory();
    if (!inventory) return 0;

    let total = 0;
    for (const item of inventory) {
        if (item?.itemHrid === itemHrid && item.itemLocationHrid === INVENTORY_LOCATION) {
            total += item.count || 0;
        }
    }
    return total;
}

/**
 * Parse a locale-formatted amount (digits plus thousands separators or whitespace).
 * @param {string} text
 * @returns {{amount: number, matchEnd: number}|null}
 */
function matchAmount(text) {
    const match = text.match(AMOUNT_RE);
    if (!match) return null;

    const amount = parseInt(match[0].replace(/[.,\s]/g, ''), 10);
    if (!Number.isFinite(amount)) return null;

    return { amount, matchEnd: match.index + match[0].length };
}

/**
 * The innermost divs of the cost row that contain a digit (one per currency the item costs).
 * A wrapper around several cost lines is excluded because a descendant div holds a digit too.
 * @param {Element} costContainer
 * @returns {Array<Element>}
 */
function getCandidateRows(costContainer) {
    const divs = Array.from(costContainer.querySelectorAll('div'));
    const pool = divs.length ? divs : [costContainer];

    return pool.filter((el) => {
        if (!/\d/.test(el.textContent || '')) return false;
        return !Array.from(el.querySelectorAll('div')).some((d) => /\d/.test(d.textContent || ''));
    });
}

/**
 * Resolve a buy dialog's cost line(s) to item hrids and per-unit amounts.
 * @param {Element} inputContainer - the *Panel_inputContainer element the Max button sits in
 * @returns {Array<{itemHrid: string, perUnitAmount: number}>}
 */
export function resolveCostLines(inputContainer) {
    const costContainer = inputContainer?.nextElementSibling;
    if (!costContainer) return [];

    const lines = [];

    for (const row of getCandidateRows(costContainer)) {
        const parsed = matchAmount(row.textContent);
        if (!parsed) continue;

        // Sprite first: it does not change with the game language
        let itemHrid = getItemHridFromIconHref(getIconHref(row, 'items_sprite'));
        if (!itemHrid) {
            // The Shop tab draws "5,000 Coin" as text after the amount
            const itemName = row.textContent.slice(parsed.matchEnd).trim();
            itemHrid = itemName ? getItemHridFromName(itemName) : null;
        }
        if (!itemHrid) continue;

        lines.push({ itemHrid, perUnitAmount: parsed.amount });
    }

    return lines;
}

/**
 * Max quantity affordable across every cost line: min of floor(owned / perUnitAmount).
 * @param {Array<{itemHrid: string, perUnitAmount: number}>} costLines
 * @returns {number|null} null when there is no resolvable cost line or one unit is unaffordable
 *   (the caller leaves the input untouched).
 */
export function computeMaxAffordable(costLines) {
    if (!costLines.length) return null;

    let max = Infinity;
    for (const { itemHrid, perUnitAmount } of costLines) {
        if (!perUnitAmount || perUnitAmount <= 0) return null;
        max = Math.min(max, Math.floor(getOwnedCount(itemHrid) / perUnitAmount));
    }

    return max >= 1 ? max : null;
}

/**
 * Find the largest valid quantity at or below `candidate`, using an oracle for whether a quantity
 * is rejected (the Buy button's disabled state). Some purchases cap quantity beyond affordability
 * (a purchase limit) and the cap is not readable from the page.
 * @param {number} candidate - The affordability ceiling
 * @param {(quantity: number) => Promise<boolean>} isDisabledAt - Sets the quantity and reports
 *   whether the dialog rejects it
 * @returns {Promise<number|null>} The accepted quantity, or null when even 1 is rejected
 */
export async function findMaxValidQuantity(candidate, isDisabledAt) {
    if (!(await isDisabledAt(candidate))) return candidate;

    let low = 1;
    let high = candidate - 1;
    let best = null;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (await isDisabledAt(mid)) {
            high = mid - 1;
        } else {
            best = mid;
            low = mid + 1;
        }
    }
    return best;
}
