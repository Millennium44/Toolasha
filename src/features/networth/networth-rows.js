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
import { abilityBookPanel, abilityPlans } from '../abilities/ability-book-panel.js';
import { cheapestNextLevel } from '../../utils/ability-books.js';
import { formatLargeNumber, formatWithSeparator } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS, glyph } from '../../utils/overlay-format.js';
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
    empty: 'No coins counted',
    name: 'Coins',
    defaultSize: { width: 160, height: 30 },
    render: (container) => {
        const coins = fromNetworth((data) => data.coins);
        // Zero coins is a real answer and worth showing; no answer yet is not
        if (coins === null) return blank(container);

        row(container, [
            glyph('coin'),
            { text: formatLargeNumber(Math.round(coins)), color: ROW_COLORS.gold, bold: true, push: true },
        ]);
    },
});

registerRow({
    key: 'marketListings',
    empty: 'No listings',
    name: 'Market Listings',
    defaultSize: { width: 180, height: 30 },
    render: (container) => {
        const listings = fromNetworth((data) => data.currentAssets?.listings?.value);
        if (listings === null) return blank(container);

        row(container, [
            glyph('market'),
            { text: formatLargeNumber(Math.round(listings)), color: ROW_COLORS.accent, bold: true, push: true },
        ]);
    },
});

registerRow({
    key: 'inventoryValue',
    empty: 'No inventory value yet',
    name: 'Inventory Value',
    defaultSize: { width: 180, height: 30 },
    render: (container) => {
        const inventory = fromNetworth((data) => data.currentAssets?.inventory?.value);
        if (inventory === null) return blank(container);

        row(container, [
            glyph('inventory'),
            { text: formatLargeNumber(Math.round(inventory)), bold: true, push: true },
        ]);
    },
});

/**
 * The next ability level, and what it costs.
 *
 * BRead's own tile: the cheapest ability to advance, written as its book's icon,
 * how many books that level takes, and what they come to. The icon does the
 * naming — a tile is not wide enough to spell "Penetrating Strike" and still
 * have room for the number that decides anything.
 *
 * Books already held sit in the tooltip. They are a figure; the cheapest next
 * level is a purchase, and only one of the two is worth a tile.
 */
registerRow({
    key: 'skillBooks',
    empty: 'No books held',
    name: 'Skill Books',
    defaultSize: { width: 180, height: 30 },
    render: (container) => {
        const books = networthFeature.currentData?.fixedAssets?.abilityBooks;
        const breakdown = books?.breakdown || [];
        const held = breakdown.reduce((sum, entry) => sum + (entry.count || 0), 0);

        const best = cheapestNextLevel(abilityPlans(null));
        if (!best) return blank(container);

        row(
            container,
            [
                { icon: best.itemHrid, size: 18 },
                // Counted, not abbreviated: "2.8K books" is a number you cannot
                // put in a buy order, and this is a figure you act on
                { text: formatWithSeparator(best.booksToNext), color: ROW_COLORS.good, bold: true },
                { text: 'books', color: ROW_COLORS.dim },
                { text: formatLargeNumber(Math.round(best.costToNext)), color: ROW_COLORS.gold },
            ],
            { center: true }
        );
        container.title =
            `${best.name} is the cheapest next ability level: ${best.booksToNext} books at ` +
            `${Math.round(best.bookPrice).toLocaleString()} each.` +
            (breakdown.length
                ? `\nYou hold ${formatLargeNumber(held)} unread books worth ` +
                  `${formatLargeNumber(Math.round(books.totalCost || 0))}.`
                : '') +
            '\nDouble-click for every equipped ability.';
    },
    // BRead's panel, behind the row that was already about books
    onOpen: () => abilityBookPanel.toggle(),
});
