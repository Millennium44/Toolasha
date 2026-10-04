/** @vitest-environment happy-dom
 *
 * The success-rate "+N -> +N+1" line reads the level of the item on the panel, not of whatever
 * the player happens to be enhancing. With one item running at +7 and the Enhance tab set up on a
 * different +0 item, the line used to read the running item's level.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as mathjs from 'mathjs';

const state = vi.hoisted(() => ({
    actions: [],
    settings: { enhanceSim: true, enhanceSim_autoDetect: false },
    prices: {
        '/items/cheese': 500,
        '/items/cheese_sword': 50_000,
        '/items/gouda_sword': 50_000,
        '/items/brie_sword': 50_000,
    },
    blessedTeaBonus: 0.01,
    teas: { blessed: false },
    items: {
        // Same item level, no `level` field — which is what enhanceable equipment
        // actually looks like — and a steep skill requirement beside it.
        '/items/cheese_sword': {
            hrid: '/items/cheese_sword',
            name: 'Cheese Sword',
            itemLevel: 10,
            enhancementCosts: [{ itemHrid: '/items/cheese', count: 2 }],
            equipmentDetail: { levelRequirements: [{ skillHrid: '/skills/attack', level: 70 }] },
        },
        // The same weapon with no requirement at all
        '/items/gouda_sword': {
            hrid: '/items/gouda_sword',
            name: 'Gouda Sword',
            itemLevel: 10,
            enhancementCosts: [{ itemHrid: '/items/cheese', count: 2 }],
            equipmentDetail: { levelRequirements: [] },
        },
        // Far above the enhancer's level, so the chain takes the deficit penalty
        '/items/brie_sword': {
            hrid: '/items/brie_sword',
            name: 'Brie Sword',
            itemLevel: 100,
            enhancementCosts: [{ itemHrid: '/items/cheese', count: 2 }],
            equipmentDetail: { levelRequirements: [] },
        },
        '/items/cheese': { hrid: '/items/cheese', name: 'Cheese', sellPrice: 100 },
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => Boolean(state.settings[key]),
        getSettingValue: (key, fallback) => state.settings[key] ?? fallback,
        toggleSetting: () => {},
        COLOR_XP_RATE: '#ffdd88',
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap: state.items }),
        getItemDetails: (hrid) => state.items[hrid] || null,
        getActionDetails: () => ({ baseTimeCost: 12e9 }),
        getCurrentActions: () => state.actions,
        getPersonalBuffFlatBoost: () => 0,
    },
}));
vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: () => ({
        enhancingLevel: 60,
        houseLevel: 0,
        toolBonus: 3,
        speedBonus: 0,
        experienceBonus: 20,
        rareFindBonus: 0,
        detectedTeaBonus: 0,
        guzzlingBonus: 1,
        blessedTeaBonus: state.blessedTeaBonus,
        teas: state.teas,
    }),
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: (hrid) => ({ ask: state.prices[hrid] || -1, bid: -1 }), on: () => {} },
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    resolveItemPrice: (hrid) => ({ price: state.prices[hrid] || 0, custom: false, missing: !state.prices[hrid] }),
}));
vi.mock('../../utils/tester-shop.js', () => ({
    testerShopEnabled: () => false,
    testerGearPrice: () => null,
    MIRROR_HRID: '/items/philosophers_mirror',
}));
vi.mock('../../utils/bundle-bridge.js', () => ({ missingMaterialsButton: () => null }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));

import { displayEnhancementStats } from './enhancement-display.js';
import { clearProtectSweepMemo } from '../../utils/enhancement-protect-sweep.js';

beforeAll(() => {
    globalThis.math = mathjs;
});

beforeEach(() => {
    clearProtectSweepMemo();
    state.actions = [];
    document.body.innerHTML = '';
});

const running = (itemHrid, level) => [
    {
        id: 1,
        actionHrid: '/actions/enhancing/enhance',
        primaryItemHash: `1234::/item_locations/inventory::${itemHrid}::${level}`,
        isDone: false,
        ordinal: 1,
    },
];

async function successLine(itemName, itemHrid) {
    const panel = document.createElement('div');
    panel.innerHTML =
        '<div><span>Target Level</span><input type="number" value="10"></div>' +
        '<div><span>Protect From Level</span><input type="number" value="0"></div>' +
        '<div class="protectionItemInputContainer"></div>' +
        `<div class="SkillActionDetail_item__2vEAz"><div class="Item_name__2C42x">${itemName}</div></div>`;
    document.body.appendChild(panel);
    await displayEnhancementStats(panel, itemHrid);
    return panel.textContent.match(/\+(\d+) \u2192 \+(\d+):\s*[\d.]+%\s*\u2192/);
}

describe('the success-rate line level', () => {
    test('an enhance running on another item does not set the level of the panel item', async () => {
        state.actions = running('/items/cheese_sword', 7);
        const line = await successLine('Brie Sword', '/items/brie_sword');
        expect(line).toBeTruthy();
        expect(line.slice(1, 3)).toEqual(['0', '1']);
    });

    test('an enhance running on the panel item itself still gives its level', async () => {
        state.actions = running('/items/brie_sword', 7);
        const line = await successLine('Brie Sword', '/items/brie_sword');
        expect(line).toBeTruthy();
        expect(line.slice(1, 3)).toEqual(['7', '8']);
    });
});
