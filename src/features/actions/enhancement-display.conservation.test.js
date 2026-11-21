/** @vitest-environment happy-dom
 *
 * Conservation on the enhancing panel.
 *
 * A Conservation talisman line keeps a protection item a failure would have consumed, so the
 * costs-by-level table's Protection column must thin out by that share. Asserted through the
 * panel's real entry point, displayEnhancementStats.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';

// The panel prices every input through the shared enhancement input rule; here it reads the same
// mocked resolver (and, where a file has one, a craft-cost table) every other price in the file does
vi.mock('../../utils/enhancement-input-pricing.js', async () => {
    const { resolveItemPrice } = await import('../../utils/profit-helpers.js');
    const answer = (price) =>
        price > 0 ? { price, unpriced: false, estimated: false } : { price: null, unpriced: true, estimated: false };
    const via = (hrid) => answer(resolveItemPrice(hrid, { side: 'buy', enhancementLevel: 0 })?.price);
    return {
        priceMaterial: (hrid) => {
            if (hrid === '/items/coin') return answer(1);
            if (hrid?.startsWith('/items/trainee_')) return answer(250_000);
            const quoted = via(hrid);
            return quoted.unpriced ? answer({}[hrid]) : quoted;
        },
        priceGuarded: (hrid) => via(hrid),
        priceMirror: () => via('/items/philosophers_mirror'),
        priceBase: (hrid) => via(hrid),
    };
});
import * as mathjs from 'mathjs';

const state = vi.hoisted(() => ({
    settings: { enhanceSim: true, enhanceSim_autoDetect: false },
    prices: {
        '/items/cheese': 500,
        '/items/cheese_sword': 50_000,
        '/items/cheese_sword_protector': 4_000,
        '/items/gouda_sword': 50_000,
        '/items/brie_sword': 50_000,
    },
    blessedTeaBonus: 0.01,
    conservation: 0,
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
        '/items/cheese_sword_protector': { hrid: '/items/cheese_sword_protector', name: 'Protector' },
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
        getCurrentActions: () => [],
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
        conservation: state.conservation,
        teas: state.teas,
    }),
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: (hrid) => ({ ask: state.prices[hrid] || -1, bid: -1 }), on: () => {} },
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price) => price,
    resolveItemPrice: (hrid) => ({ price: state.prices[hrid] || 0, custom: false, missing: !state.prices[hrid] }),
}));
vi.mock('../../utils/tester-shop.js', () => ({
    testerShopEnabled: () => false,
    testerGearPrice: () => null,
    MIRROR_HRID: '/items/philosophers_mirror',
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    marketDepthCap: () => null,
    guildMemberSkills: () => null,
    missingMaterialsButton: () => null,
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));

import { displayEnhancementStats } from './enhancement-display.js';
import { clearProtectSweepMemo } from '../../utils/enhancement-protect-sweep.js';

beforeAll(() => {
    globalThis.math = mathjs;
});

beforeEach(() => {
    clearProtectSweepMemo();
    state.conservation = 0;
    document.body.innerHTML = '';
});

/**
 * Render the panel (protect from +2 with a protector in the slot, target +5) and read the +5 row's
 * Protection cell.
 * @returns {Promise<number>} Expected protections to +5
 */
async function protectionsTo5() {
    document.body.innerHTML = '';
    const panel = document.createElement('div');
    panel.innerHTML =
        '<div><span>Target Level</span><input type="number" value="5"></div>' +
        '<div><span>Protect From Level</span><input type="number" value="2"></div>' +
        '<div class="protectionItemInputContainer"><svg><use href="/static/media/items_sprite.abc.svg#cheese_sword_protector"></use></svg></div>';
    document.body.appendChild(panel);
    await displayEnhancementStats(panel, '/items/cheese_sword');
    const headers = [...panel.querySelectorAll('th')];
    const column = headers.findIndex((th) => th.textContent.trim() === 'Protection');
    expect(column).toBeGreaterThanOrEqual(0);
    const row = [...panel.querySelectorAll('tr')]
        .map((r) => [...r.querySelectorAll('td')])
        .find((cells) => cells[0]?.textContent.trim() === '+5');
    return Number(row[column].textContent.trim().replace(/,/g, ''));
}

describe('the costs-by-level Protection column', () => {
    test('thins out by the Conservation share', async () => {
        const plain = await protectionsTo5();
        state.conservation = 0.5;
        clearProtectSweepMemo();
        const kept = await protectionsTo5();
        expect(plain).toBeGreaterThan(0);
        expect(kept).toBeCloseTo(plain * 0.5, 1);
    });
});
