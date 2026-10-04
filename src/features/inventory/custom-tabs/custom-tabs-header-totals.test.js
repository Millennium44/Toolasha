/**
 * @vitest-environment happy-dom
 *
 * Section header totals are summed from tile datasets when the headers are built, but the badge
 * render that writes those datasets runs after the layout. A header built before prices arrived
 * (or changed) stayed stale until a collapse and reopen rebuilt it; the post-render check redraws it.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';

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
vi.mock('../../../utils/bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));
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

/** An active UI with a Resources section holding two tiles, headers drawn from the tiles' datasets */
async function setup() {
    ui = new CustomTabsUI();
    await ui.initialize();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const tiles = [makeTile('/items/cheese'), makeTile('/items/milk')];
    for (const t of tiles) container.appendChild(t);
    ui._config = {
        tabs: [{ id: 'res', name: 'Resources', open: true, items: tiles.map((t) => t.dataset.hrid), children: [] }],
    };
    ui._isActive = true;
    ui._invContainer = container;
    const tileMap = () => new Map(tiles.map((t) => [t.dataset.hrid, [t]]));
    // Stand-in for the full-rebuild path of _applyLayoutSync: real header injection, real signature
    const layout = vi.spyOn(ui, '_applyLayout').mockImplementation(async () => {
        ui._injectAccordionHeaders(container, ui._config.tabs, 0, tileMap(), 0);
        ui._headerTotalsSignature = ui._tileValueSignature?.(container);
    });
    const total = () => container.querySelector('.toolasha-ct-section-value')?.textContent ?? null;
    return { container, tiles, layout, total };
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

    test('does not redraw when the render left the values alone, so the refresh settles', async () => {
        const { container, tiles, layout } = await setup();
        tiles[0].dataset.askValue = '1000';
        await ui._applyLayout();
        layout.mockClear();

        await ui._refreshBadgesWhenSettled(container);

        expect(layout).not.toHaveBeenCalled();
    });
});
