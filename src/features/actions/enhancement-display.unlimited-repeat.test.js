/** @vitest-environment happy-dom
 *
 * The enhancing panel's own "Repeat ∞" estimate.
 *
 * The general action panel and the alchemy panel already show the materials-bounded time a
 * "Repeat ∞" run would actually take, both built from the one shared calculator in
 * `unlimited-action-estimate.js` (`estimateUnlimitedAction`, wrapping
 * `calculateSingleQueueActionTime`). The enhancing panel was left out on purpose: its synthetic
 * action object carried no `enhancingMaxLevel` / `enhancingProtectionMinLevel` /
 * `enhancingProtectionItemHrid`, so `calculateEnhancingQueueTime` always bailed out and the
 * shared estimate always came back truly infinite for it.
 *
 * This drives the real panel (`displayEnhancementStats`) and the real arithmetic
 * (`calculateEnhancingQueueTime`, `calculateMaterialLimit`'s enhancing branch,
 * `getEnhancingProtectionDraw`) — nothing here is a hardcoded string. `timeReadable` is
 * imported for real and used to compute the expected text, the same way
 * `unlimited-action-estimate.test.js` does for the other two panels.
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as mathjs from 'mathjs';
import { timeReadable } from '../../utils/formatters.js';

const state = vi.hoisted(() => ({
    settings: { enhanceSim: true, enhanceSim_autoDetect: false, actionPanel_enhanceMatLimitProtections: true },
    prices: {},
    items: {
        '/items/cheese_sword': {
            hrid: '/items/cheese_sword',
            name: 'Cheese Sword',
            itemLevel: 10,
            level: 10,
            enhancementCosts: [{ itemHrid: '/items/cheese', count: 2 }],
        },
        '/items/cheese': { hrid: '/items/cheese', name: 'Cheese', sellPrice: 100 },
        '/items/mirror_of_protection': { hrid: '/items/mirror_of_protection', name: 'Mirror Of Protection' },
        '/items/philosophers_mirror': { hrid: '/items/philosophers_mirror', name: "Philosopher's Mirror" },
    },
    actionDetails: {
        '/actions/enhancing/enhance': {
            hrid: '/actions/enhancing/enhance',
            type: '/action_types/enhancing',
            baseTimeCost: 12e9,
        },
    },
    currentActions: [],
    inventory: [],
    predictions: null,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => state.settings[key] ?? false,
        getSettingValue: (key, fallback) => state.settings[key] ?? fallback,
        toggleSetting: () => {},
        onSettingChange: () => () => {},
        onSettingsLoaded: () => () => {},
        getPricingModeDisplayLabel: (mode) => `label:${mode}`,
        COLOR_XP_RATE: '#ffdd88',
        COLOR_TOOLTIP_INFO: '#abc',
        COLOR_TEXT_PRIMARY: '#fff',
        COLOR_TEXT_SECONDARY: '#888',
        COLOR_INFO: '#09f',
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap: state.items }),
        getItemDetails: (hrid) => state.items[hrid] || null,
        getActionDetails: (hrid) => state.actionDetails[hrid] ?? null,
        getCurrentActions: () => state.currentActions,
        getInventory: () => state.inventory,
        getPersonalBuffFlatBoost: () => 0,
        getActionDrinkSlots: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        getSkills: () => [],
        getEquipment: () => [],
        on: () => () => {},
        off: () => {},
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, register: () => () => {} },
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
    default: { getPrice: () => null, isLoaded: () => true, on: () => () => {} },
}));

vi.mock('../../utils/profit-helpers.js', () => ({
    resolveItemPrice: (hrid) => ({ price: state.prices[hrid] || 0, custom: false, missing: !state.prices[hrid] }),
}));

vi.mock('../../utils/tester-shop.js', () => ({
    testerShopEnabled: () => false,
    testerGearPrice: () => null,
    MIRROR_HRID: '/items/philosophers_mirror',
}));

vi.mock('../../utils/bundle-bridge.js', () => ({
    missingMaterialsButton: () => null,
    loadoutSnapshot: () => null,
    combatSimUI: () => null,
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({ actionTime: 10, totalEfficiency: 0 }),
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        calculate: async () => null,
        calculateCoinifyProfit: () => null,
        calculateDecomposeProfit: () => null,
        calculateTransmuteProfit: () => null,
    },
}));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => state.predictions }));

const { default: actionTimeDisplay } = await import('./action-time-display.js');
const { displayEnhancementStats } = await import('./enhancement-display.js');
const { clearUnlimitedEstimateCache } = await import('./unlimited-action-estimate.js');

beforeAll(() => {
    globalThis.math = mathjs;
});

beforeEach(() => {
    document.body.innerHTML = '';
    clearUnlimitedEstimateCache();
    state.settings = { enhanceSim: true, enhanceSim_autoDetect: false, actionPanel_enhanceMatLimitProtections: true };
    state.currentActions = [];
    state.predictions = null;
});

afterEach(() => {
    clearUnlimitedEstimateCache();
    vi.useRealTimers();
});

/** Inventory rows in the one location the lookup counts */
function stack(itemHrid, count) {
    return { itemHrid, count, enhancementLevel: 0, itemLocationHrid: '/item_locations/inventory' };
}

/**
 * The enhancing panel's own DOM shape: a Target Level input, a Protect From Level input, a
 * Repeat input, and (optionally) a protection item in the protection slot.
 */
function buildPanel({ target = '', protectFrom = 0, protection = null, repeat = '∞' } = {}) {
    const panel = document.createElement('div');
    panel.innerHTML =
        `<div><span>Target Level</span><input type="number" value="${target}"></div>` +
        `<div><span>Protect From Level</span><input type="number" value="${protectFrom}"></div>` +
        `<div><span>Repeat</span><input type="text" value="${repeat}"></div>` +
        `<div class="protectionItemInputContainer">${
            protection ? `<svg><use href="/static/media/items_sprite.abc.svg#${protection}"></use></svg>` : ''
        }</div>`;
    document.body.appendChild(panel);
    return panel;
}

/** The "Repeat ∞" banner's value line, or null when the banner was not drawn. */
function repeatLine(stats) {
    const divs = Array.from(stats.querySelectorAll('div'));
    const heading = divs.find((d) => d.children.length === 0 && d.textContent === 'Repeat ∞');
    if (!heading) return null;
    return heading.nextElementSibling?.textContent ?? null;
}

describe('the enhancing panel draws the bounded time', () => {
    test('Repeat ∞ shows the materials-bounded time and attempt count', async () => {
        state.inventory = [stack('/items/cheese', 40)];
        state.predictions = { expectedAttempts: 34, expectedProtections: 0, perActionTime: 10, successMultiplier: 1 };
        const panel = buildPanel({ target: 5, repeat: '∞' });

        await displayEnhancementStats(panel, '/items/cheese_sword');

        const stats = panel.querySelector('#mwi-enhancement-stats');
        expect(stats).not.toBeNull();
        expect(stats.textContent).not.toContain('failed');

        // 40 cheese / 2 per attempt = 20 affordable, below the 34 expected attempts, at 10s each
        const expected = `To +5: ${timeReadable(200)} · 20 attempts`;
        expect(repeatLine(stats)).toBe(expected);
        // The banner's own heading reads "Repeat ∞"; only the bounded value line itself must
        // never read a bare, unsupported "∞".
        expect(repeatLine(stats)).not.toBe('∞');
    });

    test('a finite Repeat draws no banner at all', async () => {
        state.inventory = [stack('/items/cheese', 40)];
        state.predictions = { expectedAttempts: 34, expectedProtections: 0, perActionTime: 10, successMultiplier: 1 };
        const panel = buildPanel({ target: 5, repeat: '10' });

        await displayEnhancementStats(panel, '/items/cheese_sword');

        const stats = panel.querySelector('#mwi-enhancement-stats');
        expect(stats.textContent).not.toContain('Repeat ∞');
    });
});

describe('a genuine infinity stays honest', () => {
    test('Repeat ∞ with no Target Level set prints ∞, not a fabricated time', async () => {
        state.inventory = [stack('/items/cheese', 40)];
        const panel = buildPanel({ target: '', repeat: '∞' });

        await displayEnhancementStats(panel, '/items/cheese_sword');

        const stats = panel.querySelector('#mwi-enhancement-stats');
        expect(repeatLine(stats)).toBe('∞');
    });
});

describe('the ~ marker', () => {
    test('a limit resting on the expected protection draw is marked', async () => {
        // The protection item binds: 3 in the bag at ~2 draws per 12 attempts pays for 18,
        // fewer than the 12 attempts the climb expects — so the estimate itself never has to
        // reach the protection ceiling for it to still be marked, because the marker tracks
        // whether the ceiling it was compared against rested on an estimate, not whether that
        // ceiling ended up binding.
        state.inventory = [stack('/items/cheese', 1000), stack('/items/mirror_of_protection', 3)];
        state.predictions = { expectedAttempts: 12, expectedProtections: 2, perActionTime: 10, successMultiplier: 1 };
        const panel = buildPanel({ target: 10, protectFrom: 5, protection: 'mirror_of_protection', repeat: '∞' });

        await displayEnhancementStats(panel, '/items/cheese_sword');

        const stats = panel.querySelector('#mwi-enhancement-stats');
        const expected = `To +10: ${timeReadable(120)} · ~12 attempts`;
        expect(repeatLine(stats)).toBe(expected);
    });

    test('no protection configured leaves the figure unmarked', async () => {
        state.inventory = [stack('/items/cheese', 40)];
        state.predictions = { expectedAttempts: 34, expectedProtections: 0, perActionTime: 10, successMultiplier: 1 };
        const panel = buildPanel({ target: 5, protectFrom: 0, protection: null, repeat: '∞' });

        await displayEnhancementStats(panel, '/items/cheese_sword');

        const stats = panel.querySelector('#mwi-enhancement-stats');
        expect(repeatLine(stats)).not.toContain('~');
    });
});

describe('redraw cost', () => {
    test('one inventory walk serves the panel, and repeated re-renders inside the throttle window reuse it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T10:00:00'));
        state.inventory = [stack('/items/cheese', 40)];
        state.predictions = { expectedAttempts: 34, expectedProtections: 0, perActionTime: 10, successMultiplier: 1 };
        const panel = buildPanel({ target: 5, repeat: '∞' });
        const walk = vi.spyOn(actionTimeDisplay, 'buildInventoryLookup');

        await displayEnhancementStats(panel, '/items/cheese_sword');
        await displayEnhancementStats(panel, '/items/cheese_sword');
        await displayEnhancementStats(panel, '/items/cheese_sword');

        expect(walk).toHaveBeenCalledTimes(1);

        const stats = panel.querySelector('#mwi-enhancement-stats');
        expect(repeatLine(stats)).toBe(`To +5: ${timeReadable(200)} · 20 attempts`);

        walk.mockRestore();
    });
});
