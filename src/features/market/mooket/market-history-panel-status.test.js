/** @vitest-environment happy-dom
 *
 * The price-history chart draws an empty result for two different reasons
 * that used to look identical: the pool has never seen this item trade, or
 * the shared cool-down engaged and nothing was asked at all. `fetchHistory`
 * answers `null` for both, and the panel used to draw the same blank chart
 * either way with nothing but a console line — invisible to the player — to
 * say which one happened.
 *
 * These tests drive `showItem()` against a real, minimal panel (built with
 * `buildPanel()`, the same as the live panel) and assert the two cases render
 * distinctly: a status line naming the back-off and roughly how long is left,
 * versus the ordinary chart area for a genuinely empty history.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const character = vi.hoisted(() => ({ id: 'market123', mode: 'standard' }));

const storageMock = vi.hoisted(() => ({
    ready: Promise.resolve(true),
    get: async () => null,
    getJSON: async () => null,
    tryGet: async () => ({ found: false, value: null }),
    set: async () => true,
    setJSON: async () => true,
    delete: async () => true,
    getAllKeys: async () => [],
}));

const historyApi = vi.hoisted(() => ({
    rows: null,
    cooldownMs: 0,
    connect: vi.fn(),
    disconnect: vi.fn(),
    report: vi.fn(),
    fetchHistory: vi.fn(async () => historyApi.rows),
    currentSource: vi.fn(() => ({ key: 'mooket2', hasVolume: true, avgLabel: 'Avg' })),
    cooldownRemainingMs: vi.fn((sourceKey) => (sourceKey === 'mooket2' ? historyApi.cooldownMs : 0)),
}));

vi.mock('../../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => character.id,
        getCurrentCharacterGameMode: () => character.mode,
        getItemDetails: () => null,
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../../core/config.js', () => ({ default: { getSetting: () => false, onSettingChange: () => {} } }));
vi.mock('../../../api/marketplace.js', () => ({ default: { on: () => {}, off: () => {}, marketData: {} } }));
vi.mock('../../../utils/cleanup-registry.js', () => ({
    createCleanupRegistry: () => ({
        registerCleanup: () => {},
        registerInterval: () => {},
        registerTimeout: () => {},
        registerListener: () => {},
        cleanupAll: () => {},
    }),
}));
vi.mock('../../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../../utils/mobile.js', () => ({ hasCoarsePointer: () => false }));
vi.mock('./market-price-store.js', () => ({
    default: { initialize: async () => {}, cleanup: () => {}, ingestSnapshot: () => {}, priceFor: () => null },
}));
vi.mock('./market-history-api.js', () => ({ default: historyApi }));

const { default: panel } = await import('./index.js');

beforeEach(() => {
    document.body.innerHTML = '';
    historyApi.rows = null;
    historyApi.cooldownMs = 0;
    historyApi.fetchHistory.mockClear();
    panel.prefs = { x: 20, y: 120, w: 520, h: 300, days: 7, open: true, locked: false, mode: 'iconPrice' };
    panel.watchlist = [];
    panel.watchlistOwner = null;
    panel.current = null;
    panel.shown = null;
    panel.chart = null;
    panel.buildPanel();
});

/** @returns {string} What the status area currently shows, '' when hidden */
function statusText() {
    return panel.historyStatusEl.style.display === 'none' ? '' : panel.historyStatusEl.textContent;
}

describe('a null answer while the shared cool-down is active', () => {
    test('shows a plain status line, with how long is left, in place of the chart', async () => {
        historyApi.rows = null;
        historyApi.cooldownMs = 4 * 60 * 1000 + 10_000; // just over 4 minutes

        await panel.showItem('/items/cheese', 0);

        expect(statusText()).toBe('the shared price-history server is busy; retrying in ~4m');
        expect(panel.canvas.style.display).toBe('none');
    });

    test('does not say “429” or “rate limit” — the panel’s own plain register', async () => {
        historyApi.rows = null;
        historyApi.cooldownMs = 30_000;

        await panel.showItem('/items/cheese', 0);

        const text = statusText();
        expect(text.toLowerCase()).not.toMatch(/429|rate limit/);
        expect(text).not.toMatch(/!/);
    });
});

describe('a genuinely empty history — no cool-down in force', () => {
    test('draws the (empty) chart rather than a status line', async () => {
        historyApi.rows = [];
        historyApi.cooldownMs = 0;

        await panel.showItem('/items/cheese', 0);

        expect(statusText()).toBe('');
        expect(panel.canvas.style.display).toBe('block');
    });

    test('reads distinctly from the back-off case — the two never share a message', async () => {
        historyApi.rows = [];
        historyApi.cooldownMs = 0;
        await panel.showItem('/items/cheese', 0);
        const emptyHistoryText = statusText();

        historyApi.rows = null;
        historyApi.cooldownMs = 60_000;
        panel.shown = null; // force a re-fetch for the "same" item
        await panel.showItem('/items/cheese', 0);
        const backedOffText = statusText();

        expect(emptyHistoryText).toBe('');
        expect(backedOffText).not.toBe('');
        expect(backedOffText).not.toBe(emptyHistoryText);
    });
});

describe('a null answer that is not the cool-down (e.g. a lone network blip)', () => {
    test('draws the chart as before — only the cool-down gets the status line', async () => {
        historyApi.rows = null;
        historyApi.cooldownMs = 0; // fetchHistory failed, but not backed off

        await panel.showItem('/items/cheese', 0);

        expect(statusText()).toBe('');
        expect(panel.canvas.style.display).toBe('block');
    });
});

describe('switching items clears a stale status', () => {
    test('a status shown for one item does not linger once another draws fine', async () => {
        historyApi.rows = null;
        historyApi.cooldownMs = 60_000;
        await panel.showItem('/items/cheese', 0);
        expect(statusText()).not.toBe('');

        historyApi.rows = [{ a: 5, b: 4, p: 4.5, v: 1, time: 1_700_000_000 }];
        historyApi.cooldownMs = 0;
        await panel.showItem('/items/log', 0);

        expect(statusText()).toBe('');
        expect(panel.canvas.style.display).toBe('block');
    });
});
