/**
 * The Alchemy History window: one tab in the alchemy panel and one modal with a
 * switcher between transmute, coinify and decompose, each pane drawn by its own
 * viewer. A type whose history setting is off is absent; the type last picked
 * is remembered.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const INPUT_HRID = '/items/gem';
const OUTPUT_HRID = '/items/dust';
const PRIME_HRID = '/items/prime_catalyst';

const mocks = vi.hoisted(() => ({
    store: new Map(),
    settings: {},
    sessions: { transmute: [], coinify: [], decompose: [] },
    loaders: {},
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, store, fallback) => {
            const k = `${store}:${key}`;
            return mocks.store.has(k) ? mocks.store.get(k) : fallback;
        },
        set: async (key, value, store) => {
            mocks.store.set(`${store}:${key}`, value);
            return true;
        },
    },
}));

/**
 * @param {string} type
 * @returns {Promise<Array<Object>>}
 */
function loadSessions(type) {
    if (mocks.loaders[type]) return mocks.loaders[type]();
    return Promise.resolve(mocks.sessions[type]);
}

vi.mock('./transmute-history-tracker.js', () => ({
    transmuteHistoryTracker: { loadSessions: () => loadSessions('transmute') },
}));
vi.mock('./coinify-history-tracker.js', () => ({
    coinifyHistoryTracker: { loadSessions: () => loadSessions('coinify') },
}));
vi.mock('./decompose-history-tracker.js', () => ({
    decomposeHistoryTracker: { loadSessions: () => loadSessions('decompose') },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => mocks.settings[key] !== false,
        getSettingValue: (_key, fallback) => fallback,
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
    },
}));

vi.mock('../../utils/market-data.js', () => {
    const prices = { [INPUT_HRID]: 500, [OUTPUT_HRID]: 1000, [PRIME_HRID]: 300 };
    return {
        getItemPrice: (hrid) => prices[hrid] ?? null,
        getItemPriceInfo: (hrid) => {
            const price = prices[hrid] ?? null;
            return { price, source: price === null ? null : 'book', estimated: false };
        },
        getItemPrices: () => null,
        getPricingMode: () => 'ask',
    };
});

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        getItemDetails: (hrid) => ({
            name: hrid.split('/').pop(),
            itemLevel: 10,
            sellPrice: 1000,
            alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: '/items/dust', count: 1 }] },
        }),
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));

const { transmuteHistoryViewer } = await import('./transmute-history-viewer.js');
const { coinifyHistoryViewer } = await import('./coinify-history-viewer.js');
const { decomposeHistoryViewer } = await import('./decompose-history-viewer.js');
const { alchemyHistoryViewer, LAST_TYPE_STORAGE_KEY } = await import('./alchemy-history-viewer.js');

const VIEWERS = {
    transmute: transmuteHistoryViewer,
    coinify: coinifyHistoryViewer,
    decompose: decomposeHistoryViewer,
};

const SETTING_KEYS = {
    transmute: 'alchemy_transmuteHistory',
    coinify: 'alchemy_coinifyHistory',
    decompose: 'alchemy_decomposeHistory',
};

/**
 * @param {Object} overrides
 * @returns {Object} A session every type's viewer can read
 */
function session(overrides = {}) {
    return {
        id: 's1',
        startTime: Date.UTC(2026, 8, 20),
        trackerVersion: 2,
        inputItemHrid: INPUT_HRID,
        enhancementLevel: 0,
        bulkMultiplier: 1,
        totalAttempts: 10,
        totalSuccesses: 8,
        totalCoinsEarned: 8000,
        results: { [OUTPUT_HRID]: { count: 8, totalValue: 8000, priceEach: 1000 } },
        catalystsUsed: { [PRIME_HRID]: 8 },
        catalystOfDecompositionUsed: 0,
        catalystOfCoinificationUsed: 0,
        primeCatalystUsed: 8,
        ...overrides,
    };
}

/** Build the game's alchemy tab bar. @returns {HTMLElement} */
function buildAlchemyTablist() {
    const tablist = document.createElement('div');
    tablist.setAttribute('role', 'tablist');
    for (const label of ['Coinify', 'Decompose', 'Transmute', 'Unrefine', 'Current Action']) {
        const tab = document.createElement('button');
        tab.setAttribute('role', 'tab');
        tab.textContent = label;
        tablist.appendChild(tab);
    }
    document.body.appendChild(tablist);
    return tablist;
}

function initializeAll() {
    for (const viewer of Object.values(VIEWERS)) viewer.initialize();
}

function disableAll() {
    for (const viewer of Object.values(VIEWERS)) viewer.disable();
}

/** @returns {HTMLElement|null} */
function historyTab() {
    return document.querySelector('[data-mwi-alchemy-history-tab="true"]');
}

/** @returns {Array<string>} The switcher's button labels */
function switcherLabels() {
    const switcher = alchemyHistoryViewer.modal.querySelector('.mwi-alchemy-history-switcher');
    if (switcher.style.display === 'none') return [];
    return Array.from(switcher.querySelectorAll('button')).map((btn) => btn.textContent);
}

/** @returns {Array<string>} Types whose pane is on screen */
function visiblePanes() {
    const host = alchemyHistoryViewer.modal.querySelector('.mwi-alchemy-history-panes');
    return Array.from(host.children)
        .filter((pane) => pane.style.display !== 'none')
        .map((pane) => pane.dataset.mwiAlchemyHistoryType);
}

/** @returns {string} */
function title() {
    return alchemyHistoryViewer.modal.querySelector('.mwi-alchemy-history-title').textContent;
}

/**
 * Click a switcher button and wait for its type to draw.
 * @param {string} type
 */
async function pick(type) {
    const btn = alchemyHistoryViewer.modal.querySelector(`[data-mwi-alchemy-history-switch="${type}"]`);
    btn.click();
    await vi.waitFor(() => expect(alchemyHistoryViewer.activeType).toBe(type));
}

let tablist;
let errorSpy;

beforeEach(() => {
    mocks.store.clear();
    mocks.settings = {};
    mocks.loaders = {};
    mocks.sessions = {
        transmute: [session({ id: 't1' })],
        coinify: [session({ id: 'c1' })],
        decompose: [session({ id: 'd1' })],
    };
    tablist = buildAlchemyTablist();
    errorSpy = vi.spyOn(console, 'error');
});

afterEach(() => {
    disableAll();
    tablist.remove();
    document.body.innerHTML = '';
    errorSpy.mockRestore();
});

describe('Alchemy History tab', () => {
    test('one tab replaces the three per-type tabs', () => {
        initializeAll();

        expect(document.querySelectorAll('[data-mwi-alchemy-history-tab="true"]')).toHaveLength(1);
        expect(historyTab().textContent).toBe('Alchemy History');
        for (const old of ['transmute', 'coinify', 'decompose']) {
            expect(document.querySelector(`[data-mwi-${old}-history-tab]`)).toBeNull();
        }
        const labels = Array.from(tablist.children).map((tab) => tab.textContent);
        expect(labels.filter((label) => label.includes('History'))).toEqual(['Alchemy History']);
    });

    test('the tab stays while any type is on and goes with the last one', () => {
        initializeAll();
        transmuteHistoryViewer.disable();
        coinifyHistoryViewer.disable();
        expect(historyTab()).not.toBeNull();

        decomposeHistoryViewer.disable();
        expect(historyTab()).toBeNull();
        expect(alchemyHistoryViewer.modal).toBeNull();
        expect(alchemyHistoryViewer.tabWatcher).toBeNull();
    });

    test('no tab when every type is off', () => {
        mocks.settings = {
            alchemy_transmuteHistory: false,
            alchemy_coinifyHistory: false,
            alchemy_decomposeHistory: false,
        };
        initializeAll();

        expect(historyTab()).toBeNull();
    });

    test('clicking the tab opens the window', async () => {
        initializeAll();
        historyTab().click();

        await vi.waitFor(() => expect(alchemyHistoryViewer.isOpen()).toBe(true));
        expect(title()).toBe('Transmute History');
    });
});

describe('Alchemy History switcher', () => {
    test.each(['transmute', 'coinify', 'decompose'])('the %s pane draws its sessions', async (type) => {
        initializeAll();
        await alchemyHistoryViewer.openModal();
        if (alchemyHistoryViewer.activeType !== type) await pick(type);

        expect(visiblePanes()).toEqual([type]);
        expect(title()).toBe(`${type[0].toUpperCase()}${type.slice(1)} History`);
        const pane = VIEWERS[type].modal;
        expect(pane.querySelectorAll(`.mwi-${type}-history-table-container tbody tr`)).toHaveLength(1);
        expect(pane.querySelector(`.mwi-${type}-history-totals-container`).textContent).not.toBe('');
        expect(pane.querySelector(`.mwi-${type}-history-controls`).children.length).toBeGreaterThan(0);
        expect(alchemyHistoryViewer.modal.textContent).not.toContain('could not be drawn');
        expect(errorSpy).not.toHaveBeenCalled();
    });

    test('lists every enabled type in order, and marks the one showing', async () => {
        initializeAll();
        await alchemyHistoryViewer.openModal();

        expect(switcherLabels()).toEqual(['Transmute', 'Coinify', 'Decompose']);
        const pressed = alchemyHistoryViewer.modal.querySelector('[aria-pressed="true"]');
        expect(pressed.dataset.mwiAlchemyHistorySwitch).toBe('transmute');
    });

    test.each(['transmute', 'coinify', 'decompose'])('a type whose setting is off is absent: %s', async (off) => {
        mocks.settings = { [SETTING_KEYS[off]]: false };
        initializeAll();
        await alchemyHistoryViewer.openModal();

        const expected = ['Transmute', 'Coinify', 'Decompose'].filter((label) => label.toLowerCase() !== off);
        expect(switcherLabels()).toEqual(expected);
        expect(VIEWERS[off].modal).toBeNull();
        expect(alchemyHistoryViewer.modal.querySelector(`.mwi-${off}-history-pane`)).toBeNull();
    });

    test('with only one type on, the switcher is hidden and that type shows', async () => {
        mocks.settings = { alchemy_transmuteHistory: false, alchemy_decomposeHistory: false };
        initializeAll();
        await alchemyHistoryViewer.openModal();

        expect(switcherLabels()).toEqual([]);
        expect(visiblePanes()).toEqual(['coinify']);
        expect(title()).toBe('Coinify History');
    });

    test('remembers the type last picked across a teardown and back', async () => {
        initializeAll();
        await alchemyHistoryViewer.openModal();
        await pick('decompose');
        await vi.waitFor(() => expect(mocks.store.get(`settings:${LAST_TYPE_STORAGE_KEY}`)).toBe('decompose'));

        // Character switch / reload: every viewer goes, then comes back
        disableAll();
        initializeAll();
        await alchemyHistoryViewer.openModal();

        expect(alchemyHistoryViewer.activeType).toBe('decompose');
        expect(visiblePanes()).toEqual(['decompose']);
    });

    test('a remembered type that is now off falls back to the first enabled type', async () => {
        mocks.store.set(`settings:${LAST_TYPE_STORAGE_KEY}`, 'coinify');
        mocks.settings = { alchemy_coinifyHistory: false };
        initializeAll();
        await alchemyHistoryViewer.openModal();

        expect(alchemyHistoryViewer.activeType).toBe('transmute');
    });

    test('reopening keeps the type that was showing', async () => {
        initializeAll();
        await alchemyHistoryViewer.openModal();
        await pick('coinify');
        alchemyHistoryViewer.closeModal();
        expect(alchemyHistoryViewer.isOpen()).toBe(false);

        await alchemyHistoryViewer.openModal();
        expect(alchemyHistoryViewer.activeType).toBe('coinify');
        expect(visiblePanes()).toEqual(['coinify']);
    });

    test('a slower earlier switch does not take the window back', async () => {
        initializeAll();
        await alchemyHistoryViewer.openModal();

        let releaseCoinify;
        mocks.loaders.coinify = () =>
            new Promise((resolve) => {
                releaseCoinify = () => resolve(mocks.sessions.coinify);
            });
        const slow = alchemyHistoryViewer.showType('coinify');
        await alchemyHistoryViewer.showType('decompose');
        releaseCoinify();
        await slow;

        expect(alchemyHistoryViewer.activeType).toBe('decompose');
        expect(visiblePanes()).toEqual(['decompose']);
    });

    test('turning off the type showing moves an open window to another type', async () => {
        initializeAll();
        await alchemyHistoryViewer.openModal();
        expect(alchemyHistoryViewer.activeType).toBe('transmute');

        transmuteHistoryViewer.disable();
        await vi.waitFor(() => expect(alchemyHistoryViewer.activeType).toBe('coinify'));
        expect(switcherLabels()).toEqual(['Coinify', 'Decompose']);
        expect(visiblePanes()).toEqual(['coinify']);
    });

    test('closing the window closes an open column filter popup', async () => {
        vi.useFakeTimers();
        try {
            initializeAll();
            await alchemyHistoryViewer.openModal();
            const button = document.createElement('button');
            document.body.appendChild(button);
            transmuteHistoryViewer.showFilterPopup('startTime', button);
            vi.advanceTimersByTime(20);
            const popup = transmuteHistoryViewer.activeFilterPopup;
            expect(document.body.contains(popup)).toBe(true);

            alchemyHistoryViewer.closeModal();
            expect(document.body.contains(popup)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    test('switching type closes the previous type’s filter popup', async () => {
        vi.useFakeTimers();
        try {
            initializeAll();
            await alchemyHistoryViewer.openModal();
            const button = document.createElement('button');
            document.body.appendChild(button);
            transmuteHistoryViewer.showFilterPopup('startTime', button);
            vi.advanceTimersByTime(20);
            const popup = transmuteHistoryViewer.activeFilterPopup;

            await alchemyHistoryViewer.showType('coinify');
            expect(document.body.contains(popup)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
