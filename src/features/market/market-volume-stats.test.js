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

/** Per-key subscriber lists, so a test can flip a setting and fire the module's own listener. */
const settingChangeCallbacks = vi.hoisted(() => ({}));

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

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings[key],
        onSettingChange: (key, callback) => {
            (settingChangeCallbacks[key] ||= []).push(callback);
            return () => {};
        },
    },
}));

/**
 * Set a setting and fire the module's own `onSettingChange` subscribers for it,
 * the way `config.js` would when the player flips it mid-session.
 * @param {string} key
 * @param {boolean} value
 */
function setSetting(key, value) {
    settings[key] = value;
    for (const callback of settingChangeCallbacks[key] || []) callback(value);
}
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: vi.fn(() => () => {}) } }));
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('./mooket/market-history-api.js', () => ({ default: historyApi }));

const { default: marketVolumeStats } = await import('./market-volume-stats.js');
const { default: domObserver } = await import('../../core/dom-observer.js');
const { getCleanupRegistryCensus } = await import('../../utils/cleanup-registry.js');

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
    domObserver.onClass.mockClear();
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

    test('an item with ask/bid history but no trades in the window still renders the table, not "No trades"', async () => {
        // The live shape a September 2026 probe found: `/items/furious_spear`
        // level 10's order book (Ask 1280M, several bids) has 120 rows of
        // ask/bid with p and v both 0 on every one — no trade to report, but
        // very much not "no history".
        const recentHour = Math.floor(Date.now() / 3600_000) - 1;
        historyApi.rows = [
            { a: 620_000_000, b: 600_000_000, p: 0, v: 0, time: recentHour * 3600 },
            { a: 630_000_000, b: 610_000_000, p: 0, v: 0, time: recentHour * 3600 + 10 },
        ];
        const currentItem = buildCurrentItem('/items/furious_spear', 10);
        await marketVolumeStats.initialize();
        marketVolumeStats.currentKey = '/items/furious_spear:10';
        await marketVolumeStats.fetchAndRender(
            currentItem,
            '/items/furious_spear',
            10,
            '/items/furious_spear:10',
            false
        );

        const text = panelText();
        expect(text).not.toContain('No trades in this window');
        expect(text).not.toContain('could not be drawn');
        expect(text).toContain('1d');
        // The per-window note names which windows had nothing traded
        expect(text).toContain('no trades');
        expect(text).toContain('ask/bid only');
        // Ask/bid mid fallback for Average/Median, "—/—" (no basis) for Min/Max,
        // not a zero read as real data.
        const rows = [...document.querySelectorAll('.mwi-volume-stats table tr')].map((tr) =>
            [...tr.querySelectorAll('td')].map((td) => td.textContent)
        );
        const oneDayRow = rows.find((r) => r[0] === '1d');
        const [, avgCell, medianCell, volumeCell, buySellCell, minMaxCell] = oneDayRow;
        expect(avgCell).toBe('615M');
        expect(medianCell).toBe('615M');
        expect(volumeCell).toBe('0');
        expect(buySellCell).toBe('0/0');
        expect(minMaxCell).toBe('—/—');
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

    test('an enhancement badge that settles without ever inserting a node is still picked up, not left on the first read forever', async () => {
        // `domObserver` (src/core/dom-observer.js) only watches `addedNodes` —
        // it has no `attributes: true` anywhere. Direct in-page navigation to an
        // equipment item reuses the existing current-item node and updates the
        // enhancement-level badge's *text* in place once the tile finishes
        // rendering, which produces no mutation this module's observer would
        // ever see. A pop-out/tab view paints the badge once on first mount and
        // has no such gap, which is why only direct navigation showed the
        // stall. Without the bounded settle-check re-running `update()`, this
        // module would stay on whatever it first read (or whatever that first,
        // possibly-discarded fetch produced) forever.
        vi.useFakeTimers();
        try {
            const currentItem = buildCurrentItem('/items/stalactite_spear', 0);
            currentItem.querySelector('[class*="Item_enhancementLevel"]').remove();
            await marketVolumeStats.initialize();

            historyApi.rows = [{ a: 110, b: 90, p: 100, v: 10, time: Math.floor(Date.now() / 1000) - 3600 }];
            marketVolumeStats.update();
            await vi.advanceTimersByTimeAsync(0);
            expect(marketVolumeStats.currentKey).toBe('/items/stalactite_spear:0');

            // The badge settles by mutating existing text -- no added node, so
            // domObserver's `MarketplacePanel_orderBooksContainer` watch never
            // fires again for this.
            const badge = document.createElement('div');
            badge.className = 'Item_enhancementLevel__x';
            badge.textContent = '+20';
            currentItem.appendChild(badge);

            // Nothing but the bounded settle-check will ever call `update()` again.
            await vi.advanceTimersByTimeAsync(500);

            expect(marketVolumeStats.currentKey).toBe('/items/stalactite_spear:20');
            expect(panelText()).not.toContain('Loading');
            expect(panelText()).toContain('1d');
        } finally {
            vi.useRealTimers();
        }
    });

    test('a response discarded while `currentKey` was briefly elsewhere does not leave the panel stuck on Loading forever', async () => {
        // The exact shape the maintainer traced through: `currentKey` moves
        // away and back before a request answers (the current-item element
        // briefly vanishing mid-render and reappearing on the same item and
        // level is one way this happens; `removePanel()` nulling `currentKey`
        // is the specific path in `update()`). `fetchAndRender`'s guard
        // correctly discards the response, since it no longer matches what is
        // current at the moment it checks — but once `currentKey` settles back
        // to that same key, nothing else was ever going to fetch it again.
        const currentItem = buildCurrentItem('/items/stalactite_spear', 0);
        await marketVolumeStats.initialize();
        marketVolumeStats.currentKey = '/items/stalactite_spear:0';

        let resolveFetch;
        historyApi.fetchHistory.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveFetch = resolve;
                })
        );
        const pending = marketVolumeStats.fetchAndRender(
            currentItem,
            '/items/stalactite_spear',
            0,
            '/items/stalactite_spear:0',
            false
        );
        expect(panelText()).toContain('Loading');

        marketVolumeStats.currentKey = '/items/other:0';
        resolveFetch([{ a: 999, b: 999, p: 999, v: 999, time: Math.floor(Date.now() / 1000) - 3600 }]);
        await pending;
        marketVolumeStats.currentKey = '/items/stalactite_spear:0';
        expect(panelText()).toContain('Loading'); // discarded: nothing rendered for it yet

        // The observer fires again for this exact, unchanged key (an order-book
        // mutation, say). Pre-fix, `update()` sees `key === currentKey` and
        // simply reattaches this same stale "Loading" panel, forever.
        historyApi.rows = [{ a: 110, b: 90, p: 100, v: 10, time: Math.floor(Date.now() / 1000) - 3600 }];
        marketVolumeStats.update();
        await vi.waitFor(() => expect(panelText()).toContain('1d'));
        expect(panelText()).not.toContain('Loading');
    });
});

describe('navigating from "View All Enhancement Levels"', () => {
    test('picking a level from the all-levels list reuses the same card — no added node for domObserver to see — and is still picked up', async () => {
        // On live, an equipment order book reached by opening "View All
        // Enhancement Levels" and then clicking one level reuses the same
        // current-item card and order-book container the list itself was
        // already showing: only the icon's `<use>` href and the
        // enhancement-level badge *text* change in place. `domObserver`
        // dispatches on `addedNodes` only (its mock here always returns a
        // no-op unregister, standing in for that), so nothing in this test
        // ever calls `scheduleUpdate()` through that channel after the first
        // mount — only `watchItemChanges()`'s own `MutationObserver` can pick
        // this up.
        const currentItem = buildCurrentItem('/items/furious_spear', 0);
        await marketVolumeStats.initialize();

        historyApi.rows = [
            { a: 620_000_000, b: 600_000_000, p: 600_000_000, v: 1, time: Math.floor(Date.now() / 1000) - 3600 },
        ];
        // Stand-in for the initial mount's own `addedNodes` mutation, the one
        // real event this module ever gets from `domObserver` for this card.
        marketVolumeStats.update();
        await vi.waitFor(() => expect(marketVolumeStats.currentKey).toBe('/items/furious_spear:0'));

        // Picking level 10 from the all-levels list: same node, same href
        // target item, only the badge text changes.
        historyApi.rows = [
            { a: 1_280_000_000, b: 1_200_000_000, p: 0, v: 0, time: Math.floor(Date.now() / 1000) - 3600 },
        ];
        currentItem.querySelector('[class*="Item_enhancementLevel"]').textContent = '+10';

        await vi.waitFor(() => expect(marketVolumeStats.currentKey).toBe('/items/furious_spear:10'));
        expect(panelText()).not.toContain('Loading');
    });

    test('switching to a different item entirely through the same reused card is also picked up', async () => {
        const currentItem = buildCurrentItem('/items/furious_spear', 0);
        await marketVolumeStats.initialize();
        historyApi.rows = [{ a: 100, b: 80, p: 90, v: 3, time: Math.floor(Date.now() / 1000) - 3600 }];
        marketVolumeStats.update();
        await vi.waitFor(() => expect(marketVolumeStats.currentKey).toBe('/items/furious_spear:0'));

        // The item icon's `<use>` href swaps in place, no node added/removed.
        // The attribute itself is what the observer watches; `href.baseVal` is
        // the fixed stand-in object `buildCurrentItem` gave it for happy-dom
        // (see there) and is mutated the same way the browser's own
        // `SVGAnimatedString` would reflect the attribute change.
        const use = currentItem.querySelector('use');
        use.setAttribute('href', '#coin');
        use.href.baseVal = '#coin';

        await vi.waitFor(() => expect(marketVolumeStats.currentKey).toBe('/items/coin:0'));
    });
});

describe('panel placement', () => {
    test('the panel is an absolutely-positioned overlay anchored to the item card, adding no height to the page', async () => {
        document.body.innerHTML = '';
        const infoContainer = document.createElement('div');
        infoContainer.className = 'MarketplacePanel_infoContainer__q';

        const currentItem = document.createElement('div');
        currentItem.className = 'MarketplacePanel_currentItem__abc';
        currentItem.innerHTML = `<svg><use href="#coin"></use></svg>`;
        const use = currentItem.querySelector('use');
        Object.defineProperty(use, 'href', { value: { baseVal: use.getAttribute('href') } });

        const range = document.createElement('div');
        range.className = 'MarketplacePanel_tradableRange__z';
        range.textContent = 'Tradable range: 100 - 200';

        infoContainer.append(currentItem, range);
        document.body.appendChild(infoContainer);

        historyApi.rows = [{ a: 110, b: 90, p: 100, v: 10, time: Math.floor(Date.now() / 1000) - 3600 }];
        await marketVolumeStats.initialize();
        marketVolumeStats.currentKey = '/items/coin:0';
        await marketVolumeStats.fetchAndRender(currentItem, '/items/coin', 0, '/items/coin:0', false);

        const panel = document.querySelector('.mwi-volume-stats');
        expect(panel).not.toBeNull();
        // A child of the item card, absolutely positioned over its top-right
        // corner: it never pushes the "Tradable range" line (or anything else
        // in the info container) down, unlike the in-flow grid placement this
        // replaces.
        expect(currentItem.contains(panel)).toBe(true);
        expect(panel.style.position).toBe('absolute');
        expect(range.previousElementSibling).toBe(currentItem);
    });

    test('re-attaching does not duplicate the panel or leave a stray copy elsewhere', async () => {
        document.body.innerHTML = '';
        const currentItem = document.createElement('div');
        currentItem.className = 'MarketplacePanel_currentItem__abc';
        currentItem.innerHTML = `<svg><use href="#coin"></use></svg>`;
        const use = currentItem.querySelector('use');
        Object.defineProperty(use, 'href', { value: { baseVal: use.getAttribute('href') } });
        document.body.appendChild(currentItem);

        historyApi.rows = [{ a: 110, b: 90, p: 100, v: 10, time: Math.floor(Date.now() / 1000) - 3600 }];
        await marketVolumeStats.initialize();
        marketVolumeStats.currentKey = '/items/coin:0';
        await marketVolumeStats.fetchAndRender(currentItem, '/items/coin', 0, '/items/coin:0', false);
        marketVolumeStats.attachPanel(currentItem);

        expect(document.querySelectorAll('.mwi-volume-stats')).toHaveLength(1);
    });
});

describe('mid-session live start', () => {
    test('turning Price History on after a start with it off initializes the module without a reload', async () => {
        settings.market_pooledHistory = false;
        buildCurrentItem('/items/coin');
        await marketVolumeStats.initialize();
        expect(marketVolumeStats.isInitialized).toBe(false);
        expect(document.querySelector('.mwi-volume-stats')).toBeNull();

        setSetting('market_pooledHistory', true);
        // The listener's own `initialize()` call is async (it awaits column
        // prefs); let it finish.
        await Promise.resolve();
        await Promise.resolve();

        expect(marketVolumeStats.isInitialized).toBe(true);
    });

    test('turning either gating setting off stops the module cleanly', async () => {
        buildCurrentItem('/items/coin');
        await marketVolumeStats.initialize();
        expect(marketVolumeStats.isInitialized).toBe(true);

        setSetting('market_volumeStats', false);

        expect(marketVolumeStats.isInitialized).toBe(false);
        expect(document.querySelector('.mwi-volume-stats')).toBeNull();
    });
});

describe('fitting beside the Buy button', () => {
    const rect = (left, top, width, height) => ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
    });

    const setup = (buyLeft) => {
        const row = document.createElement('div');
        row.className = 'MarketplacePanel_newListingButtonsContainer__x';
        const sell = document.createElement('button');
        const buy = document.createElement('button');
        row.append(sell, buy);
        const panel = document.createElement('div');
        panel.className = 'mwi-volume-stats';
        document.body.append(row, panel);
        panel.getBoundingClientRect = () => rect(100, 0, 400, 100);
        buy.getBoundingClientRect = () => rect(buyLeft, 60, 120, 30);
        return panel;
    };

    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('scales the overlay down so it stops short of the Buy button', () => {
        // 400 wide from x=100 would reach 500; the Buy button starts at 400
        const panel = setup(400);
        marketVolumeStats.fitPanel(panel);
        expect(panel.style.transform).toBe('scale(0.730)');
        expect(panel.style.transformOrigin).toBe('top left');
    });

    test('leaves a wide layout untouched', () => {
        const panel = setup(700);
        marketVolumeStats.fitPanel(panel);
        expect(panel.style.transform).toBe('');
    });

    test('never shrinks below the readable minimum', () => {
        const panel = setup(150);
        marketVolumeStats.fitPanel(panel);
        expect(panel.style.transform).toBe('scale(0.550)');
    });
});

describe('watchPanelFit teardown bookkeeping', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    /** A fresh info-container + overlay pair, the way React re-creates them on every item change */
    function newArea() {
        const area = document.createElement('div');
        area.className = 'MarketplacePanel_infoContainer__x';
        const panel = document.createElement('div');
        panel.className = 'mwi-volume-stats';
        area.appendChild(panel);
        document.body.appendChild(area);
        return panel;
    }

    test('watching several distinct areas across a session registers only one teardown cleanup', () => {
        const before = getCleanupRegistryCensus().cleanups;

        // Five item changes, each swapping in a brand-new info-container node —
        // exactly what watchPanelFit() sees on every renderTable() in real use.
        for (let i = 0; i < 5; i++) {
            marketVolumeStats.watchPanelFit(newArea());
        }

        // Before the fix, every distinct area pushed its own customCleanup closure
        // into the registry, growing it without bound for the life of the tab.
        expect(getCleanupRegistryCensus().cleanups - before).toBe(1);
    });

    test('disable() lets a later watch register its cleanup again', () => {
        marketVolumeStats.watchPanelFit(newArea());
        const afterFirstWatch = getCleanupRegistryCensus().cleanups;

        marketVolumeStats.disable();
        expect(getCleanupRegistryCensus().cleanups).toBe(afterFirstWatch - 1);

        marketVolumeStats.watchPanelFit(newArea());
        expect(getCleanupRegistryCensus().cleanups).toBe(afterFirstWatch);
    });
});

describe('concurrent initialize() calls', () => {
    test('two calls before loadColumnPrefs resolves register the order-book observer once', async () => {
        let release;
        storageMock.getJSON.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(null);
                })
        );
        buildCurrentItem('/items/coin');

        const first = marketVolumeStats.initialize();
        const second = marketVolumeStats.initialize();
        release();
        await Promise.all([first, second]);

        expect(domObserver.onClass).toHaveBeenCalledTimes(1);
        expect(marketVolumeStats.isInitialized).toBe(true);
    });

    test('disable() during an in-flight initialize() ends disabled, and a later call still works', async () => {
        let release;
        storageMock.getJSON.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(null);
                })
        );
        buildCurrentItem('/items/coin');

        const pending = marketVolumeStats.initialize();
        marketVolumeStats.disable();
        release();
        await pending;

        expect(marketVolumeStats.isInitialized).toBe(false);
        expect(domObserver.onClass).not.toHaveBeenCalled();

        await marketVolumeStats.initialize();
        expect(marketVolumeStats.isInitialized).toBe(true);
        expect(domObserver.onClass).toHaveBeenCalledTimes(1);
    });
});
