/**
 * @vitest-environment happy-dom
 *
 * The Item spacing setting reaches the game's own Inventory view through one injected rule.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    charId: 'char-1',
    settings: { inventoryTabs_showUnorganized: true, inventoryTabs_iconRowTab: true },
    itemDetailMap: {
        '/items/cheese': { name: 'Cheese', categoryHrid: '/item_categories/food', sortIndex: 1 },
        '/items/milk': { name: 'Milk', categoryHrid: '/item_categories/resource', sortIndex: 2 },
        '/items/coin': { name: 'Coin', categoryHrid: '/item_categories/currency', sortIndex: 0 },
    },
    itemCategoryDetailMap: {
        '/item_categories/currency': { name: 'Currency', sortIndex: 0 },
        '/item_categories/food': { name: 'Food', sortIndex: 1 },
        '/item_categories/resource': { name: 'Resources', sortIndex: 2 },
    },
    inventory: [],
    listeners: [],
}));

const storageMock = vi.hoisted(() => {
    const map = new Map();
    return {
        map,
        get: vi.fn(async (key, _store, fallback = null) => (map.has(key) ? map.get(key) : fallback)),
        set: vi.fn(async (key, value) => {
            map.set(key, value);
            return true;
        }),
        delete: vi.fn(async (key) => {
            map.delete(key);
            return true;
        }),
    };
});

/** Callbacks registered with the DOM observer, so a test can play the game rendering a strip */
const observer = vi.hoisted(() => ({ classHandlers: new Map(), readyHandlers: [] }));

vi.mock('../../../core/config.js', () => ({
    default: {
        getSetting: (key) => game.settings[key] ?? false,
        getSettingValue: (key, fallback = null) => game.settings[key] ?? fallback,
        onSettingChange: (key, fn) => {
            game.listeners.push({ key, fn });
            return () => {};
        },
    },
}));
vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, className, fn) => {
            observer.classHandlers.set(`${name}:${className}`, fn);
            return () => observer.classHandlers.delete(`${name}:${className}`);
        },
        onReady: (_name, fn) => {
            observer.readyHandlers.push(fn);
            return () => {};
        },
    },
}));
vi.mock('../../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.charId,
        on: () => {},
        off: () => {},
        getInventory: () => game.inventory,
        getInitClientData: () => ({
            itemDetailMap: game.itemDetailMap,
            itemCategoryDetailMap: game.itemCategoryDetailMap,
        }),
    },
}));
vi.mock('../inventory-sort.js', () => ({ default: { currentMode: 'none', onModeChange: () => () => {} } }));
/** The badge manager, busy pricing tiles when a test says so */
const badges = vi.hoisted(() => ({
    currentInventoryElem: {},
    isCalculating: false,
    isRendering: false,
    onRepriced: () => () => {},
    renderAllBadges: async () => {},
}));
vi.mock('../inventory-badge-manager.js', () => ({ default: badges }));
vi.mock('../../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    marketDepthCap: () => null,
    guildMemberSkills: () => null,
    loadoutSnapshot: () => ({ onUpdate: () => {}, offUpdate: () => {} }),
}));
vi.mock('./custom-tabs-data.js', async (importOriginal) => ({
    ...(await importOriginal()),
    loadConfig: async () => ({ tabs: [] }),
}));

const { default: CustomTabsUI, NATIVE_GAP_SEL: RULE_SEL } = await import('./custom-tabs-ui.js');

const gapSheet = () => {
    const el = document.head.querySelector('style');
    const line = el?.textContent.split('\n').find((l) => l.startsWith(RULE_SEL));
    return line ? { textContent: line } : null;
};

describe('item spacing on the native Inventory view', () => {
    let ui;
    beforeEach(async () => {
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        game.settings = { inventoryTabs_showUnorganized: true, inventoryTabs_iconRowTab: true };
        game.listeners = [];
        ui = new CustomTabsUI();
        await ui.initialize();
    });
    afterEach(() => {
        ui.cleanup();
    });

    const change = (value) => {
        game.settings.inventoryTabs_tileGap = value;
        for (const l of game.listeners.filter((x) => x.key === 'inventoryTabs_tileGap')) l.fn(value);
    };

    test('default 4 writes the game own gap', () => {
        expect(gapSheet().textContent).toBe(`${RULE_SEL} { gap: 4px; }`);
    });

    test('0 and 10 produce the rule, live on a setting change', () => {
        change(0);
        expect(gapSheet().textContent).toBe(`${RULE_SEL} { gap: 0px; }`);
        change(10);
        expect(gapSheet().textContent).toBe(`${RULE_SEL} { gap: 10px; }`);
        expect(document.head.querySelectorAll('style').length).toBe(1);
    });

    test('the rule scopes to grids inside Inventory_items only', () => {
        document.body.innerHTML =
            '<div class="Inventory_items__x"><div class="Inventory_itemGrid__a" id="in"></div></div>' +
            '<div class="Other_panel"><div class="Inventory_itemGrid__b" id="out"></div></div>';
        expect(document.querySelector('#in').matches(RULE_SEL)).toBe(true);
        expect(document.querySelector('#out').matches(RULE_SEL)).toBe(false);
    });

    test('feature off removes the rule', () => {
        ui.cleanup();
        expect(document.head.querySelectorAll('style').length).toBe(0);
    });

    test('Toolasha tab keeps its inline gap on the container', () => {
        const host = document.createElement('div');
        change(10);
        ui._applyTileGap(host);
        expect(host.style.gap).toBe('10px');
    });
});
