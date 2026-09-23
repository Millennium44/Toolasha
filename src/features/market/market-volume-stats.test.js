/** @vitest-environment happy-dom
 *
 * Renders the panel against a real DOM (the game's `MarketplacePanel_currentItem`
 * card, minimally reproduced) and a mocked `market-history-api.js`, following
 * the pattern in AGENTS.md ("Testing something that draws"): mock the game and
 * anything reaching storage, drive the pieces directly rather than through
 * timers, and assert nothing failed to draw.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ market_pooledHistory: true, market_volumeStats: true }));

const historyApi = vi.hoisted(() => ({
    rows: null,
    cooldownMs: 0,
    fetchHistory: vi.fn(async () => historyApi.rows),
    currentSource: vi.fn(() => ({ key: 'mooket2', label: 'mooket II (Q7)', hasVolume: true, avgLabel: 'Avg' })),
    cooldownRemainingMs: vi.fn((sourceKey) => (sourceKey === 'mooket2' ? historyApi.cooldownMs : 0)),
}));

const storageMock = vi.hoisted(() => ({
    getJSON: vi.fn(async () => null),
    setJSON: vi.fn(async () => true),
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: (key) => settings[key] } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: vi.fn(() => () => {}) } }));
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('./mooket/market-history-api.js', () => ({ default: historyApi }));

const { default: marketVolumeStats } = await import('./market-volume-stats.js');

/** Builds a minimal stand-in for the game's current-item card, holding one item's sprite `use` and enhancement badge. */
function buildCurrentItem(itemHrid, enhancementLevel = 0) {
    document.body.innerHTML = '';
    const currentItem = document.createElement('div');
    currentItem.className = 'MarketplacePanel_currentItem__abc';
    currentItem.innerHTML = `
        <svg><use href="#${itemHrid.replace('/items/', '')}"></use></svg>
        <div class="Item_enhancementLevel__x">+${enhancementLevel}</div>
    `;
    document.body.appendChild(currentItem);
    // happy-dom's SVGAnimatedString on `use.href` needs `baseVal` to read like the browser's
    const use = currentItem.querySelector('use');
    Object.defineProperty(use, 'href', { value: { baseVal: use.getAttribute('href') } });
    return currentItem;
}

function panelText() {
    return document.querySelector('.mwi-volume-stats')?.textContent ?? '';
}

beforeEach(() => {
    settings.market_pooledHistory = true;
    settings.market_volumeStats = true;
    historyApi.rows = null;
    historyApi.cooldownMs = 0;
    historyApi.fetchHistory.mockClear();
    document.body.innerHTML = '';
});

afterEach(() => {
    marketVolumeStats.disable();
    document.body.innerHTML = '';
});

describe('gating', () => {
    test('nothing is drawn when pooled history is off', async () => {
        settings.market_pooledHistory = false;
        buildCurrentItem('/items/coin');
        await marketVolumeStats.initialize();
        marketVolumeStats.update();
        expect(document.querySelector('.mwi-volume-stats')).toBeNull();
        expect(historyApi.fetchHistory).not.toHaveBeenCalled();
    });

    test('nothing is drawn when the stats setting itself is off', async () => {
        settings.market_volumeStats = false;
        buildCurrentItem('/items/coin');
        await marketVolumeStats.initialize();
        expect(document.querySelector('.mwi-volume-stats')).toBeNull();
        expect(historyApi.fetchHistory).not.toHaveBeenCalled();
    });
});

describe('rendering', () => {
    test('draws the 1d/3d/5d table for a normal fetch', async () => {
        const recentHour = Math.floor(Date.now() / 3600_000) - 1;
        historyApi.rows = [
            { a: 110, b: 90, p: 100, v: 10, time: recentHour * 3600 },
            { a: 110, b: 90, p: 120, v: 5, time: recentHour * 3600 + 10 },
        ];
        buildCurrentItem('/items/coin');
        await marketVolumeStats.initialize();
        marketVolumeStats.currentKey = '/items/coin:0';
        await marketVolumeStats.fetchAndRender(
            document.querySelector('.MarketplacePanel_currentItem__abc'),
            '/items/coin',
            0,
            '/items/coin:0',
            false
        );

        const text = panelText();
        expect(text).not.toContain('could not be drawn');
        expect(text).toContain('1d');
        expect(text).toContain('3d');
        expect(text).toContain('5d');
        expect(text).toContain('Average');
        expect(text).toContain('Bought/Sold');
    });

    test('a fetch that answers null with no active cool-down shows a reachability error, not a blank "no trades"', async () => {
        historyApi.rows = null;
        historyApi.cooldownMs = 0;
        const currentItem = buildCurrentItem('/items/coin');
        await marketVolumeStats.initialize();
        marketVolumeStats.currentKey = '/items/coin:0';
        await marketVolumeStats.fetchAndRender(currentItem, '/items/coin', 0, '/items/coin:0', false);

        expect(panelText()).toContain('could not reach');
    });

    test('a fetch that answers null during a cool-down says so and roughly how long is left', async () => {
        historyApi.rows = null;
        historyApi.cooldownMs = 90_000;
        const currentItem = buildCurrentItem('/items/coin');
        await marketVolumeStats.initialize();
        marketVolumeStats.currentKey = '/items/coin:0';
        await marketVolumeStats.fetchAndRender(currentItem, '/items/coin', 0, '/items/coin:0', false);

        expect(panelText()).toContain('busy');
    });

    test('an item with rows but no real trades says so rather than drawing zeros as data', async () => {
        historyApi.rows = [];
        const currentItem = buildCurrentItem('/items/coin');
        await marketVolumeStats.initialize();
        marketVolumeStats.currentKey = '/items/coin:0';
        await marketVolumeStats.fetchAndRender(currentItem, '/items/coin', 0, '/items/coin:0', false);

        expect(panelText()).toContain('No trades');
    });

    test('a volume-less source (mooket I) hides Volume/Bought-Sold and notes why, without showing zeros as data', async () => {
        historyApi.currentSource.mockReturnValue({
            key: 'mooket1',
            label: 'mooket I (IOMisaka)',
            hasVolume: false,
            avgLabel: 'Mid',
        });
        historyApi.rows = [{ a: 100, b: 80, p: 90, v: 0, time: Math.floor(Date.now() / 1000) - 3600 }];
        const currentItem = buildCurrentItem('/items/coin');
        await marketVolumeStats.initialize();
        marketVolumeStats.currentKey = '/items/coin:0';
        await marketVolumeStats.fetchAndRender(currentItem, '/items/coin', 0, '/items/coin:0', false);

        const text = panelText();
        expect(text).not.toContain('could not be drawn');
        // The note names the hidden columns to explain why they are gone, so it
        // is the header row — not the whole panel's text — that must lack them.
        expect(text).toContain('no volume data');
        const headerCells = [...document.querySelectorAll('.mwi-volume-stats table tr:first-child td')].map(
            (td) => td.textContent
        );
        expect(headerCells).not.toContain('Bought/Sold');
        expect(headerCells).not.toContain('Volume');
        expect(headerCells).toContain('Average');
    });
});

describe('stale response guard', () => {
    test('a slow response for a previously-selected item does not overwrite the current one', async () => {
        const currentItem = buildCurrentItem('/items/coin');
        await marketVolumeStats.initialize();

        let resolveFirst;
        historyApi.fetchHistory.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveFirst = resolve;
                })
        );

        // Select item A: the fetch is left hanging
        marketVolumeStats.currentKey = '/items/coin:0';
        const firstFetch = marketVolumeStats.fetchAndRender(currentItem, '/items/coin', 0, '/items/coin:0', false);

        // The player switches to item B before A's request answers
        historyApi.rows = [{ a: 100, b: 80, p: 90, v: 3, time: Math.floor(Date.now() / 1000) - 3600 }];
        marketVolumeStats.currentKey = '/items/gem:0';
        await marketVolumeStats.fetchAndRender(currentItem, '/items/gem', 0, '/items/gem:0', false);
        const afterB = panelText();

        // A's stale response now arrives
        resolveFirst([{ a: 999, b: 999, p: 999, v: 999, time: Math.floor(Date.now() / 1000) - 3600 }]);
        await firstFetch;

        expect(panelText()).toBe(afterB);
    });

    test('a teardown mid-flight discards the response instead of rendering into a disabled panel', async () => {
        const currentItem = buildCurrentItem('/items/coin');
        await marketVolumeStats.initialize();

        let resolveFetch;
        historyApi.fetchHistory.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveFetch = resolve;
                })
        );
        marketVolumeStats.currentKey = '/items/coin:0';
        const pending = marketVolumeStats.fetchAndRender(currentItem, '/items/coin', 0, '/items/coin:0', false);

        marketVolumeStats.disable();
        resolveFetch([{ a: 100, b: 80, p: 90, v: 3, time: Math.floor(Date.now() / 1000) - 3600 }]);
        await pending;

        expect(document.querySelector('.mwi-volume-stats')).toBeNull();
    });
});
