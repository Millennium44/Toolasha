/**
 * @vitest-environment happy-dom
 *
 * The Charms panel, built rather than reasoned about.
 *
 * This file exists because of one bug that no arithmetic test could have caught:
 * the panel asked the equipment map for `/equipment_types/charm` when the map is
 * keyed by `/item_locations/…`. Every lookup returned undefined, the panel said
 * "Nothing in the charm slot", and the ranking silently fell back to every charm
 * in the game. Nothing threw. So the load-bearing assertion here is that the
 * panel finds the charm the character is actually wearing.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ equipment: new Map(), prices: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getEquipment: () => game.equipment,
        getItemDetails: () => undefined,
        on: () => {},
        off: () => {},
        getCurrentCharacterId: () => 'char1',
    },
}));
vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
    markPanelInteracted: () => {},
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: (hrid, level = 0) => game.prices[`${hrid}:${level}`] || null,
}));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: () => {} }));

// The folds are persisted, and IndexedDB is not what this file is about
vi.mock('../../core/storage.js', () => ({
    default: { db: {}, getJSON: async () => null, setJSON: async () => {} },
}));
vi.mock('../../utils/deferred-load.js', () => ({ loadWhenReady: async () => {} }));

const { charmPanel, equippedCharm, familyRows, resetCharmSort } = await import('./charm-value-row.js');

beforeEach(() => {
    // The key the game actually uses. Getting this wrong is the bug this file
    // is here for, so the fixture states it plainly.
    game.equipment = new Map([
        ['/item_locations/charm', { itemHrid: '/items/grandmaster_melee_charm', enhancementLevel: 0 }],
    ]);
    game.prices = {
        '/items/grandmaster_melee_charm:0': { ask: 500_000_000 },
        '/items/grandmaster_melee_charm:5': { ask: 980_000_000 },
        '/items/expert_melee_charm:5': { ask: 155_000_000 },
        '/items/master_melee_charm:3': { ask: 240_000_000 },
        '/items/basic_melee_charm:0': { ask: 840_000 },
        // A charm of another focus, which must not appear
        '/items/grandmaster_brewing_charm:0': { ask: 1_000 },
    };
});

afterEach(() => {
    charmPanel.hide();
    resetCharmSort();
});

const text = () => charmPanel.panel.textContent;
const FAILED = 'could not be drawn';

describe('finding the charm', () => {
    test('it reads the slot the game actually uses', () => {
        const worn = equippedCharm();
        expect(worn).not.toBeNull();
        expect(worn.itemHrid).toBe('/items/grandmaster_melee_charm');
        expect(worn.experience).toBeCloseTo(8, 6);
    });

    test('enhancement scales the bonus', () => {
        // +5 on a charm is 1.6×, which is the slot's 5× multiplier and not the 1×
        // default a missing item lookup would silently fall back to
        game.equipment = new Map([
            ['/item_locations/charm', { itemHrid: '/items/grandmaster_melee_charm', enhancementLevel: 5 }],
        ]);
        expect(equippedCharm().experience).toBeCloseTo(12.8, 6);
    });

    test('an empty slot is nothing rather than a crash', () => {
        game.equipment = new Map();
        expect(equippedCharm()).toBeNull();
    });
});

describe('the family', () => {
    test('only charms of the focus you are wearing', () => {
        const focuses = new Set(familyRows().map((charm) => charm.itemHrid));
        expect([...focuses].every((hrid) => hrid.includes('_melee_charm'))).toBe(true);
        expect(focuses.has('/items/grandmaster_brewing_charm')).toBe(false);
    });

    test('a row per enhancement level on the market, not one per charm', () => {
        // A Grandmaster +0 and a Grandmaster +5 are different purchases
        const grandmaster = familyRows().filter((charm) => charm.tier === 'grandmaster');
        expect(grandmaster.map((charm) => charm.enhancementLevel).sort()).toEqual([0, 5]);
    });

    test('a tier nobody is selling still gets a line', () => {
        const advanced = familyRows().find((charm) => charm.tier === 'advanced');
        expect(advanced).toBeDefined();
        expect(advanced.price).toBe(0);
        expect(advanced.experiencePerMillion).toBeNull();
    });

    test('the trainee tier is never listed and is not unpriced either', () => {
        // The vendor stocks it at 250,000, which is the floor every other tier's
        // value per coin is judged against
        const trainee = familyRows().find((charm) => charm.tier === 'trainee');
        expect(trainee.price).toBe(250_000);
        expect(trainee.experiencePerMillion).toBeCloseTo(4, 6);
    });

    test('nothing equipped is no family rather than every charm in the game', () => {
        game.equipment = new Map();
        expect(familyRows()).toEqual([]);
    });
});

describe('the panel renders', () => {
    test('every section draws, and none of them fails', () => {
        charmPanel.show();

        expect(text()).toContain('Charm EXP Guide');
        expect(text()).toContain('Charm Upgrades');
        expect(text()).toContain('Melee (Expert)');
        expect(text()).not.toContain(FAILED);
    });

    test('the sections are headed with what you are wearing', () => {
        charmPanel.show();
        expect(text()).toContain('Charm Upgrades (8.00%)');
    });

    test('a charm worth less than yours is a downgrade, not missing', () => {
        charmPanel.show();
        // Seeing that a charm two tiers down is a fraction of the price is how
        // you decide the top tier is not worth it
        expect(text()).toContain('Charm Downgrades');
        expect(text()).toContain('Melee (Basic)');
    });

    test('an empty slot says so rather than ranking everything', () => {
        game.equipment = new Map();
        charmPanel.show();

        expect(text()).toContain('No charm equipped');
        expect(text()).not.toContain(FAILED);
    });

    test('it draws before the market has answered', () => {
        game.prices = {};
        charmPanel.show();
        expect(text()).not.toContain(FAILED);
    });

    test('a section you fold away stays folded across a refresh', () => {
        // The panel rebuilds its whole body every few seconds. A fold held in
        // the DOM springs back to its default on the next redraw — collapse it,
        // watch it reappear, over and over.
        charmPanel.show();

        const fold = (id) => charmPanel.panel.querySelector(`[data-section="${id}"]`);
        const isOpen = (id) => fold(id).textContent.startsWith('▼');

        expect(isOpen('upgrades')).toBe(true);
        fold('upgrades').click();
        expect(isOpen('upgrades')).toBe(false);

        charmPanel.render();
        expect(isOpen('upgrades')).toBe(false);
    });

    test('and one you unfold stays unfolded', () => {
        charmPanel.show();

        const guide = () => charmPanel.panel.querySelector('[data-section="guide"]');
        guide().click();
        charmPanel.render();

        expect(guide().textContent.startsWith('▼')).toBe(true);
        expect(charmPanel.panel.textContent).toContain('Grandmaster 8%');
    });

    test('clicking a column heading reorders rather than throwing', () => {
        charmPanel.show();

        const heading = charmPanel.panel.querySelector('[data-column="price"]');
        heading.click();

        expect(charmPanel.panel.textContent).toContain('Ask');
        expect(text()).not.toContain(FAILED);
    });
});
