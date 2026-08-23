/** @vitest-environment happy-dom
 *
 * The protect-from sweep drawn into the enhancing panel.
 *
 * Mock the game, not the panel: a character, an item with one material and a protection item
 * in the slot, prices from a table. What is worth asserting is that the section draws, carries
 * a row per protect-from level for the slot item and for the cheapest alternative, marks the
 * panel's current setting, and stays collapsed until clicked.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as mathjs from 'mathjs';

const state = vi.hoisted(() => ({
    settings: { enhanceSim: true, enhanceSim_autoDetect: false },
    prices: {
        '/items/cheese': 500,
        '/items/mirror_of_protection': 20_000,
        '/items/cheese_sword_protector': 4_000,
        '/items/cheese_sword': 50_000,
    },
    items: {
        '/items/cheese_sword': {
            hrid: '/items/cheese_sword',
            name: 'Cheese Sword',
            itemLevel: 10,
            level: 10,
            enhancementCosts: [{ itemHrid: '/items/cheese', count: 2 }],
            protectionItemHrids: ['/items/cheese_sword_protector'],
        },
        '/items/cheese': { hrid: '/items/cheese', name: 'Cheese', sellPrice: 100 },
        '/items/mirror_of_protection': { hrid: '/items/mirror_of_protection', name: 'Mirror Of Protection' },
        '/items/cheese_sword_protector': { hrid: '/items/cheese_sword_protector', name: 'Cheese Sword Protector' },
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
        experienceBonus: 0,
        rareFindBonus: 0,
        detectedTeaBonus: 0,
        guzzlingBonus: 1,
        teas: { blessed: false },
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

import { displayEnhancementStats, protectSweepHTML } from './enhancement-display.js';
import { clearProtectSweepMemo } from '../../utils/enhancement-protect-sweep.js';

beforeAll(() => {
    globalThis.math = mathjs;
});

beforeEach(() => {
    clearProtectSweepMemo();
    document.body.innerHTML = '';
});

function buildPanel({ target = 5, protectFrom = 3, protection = 'mirror_of_protection' } = {}) {
    const panel = document.createElement('div');
    panel.innerHTML =
        `<div><span>Target Level</span><input type="number" value="${target}"></div>` +
        `<div><span>Protect From Level</span><input type="number" value="${protectFrom}"></div>` +
        `<div class="protectionItemInputContainer">${
            protection ? `<svg><use href="/static/media/items_sprite.abc.svg#${protection}"></use></svg>` : ''
        }</div>`;
    document.body.appendChild(panel);
    return panel;
}

describe('protect-from sweep in the enhancing panel', () => {
    test('draws a collapsed sweep with a row per protect-from level for the slot item and the cheapest alternative', async () => {
        const panel = buildPanel();
        await displayEnhancementStats(panel, '/items/cheese_sword');

        const stats = panel.querySelector('#mwi-enhancement-stats');
        expect(stats).not.toBeNull();
        expect(stats.textContent).not.toContain('failed');

        const section = stats.querySelector('#mwi-enh-protsweep');
        expect(section).not.toBeNull();
        expect(section.style.display).toBe('none');

        const rows = Array.from(stats.querySelectorAll('.mwi-protsweep-row'));
        const none = rows.filter((row) => row.dataset.protectFrom === '0');
        const mirror = rows.filter((row) => row.dataset.item === '/items/mirror_of_protection');
        const protector = rows.filter((row) => row.dataset.item === '/items/cheese_sword_protector');
        expect(none).toHaveLength(1);
        expect(mirror.map((row) => row.dataset.protectFrom)).toEqual(['2', '3', '4', '5']);
        expect(protector.map((row) => row.dataset.protectFrom)).toEqual(['2', '3', '4', '5']);
        expect(stats.textContent).toContain('Mirror Of Protection');
        expect(stats.textContent).toContain('cheapest alternative');

        // The panel's own setting — protect from +3 with the mirror — is the marked row
        const current = rows.filter((row) => row.textContent.includes('◂'));
        expect(current).toHaveLength(1);
        expect(current[0].dataset.protectFrom).toBe('3');
        expect(current[0].dataset.item).toBe('/items/mirror_of_protection');

        // Exactly one cheapest star
        expect(rows.filter((row) => row.textContent.includes('★'))).toHaveLength(1);

        // The header toggles it open
        stats.querySelector('.mwi-enh-toggle[data-target="mwi-enh-protsweep"]').click();
        expect(section.style.display).toBe('');
    });

    test('no target level, no sweep; an empty slot prices the cheapest candidate alone', async () => {
        const noTarget = buildPanel({ target: '' });
        await displayEnhancementStats(noTarget, '/items/cheese_sword');
        expect(noTarget.querySelector('#mwi-enh-protsweep')).toBeNull();

        document.body.innerHTML = '';
        const emptySlot = buildPanel({ protectFrom: 0, protection: null });
        await displayEnhancementStats(emptySlot, '/items/cheese_sword');
        const rows = Array.from(emptySlot.querySelectorAll('.mwi-protsweep-row'));
        expect(
            rows
                .filter((row) => row.dataset.protectFrom !== '0')
                .every((row) => row.dataset.item === '/items/cheese_sword_protector')
        ).toBe(true);
        expect(emptySlot.textContent).toContain('Nothing in the protection slot');
        // No protection is the panel's setting, so the none row is the marked one
        const current = rows.filter((row) => row.textContent.includes('◂'));
        expect(current).toHaveLength(1);
        expect(current[0].dataset.protectFrom).toBe('0');
    });

    test('the spread column says it is approximate, and only the protected rows carry the mark', async () => {
        const panel = buildPanel();
        await displayEnhancementStats(panel, '/items/cheese_sword');
        const stats = panel.querySelector('#mwi-enhancement-stats');

        const header = Array.from(stats.querySelectorAll('th')).find((th) => th.textContent.includes('p10 – p90'));
        expect(header.textContent).toContain('(approx.)');
        expect(header.title).toContain('proportional to attempts');

        const rows = Array.from(stats.querySelectorAll('.mwi-protsweep-row'));
        const spreadCell = (row) => row.children[2];

        const none = rows.find((row) => row.dataset.protectFrom === '0');
        expect(spreadCell(none).textContent).not.toContain('≈');
        expect(spreadCell(none).title).toContain('Exact');

        const protectedRow = rows.find((row) => row.dataset.item === '/items/mirror_of_protection');
        expect(spreadCell(protectedRow).textContent).toContain('≈');
        expect(spreadCell(protectedRow).title).toContain('Approximate');

        expect(stats.textContent).toContain('exact on the "none" row');
    });

    test('protectSweepHTML returns nothing without an item', () => {
        expect(protectSweepHTML({ itemDetails: null, targetLevel: 5 })).toBe('');
    });
});
