/**
 * Net worth overlay rows
 *
 * The pieces of net worth worth watching on their own.
 *
 * Net worth as a single figure moves too slowly to be interesting and hides the
 * parts that do move: coins spent, listings that have sold, books bought. Each
 * of these is one field of the same calculation, so they cost nothing to add and
 * nothing to keep current.
 *
 * ## Nothing is computed here
 *
 * A full net worth pass prices every item you own and runs a worker pool, which
 * is emphatically not something a row redrawn once a second may do. Every row
 * here reads the last result the feature published and does no work of its own,
 * so the figures refresh when net worth itself recalculates — on item and price
 * changes — rather than on the overlay's timer.
 *
 * The rows are OPanel's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import { registerRow } from '../../utils/overlay-rows.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import networthFeature from './index.js';

/**
 * A field of the last published net worth, or null.
 * @param {Function} pick - `(data) => number|undefined`
 * @returns {number|null} The figure, or null when there is nothing published yet
 */
function fromNetworth(pick) {
    const data = networthFeature.currentData;
    if (!data) return null;
    const value = pick(data);
    return Number.isFinite(value) ? value : null;
}

registerRow({
    key: 'coins',
    name: 'Coins',
    defaultSize: { width: 160, height: 30 },
    render: (container) => {
        const coins = fromNetworth((data) => data.coins);
        // Zero coins is a real answer and worth showing; no answer yet is not
        if (coins === null) return blank(container);

        row(container, [
            { text: '🪙' },
            { text: formatLargeNumber(Math.round(coins)), color: ROW_COLORS.gold, bold: true, push: true },
        ]);
    },
});

registerRow({
    key: 'marketListings',
    name: 'Market Listings',
    defaultSize: { width: 180, height: 30 },
    render: (container) => {
        const listings = fromNetworth((data) => data.currentAssets?.listings?.value);
        if (listings === null) return blank(container);

        row(container, [
            { text: '📈' },
            { text: formatLargeNumber(Math.round(listings)), color: ROW_COLORS.accent, bold: true, push: true },
        ]);
    },
});

registerRow({
    key: 'inventoryValue',
    name: 'Inventory Value',
    defaultSize: { width: 180, height: 30 },
    render: (container) => {
        const inventory = fromNetworth((data) => data.currentAssets?.inventory?.value);
        if (inventory === null) return blank(container);

        row(container, [{ text: '🎒' }, { text: formatLargeNumber(Math.round(inventory)), bold: true, push: true }]);
    },
});

/**
 * Books held, and what they are worth.
 *
 * Both halves, because the two answer different questions — how many are waiting
 * to be read, and how much is sitting there unread. Which pile the game counts
 * as books follows the net worth setting: with "ability books as inventory" on
 * they are part of the inventory figure instead, and this row goes quiet rather
 * than counting them twice.
 */
registerRow({
    key: 'skillBooks',
    name: 'Skill Books',
    defaultSize: { width: 200, height: 30 },
    render: (container) => {
        const books = networthFeature.currentData?.fixedAssets?.abilityBooks;
        const breakdown = books?.breakdown || [];
        if (!breakdown.length) return blank(container);

        const count = breakdown.reduce((sum, entry) => sum + (entry.count || 0), 0);
        row(container, [
            { text: '📖' },
            { text: `${formatLargeNumber(count)} books`, color: ROW_COLORS.dim },
            { text: formatLargeNumber(Math.round(books.totalCost || 0)), color: ROW_COLORS.violet, push: true },
        ]);
    },
});
