/**
 * @vitest-environment happy-dom
 *
 * The popup lets a player build up an exclusion list one chip at a time, but
 * until now it never said what all of them added up to — the only place that
 * total showed was the collapsed "Excluded" row back on the main panel, which
 * this popup sits on top of and hides. This tests that the total currently
 * being omitted from net worth is visible while configuring, and stays silent
 * when there is nothing to add up.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { COLOR_ACCENT: '#22c55e', Z_FLOATING_PANEL: 1100 },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => null, getItemDetails: () => null },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: (hrid, level = 0) => market.prices[`${hrid}:${level}`] ?? null },
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: vi.fn(),
    unregisterFloatingPanel: vi.fn(),
    bringPanelToFront: vi.fn(),
}));
const gear = vi.hoisted(() => ({ snapshots: [], wornLevels: new Map() }));
const market = vi.hoisted(() => ({ prices: {} }));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: {
        getAllSnapshots: () => gear.snapshots,
        // The resolver itself is unit-tested in loadout-snapshot.test.js; here
        // it only has to disagree with the stored level so a reader of the raw
        // snapshot is caught.
        resolveEquipment: (snap) =>
            (snap?.equipment || []).map((eq) => ({
                ...eq,
                enhancementLevel: gear.wornLevels.get(eq.itemHrid) ?? eq.enhancementLevel ?? 0,
            })),
    },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));

const state = vi.hoisted(() => ({ exclusions: [{ type: 'item', value: '/items/coin' }] }));
vi.mock('./networth-exclusions.js', () => ({
    getExclusions: () => state.exclusions,
    isExcluded: (type, value) => state.exclusions.some((e) => e.type === type && e.value === value),
    addExclusion: vi.fn(async () => {}),
    removeExclusion: vi.fn(async () => {}),
    clearExclusions: vi.fn(async () => {}),
}));

const { default: networthExclusionPopup } = await import('./networth-exclusion-popup.js');

/** A networthData shaped enough for the popup to render without throwing. */
function networthData(excludedTotal) {
    return {
        currentAssets: {
            equipped: { value: 0, breakdown: [] },
            inventory: { value: 0, breakdown: [], byCategory: {} },
            listings: { value: 0, breakdown: [] },
        },
        fixedAssets: {
            houses: { totalCost: 0, breakdown: [] },
            abilities: { totalCost: 0, breakdown: [] },
            abilityBooks: { totalCost: 0, breakdown: [] },
            guildShrines: { totalCost: 0, breakdown: [] },
        },
        excluded: { total: excludedTotal, items: [] },
    };
}

beforeEach(() => {
    document.body.innerHTML = '';
    networthExclusionPopup.close();
    state.exclusions = [{ type: 'item', value: '/items/coin' }];
    gear.snapshots = [];
    gear.wornLevels = new Map();
    market.prices = {};
});

describe('exclusion total readout', () => {
    test('shows what the current exclusions add up to omitting', () => {
        networthExclusionPopup.open(networthData(1_250_000), () => {});

        const totalLine = document.getElementById('mwi-nex-total');
        expect(totalLine).toBeTruthy();
        expect(totalLine.textContent).toContain('1.25M');
        expect(totalLine.textContent).toContain('Currently omitting');
    });

    test('says nothing when there are no exclusions configured', () => {
        state.exclusions = [];
        networthExclusionPopup.open(networthData(0), () => {});

        expect(document.getElementById('mwi-nex-total')).toBeNull();
    });

    test('refreshing after an exclusion is cleared drops the total line too', () => {
        networthExclusionPopup.open(networthData(1_250_000), () => {});
        expect(document.getElementById('mwi-nex-total')).toBeTruthy();

        state.exclusions = [];
        networthExclusionPopup.refresh(networthData(0));

        expect(document.getElementById('mwi-nex-total')).toBeNull();
    });
});

/**
 * A loadout in "highest owned" mode wears the best copy owned now, not the
 * level the snapshot stored at last save (usually 0). The popup's loadout
 * amounts used to price every piece at the base level, so a +13 outfit was
 * quoted as if it were bare — wildly understating what excluding it removes.
 */
describe('loadout exclusion amounts', () => {
    const SWORD = '/items/sword';

    beforeEach(() => {
        state.exclusions = [];
        gear.snapshots = [
            {
                name: 'Boss',
                useExactEnhancement: false,
                equipment: [{ itemLocationHrid: '/item_locations/main_hand', itemHrid: SWORD, enhancementLevel: 0 }],
            },
        ];
        gear.wornLevels = new Map([[SWORD, 20]]);
    });

    test('are priced at the level the loadout actually wears', () => {
        market.prices = {
            [`${SWORD}:0`]: { ask: 100, bid: null },
            [`${SWORD}:20`]: { ask: 50_000, bid: null },
        };

        const entries = networthExclusionPopup._buildSearchList(networthData(0));
        const loadoutEntry = entries.find((e) => e.type === 'loadout' && e.value === 'Boss');

        expect(loadoutEntry).toBeDefined();
        expect(loadoutEntry.amount).toBe(50_000);
    });

    test('fall back to the base price when the worn level has no book', () => {
        market.prices = { [`${SWORD}:0`]: { ask: 100, bid: null } };

        const entries = networthExclusionPopup._buildSearchList(networthData(0));
        const loadoutEntry = entries.find((e) => e.type === 'loadout' && e.value === 'Boss');

        expect(loadoutEntry.amount).toBe(100);
    });

    test('the expanded breakdown names and prices the worn level too', () => {
        state.exclusions = [{ type: 'loadout', value: 'Boss' }];
        market.prices = {
            [`${SWORD}:0`]: { ask: 100, bid: null },
            [`${SWORD}:20`]: { ask: 50_000, bid: null },
        };

        networthExclusionPopup.open(networthData(0), () => {});
        const rows = networthExclusionPopup._getBreakdownItems({ type: 'loadout', value: 'Boss' });

        expect(rows).toEqual([{ name: 'sword +20', value: 50_000 }]);
    });
});
