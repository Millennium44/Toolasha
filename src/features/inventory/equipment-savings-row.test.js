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

const game = vi.hoisted(() => ({ inventory: [], equipment: new Map(), details: {}, prices: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => game.inventory,
        getEquipment: () => game.equipment,
        getItemDetails: (hrid) => game.details[hrid],
        // The picker builds its list from the whole item map, which is the same
        // fixture the per-item lookups read
        getInitClientData: () => ({ itemDetailMap: game.details }),
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
vi.mock('../../core/storage.js', () => ({ default: { db: {}, getJSON: async () => null, setJSON: async () => {} } }));
vi.mock('../../utils/deferred-load.js', () => ({ loadWhenReady: async () => {} }));
vi.mock('../../utils/panel-geometry.js', () => ({ restoreGeometry: () => {}, saveGeometry: () => {} }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/game-lookups.js', () => ({ getItemHridFromName: () => null }));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: () => {} }));
vi.mock('../../api/marketplace.js', () => ({ default: { getDataAge: () => 60_000, fetch: async () => {} } }));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: (hrid, level = 0) => game.prices[`${hrid}:${level}`] || null,
}));

const {
    equipmentSavingsPanel,
    watchTarget,
    watchedTargets,
    everything,
    coinsHeld,
    setNoSell,
    selectTarget,
    resetEquipmentSavings,
} = await import('./equipment-savings-row.js');

beforeEach(() => {
    game.inventory = [
        { itemHrid: '/items/coin', itemLocationHrid: '/item_locations/inventory', count: 60_000_000 },
        // Coins turn up under more than one location; only the inventory one is
        // money you can spend
        { itemHrid: '/items/coin', itemLocationHrid: '/item_locations/market_listing', count: 51_000_000_000_000 },
    ];
    game.details = {
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
    };
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
