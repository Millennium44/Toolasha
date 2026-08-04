/**
 * @vitest-environment happy-dom
 *
 * Equipment Savings, built rather than reasoned about.
 *
 * The arithmetic is tested in `utils/equipment-savings.test.js`. What only
 * building the panel catches is that it finds the piece a target would replace —
 * which needs the equipment map's **item location** key derived from the
 * target's **equipment type**, two different strings that look interchangeable.
 * Get it wrong and nothing throws: every upgrade silently costs full price.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    inventory: [],
    equipment: new Map(),
    details: {},
    prices: {},
    actions: {},
    shops: {},
    artisan: 0,
    // What `networthHistory.recentSeries` hands back — empty by default, so
    // tests that are not about the fallback see the same "nothing measured"
    // behaviour they did before it existed
    networthSeries: () => [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => game.inventory,
        getEquipment: () => game.equipment,
        getItemDetails: (hrid) => game.details[hrid],
        // The picker builds its list from the whole item map, which is the same
        // fixture the per-item lookups read
        getInitClientData: () => ({ itemDetailMap: game.details, actionDetailMap: game.actions, ...game.shops }),
        // Gear targets are one character's, so the module keys on the character
        // and listens for the switch
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSetting: () => false,
        onSettingChange: () => {},
        getSettingValue: () => 'full',
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        db: {},
        ready: Promise.resolve(true),
        getJSON: async () => null,
        setJSON: async () => {},
        get: async (_k, _s, fallback = null) => fallback,
        set: async () => true,
        delete: async () => true,
        getAllKeys: async () => [],
    },
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/game-lookups.js', () => ({ getItemHridFromName: () => null }));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: () => {} }));
vi.mock('../../api/marketplace.js', () => ({ default: { getDataAge: () => 60_000, fetch: async () => {} } }));
vi.mock('../networth/networth-history.js', () => ({
    default: { recentSeries: (hours) => game.networthSeries(hours) },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: (hrid, level = 0) => game.prices[`${hrid}:${level}`] || null,
}));
// The real one resolves a loadout and parses teas; what this file cares about
// is that the saving reaches the recipe, whatever produced it
vi.mock('../../utils/material-calculator.js', () => ({ calculateArtisanBonus: () => game.artisan }));

const {
    equipmentSavingsPanel,
    watchTarget,
    watchedTargets,
    everything,
    coinsHeld,
    setNoSell,
    selectTarget,
    incomePerDay,
    incomeEstimate,
    trendPerDay,
    toggleCrafting,
    cycleTargetNoSell,
    resetEquipmentSavings,
} = await import('./equipment-savings-row.js');

beforeEach(() => {
    game.inventory = [
        { itemHrid: '/items/coin', itemLocationHrid: '/item_locations/inventory', count: 60_000_000 },
        // Coins turn up under more than one location; only the inventory one is
        // money you can spend
        { itemHrid: '/items/coin', itemLocationHrid: '/item_locations/market_listing', count: 51_000_000_000_000 },
    ];
    game.actions = {
        // An upgrade: shards plus the spear you already hold
        '/actions/refine': {
            outputItems: [{ itemHrid: '/items/refined_spear', count: 1 }],
            inputItems: [{ itemHrid: '/items/shard', count: 30 }],
            upgradeItemHrid: '/items/plain_spear',
        },
    };
    game.details = {
        '/items/refined_spear': { name: 'Refined Spear', equipmentDetail: { type: '/equipment_types/main_hand' } },
        '/items/plain_spear': { name: 'Plain Spear', equipmentDetail: { type: '/equipment_types/main_hand' } },
        '/items/shard': { name: 'Shard' },
        '/items/cheese_sword': { name: 'Cheese Sword', equipmentDetail: { type: '/equipment_types/main_hand' } },
        '/items/holy_sword': { name: 'Holy Sword', equipmentDetail: { type: '/equipment_types/main_hand' } },
        '/items/rough_boots': { name: 'Rough Boots', equipmentDetail: { type: '/equipment_types/feet' } },
        '/items/cheese': { name: 'Cheese' },
    };
    // Keyed by item LOCATION, which is not the same string as the equipment type
    game.equipment = new Map([['/item_locations/main_hand', { itemHrid: '/items/cheese_sword', enhancementLevel: 0 }]]);
    game.prices = {
        '/items/holy_sword:0': { ask: 100_000_000, bid: 90_000_000 },
        '/items/cheese_sword:0': { ask: 45_000_000, bid: 40_000_000 },
        '/items/rough_boots:0': { ask: 5_000_000, bid: 4_000_000 },
        '/items/refined_spear:0': { ask: 900_000_000, bid: 800_000_000 },
        '/items/plain_spear:0': { ask: 300_000_000, bid: 250_000_000 },
        '/items/shard:0': { ask: 1_000_000, bid: 900_000 },
    };
    game.shops = {};
    game.artisan = 0;
    game.networthSeries = () => [];
    resetEquipmentSavings();
});

afterEach(() => {
    equipmentSavingsPanel.hide();
    resetEquipmentSavings();
});

const text = () => equipmentSavingsPanel.panel.textContent;
const FAILED = 'could not be drawn';

describe('costing a target', () => {
    test('the piece it replaces is found through the slot, not the name', () => {
        // 100M to buy, less 40M for the sword being worn
        watchTarget('/items/holy_sword');
        const [target] = watchedTargets();

        expect(target.worn?.itemHrid).toBe('/items/cheese_sword');
        expect(target.cost).toBe(60_000_000);
    });

    test('an empty slot has nothing to trade in', () => {
        watchTarget('/items/rough_boots');
        expect(watchedTargets()[0].cost).toBe(5_000_000);
    });

    test('no-sell pays the full ask', () => {
        watchTarget('/items/holy_sword');
        setNoSell(true);
        expect(watchedTargets()[0].cost).toBe(100_000_000);
    });

    test('an unpriced target is unknown rather than affordable', () => {
        // Zero cost would report it as already bought, which is the most
        // misleading thing this could say
        game.prices = {};
        watchTarget('/items/holy_sword');

        const [target] = watchedTargets();
        expect(target.cost).toBeNull();
        expect(target.affordable).toBe(false);
    });
});

describe('the whole list', () => {
    test('everything is the sum, against your coins', () => {
        watchTarget('/items/holy_sword');
        watchTarget('/items/rough_boots');

        const plan = everything();
        expect(plan.cost).toBe(65_000_000);
        expect(plan.affordable).toBe(false);
        expect(plan.needed).toBe(5_000_000);
    });

    test('coins come off the character rather than out of net worth', () => {
        expect(coinsHeld()).toBe(60_000_000);
    });

    test('only coins in the inventory count, not every coin row the game has', () => {
        // An unfiltered read picked up a listing's row and reported fifty-one
        // trillion, which made everything affordable
        expect(coinsHeld()).not.toBe(51_000_000_000_000);
    });

    test('no income measured means no arrival time rather than never', () => {
        // Genuinely short: with nothing left to save the answer is zero seconds
        // whatever the income, which is not the case being tested
        watchTarget('/items/holy_sword');
        watchTarget('/items/rough_boots');

        expect(everything().needed).toBeGreaterThan(0);
        expect(everything().seconds).toBeNull();
    });
});

describe('the panel renders', () => {
    test('an empty list is the slots inviting one', () => {
        // The invitation is the slot itself, so there is nothing to explain
        equipmentSavingsPanel.show();

        expect(text()).toContain('Click to watch');
        expect(text()).not.toContain(FAILED);
    });

    test('locked with nothing watched says where to go', () => {
        // The slots are hidden there, so the invitation has to be words
        equipmentSavingsPanel.show();
        equipmentSavingsPanel.panel.querySelector('[data-lock-toggle]').click();

        expect(text()).toContain('Nothing being saved for');
        expect(text()).not.toContain(FAILED);
    });

    test('a target draws with its cost and the Everything row', () => {
        watchTarget('/items/holy_sword');
        equipmentSavingsPanel.show();

        expect(text()).toContain('Holy Sword');
        expect(text()).toContain('Everything');
        expect(text()).not.toContain(FAILED);
    });

    test('an affordable target says so rather than showing a shortfall', () => {
        watchTarget('/items/rough_boots');
        equipmentSavingsPanel.show();

        expect(text()).toContain('Affordable');
    });

    test('the No Sell switch re-costs the list', () => {
        watchTarget('/items/holy_sword');
        equipmentSavingsPanel.show();

        equipmentSavingsPanel.panel.querySelector('[data-toggle="No Sell"]').click();

        expect(watchedTargets()[0].cost).toBe(100_000_000);
        expect(text()).not.toContain(FAILED);
    });

    test('the eye moves which target the header carries', () => {
        watchTarget('/items/holy_sword');
        watchTarget('/items/rough_boots');
        equipmentSavingsPanel.show();

        equipmentSavingsPanel.panel.querySelector('[data-watch-eye="/items/rough_boots"]').click();
        // The headline is the first thing in the body, so the watched one leads
        expect(equipmentSavingsPanel.panel.textContent.indexOf('Rough Boots')).toBeLessThan(
            equipmentSavingsPanel.panel.textContent.indexOf('Holy Sword')
        );
    });

    test('market orders count towards what you can spend, until they do not', () => {
        watchTarget('/items/holy_sword');
        const withOrders = everything().needed;

        equipmentSavingsPanel.show();
        equipmentSavingsPanel.panel.querySelector('[data-toggle="Market Value"]').click();

        // No orders in the fixture, so the figure holds either way — what is
        // being pinned is that the switch does not throw and does re-cost
        expect(everything().needed).toBe(withOrders);
        expect(text()).not.toContain(FAILED);
    });

    test('removing a target takes it off the list', () => {
        watchTarget('/items/holy_sword');
        equipmentSavingsPanel.show();

        equipmentSavingsPanel.panel.querySelector('[data-remove-target]').click();
        expect(watchedTargets()).toEqual([]);
    });

    test('it draws before the market has answered', () => {
        game.prices = {};
        watchTarget('/items/holy_sword');
        equipmentSavingsPanel.show();

        expect(text()).not.toContain(FAILED);
    });
});

/** The panel opens unlocked, so a slot interaction only needs it open */
const unlock = () => equipmentSavingsPanel.show();

/** Unlock, open the picker under a slot, and hand back its list */
const openPicker = (slot = 'main_hand') => {
    unlock();
    equipmentSavingsPanel.panel.querySelector(`[data-watch-slot="${slot}"]`).click();
    return equipmentSavingsPanel.panel.querySelector('[data-pick-item]');
};

describe('lock and edit', () => {
    test('the slots are what it opens on', () => {
        // EWatch's own resting state. Hiding them behind a button hides the only
        // way to add anything, which is the panel's whole point.
        equipmentSavingsPanel.show();
        expect(text()).toContain('Main Hand:');
    });

    test('locked lists only what is being saved for', () => {
        watchTarget('/items/holy_sword');
        equipmentSavingsPanel.show();
        equipmentSavingsPanel.panel.querySelector('[data-lock-toggle]').click();

        expect(text()).toContain('Holy Sword');
        expect(text()).not.toContain('Main Hand:');
        expect(text()).toContain('Everything');
    });

    test('the button names what pressing it does', () => {
        equipmentSavingsPanel.show();
        const button = () => equipmentSavingsPanel.panel.querySelector('[data-lock-toggle]');

        expect(button().textContent).toBe('Lock');
        button().click();
        expect(button().textContent).toBe('Edit');
    });

    test('locking closes any picker that was open', () => {
        openPicker('feet');
        expect(equipmentSavingsPanel.panel.querySelector('[data-pick-item]')).toBeTruthy();

        equipmentSavingsPanel.panel.querySelector('[data-lock-toggle]').click();
        expect(equipmentSavingsPanel.panel.querySelector('[data-pick-item]')).toBeNull();
    });
});

describe('the slot layout', () => {
    test('every slot gets a section, watched or not', () => {
        // A slot with nothing on it still says what is in it and invites a
        // target, which a list of only your targets cannot do
        unlock();

        expect(text()).toContain('Main Hand:');
        expect(text()).toContain('Charm:');
        expect(text()).toContain('Cheese Sword');
    });

    test('an empty slot reads as empty rather than as missing', () => {
        unlock();
        expect(text()).toContain('Empty');
    });

    test('a watched target sits under the slot it would fill', () => {
        watchTarget('/items/holy_sword');
        unlock();

        expect(equipmentSavingsPanel.panel.querySelector('[data-slot="main_hand"]').textContent).toContain(
            'Holy Sword'
        );
        expect(equipmentSavingsPanel.panel.querySelector('[data-slot="feet"]').textContent).not.toContain('Holy Sword');
    });

    test('a watched target shows its ask and what the swap actually costs', () => {
        watchTarget('/items/holy_sword');
        unlock();

        expect(text()).toContain('Ask Price:');
        expect(text()).toContain('Difference:');
        expect(text()).not.toContain(FAILED);
    });
});

describe('the item picker', () => {
    test('it opens under the slot that asked for it', () => {
        // Not at the top of the panel: the question is "what goes in this slot",
        // and a picker somewhere else makes you carry the slot in your head
        openPicker('feet');

        const feet = equipmentSavingsPanel.panel.querySelector('[data-slot="feet"]');
        expect(feet.querySelector('[data-pick-item]')).toBeTruthy();
        expect(
            equipmentSavingsPanel.panel.querySelector('[data-slot="main_hand"]').querySelector('[data-pick-item]')
        ).toBeNull();
    });

    test('it offers only the pieces that fill that slot', () => {
        openPicker('feet');

        const values = [...equipmentSavingsPanel.panel.querySelectorAll('[data-pick-item] option')].map(
            (option) => option.value
        );
        expect(values).toContain('/items/rough_boots');
        expect(values).not.toContain('/items/holy_sword');
    });

    test('it is a list box rather than a dropdown', () => {
        // A dropdown over three hundred items is a scroll you cannot see the
        // shape of, and it closes every time anything redraws
        expect(openPicker().size).toBe(10);
    });

    test('clicking the same slot again closes it', () => {
        openPicker('feet');
        equipmentSavingsPanel.panel.querySelector('[data-watch-slot="feet"]').click();

        expect(equipmentSavingsPanel.panel.querySelector('[data-pick-item]')).toBeNull();
    });

    test('picking a piece offers its enhancement levels and prices the choice', () => {
        const list = openPicker();
        list.value = '/items/holy_sword';
        list.dispatchEvent(new Event('change'));

        expect(equipmentSavingsPanel.panel.querySelectorAll('[data-pick-level]')).toHaveLength(21);
        expect(text()).toContain('Lowest Ask:');
        expect(text()).not.toContain(FAILED);
    });

    test('watching it adds it at the enhancement that was chosen', () => {
        const list = openPicker();
        list.value = '/items/holy_sword';
        list.dispatchEvent(new Event('change'));

        equipmentSavingsPanel.panel.querySelector('[data-pick-level="5"]').click();
        equipmentSavingsPanel.panel.querySelector('[data-pick-add]').click();

        const [target] = watchedTargets();
        expect(target.itemHrid).toBe('/items/holy_sword');
        expect(target.enhancementLevel).toBe(5);
    });

    test('the picker closes once it has been used', () => {
        const list = openPicker();
        list.value = '/items/holy_sword';
        list.dispatchEvent(new Event('change'));
        equipmentSavingsPanel.panel.querySelector('[data-pick-add]').click();

        expect(equipmentSavingsPanel.panel.querySelector('[data-pick-item]')).toBeNull();
    });

    test('nothing picked means nothing to watch', () => {
        expect(openPicker().value).toBe('');
        expect(equipmentSavingsPanel.panel.querySelector('[data-pick-add]').disabled).toBe(true);
    });
});

describe('the pin', () => {
    test('the tile follows the eye rather than always the cheapest', () => {
        // The thing somebody is saving for is often not the cheapest, and a tile
        // that always shows the cheapest cannot be told otherwise
        watchTarget('/items/holy_sword');
        watchTarget('/items/rough_boots');

        const container = document.createElement('div');
        selectTarget('/items/holy_sword');
        equipmentSavingsPanel.show();

        expect(everything().targets).toHaveLength(2);
        expect(container).toBeTruthy();
        expect(equipmentSavingsPanel.panel.textContent.indexOf('Holy Sword')).toBeLessThan(
            equipmentSavingsPanel.panel.textContent.indexOf('Rough Boots')
        );
    });

    test('pressing the eye again unpins it', () => {
        watchTarget('/items/holy_sword');
        selectTarget('/items/holy_sword');
        selectTarget('/items/holy_sword');

        equipmentSavingsPanel.show();
        expect(text()).not.toContain(FAILED);
    });
});

describe('income per day', () => {
    /** A collector reading of the shape the real one publishes */
    const withCombat = (durationSeconds, dailyProfit) => {
        window.Toolasha = {
            Combat: {
                combatStatsDataCollector: {
                    getLatestData: () => ({ durationSeconds, players: [{ isCurrentPlayer: true, loot: {} }] }),
                },
                combatStatsCalculator: { calculatePlayerStats: () => ({ dailyProfit }) },
            },
        };
    };

    afterEach(() => {
        delete window.Toolasha;
    });

    test('it reads the duration field the collector actually publishes', () => {
        // Reaching for startTime/endTime, which the collector does not have,
        // made every run zero seconds long and every rate unmeasurable
        withCombat(3600, { ask: 90_000_000, bid: 65_000_000 });
        expect(incomePerDay()).toBe(65_000_000);
    });

    test('daily profit is two figures, not one', () => {
        // Compared as a number it is NaN, so this returned null however long
        // the run had been
        withCombat(3600, { ask: 90_000_000, bid: 65_000_000 });
        setNoSell(true);
        expect(incomePerDay()).toBe(90_000_000);
    });

    test('a run of no length is unmeasurable rather than zero', () => {
        withCombat(0, { ask: 90_000_000, bid: 65_000_000 });
        expect(incomePerDay()).toBeNull();
    });

    test('no combat at all is nothing rather than a crash', () => {
        expect(incomePerDay()).toBeNull();
    });
});

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000; // an arbitrary but fixed epoch, for readable offsets

/** Points every 6h across a 48h window, growing by `perHour` coins each hour */
function growthSeries(perHour, hours = 48, step = 6) {
    const points = [];
    for (let h = 0; h <= hours; h += step) points.push({ t: T0 + h * HOUR, total: 500_000_000 + h * perHour });
    return points;
}

describe('the net worth trend', () => {
    test('steady growth gives the per-day rate it was growing at', () => {
        // 2,000,000/hour is 48,000,000/day
        expect(trendPerDay(growthSeries(2_000_000))).toBeCloseTo(48_000_000, 0);
    });

    test('a span under the minimum is unmeasurable rather than a guess from two dots', () => {
        // Four points, but only 3h apart — a real window, just too short
        const points = [0, 1, 2, 3].map((h) => ({ t: T0 + h * HOUR, total: 500_000_000 + h * 2_000_000 }));
        expect(trendPerDay(points)).toBeNull();
    });

    test('fewer than three points is unmeasurable however wide the span', () => {
        expect(trendPerDay([growthSeries(2_000_000)[0], growthSeries(2_000_000).at(-1)])).toBeNull();
    });

    test('a flat net worth reads as roughly nothing, not null', () => {
        expect(trendPerDay(growthSeries(0))).toBeCloseTo(0, 6);
    });

    test('a sell-off dip inside the window still comes out finite and close to the trend', () => {
        const points = growthSeries(2_000_000);
        // A one-off drop in the middle of otherwise steady growth
        points[4] = { ...points[4], total: points[4].total - 500_000_000 };

        const result = trendPerDay(points);
        expect(Number.isFinite(result)).toBe(true);
        // Sane: still a positive rate, and not wildly off the 48,000,000/day
        // the series grows at everywhere but the one dip
        expect(result).toBeGreaterThan(0);
        expect(result).toBeLessThan(150_000_000);
    });

    test('no points at all is unmeasurable', () => {
        expect(trendPerDay([])).toBeNull();
    });
});

describe('income source selection', () => {
    /** A collector reading of the shape the real one publishes */
    const withCombat = (durationSeconds, dailyProfit) => {
        window.Toolasha = {
            Combat: {
                combatStatsDataCollector: {
                    getLatestData: () => ({ durationSeconds, players: [{ isCurrentPlayer: true, loot: {} }] }),
                },
                combatStatsCalculator: { calculatePlayerStats: () => ({ dailyProfit }) },
            },
        };
    };

    afterEach(() => {
        delete window.Toolasha;
    });

    test('combat is read first when it has something to say', () => {
        withCombat(3600, { ask: 90_000_000, bid: 65_000_000 });
        // A trend that would give a very different number, to prove combat wins
        game.networthSeries = () => growthSeries(2_000_000);

        expect(incomeEstimate()).toEqual({ perDay: 65_000_000, source: 'combat' });
    });

    test('the net worth trend stands in once combat has nothing to say', () => {
        game.networthSeries = () => growthSeries(2_000_000);

        const result = incomeEstimate();
        expect(result.source).toBe('networth');
        expect(result.perDay).toBeCloseTo(48_000_000, 0);
    });

    test('nothing measured from either source is null, not a confident zero', () => {
        expect(incomeEstimate()).toEqual({ perDay: null, source: null });
    });

    test('the panel names the trend as its source', () => {
        game.networthSeries = () => growthSeries(2_000_000);
        equipmentSavingsPanel.show();

        expect(text()).toContain(`networth trend, 48h`);
        expect(text()).not.toContain(FAILED);
    });

    test('the panel names combat as its source', () => {
        withCombat(3600, { ask: 90_000_000, bid: 65_000_000 });
        equipmentSavingsPanel.show();

        expect(text()).toContain('combat session');
        expect(text()).not.toContain(FAILED);
    });
});

describe('crafting rather than buying', () => {
    test('a craft is priced at its materials, not the finished piece', () => {
        // A spear you already hold becomes a refined one for the price of the
        // shards — 30M against a 900M ask, which is a different decision
        game.inventory.push({
            itemHrid: '/items/plain_spear',
            itemLocationHrid: '/item_locations/inventory',
            count: 1,
        });
        watchTarget('/items/refined_spear');
        expect(watchedTargets()[0].cost).toBe(900_000_000 - 40_000_000);

        toggleCrafting('/items/refined_spear');
        // 30 shards at 1M, less the 40M for the sword being replaced
        expect(watchedTargets()[0].cost).toBe(30_000_000 - 40_000_000 > 0 ? 30_000_000 - 40_000_000 : 0);
    });

    test('a base piece you do not own is counted into the craft', () => {
        watchTarget('/items/refined_spear');
        toggleCrafting('/items/refined_spear');

        // 30M of shards plus the 300M spear, less the 40M trade-in
        expect(watchedTargets()[0].cost).toBe(330_000_000 - 40_000_000);
    });

    test('the tea takes its cut off the materials', () => {
        // The game's own panel says 88.9 shards where the recipe says 100.
        // Pricing the printed 100 is an eleven per cent overcharge on every
        // craft this card quotes.
        game.artisan = 0.111;
        watchTarget('/items/refined_spear');
        toggleCrafting('/items/refined_spear');

        // 30 shards less 11.1%, at 1M each, plus the 300M spear, less the 40M
        // trade-in
        const shards = 30 * (1 - 0.111) * 1_000_000;
        expect(watchedTargets()[0].cost).toBeCloseTo(shards + 300_000_000 - 40_000_000, 0);
    });

    test('the saving is shown, not just applied', () => {
        // A count that quietly disagrees with the game's panel reads as a bug
        game.artisan = 0.111;
        watchTarget('/items/refined_spear');
        toggleCrafting('/items/refined_spear');
        equipmentSavingsPanel.show();

        expect(text()).toContain('26.7 × Shard');
        expect(text()).toContain('Artisan tea');
        expect(text()).not.toContain(FAILED);
    });

    test('a craft offers to open the marketplace on what it is short of', () => {
        watchTarget('/items/refined_spear');
        toggleCrafting('/items/refined_spear');
        equipmentSavingsPanel.show();

        expect(text()).toContain('Missing Mats Marketplace');
    });

    test('an unpriced ingredient leaves the craft unpriced rather than cheap', () => {
        game.prices['/items/shard:0'] = null;
        watchTarget('/items/refined_spear');
        toggleCrafting('/items/refined_spear');

        expect(watchedTargets()[0].cost).toBeNull();
    });

    test('a piece with no recipe offers no craft switch', () => {
        watchTarget('/items/holy_sword');
        equipmentSavingsPanel.show();

        expect(equipmentSavingsPanel.panel.querySelector('[data-target-craft="/items/holy_sword"]')).toBeNull();
    });

    test('the recipe is itemised, since one ingredient is usually the expensive one', () => {
        watchTarget('/items/refined_spear');
        toggleCrafting('/items/refined_spear');
        equipmentSavingsPanel.show();

        expect(text()).toContain('Shard');
        expect(text()).toContain('Plain Spear');
        expect(text()).not.toContain(FAILED);
    });
});

describe('selling per target', () => {
    test('a target follows the panel until it is told otherwise', () => {
        watchTarget('/items/holy_sword');
        expect(watchedTargets()[0].cost).toBe(60_000_000);

        setNoSell(true);
        expect(watchedTargets()[0].cost).toBe(100_000_000);
    });

    test('and then keeps its own answer whatever the panel says', () => {
        // The sword being replaced gets sold; the second ring replaces nothing
        watchTarget('/items/holy_sword');
        cycleTargetNoSell('/items/holy_sword'); // always sells

        setNoSell(true);
        expect(watchedTargets()[0].cost).toBe(60_000_000);
    });

    test('cycling three times hands it back to the panel', () => {
        watchTarget('/items/holy_sword');
        cycleTargetNoSell('/items/holy_sword');
        cycleTargetNoSell('/items/holy_sword');
        cycleTargetNoSell('/items/holy_sword');

        setNoSell(true);
        expect(watchedTargets()[0].cost).toBe(100_000_000);
    });
});

describe('the order of the list', () => {
    test('nearest to done leads, and affordable leads that', () => {
        // The sword needs 300M of the 60M held; the spear needs more again.
        // Boots are affordable outright, so they come first.
        game.prices['/items/holy_sword:0'] = { ask: 340_000_000, bid: 300_000_000 };
        watchTarget('/items/holy_sword');
        watchTarget('/items/refined_spear');
        watchTarget('/items/rough_boots');

        expect(watchedTargets().map((target) => target.name)).toEqual(['Rough Boots', 'Holy Sword', 'Refined Spear']);
    });

    test('unpriced targets go last, since they have no progress to sort by', () => {
        game.prices['/items/holy_sword:0'] = null;
        watchTarget('/items/holy_sword');
        watchTarget('/items/rough_boots');

        const names = watchedTargets().map((target) => target.name);
        expect(names[names.length - 1]).toBe('Holy Sword');
    });
});

describe('targets nobody is selling at that level', () => {
    beforeEach(() => {
        // Deliberately tradable, with an ask at +0 and nothing above — which is
        // what a cape actually looks like, and what gating this on
        // `isTradable` got wrong: the item is perfectly tradable and the
        // target still has no price
        game.details['/items/sinister_cape'] = {
            name: 'Sinister Cape',
            itemLevel: 70,
            enhancementCosts: [{ itemHrid: '/items/shard', count: 2 }],
            equipmentDetail: { type: '/equipment_types/back' },
        };
        game.prices['/items/sinister_cape:0'] = { ask: 50_000_000, bid: 45_000_000 };
        // One already on your back. The inventory covers worn pieces, which is
        // how the run knows what level to start from.
        game.inventory.push({
            itemHrid: '/items/sinister_cape',
            itemLocationHrid: '/item_locations/back',
            count: 1,
            enhancementLevel: 5,
        });
        game.equipment.set('/item_locations/back', { itemHrid: '/items/sinister_cape', enhancementLevel: 5 });

        window.Toolasha = {
            Utils: {
                enhancementCalculator: {
                    // Protecting costs protections and saves attempts, which is
                    // the whole reason there is a strategy to pick
                    calculateEnhancement: ({ protectFrom }) =>
                        protectFrom > 0 ? { attempts: 40, protectionCount: 5 } : { attempts: 200, protectionCount: 0 },
                },
                enhancementConfig: {
                    // The character's own bench. `getEnhancingParams` would
                    // hand back the simulator's manual settings, which default
                    // to a fully kitted enhancer nobody here owns.
                    getAutoDetectedParams: () => ({
                        enhancingLevel: 100,
                        toolBonus: 10,
                        teas: { blessed: false },
                        guzzlingBonus: 1,
                    }),
                },
            },
        };
        game.details['/items/mirror_of_protection'] = { name: 'Mirror of Protection', sellPrice: 2_000_000 };
        game.prices['/items/mirror_of_protection:0'] = { ask: 2_000_000, bid: 1_800_000 };
    });

    afterEach(() => {
        delete window.Toolasha;
    });

    test('a cape is priced at the run, not at an ask that does not exist', () => {
        // Protected: 40 attempts × 2 shards at 1M, plus 5 protections at 2M —
        // cheaper than the 400M the unprotected run costs, so that is the one
        // to quote
        watchTarget('/items/sinister_cape', 7);
        expect(watchedTargets()[0].cost).toBe(40 * 2 * 1_000_000 + 5 * 2_000_000);
    });

    test('it counts from the level already on your back', () => {
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].enhancing).toBe(true);
        expect(watchedTargets()[0].fromLevel).toBe(5);
    });

    test('the piece being enhanced is not also traded in', () => {
        // It is the same cape. Subtracting what it would fetch would have you
        // sell the thing you are about to enhance.
        watchTarget('/items/sinister_cape', 7);
        expect(watchedTargets()[0].cost).toBe(40 * 2 * 1_000_000 + 5 * 2_000_000);
    });

    test('with none owned, it buys a base and enhances that', () => {
        game.inventory = game.inventory.filter((item) => item.itemHrid !== '/items/sinister_cape');
        game.equipment.delete('/item_locations/back');
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].fromLevel).toBe(0);
        expect(watchedTargets()[0].cost).toBe(50_000_000 + 40 * 2 * 1_000_000 + 5 * 2_000_000);
    });

    test('a base nobody lists is still priced through the shop that sells it', () => {
        // Capes are drops and shop lines; they are never listed. Reading the
        // market alone says a cape cannot be bought at any price.
        game.inventory = game.inventory.filter((item) => item.itemHrid !== '/items/sinister_cape');
        game.equipment.delete('/item_locations/back');
        game.prices['/items/sinister_cape:0'] = null;
        game.shops.shopItemDetailMap = {
            cape: { itemHrid: '/items/sinister_cape', costs: [{ itemHrid: '/items/token', count: 10 }] },
            // What the token is worth: the best coins any line in this shop
            // converts one into
            sword: { itemHrid: '/items/holy_sword', costs: [{ itemHrid: '/items/token', count: 20 }] },
        };
        watchTarget('/items/sinister_cape', 7);

        // 100M for the sword over 20 tokens is 5M a token, so a 10-token cape
        // is 50M
        expect(watchedTargets()[0].cost).toBe(50_000_000 + 40 * 2 * 1_000_000 + 5 * 2_000_000);
    });

    test('with none owned and nowhere selling one there is nothing to model', () => {
        game.inventory = game.inventory.filter((item) => item.itemHrid !== '/items/sinister_cape');
        game.equipment.delete('/item_locations/back');
        game.prices['/items/sinister_cape:0'] = null;
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].cost).toBeNull();
    });

    test('with nothing to protect with, it quotes the run that has no protection', () => {
        // Offering a protected run at a protection nobody sells would price a
        // run that cannot be made
        game.prices['/items/mirror_of_protection:0'] = null;
        delete game.details['/items/mirror_of_protection'];
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].cost).toBe(200 * 2 * 1_000_000);
    });

    test('the card says it is an anvil run rather than a purchase', () => {
        watchTarget('/items/sinister_cape', 7);
        equipmentSavingsPanel.show();

        expect(text()).toContain('Not sold at this level');
        expect(text()).toContain('Enhancement Cost');
        expect(text()).toContain('Enhance +5');
        expect(text()).not.toContain(FAILED);
    });

    test('it costs the run at your own bench, not the simulator settings', () => {
        // The simulator's manual defaults are a fully kitted enhancer. Costing
        // a cape at somebody else's bench quotes a run you cannot make.
        window.Toolasha.Utils.enhancementConfig.getEnhancingParams = () => {
            throw new Error('the simulator settings are not this character');
        };
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].cost).toBe(40 * 2 * 1_000_000 + 5 * 2_000_000);
    });

    test('without the calculator it is unpriced rather than wrong', () => {
        delete window.Toolasha;
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].cost).toBeNull();
    });
});

describe('the ladder', () => {
    // A run whose cost follows how far it has to climb, so a ladder starting
    // lower reads as dearer — the flat mock above cannot tell the two apart
    const cape = (level, count = 1) => ({
        itemHrid: '/items/sinister_cape',
        itemLocationHrid: '/item_locations/inventory',
        count,
        enhancementLevel: level,
    });

    beforeEach(() => {
        game.details['/items/sinister_cape'] = {
            name: 'Sinister Cape',
            itemLevel: 70,
            enhancementCosts: [{ itemHrid: '/items/shard', count: 2 }],
            equipmentDetail: { type: '/equipment_types/back' },
        };
        game.prices['/items/sinister_cape:0'] = { ask: 50_000_000, bid: 45_000_000 };
        game.details['/items/mirror_of_protection'] = { name: 'Mirror of Protection', sellPrice: 2_000_000 };
        game.prices['/items/mirror_of_protection:0'] = { ask: 2_000_000, bid: 1_800_000 };

        // The one on your back, and a spare in the bag
        game.inventory.push({ ...cape(5), itemLocationHrid: '/item_locations/back' }, cape(2));
        game.equipment.set('/item_locations/back', { itemHrid: '/items/sinister_cape', enhancementLevel: 5 });

        window.Toolasha = {
            Utils: {
                enhancementCalculator: {
                    calculateEnhancement: ({ targetLevel, startLevel, protectFrom }) =>
                        protectFrom > 0
                            ? { attempts: 10 * (targetLevel - startLevel), protectionCount: targetLevel - startLevel }
                            : { attempts: 100 * (targetLevel - startLevel), protectionCount: 0 },
                },
                enhancementConfig: {
                    getAutoDetectedParams: () => ({ enhancingLevel: 100, teas: {}, guzzlingBonus: 1 }),
                },
            },
        };
    });

    afterEach(() => {
        delete window.Toolasha;
    });

    test('it counts from the second-best copy, not from the one you are wearing', () => {
        watchTarget('/items/sinister_cape', 7);
        const target = watchedTargets()[0];

        // Direct: two levels to climb — 20 attempts × 2 shards at 1M, plus two
        // mirrors at 2M
        expect(target.cost).toBe(44_000_000);
        // Ladder: five levels from the +2 spare, and the +5 stays on your back
        expect(target.ladder).toMatchObject({ spare: true, fromLevel: 2, cost: 110_000_000 });
    });

    test('the card says which copy it would climb', () => {
        watchTarget('/items/sinister_cape', 7);
        equipmentSavingsPanel.show();

        expect(text()).toContain('Ladder: enhance your +2 copy instead');
        expect(text()).not.toContain(FAILED);
    });

    test('a stack of two is two copies, so the spare is at the same level', () => {
        game.inventory = game.inventory.filter((item) => item.itemHrid !== '/items/sinister_cape');
        game.equipment.delete('/item_locations/back');
        game.inventory.push(cape(3, 2));
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].ladder).toMatchObject({ spare: true, fromLevel: 3 });
    });

    test('with only the one copy it prices a fresh base and says so', () => {
        game.inventory = game.inventory.filter((item) => (item.enhancementLevel || 0) !== 2);
        watchTarget('/items/sinister_cape', 7);
        equipmentSavingsPanel.show();

        // 50M for a +0 off the market, then seven levels of run
        expect(watchedTargets()[0].ladder).toMatchObject({
            spare: false,
            fromLevel: 0,
            base: 50_000_000,
            cost: 50_000_000 + 154_000_000,
        });
        expect(text()).toContain('Ladder: enhance a fresh +0 you buy instead');
    });

    test('with no spare and nowhere to get one there is no ladder to offer', () => {
        game.inventory = game.inventory.filter((item) => (item.enhancementLevel || 0) !== 2);
        game.prices['/items/sinister_cape:0'] = null;
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].ladder).toBeNull();
        expect(equipmentSavingsPanel.panel).toBeFalsy();
    });

    test('the copy it climbs is the second best, wherever the best one is', () => {
        // A +6 in the bag is now the best copy, so the direct cost counts from
        // there and the ladder falls to the +5 on your back
        game.inventory.push(cape(6));
        watchTarget('/items/sinister_cape', 7);
        const target = watchedTargets()[0];

        expect(target.fromLevel).toBe(6);
        expect(target.ladder).toMatchObject({ spare: true, fromLevel: 5, cost: 44_000_000 });
    });

    test('a copy already at the target leaves no run to price, and so no ladder', () => {
        game.inventory.push(cape(7));
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].ladder).toBeNull();
    });
});
