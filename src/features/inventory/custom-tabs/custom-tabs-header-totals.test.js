/**
 * @vitest-environment happy-dom
 *
 * Section header totals are summed from tile datasets when the headers are built, but the badge
 * render that writes those datasets runs after the layout. A header built before prices arrived
 * (or changed) stayed stale until a collapse and reopen rebuilt it; the post-render check redraws it.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import { buildCharacterPanel, buildNewInventory } from './custom-tabs-inventory.fixture.js';

const badgeMock = vi.hoisted(() => ({ renderAllBadges: vi.fn(async () => {}) }));

const storageMock = vi.hoisted(() => ({
    get: vi.fn(async (_key, _store, fallback = null) => fallback),
    tryGet: vi.fn(async () => ({ found: false, value: null })),
    set: vi.fn(async () => true),
    delete: vi.fn(async () => true),
    getAllKeys: vi.fn(async () => []),
}));

const dm = vi.hoisted(() => ({
    getCurrentCharacterId: () => 'char',
    getCurrentCharacterGameMode: () => 'standard',
    getInitClientData: () => ({}),
    characterItems: [],
    getInventory: () => [],
    on: () => {},
    off: () => {},
}));

vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/data-manager.js', () => ({ default: dm }));
vi.mock('../../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => () => {},
    },
}));
vi.mock('../../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        onReady: (name, callback) => {
            callback();
            return () => {};
        },
    },
}));
vi.mock('../inventory-sort.js', () => ({ default: { onModeChange: () => () => {}, currentMode: 'none' } }));
vi.mock('../inventory-badge-manager.js', () => ({
    default: {
        currentInventoryElem: null,
        isRendering: false,
        isCalculating: false,
        renderAllBadges: badgeMock.renderAllBadges,
        onRepriced: () => () => {},
    },
}));
vi.mock('../../combat/loadout-snapshot.js', () => ({
    default: { snapshots: {}, onUpdate: vi.fn(), offUpdate: vi.fn(), updateEnhancementLevel: vi.fn() },
}));
vi.mock('../../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    marketDepthCap: () => null,
    guildMemberSkills: () => null,
    loadoutSnapshot: () => null,
}));
vi.mock('../../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async (id) => id,
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { default: CustomTabsUI } = await import('./custom-tabs-ui.js');

let ui;

afterEach(() => {
    ui?.cleanup();
    ui = null;
});

function makeTile(hrid) {
    const el = document.createElement('div');
    el.className = 'Item_itemContainer__x';
    el.dataset.hrid = hrid;
    return el;
}

/**
 * An active UI over a game-shaped inventory (see custom-tabs-inventory.fixture.js), laid out by the real
 * `_applyLayout`: a Resources section holding the cheese and milk tiles, the coin tile left Unorganized.
 * `layout` only watches the real pass.
 */
async function setup() {
    document.body.replaceChildren();
    const { inventoryPanel } = buildCharacterPanel();
    const { inv } = buildNewInventory(inventoryPanel, 'inventory_all');
    const tileFor = (name) =>
        [...inv.querySelectorAll('[class*="Item_itemContainer"]')].find(
            (tile) => tile.querySelector('use').getAttribute('href').split('#')[1] === name
        );
    const tiles = [tileFor('cheese'), tileFor('milk')];

    ui = new CustomTabsUI();
    ui._config = {
        tabs: [
            {
                id: 'res',
                name: 'Resources',
                open: true,
                items: ['/items/cheese', '/items/milk'],
                children: [],
            },
        ],
    };
    ui._configCharId = dm.getCurrentCharacterId();
    ui._isActive = true;
    const layout = vi.spyOn(ui, '_applyLayout');
    const total = () => inv.querySelector('.toolasha-ct-section-value')?.textContent ?? null;
    return { container: inv, tiles, layout, total };
}

describe('section header totals after the prices arrive', () => {
    test('redraws a total built before the badge render wrote the tile values', async () => {
        const { container, tiles, layout, total } = await setup();
        await ui._applyLayout();
        expect(total()).toBeNull();
        layout.mockClear();

        badgeMock.renderAllBadges.mockImplementationOnce(async () => {
            tiles[0].dataset.askValue = '2000000';
            tiles[1].dataset.askValue = '1000000';
        });
        await ui._refreshBadgesWhenSettled(container);

        expect(layout).toHaveBeenCalledTimes(1);
        expect(total()).toBe('3.00M');
    });

    test('redraws a total that changed when a price moved, without a collapse', async () => {
        const { container, tiles, layout, total } = await setup();
        tiles[0].dataset.askValue = '1000';
        tiles[1].dataset.askValue = '1000';
        await ui._applyLayout();
        expect(total()).toBe('2.00K');

        badgeMock.renderAllBadges.mockImplementationOnce(async () => {
            tiles[0].dataset.askValue = '5000';
        });
        await ui._refreshBadgesWhenSettled(container);

        expect(total()).toBe('6.00K');
        expect(layout).toHaveBeenCalledTimes(2);
    });

    test('redraws when two tiles change by opposite amounts, leaving the overall sum alone', async () => {
        const { container, tiles, layout } = await setup();
        tiles[0].dataset.askValue = '3000';
        tiles[1].dataset.askValue = '1000';
        await ui._applyLayout();
        layout.mockClear();

        badgeMock.renderAllBadges.mockImplementationOnce(async () => {
            tiles[0].dataset.askValue = '1000';
            tiles[1].dataset.askValue = '3000';
        });
        await ui._refreshBadgesWhenSettled(container);

        expect(layout).toHaveBeenCalledTimes(1);
    });

    test('a container swapped in while a render runs gets its headers checked', async () => {
        const { container, layout } = await setup();
        await ui._applyLayout();
        layout.mockClear();

        // The game replaces the whole inventory grid mid-render, tiles and all; its own refresh request is
        // folded in
        const host = container.parentElement;
        container.remove();
        const fresh = buildNewInventory(host, 'inventory_all').inv;
        const freshCheese = [...fresh.querySelectorAll('[class*="Item_itemContainer"]')].find(
            (tile) => tile.querySelector('use').getAttribute('href').split('#')[1] === 'cheese'
        );
        let firstRender = true;
        badgeMock.renderAllBadges.mockImplementation(async () => {
            if (firstRender) {
                firstRender = false;
                ui._invContainer = fresh;
                ui._refreshBadgesWhenSettled(fresh);
            }
            freshCheese.dataset.askValue = '2000000';
        });
        await ui._refreshBadgesWhenSettled(container);
        badgeMock.renderAllBadges.mockReset();

        expect(layout).toHaveBeenCalled();
        expect(fresh.querySelector('.toolasha-ct-section-value')?.textContent).toBe('2.00M');
    });

    test('redraws when a tile is replaced by a different item of the same value', async () => {
        const { container, tiles, layout } = await setup();
        tiles[0].dataset.askValue = '1000';
        tiles[1].dataset.askValue = '1000';
        await ui._applyLayout();
        layout.mockClear();
        const baseHrid = vi.spyOn(ui, '_tileBaseHrid');
        baseHrid.mockImplementation((tile) => (tile === tiles[0] ? '/items/egg' : tile.dataset.hrid));

        await ui._refreshBadgesWhenSettled(container);
        baseHrid.mockRestore();

        expect(layout).toHaveBeenCalledTimes(1);
    });

    test('does not redraw when the render left the values alone, so the refresh settles', async () => {
        const { container, tiles, layout } = await setup();
        tiles[0].dataset.askValue = '1000';
        await ui._applyLayout();
        layout.mockClear();

        await ui._refreshBadgesWhenSettled(container);

        expect(layout).not.toHaveBeenCalled();
    });
});

describe('section totals mark unpriced items', () => {
    test('an expanded section with an unpriced item shows the mark and names it; priced-only shows none', async () => {
        const { tiles, total, container } = await setup();
        tiles[0].dataset.askValue = '1000';
        tiles[1].dataset.askValue = '0';
        tiles[1].dataset.expectPrice = 'Rare Thing';
        await ui._applyLayout();
        expect(total()).toBe('≥1.00K');
        expect(container.querySelector('.toolasha-ct-section-value').title).toContain('Rare Thing');

        container.querySelector('.toolasha-ct-section-value').remove();
        tiles[1].dataset.askValue = '500';
        await ui._applyLayout();
        expect(total()).toBe('1.50K');
        expect(container.querySelector('.toolasha-ct-section-value').title).not.toContain('Not included');
    });

    test('a deliberate 0 (no flag) does not mark the section', async () => {
        const { tiles, total } = await setup();
        tiles[0].dataset.askValue = '1000';
        tiles[1].dataset.askValue = '0';
        await ui._applyLayout();
        expect(total()).toBe('1.00K');
    });

    test('the collapsed rollup marks and names unpriced items across descendants', () => {
        const priced = makeTile('/items/cheese');
        priced.dataset.askValue = '2000';
        const unpriced = makeTile('/items/rare');
        unpriced.dataset.askValue = '0';
        unpriced.dataset.expectPrice = 'Rare Thing';
        const tab = {
            items: ['/items/cheese'],
            children: [{ items: ['/items/rare'], children: [] }],
        };
        const map = new Map([
            ['/items/cheese', [priced]],
            ['/items/rare', [unpriced]],
        ]);
        const result = CustomTabsUI.prototype._peekTileValue.call({}, tab, map, 'askValue');
        expect(result).toEqual({ total: 2000, unpriced: ['Rare Thing'] });
    });
});
