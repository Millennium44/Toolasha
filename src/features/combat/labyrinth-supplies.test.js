/** @vitest-environment happy-dom */

/**
 * Tests for reading labyrinth supplies and clamping plans to them.
 *
 * All pure: fixture inventories, payloads and markup in, counts and shortfall
 * wording out. The reason this logic lives apart from the panel is exactly so it
 * can be checked without a game — the bugs it exists to prevent (a plan calling
 * for thirteen shrouds against two owned; a mid-run readout counting the bag the
 * run already emptied) are arithmetic and sourcing, not rendering.
 *
 * A DOM is taken because one of the three sources is the game's own Supplies
 * row, and the thing worth testing about it is that it reads that row and not
 * the labyrinth shop sitting on the same screen.
 */

import { describe, test, expect } from 'vitest';

import {
    SUPPLY_HRIDS,
    SUPPLY_SOURCE,
    resolveSupplyHrids,
    readSupplyCounts,
    readRunSupplyCounts,
    readSupplyRowCounts,
    isLabyrinthRunActive,
    chooseSupplyCounts,
    bestOwnedTier,
    clampToOwned,
    describeSupplyNeed,
    remainingWord,
    estimateRestockCost,
    restockCandidates,
} from './labyrinth-supplies.js';

const inInventory = (itemHrid, count) => ({
    itemHrid,
    count,
    enhancementLevel: 0,
    itemLocationHrid: '/item_locations/inventory',
});

/** The user's reported floor: plenty of torches, three beacons, two shrouds */
const reportedBag = [
    inInventory('/items/expert_torch', 43),
    inInventory('/items/expert_shroud', 2),
    inInventory('/items/advanced_beacon', 3),
    inInventory('/items/cheese', 900),
];

describe('reading what is in the bag', () => {
    test('sums a kind across its tiers', () => {
        const counts = readSupplyCounts([
            inInventory('/items/basic_torch', 5),
            inInventory('/items/advanced_torch', 7),
            inInventory('/items/expert_torch', 1),
        ]);
        expect(counts.torch).toBe(13);
        expect(counts.byTier.torch['/items/advanced_torch']).toBe(7);
    });

    test('ignores anything that is not sitting in the inventory', () => {
        const counts = readSupplyCounts([
            inInventory('/items/expert_shroud', 2),
            { itemHrid: '/items/expert_shroud', count: 40, itemLocationHrid: '/item_locations/market_listing' },
        ]);
        expect(counts.shroud).toBe(2);
    });

    test('no inventory at all is unknown, which is not the same as owning none', () => {
        const counts = readSupplyCounts(null);
        expect(counts.known).toBe(false);
        expect(counts.shroud).toBe(0);
    });

    test('reads the reported floor as 43 torches, 2 shrouds, 3 beacons', () => {
        const counts = readSupplyCounts(reportedBag);
        expect(counts).toMatchObject({ torch: 43, shroud: 2, beacon: 3, known: true });
    });

    test('names the best tier held, not the first one listed', () => {
        const counts = readSupplyCounts([
            inInventory('/items/basic_beacon', 9),
            inInventory('/items/advanced_beacon', 1),
        ]);
        expect(bestOwnedTier(counts, 'beacon')).toBe('/items/advanced_beacon');
        expect(bestOwnedTier(counts, 'shroud')).toBeNull();
    });
});

/**
 * The reported bug: a toolbar reading 260/16/16 beside a game reading 40/0/1.
 * The counts were right about the bag and wrong about the question — a run takes
 * its supplies out of the inventory when it starts and carries them itself.
 */
describe('reading the stock a run is carrying', () => {
    const grid = [[{ roomType: '/labyrinth_room_types/combat' }]];

    test('a floor on the table is a run; nothing on it is not', () => {
        expect(isLabyrinthRunActive({ roomData: grid })).toBe(true);
        expect(isLabyrinthRunActive({ pathData: '[{"x":0,"y":0}]' })).toBe(true);
        expect(isLabyrinthRunActive({ roomData: [], pathData: '' })).toBe(false);
        expect(isLabyrinthRunActive(null)).toBe(false);
    });

    test('finds stock carried as a map keyed by item hrid', () => {
        const counts = readRunSupplyCounts({
            roomData: grid,
            supplyItemCountMap: { '/items/basic_torch': 40, '/items/expert_beacon': 1 },
        });
        expect(counts).toMatchObject({ torch: 40, shroud: 0, beacon: 1, known: true, source: SUPPLY_SOURCE.run });
    });

    test('finds stock carried as a list of item/count pairs, however deep', () => {
        const counts = readRunSupplyCounts({
            roomData: grid,
            run: { consumables: { items: [{ itemHrid: '/items/basic_torch', count: 40 }] } },
        });
        expect(counts).toMatchObject({ torch: 40, known: true });
    });

    test('the same stock reported twice is one pile, not two', () => {
        const counts = readRunSupplyCounts({
            supplyItemCountMap: { '/items/basic_torch': 40 },
            supplies: [{ itemHrid: '/items/basic_torch', count: 40 }],
        });
        expect(counts.torch).toBe(40);
    });

    test('different tiers of one kind still add up', () => {
        const counts = readRunSupplyCounts({
            supplies: [
                { itemHrid: '/items/basic_torch', count: 40 },
                { itemHrid: '/items/expert_torch', count: 2 },
            ],
        });
        expect(counts.torch).toBe(42);
    });

    test('a key merely named for a supply is not a count of one', () => {
        // `torches` on a payload is as likely to be a plan's cost as a stock,
        // and guessing wrong is the whole bug
        const counts = readRunSupplyCounts({ torches: 40, shrouds: 3 });
        expect(counts.known).toBe(false);
        expect(counts.torch).toBe(0);
    });

    test('a payload that names no supply is unknown, so the caller can look elsewhere', () => {
        expect(readRunSupplyCounts({ roomData: grid }).known).toBe(false);
        expect(readRunSupplyCounts(null).known).toBe(false);
    });
});

describe("reading the game's own Supplies row", () => {
    const icon = (id, count) =>
        `<div class="Item_itemContainer__x7kH1"><div class="Item_item__2De2O">` +
        `<svg><use href="/static/media/items_sprite.9c39e2ec.svg#${id}"></use></svg>` +
        `<div class="Item_count__1HVvv">${count}</div></div></div>`;

    const panel = (inner) => {
        document.body.innerHTML = `<div class="LabyrinthPanel_labyrinthPanel__1a2b3">${inner}</div>`;
        return document;
    };

    test('reads the row the user is looking at', () => {
        const root = panel(
            `<div><div>Supplies</div><div>${icon('basic_torch', 40)}${icon('expert_beacon', 1)}</div></div>`
        );
        expect(readSupplyRowCounts(root)).toMatchObject({
            torch: 40,
            shroud: 0,
            beacon: 1,
            known: true,
            source: SUPPLY_SOURCE.run,
        });
    });

    test('a count written as plain text beside the icon still counts', () => {
        const root = panel(
            '<div>Supplies</div>' +
                '<div><span><svg><use href="items_sprite.svg#basic_torch"></use></svg>40</span></div>'
        );
        expect(readSupplyRowCounts(root).torch).toBe(40);
    });

    test("the shop's stock of the same items is not the run's", () => {
        const root = panel(
            `<div><div>Supplies</div><div>${icon('basic_torch', 40)}</div></div>` +
                `<div class="LabyrinthPanel_buyableGrid__9z8y">${icon('basic_torch', 999)}</div>`
        );
        expect(readSupplyRowCounts(root).torch).toBe(40);
    });

    test("this script's own readout is not read back as a supply count", () => {
        const root = panel(
            `<div><div>Supplies</div><div>${icon('basic_torch', 40)}</div></div>` +
                `<span class="mwi-labyrinth-tile-controls-supplies">${icon('basic_torch', 260)}</span>`
        );
        expect(readSupplyRowCounts(root).torch).toBe(40);
    });

    test('no row on screen is unknown, not a run carrying nothing', () => {
        expect(readSupplyRowCounts(panel('<div>Floor 5</div>')).known).toBe(false);
        expect(readSupplyRowCounts(null).known).toBe(false);
    });
});

describe('choosing which pile to answer with', () => {
    const bag = readSupplyCounts([
        { itemHrid: '/items/expert_torch', count: 260, itemLocationHrid: '/item_locations/inventory' },
    ]);
    const carried = { ...readSupplyCounts([]), torch: 40, known: true, source: SUPPLY_SOURCE.run };

    test('between runs the bag is the answer, and says so', () => {
        const chosen = chooseSupplyCounts({ runActive: false, inventory: bag });
        expect(chosen).toMatchObject({ torch: 260, source: SUPPLY_SOURCE.inventory, label: 'held', stale: false });
    });

    test('in a run the payload wins over the bag, which is stale by then', () => {
        const chosen = chooseSupplyCounts({ runActive: true, run: carried, inventory: bag });
        expect(chosen).toMatchObject({ torch: 40, source: SUPPLY_SOURCE.run, label: 'this run' });
    });

    test('in a run with no payload stock, the Supplies row answers', () => {
        const chosen = chooseSupplyCounts({
            runActive: true,
            run: readRunSupplyCounts(null),
            dom: carried,
            inventory: bag,
        });
        expect(chosen).toMatchObject({ torch: 40, source: SUPPLY_SOURCE.run, label: 'this run' });
    });

    test('the bag is the last resort in a run, and is flagged rather than passed off', () => {
        const chosen = chooseSupplyCounts({
            runActive: true,
            run: readRunSupplyCounts(null),
            dom: readSupplyRowCounts(null),
            inventory: bag,
        });
        expect(chosen).toMatchObject({ torch: 260, source: SUPPLY_SOURCE.inventory, label: 'in bag', stale: true });
    });
});

describe('finding the supply items in the game data', () => {
    test('prefers what the live item map calls them', () => {
        const hrids = resolveSupplyHrids({
            '/items/basic_torch': {},
            '/items/expert_torch': {},
            '/items/cheese': {},
        });
        expect(hrids.torch).toEqual(['/items/basic_torch', '/items/expert_torch']);
    });

    test('orders tiers worst-first however the map is ordered', () => {
        const hrids = resolveSupplyHrids({
            '/items/expert_shroud': {},
            '/items/basic_shroud': {},
            '/items/advanced_shroud': {},
        });
        expect(hrids.shroud).toEqual(['/items/basic_shroud', '/items/advanced_shroud', '/items/expert_shroud']);
    });

    test('falls back to the canonical list for a kind the map does not have', () => {
        const hrids = resolveSupplyHrids({ '/items/basic_torch': {} });
        expect(hrids.beacon).toEqual(SUPPLY_HRIDS.beacon);
    });

    test('no game data at all still yields a usable set of keys', () => {
        expect(resolveSupplyHrids(null)).toEqual(SUPPLY_HRIDS);
    });
});

describe('clamping a plan to what is held', () => {
    test('four beacons set against three owned plans three, and says so', () => {
        expect(clampToOwned(4, 3)).toEqual({
            effective: 3,
            requested: 4,
            owned: 3,
            short: 1,
            clamped: true,
        });
    });

    test('a request inside the budget is left alone and not flagged', () => {
        expect(clampToOwned(2, 3)).toMatchObject({ effective: 2, short: 0, clamped: false });
    });

    test('an unreadable inventory does not clamp — it would invent a limit', () => {
        expect(clampToOwned(4, 0, false)).toMatchObject({ effective: 4, short: 0, clamped: false });
    });
});

describe('saying what is missing', () => {
    test('a plan you can afford says nothing about owning things', () => {
        expect(describeSupplyNeed(2, 2, 'shroud')).toEqual({ text: '2 shrouds', short: 0, over: false });
    });

    test('the reported case reads as needed-versus-owned', () => {
        expect(describeSupplyNeed(13, 2, 'shroud')).toEqual({
            text: '13 shrouds needed · 2 owned',
            short: 11,
            over: true,
        });
    });

    test('one of a thing is not one things', () => {
        expect(describeSupplyNeed(1, 5, 'shroud').text).toBe('1 shroud');
    });

    test('an unreadable inventory reports the need without a verdict on it', () => {
        expect(describeSupplyNeed(13, 0, 'shroud', false)).toEqual({ text: '13 shrouds', short: 0, over: false });
    });

    /**
     * The reported bug's other half: "0 owned" read as an invitation to buy
     * more when the pile in view is the run's own stock, which no purchase
     * can grow before the run ends. Same shortfall, different word for what
     * is held — `runActive` is the only thing that changes.
     */
    describe('mid-run, "owned" is not the word', () => {
        test('a run short of shrouds reads as needed-versus-left-this-run', () => {
            expect(describeSupplyNeed(4, 0, 'shroud', true, true)).toEqual({
                text: '4 shrouds needed · 0 left this run',
                short: 4,
                over: true,
            });
        });

        test('out of a run the word is unchanged, and is the default when unspecified', () => {
            expect(describeSupplyNeed(13, 2, 'shroud', true, false).text).toBe('13 shrouds needed · 2 owned');
            expect(describeSupplyNeed(13, 2, 'shroud')).toEqual({
                text: '13 shrouds needed · 2 owned',
                short: 11,
                over: true,
            });
        });

        test('remainingWord names the same word on its own', () => {
            expect(remainingWord(true)).toBe('left this run');
            expect(remainingWord(false)).toBe('owned');
        });
    });
});

describe('what the missing ones would cost', () => {
    const market = (prices) => ({ isLoaded: () => true, getPrice: (hrid) => prices[hrid] || null });

    test('quotes the cheapest tier that has a price', () => {
        const cost = estimateRestockCost(11, SUPPLY_HRIDS.shroud, market({ '/items/basic_shroud': { ask: 1000 } }));
        expect(cost).toEqual({ total: 11000, unit: 1000, itemHrid: '/items/basic_shroud' });
    });

    test('skips a tier with no price rather than reporting nothing', () => {
        const cost = estimateRestockCost(
            2,
            SUPPLY_HRIDS.beacon,
            market({ '/items/basic_beacon': { ask: null }, '/items/advanced_beacon': { ask: 50 } })
        );
        expect(cost).toMatchObject({ itemHrid: '/items/advanced_beacon', total: 100 });
    });

    test('says nothing when nothing is missing, or when the market is not loaded', () => {
        expect(estimateRestockCost(0, SUPPLY_HRIDS.shroud, market({ '/items/basic_shroud': { ask: 5 } }))).toBeNull();
        expect(estimateRestockCost(3, SUPPLY_HRIDS.shroud, { isLoaded: () => false })).toBeNull();
    });
});

/**
 * Which tier a restock hint should even be allowed to quote — the fix for the
 * other half of the report: "buying basic doesn't help, I use expert."
 */
describe('picking which tier a restock hint prices', () => {
    test('a preferred tier is priced on its own — nothing cheaper is substituted', () => {
        expect(restockCandidates(SUPPLY_HRIDS.shroud, '/items/expert_shroud')).toEqual(['/items/expert_shroud']);
    });

    test('a preferred tier absent from the candidate list is not invented', () => {
        expect(restockCandidates(SUPPLY_HRIDS.shroud, '/items/mythical_shroud')).toEqual(SUPPLY_HRIDS.shroud);
    });

    test('no preference falls back to the full worst-first list, cheapest-per-use', () => {
        expect(restockCandidates(SUPPLY_HRIDS.shroud, null)).toEqual(SUPPLY_HRIDS.shroud);
        expect(restockCandidates(SUPPLY_HRIDS.shroud)).toEqual(SUPPLY_HRIDS.shroud);
    });

    test('a preference changes which tier estimateRestockCost quotes', () => {
        const market = (prices) => ({ isLoaded: () => true, getPrice: (hrid) => prices[hrid] || null });
        const prices = { '/items/basic_shroud': { ask: 1000 }, '/items/expert_shroud': { ask: 5000 } };

        const cheapest = estimateRestockCost(4, restockCandidates(SUPPLY_HRIDS.shroud, null), market(prices));
        expect(cheapest).toMatchObject({ itemHrid: '/items/basic_shroud' });

        const preferred = estimateRestockCost(
            4,
            restockCandidates(SUPPLY_HRIDS.shroud, '/items/expert_shroud'),
            market(prices)
        );
        expect(preferred).toMatchObject({ itemHrid: '/items/expert_shroud', total: 20000 });
    });
});
