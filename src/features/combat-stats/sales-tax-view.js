/**
 * Whether live combat income is read net of the market sale tax.
 *
 * A module of its own, rather than a field on the profit panel that owns the
 * toggle, because `calculateIncome` reads it to net the tax at the source and
 * the calculator must not import the UI bundle — that would be an import cycle,
 * and would copy the whole panel into every bundle that prices loot. Both the
 * calculator and the panel import this instead.
 *
 * On by default: selling a drop always pays the tax, so the honest income is the
 * net one. The panel's Tax toggle flips it, and the choice is remembered.
 */

import storage from '../../core/storage.js';

const STORAGE_KEY = 'combatIncomeNetSalesTax';
let netted = true;

/** @returns {boolean} Whether combat income should be shown net of sale tax */
export function salesTaxNetted() {
    return netted;
}

/**
 * Set whether combat income is netted of sale tax, and remember it.
 * @param {boolean} on - True to subtract the tax
 */
export function setSalesTaxNetted(on) {
    netted = Boolean(on);
    storage
        .setJSON(STORAGE_KEY, netted, 'settings')
        .catch((error) => console.error('[SalesTaxView] Saving the choice failed:', error));
}

// Read the remembered choice once the database is open. Until then the default
// stands — the same default a fresh character gets — rather than a flash of the
// wrong figure while storage opens.
(async () => {
    try {
        await storage.ready;
        const saved = await storage.getJSON(STORAGE_KEY, 'settings', null);
        if (saved !== null) netted = Boolean(saved);
    } catch (error) {
        console.error('[SalesTaxView] Reading the choice failed:', error);
    }
})();
