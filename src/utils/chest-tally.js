/**
 * Chest Tally
 *
 * What you actually got out of the chests you opened, against what they owed you.
 *
 * Toolasha already prices a chest before you open it — `expected-value-calculator.js`
 * says what one is worth on average, and that shows up in tooltips and net worth.
 * What it cannot say is whether the four hundred you have already opened paid out.
 * Expected value is a statement about the long run; this is the ledger that says
 * whether the long run has arrived.
 *
 * The comparison is deliberately made against **your own openings**, item by item,
 * rather than against a headline average. A chest that owes you one rare in two
 * hundred is not meaningfully behind after fifty, and the per-item breakdown is
 * what shows that the shortfall is one unlucky rare rather than something wrong
 * across the board.
 *
 * Pure, and separate from the panel that draws it, for the usual reason: an
 * expectation computed slightly wrong still renders as a confident percentage.
 *
 * The idea and the ledger shape come from TReasure in MWI Combat Suite by Frotty
 * (MIT) — see `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`.
 */

/**
 * Fold one `loot_opened` message into the tally.
 *
 * Returns a new tally rather than mutating, so a caller can persist the result
 * without worrying about which copy is which.
 *
 * @param {Object} tally - `{ [chestHrid]: { opened, loot: { [itemHrid]: count } } }`
 * @param {string} chestHrid - What was opened
 * @param {number} count - How many
 * @param {Array<{itemHrid: string, count: number}>} gainedItems - What came out
 * @returns {Object} A new tally
 */
export function recordOpening(tally, chestHrid, count, gainedItems) {
    if (!chestHrid || !(count > 0)) return tally || {};

    const previous = (tally || {})[chestHrid] || { opened: 0, loot: {} };
    const loot = { ...previous.loot };
    const justNow = {};

    for (const item of gainedItems || []) {
        if (!item?.itemHrid) continue;
        loot[item.itemHrid] = (loot[item.itemHrid] || 0) + (item.count || 0);
        justNow[item.itemHrid] = (justNow[item.itemHrid] || 0) + (item.count || 0);
    }

    // `last` is the same shape as the running total, so anything that can judge
    // a lifetime can judge a single opening without a second code path
    return {
        ...tally,
        [chestHrid]: { opened: previous.opened + count, loot, last: { opened: count, loot: justNow } },
    };
}

/**
 * Forget one chest's history, or all of it.
 * @param {Object} tally - The tally
 * @param {string} [chestHrid] - Which chest; omit to clear everything
 * @returns {Object} A new tally
 */
export function resetTally(tally, chestHrid) {
    if (!chestHrid) return {};

    const next = { ...tally };
    delete next[chestHrid];
    return next;
}

/**
 * What one chest owes on average, per item.
 *
 * The midpoint of the count range times the rate — the same arithmetic the
 * expected-value calculator uses, kept here in item counts rather than collapsed
 * to a single coin figure, because the interesting question is which item came up
 * short and not just by how much.
 *
 * @param {Array<Object>} dropTable - An entry of `openableLootDropMap`
 * @returns {Object<string, number>} Item hrid → expected count per chest
 */
export function expectedLootPerChest(dropTable) {
    const expected = {};

    for (const drop of dropTable || []) {
        if (!drop?.itemHrid) continue;
        const rate = drop.dropRate ?? 0;
        const average = ((drop.minCount ?? 0) + (drop.maxCount ?? 0)) / 2;
        const count = rate * average;
        if (count > 0) expected[drop.itemHrid] = (expected[drop.itemHrid] || 0) + count;
    }
    return expected;
}

/**
 * How one chest has treated you.
 *
 * Items are returned whether they dropped or not: a rare that never came up is
 * the whole story on an unlucky chest, and leaving it out of the list would hide
 * exactly the row worth seeing.
 *
 * @param {Object} entry - `{ opened, loot }` for one chest
 * @param {Array<Object>} dropTable - That chest's drop table
 * @param {Function} priceOf - `(itemHrid) => number|null`
 * @returns {Object} `{ opened, actualValue, expectedValue, difference, ratio, items }`
 *   where `ratio` is null until something has been opened
 */
export function chestPerformance(entry, dropTable, priceOf) {
    const opened = entry?.opened || 0;
    const loot = entry?.loot || {};
    const perChest = expectedLootPerChest(dropTable);

    const hrids = new Set([...Object.keys(perChest), ...Object.keys(loot)]);
    const items = [];
    let actualValue = 0;
    let expectedValue = 0;

    for (const itemHrid of hrids) {
        const price = priceOf(itemHrid);
        // No price means no contribution to either side, which keeps the
        // comparison honest rather than counting the item as free
        if (!(price > 0)) continue;

        const actualCount = loot[itemHrid] || 0;
        const expectedCount = (perChest[itemHrid] || 0) * opened;

        actualValue += actualCount * price;
        expectedValue += expectedCount * price;

        items.push({
            itemHrid,
            actualCount,
            expectedCount,
            actualValue: actualCount * price,
            expectedValue: expectedCount * price,
        });
    }

    // Sorted by what each item was supposed to be worth, so the rows that
    // dominate the verdict are the rows at the top
    items.sort((a, b) => b.expectedValue - a.expectedValue);

    return {
        opened,
        actualValue,
        expectedValue,
        difference: actualValue - expectedValue,
        ratio: expectedValue > 0 ? actualValue / expectedValue : null,
        items,
    };
}

/**
 * One chest's history in the three views the panel shows side by side.
 *
 * The same items appear in each column, in the same order, so a row can be read
 * across: what the last opening gave, what every opening has given, and what one
 * chest and the whole run were owed. Ordering them separately per column would
 * make the comparison a lookup rather than a glance.
 *
 * @param {Object} entry - `{ opened, loot, last }` for one chest
 * @param {Array<Object>} dropTable - That chest's drop table
 * @param {Function} priceOf - `(itemHrid) => number|null`
 * @returns {Object} `{ last, total, perChestValue, items }` where each item carries
 *   its last, total and expected figures together
 */
export function chestBreakdown(entry, dropTable, priceOf) {
    const total = chestPerformance(entry, dropTable, priceOf);
    const last = chestPerformance(entry?.last, dropTable, priceOf);
    const perChest = expectedLootPerChest(dropTable);

    const lastByItem = new Map(last.items.map((item) => [item.itemHrid, item]));
    const opened = entry?.opened || 0;

    const items = total.items.map((item) => {
        const price = priceOf(item.itemHrid) || 0;
        const perOne = perChest[item.itemHrid] || 0;
        const lastItem = lastByItem.get(item.itemHrid);
        const lastOpened = entry?.last?.opened || 0;
        const lastExpectedValue = perOne * lastOpened * price;

        return {
            itemHrid: item.itemHrid,
            price,
            lastCount: lastItem?.actualCount || 0,
            lastValue: lastItem?.actualValue || 0,
            lastRatio: lastExpectedValue > 0 ? (lastItem?.actualValue || 0) / lastExpectedValue : null,
            totalCount: item.actualCount,
            totalValue: item.actualValue,
            totalRatio: item.expectedValue > 0 ? item.actualValue / item.expectedValue : null,
            expectedPerChest: perOne,
            expectedPerChestValue: perOne * price,
            expectedTotal: perOne * opened,
            expectedTotalValue: item.expectedValue,
        };
    });

    // What one chest is worth on average, which is the figure beside its name
    const perChestValue = Object.entries(perChest).reduce(
        (sum, [itemHrid, count]) => sum + count * (priceOf(itemHrid) || 0),
        0
    );

    return { last, total, perChestValue, items };
}

/**
 * Every chest in the game, with whatever history you have for it.
 *
 * Unopened chests are listed too, priced but with no verdict, because the panel
 * is also the place to look up what a chest is worth before deciding to open it
 * — a list of only what you have already opened cannot answer that.
 *
 * Ordered by how far from expectation each sits, worst first, since the reason
 * to open the panel is usually to find out which chest let you down. Chests with
 * no history sort after those, by what one is worth, so the list stays useful
 * rather than alphabetical.
 *
 * @param {Object} tally - The tally
 * @param {Object} dropTables - `openableLootDropMap`
 * @param {Function} priceOf - `(itemHrid) => number|null`
 * @returns {Array<Object>} Performances, each with `chestHrid` and `perChestValue`
 */
export function summariseTally(tally, dropTables, priceOf) {
    // Every chest the game knows about, plus anything in the tally that the game
    // has since stopped listing — history should not vanish on a game update
    const chestHrids = new Set([...Object.keys(dropTables || {}), ...Object.keys(tally || {})]);

    const rows = [...chestHrids].map((chestHrid) => {
        const dropTable = dropTables?.[chestHrid];
        const performance = chestPerformance((tally || {})[chestHrid], dropTable, priceOf);
        const perChest = expectedLootPerChest(dropTable);
        const perChestValue = Object.entries(perChest).reduce(
            (sum, [itemHrid, count]) => sum + count * (priceOf(itemHrid) || 0),
            0
        );
        return { chestHrid, perChestValue, ...performance };
    });

    rows.sort((a, b) => {
        // A chest you have never opened has no verdict to rank, so it waits
        // behind the ones that do
        if (!a.opened !== !b.opened) return a.opened ? -1 : 1;
        if (a.opened) return (a.ratio ?? Infinity) - (b.ratio ?? Infinity);
        return b.perChestValue - a.perChestValue;
    });
    return rows;
}

/**
 * The totals across every chest, since one chest running hot while another runs
 * cold is the common case and neither row answers "am I up or down".
 * @param {Array<Object>} rows - From `summariseTally`
 * @returns {Object} `{ opened, actualValue, expectedValue, difference, ratio }`
 */
export function tallyTotals(rows) {
    const totals = rows.reduce(
        (sum, row) => ({
            opened: sum.opened + row.opened,
            actualValue: sum.actualValue + row.actualValue,
            expectedValue: sum.expectedValue + row.expectedValue,
        }),
        { opened: 0, actualValue: 0, expectedValue: 0 }
    );

    return {
        ...totals,
        difference: totals.actualValue - totals.expectedValue,
        ratio: totals.expectedValue > 0 ? totals.actualValue / totals.expectedValue : null,
    };
}
