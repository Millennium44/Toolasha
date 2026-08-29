/** @vitest-environment happy-dom
 *
 * The XP the enhancing panel quotes.
 *
 * Enhancement XP is `1.4 x (1 + wisdom) x enhancementMultiplier x (10 + itemLevel)` — the item's
 * own level, which is what `calculateSuccessXP` in enhancement-xp.js reads and what the tooltip
 * path and the XPH calculator therefore quote. The panel carried its own inline copy of that
 * formula keyed on a level requirement instead, so the same item was worth two different amounts
 * of XP depending on which surface you looked at.
 *
 * What is asserted is the invariant, not a magic number: two items with the same item level are
 * worth the same XP, whatever their level requirements say.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as mathjs from 'mathjs';

const state = vi.hoisted(() => ({
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
    state.blessedTeaBonus = 0.01;
    state.teas = { blessed: false };
    document.body.innerHTML = '';
});

/**
 * Render the enhancing panel for one item and pull the XP/hr column out of the
 * costs-by-level table.
 * @param {string} itemHrid - Item to draw the panel for
 * @returns {Promise<string[]>} One XP/hr cell per enhancement level
 */
async function xpColumn(itemHrid) {
    document.body.innerHTML = '';
    const panel = document.createElement('div');
    panel.innerHTML =
        '<div><span>Target Level</span><input type="number" value="5"></div>' +
        '<div><span>Protect From Level</span><input type="number" value="0"></div>' +
        '<div class="protectionItemInputContainer"></div>';
    document.body.appendChild(panel);
    await displayEnhancementStats(panel, itemHrid);

    const headers = [...panel.querySelectorAll('th')];
    const column = headers.findIndex((th) => th.textContent.trim() === 'XP/hr');
    expect(column).toBeGreaterThanOrEqual(0);

    // Only the level rows of the costs table — its first cell is the level, and other tables
    // on the panel do not lay their columns out the same way
    return [...panel.querySelectorAll('tr')]
        .map((row) => [...row.querySelectorAll('td')])
        .filter((cells) => /^\+\d+$/.test(cells[0]?.textContent.trim() || ''))
        .map((cells) => cells[column]?.textContent.trim() ?? '');
}

describe('the costs-by-level XP column', () => {
    test('keys on the item level, not on whatever skill the item happens to require', async () => {
        const required = await xpColumn('/items/cheese_sword');
        const unrequired = await xpColumn('/items/gouda_sword');

        expect(required.length).toBeGreaterThan(0);
        expect(required.some((cell) => cell !== '-')).toBe(true);
        expect(required).toEqual(unrequired);
    });
});

describe('the costs-by-level chain', () => {
    test("runs on the live Blessed Tea double-jump chance, not the 1% stand-in", async () => {
        // Blessed Tea's real flatBoost is read from item data by getEnhancingParams; a run that
        // skips a level ten times as often is a materially cheaper and faster run, and the panel
        // has to quote the chance the character actually has.
        state.teas = { blessed: true };

        state.blessedTeaBonus = 0.01;
        const stingy = await xpColumn('/items/cheese_sword');

        state.blessedTeaBonus = 0.1;
        const generous = await xpColumn('/items/cheese_sword');

        expect(stingy).not.toEqual(generous);
    });
});

describe('the success-rate breakdown', () => {
    test('quotes the rate the chain actually runs on when the enhancer is under-levelled', () => {
        // Enhancing 60 against a level-100 item: the calculator's multiplier is
        // 1 - 0.5 x (1 - 60/100) + 3/100 = 0.83, so a 50% base rate is really 41.5%.
        // The panel used to build its own multiplier as 1 + bonuses/100, which knows
        // nothing about the deficit and quoted 51.5% - beside a table of attempts and
        // costs computed from 0.83.
        const panel = document.createElement('div');
        panel.innerHTML =
            '<div><span>Target Level</span><input type="number" value="5"></div>' +
            '<div><span>Protect From Level</span><input type="number" value="0"></div>' +
            '<div class="protectionItemInputContainer"></div>' +
            '<div class="SkillActionDetail_item__2vEAz"><div class="Item_name__2C42x">Brie Sword +0</div></div>';
        document.body.appendChild(panel);

        return displayEnhancementStats(panel, '/items/brie_sword').then(() => {
            const text = panel.textContent;
            const quoted = text.match(/\+0 → \+1:\s*50%\s*→\s*([\d.]+)%/);
            expect(quoted).toBeTruthy();
            expect(Number(quoted[1])).toBeCloseTo(50 * (1 - 0.5 * (1 - 60 / 100) + 3 / 100), 2);
        });
    });
});
