/** @vitest-environment happy-dom */

import { describe, test, expect, afterEach, vi } from 'vitest';

/** Whether the panel is being drawn for a finger or a cursor */
const pointer = vi.hoisted(() => ({ touch: false }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (id, fallback) => fallback, Z_FLOATING_PANEL: 1100 },
}));
/** A small in-memory store, with a switch for "the database cannot be read" */
const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            storageMock.unavailable = false;
        },
        get: async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        },
        getJSON: async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        },
        tryGet: async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        },
        set: async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        },
        setJSON: async () => {},
        delete: async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        },
        getAllKeys: async (store = 'settings') => Array.from(storeFor(store).keys()),
    };
});
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char-1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
const dm = vi.hoisted(() => ({ dropTables: {}, shop: {}, labyrinthShop: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => (hrid === '/items/known' ? { name: 'Known Thing' } : null),
        getInitClientData: () => ({
            openableLootDropMap: dm.dropTables,
            shopItemDetailMap: dm.shop,
            labyrinthShopItemDetailMap: dm.labyrinthShop,
        }),
        getCurrentCharacterId: () => 'char-1',
        getCurrentCharacterGameMode: () => 'standard',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/mobile.js', () => ({
    isMobileMode: () => pointer.touch,
    hasCoarsePointer: () => pointer.touch,
    detectedModeLabel: () => (pointer.touch ? 'mobile' : 'desktop'),
}));
/** Whether the geometry restore is made to fail, for the popup-visibility test */
const geometry = vi.hoisted(() => ({ restoreFails: false }));
// Geometry lives in IndexedDB and is never what these tests are about
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: async () => {
        if (geometry.restoreFails) throw new Error('storage is gone');
    },
    saveGeometry: () => {},
    clearPosition: () => {},
    saveOpenState: () => {},
    reopenIfLeftOpen: () => {},
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 1, getPricingMode: () => 'bid' }));
// Pricing untradables at their token cost reaches the market API, which opens a
// socket on import; the unit under test here is the formatting, not the pricing.
// The shop-line summing is the real implementation, because that is what the
// two-cost test below is about.
const tokenValue = vi.hoisted(() => ({ of: () => 0 }));
vi.mock('../../utils/token-valuation.js', async (importOriginal) => ({
    ...(await importOriginal()),
    calculateDungeonTokenValue: (hrid) => tokenValue.of(hrid),
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));

const {
    formatReturn,
    itemName,
    worthShowing,
    capHeightToWindow,
    pricingBasis,
    buildTreasureSummaryRows,
    buildTreasureDetailRows,
    TREASURE_SUMMARY_COLUMNS,
    TREASURE_DETAIL_COLUMNS,
    default: treasureTracker,
} = await import('./treasure-tracker.js');

describe('formatReturn', () => {
    test('reads as a gain or a shortfall against expectation', () => {
        expect(formatReturn(1.2).text).toBe('+20.0%');
        expect(formatReturn(0.8).text).toBe('-20.0%');
    });

    test('a run near expectation is not coloured as news', () => {
        // Every chest sits a percent or two off; colouring that would make the
        // panel a wall of red and green saying nothing
        expect(formatReturn(1.02).color).toBe(formatReturn(0.98).color);
        expect(formatReturn(1.2).color).not.toBe(formatReturn(0.8).color);
    });

    test('nothing opened is not a verdict of zero', () => {
        // A ratio of null must not render as -100%
        expect(formatReturn(null).text).toBe('—');
        expect(formatReturn(undefined).text).toBe('—');
    });
});

describe('itemName', () => {
    test('uses the game name when there is one', () => {
        expect(itemName('/items/known')).toBe('Known Thing');
    });

    test('falls back to the hrid so an unknown item still reads as something', () => {
        // Drop tables outrun the item map after a game update
        expect(itemName('/items/mystery_box')).toBe('mystery box');
    });
});

describe('which drop-table rows are worth a line', () => {
    const row = (actualCount, expectedCount) => ({ actualCount, expectedCount });

    test('a rare that came is kept however unlikely it was', () => {
        // Precisely the row worth seeing — one in eight thousand, and it landed
        expect(worthShowing([row(1, 0.0001)])).toHaveLength(1);
    });

    test('an expectation that rounds to nothing and did not drop is dropped', () => {
        // It would read "0, 0.00 expected, -100%" — three figures agreeing that
        // nothing happened, pushing the rows that did happen off the bottom
        expect(worthShowing([row(0, 0.004)])).toHaveLength(0);
        expect(worthShowing([row(0, 0)])).toHaveLength(0);
    });

    test('an expectation big enough to print is kept even at zero', () => {
        // "0 of 0.12 expected" is a real statement about a rare not turning up
        expect(worthShowing([row(0, 0.12)])).toHaveLength(1);
        expect(worthShowing([row(0, 0.005)])).toHaveLength(1);
    });

    test('nothing at all is nothing, not a crash', () => {
        expect(worthShowing([])).toEqual([]);
        expect(worthShowing(null)).toEqual([]);
    });
});

describe('the popup gets a height of its own', () => {
    const popup = (natural) => ({
        offsetHeight: natural,
        getBoundingClientRect: () => ({ height: natural }),
        style: {},
    });

    test('a short popup keeps the height it wants', () => {
        const element = popup(220);
        capHeightToWindow(element, 1000);

        expect(element.style.height).toBe('220px');
    });

    test('a chest with thirty drop-table rows is cut to fit the window', () => {
        const element = popup(2000);
        capHeightToWindow(element, 600);

        expect(element.style.height).toBe('420px');
    });

    test('and to the cap on a tall screen, so it does not run the full height', () => {
        const element = popup(2000);
        capHeightToWindow(element, 1600);

        expect(element.style.height).toBe('560px');
    });

    test('it writes height rather than max-height', () => {
        // The bug: the resize grip writes `height`, so a `max-height` above it
        // meant dragging the corner downwards changed a number nothing rendered
        const element = popup(2000);
        capHeightToWindow(element, 1000);

        expect(element.style.maxHeight).toBeUndefined();
        expect(element.style.height).toBeTruthy();
    });
});

describe('the header when the settings arrive late', () => {
    // The panel is reopened at start-up and builds its header before the
    // settings come back from storage, so the header sat there claiming the
    // defaults until it was closed and opened again
    const build = () => {
        treasureTracker.settings = {
            capeValue: 'token',
            valueCowbells: true,
            hiddenChests: [],
            popupPinned: false,
            sortMode: 'luck',
        };
        return treasureTracker._createHeader();
    };

    test('the toggles catch up', () => {
        const header = build();
        expect(header.textContent).toContain('Token value');
        expect(header.textContent).toContain('Cowbells counted');

        treasureTracker.settings.capeValue = 'zero';
        treasureTracker.settings.valueCowbells = false;
        treasureTracker._refreshToggles();

        expect(header.textContent).toContain('No value');
        expect(header.textContent).toContain('Cowbells at zero');
    });

    test('and so does the sort picker', () => {
        build();
        treasureTracker.settings.sortMode = 'name';
        treasureTracker._refreshToggles();

        expect(treasureTracker.sortPicker.value).toBe('name');
    });

    test('a stored order the list no longer offers falls back rather than blanking', () => {
        build();
        treasureTracker.settings.sortMode = 'by-vibes';
        treasureTracker._refreshToggles();

        expect(treasureTracker.sortPicker.value).toBe('luck');
    });
});

describe('the header on a screen too narrow for it', () => {
    // A phone is about 400px wide. The header carries a title, two value
    // chips, a gear, a sort picker and a close button, which is more than fits
    // — and the one that fell off the end was the way out of the panel.
    const build = () => {
        treasureTracker.settings = {
            capeValue: 'token',
            valueCowbells: true,
            hiddenChests: [],
            popupPinned: false,
            sortMode: 'luck',
        };
        return treasureTracker._createHeader();
    };

    /**
     * @param {HTMLElement} header - A built header
     * @returns {HTMLElement|undefined} The close button
     */
    const closeButton = (header) => [...header.querySelectorAll('button')].find((b) => b.textContent === '✕');

    afterEach(() => {
        pointer.touch = false;
    });

    test('the controls wrap instead of pushing each other off the side', () => {
        expect(build().style.flexWrap).toBe('wrap');
    });

    test('the close button is out of the flow, pinned to the corner', () => {
        const close = closeButton(build());

        expect(close.style.position).toBe('absolute');
        expect(close.style.right).toBeTruthy();
        expect(close.style.top).toBeTruthy();
    });

    test('and nothing flows underneath it', () => {
        const header = build();

        expect(parseFloat(header.style.paddingRight)).toBeGreaterThanOrEqual(28);
    });

    test('a finger gets something it can hit', () => {
        pointer.touch = true;
        const header = build();

        expect(parseFloat(closeButton(header).style.minWidth)).toBeGreaterThanOrEqual(32);
        expect(parseFloat(closeButton(header).style.minHeight)).toBeGreaterThanOrEqual(32);
        // The gutter has to grow with the button, or the picker runs under it
        expect(parseFloat(header.style.paddingRight)).toBeGreaterThanOrEqual(32);
    });

    test('pressing it closes the panel', () => {
        const hide = vi.spyOn(treasureTracker, 'hide').mockImplementation(() => {});
        closeButton(build()).click();

        expect(hide).toHaveBeenCalled();
        hide.mockRestore();
    });
});

describe('the popup’s header is the panel’s header', () => {
    // The popup is a second header built by a second method, and it got none of
    // the treatment the panel's did — its ✕ sat in the flow beside a title that
    // is a chest name, so the fix that pinned one of them left the other one
    // able to regress in exactly the same way
    const opening = { opened: 1, ratio: 1.1, actualValue: 45440, items: [] };
    const lifetime = { opened: 12, ratio: 0.98, actualValue: 500000 };
    const build = () => treasureTracker._buildPopup('/items/known', opening, lifetime);
    const header = (popup) => popup.firstChild;
    const closeButton = (popup) => [...popup.querySelectorAll('button')].find((b) => b.textContent === '✕');

    afterEach(() => {
        treasureTracker._removePopup();
        pointer.touch = false;
    });

    test('the title wraps instead of pushing the close button off the side', () => {
        expect(header(build()).style.flexWrap).toBe('wrap');
    });

    test('the close button is out of the flow, pinned to the corner', () => {
        const popup = build();
        const close = closeButton(popup);

        expect(close.style.position).toBe('absolute');
        expect(close.style.right).toBeTruthy();
        expect(close.style.top).toBeTruthy();
    });

    test('and nothing flows underneath it', () => {
        expect(parseFloat(header(build()).style.paddingRight)).toBeGreaterThanOrEqual(28);
    });

    test('a finger gets something it can hit', () => {
        pointer.touch = true;
        const popup = build();

        expect(parseFloat(closeButton(popup).style.minWidth)).toBeGreaterThanOrEqual(32);
        expect(parseFloat(closeButton(popup).style.minHeight)).toBeGreaterThanOrEqual(32);
        expect(parseFloat(header(popup).style.paddingRight)).toBeGreaterThanOrEqual(32);
    });

    test('pressing it takes the popup away', () => {
        const popup = build();
        document.body.appendChild(popup);
        treasureTracker.popup = popup;

        closeButton(popup).click();

        expect(document.getElementById(popup.id)).toBe(null);
    });
});

describe('the button in settings', () => {
    afterEach(() => {
        treasureTracker.panel = null;
        document.body.replaceChildren();
    });

    test('opens the panel, and the second press closes it again', () => {
        treasureTracker.settings = {
            capeValue: 'token',
            valueCowbells: true,
            hiddenChests: [],
            popupPinned: false,
            sortMode: 'luck',
        };

        treasureTracker.toggle();
        expect(document.getElementById('toolasha-treasure-panel')).not.toBe(null);

        treasureTracker.toggle();
        expect(document.getElementById('toolasha-treasure-panel')).toBe(null);
    });
});

describe('which side of the book the figures are', () => {
    test('is said, because it is a setting rather than a constant', () => {
        // TReasure always prices at bid and says "bid"; Toolasha follows the
        // profit pricing mode, so the same chest can be worth two different
        // numbers and neither of them is wrong
        expect(pricingBasis()).toBe('bid');
    });
});

describe('the CSV export', () => {
    // The shape summariseTally hands the panel: a summary per chest, with the
    // per-item performance the breakdown draws from
    const summaryRow = {
        chestHrid: '/items/known',
        perChestValue: 1500,
        opened: 10,
        actualValue: 16000,
        expectedValue: 15000,
        difference: 1000,
        ratio: 16000 / 15000,
        items: [
            {
                itemHrid: '/items/coin',
                actualCount: 16000,
                expectedCount: 15000,
                actualValue: 16000,
                expectedValue: 15000,
                unpriced: false,
            },
            // A rare that landed — kept however unlikely it was
            {
                itemHrid: '/items/mystery_box',
                actualCount: 1,
                expectedCount: 0.002,
                actualValue: 0,
                expectedValue: 0,
                unpriced: true,
            },
            // Equipment at odds so long nothing happened — not worth a line
            {
                itemHrid: '/items/never_dropped',
                actualCount: 0,
                expectedCount: 0.001,
                actualValue: 0,
                expectedValue: 0.4,
                unpriced: false,
            },
        ],
    };
    const untouchedRow = {
        chestHrid: '/items/never_opened',
        perChestValue: 900,
        opened: 0,
        actualValue: 0,
        expectedValue: 0,
        difference: 0,
        ratio: null,
        items: [],
    };
    const nameOf = (hrid) => hrid.split('/').pop().replace(/_/g, ' ');

    test('an empty ledger is no rows, in both files', () => {
        expect(buildTreasureSummaryRows([])).toEqual([]);
        expect(buildTreasureSummaryRows(null)).toEqual([]);
        expect(buildTreasureDetailRows([])).toEqual([]);
        expect(buildTreasureDetailRows(null)).toEqual([]);
    });

    test('one summary row per opened chest, raw values, and no row for a chest never opened', () => {
        expect(buildTreasureSummaryRows([summaryRow, untouchedRow], nameOf)).toEqual([
            {
                chest: 'known',
                chestHrid: '/items/known',
                opened: 10,
                actualValue: 16000,
                expectedValue: 15000,
                difference: 1000,
                ratio: 16000 / 15000,
                perChestValue: 1500,
            },
        ]);
    });

    test('the detail file is one row per item worth a line, unpriced said out loud', () => {
        expect(buildTreasureDetailRows([summaryRow, untouchedRow], nameOf)).toEqual([
            {
                chest: 'known',
                chestHrid: '/items/known',
                item: 'coin',
                itemHrid: '/items/coin',
                actualCount: 16000,
                expectedCount: 15000,
                actualValue: 16000,
                expectedValue: 15000,
                unpriced: false,
            },
            {
                chest: 'known',
                chestHrid: '/items/known',
                item: 'mystery box',
                itemHrid: '/items/mystery_box',
                actualCount: 1,
                expectedCount: 0.002,
                actualValue: 0,
                expectedValue: 0,
                unpriced: true,
            },
        ]);
    });

    test('every column names a field its rows carry', () => {
        const [summary] = buildTreasureSummaryRows([summaryRow], nameOf);
        for (const column of TREASURE_SUMMARY_COLUMNS) expect(summary).toHaveProperty(column.key);

        const [detail] = buildTreasureDetailRows([summaryRow], nameOf);
        for (const column of TREASURE_DETAIL_COLUMNS) expect(detail).toHaveProperty(column.key);
    });

    describe('the buttons in the gear section', () => {
        const CHEST = '/items/chimerical_chest';

        afterEach(() => {
            treasureTracker.tally = {};
            dm.dropTables = {};
        });

        test('appear once something has been opened', () => {
            dm.dropTables[CHEST] = [{ itemHrid: '/items/coin', dropRate: 1, minCount: 1, maxCount: 1 }];
            treasureTracker.tally = { [CHEST]: { opened: 4, loot: { '/items/coin': 5 } } };

            const section = treasureTracker._configSection();
            const labels = [...section.querySelectorAll('button')].map((button) => button.textContent);

            expect(labels).toContain('Chests CSV');
            expect(labels).toContain('Items CSV');
        });

        test('and not before — an empty ledger has no rows to write', () => {
            const section = treasureTracker._configSection();
            const labels = [...section.querySelectorAll('button')].map((button) => button.textContent);

            expect(labels).not.toContain('Chests CSV');
            expect(labels).not.toContain('Items CSV');
        });
    });
});

describe('measuredReturn, the treasure rate a profit estimate may use', async () => {
    const { default: treasureTracker } = await import('./treasure-tracker.js');
    const CHEST = '/items/chimerical_chest';

    afterEach(() => {
        treasureTracker.tally = {};
        dm.dropTables = {};
    });

    test('actual over expected, at one price source, with the sample it rests on', () => {
        // One coin owed per open at price 1; 400 opens returned 500 coins
        dm.dropTables[CHEST] = [{ itemHrid: '/items/coin', dropRate: 1, minCount: 1, maxCount: 1 }];
        treasureTracker.tally = { [CHEST]: { opened: 400, loot: { '/items/coin': 500 } } };

        expect(treasureTracker.measuredReturn(CHEST)).toEqual({ ratio: 1.25, opened: 400 });
    });

    test('nothing opened is nothing measured', () => {
        dm.dropTables[CHEST] = [{ itemHrid: '/items/coin', dropRate: 1, minCount: 1, maxCount: 1 }];
        expect(treasureTracker.measuredReturn(CHEST)).toBeNull();
    });

    test('a chest without a drop table cannot be compared to one', () => {
        treasureTracker.tally = { [CHEST]: { opened: 400, loot: { '/items/coin': 500 } } };
        expect(treasureTracker.measuredReturn(CHEST)).toBeNull();
    });
});

describe('the ledger survives a read that cannot be made', async () => {
    const { default: treasureTracker } = await import('./treasure-tracker.js');
    const CHEST = '/items/chimerical_chest';
    const KEY = 'treasureTally_char-1';
    const stored = () => storageMock.storeFor('settings').get(KEY);
    const open = (count = 1) =>
        treasureTracker._onLootOpened({
            openedItem: { itemHrid: CHEST, count },
            gainedItems: [{ itemHrid: '/items/coin', count: 10 * count }],
        });

    afterEach(() => {
        treasureTracker.tally = {};
        treasureTracker.ledger.reset();
        storageMock.reset();
    });

    test('a load while storage is unreadable keeps the ledger in hand instead of blanking it', async () => {
        storageMock.storeFor('settings').set(KEY, { [CHEST]: { opened: 4, loot: { '/items/coin': 40 } } });
        treasureTracker.tally = { [CHEST]: { opened: 1, loot: { '/items/coin': 10 } } };
        storageMock.unavailable = true;

        treasureTracker.ledger.set(treasureTracker.tally);
        await treasureTracker.ledger.load();
        treasureTracker.tally = treasureTracker.ledger.get();

        expect(treasureTracker.tally[CHEST].opened).toBe(1);
        expect(stored()[CHEST].opened).toBe(4);
    });

    test('a save while storage is unreadable is skipped, and lands once it is back', async () => {
        storageMock.storeFor('settings').set(KEY, { [CHEST]: { opened: 4, loot: { '/items/coin': 40 } } });
        storageMock.unavailable = true;

        open();
        await treasureTracker.ledger.flushed();
        expect(stored()[CHEST].opened).toBe(4);

        storageMock.unavailable = false;
        open();
        await treasureTracker.ledger.flushed();
        // The larger lifetime count wins: storage's 4 over this tab's 2
        expect(stored()[CHEST].opened).toBe(4);
        expect(stored()[CHEST].loot['/items/coin']).toBe(40);
    });

    test('a save folds in what another tab counted meanwhile, the larger count winning', async () => {
        treasureTracker.ledger.set(treasureTracker.tally);
        await treasureTracker.ledger.load();
        treasureTracker.tally = treasureTracker.ledger.get();
        open(5);
        await treasureTracker.ledger.flushed();
        expect(stored()[CHEST].opened).toBe(5);

        storageMock.storeFor('settings').set(KEY, {
            [CHEST]: { opened: 7, loot: { '/items/coin': 70 } },
            '/items/other_chest': { opened: 1, loot: {} },
        });
        open(1);
        await treasureTracker.ledger.flushed();

        expect(stored()[CHEST].opened).toBe(7);
        expect(stored()['/items/other_chest'].opened).toBe(1);
        expect(stored()[CHEST].last.opened).toBe(1);
    });

    test('a reset is the write that means to lose counts, and does', async () => {
        storageMock.storeFor('settings').set(KEY, { [CHEST]: { opened: 4, loot: { '/items/coin': 40 } } });
        treasureTracker.tally = {};

        treasureTracker._save({ replace: true });
        await treasureTracker.ledger.flushed();

        expect(stored()).toEqual({});
    });
});

describe('the popup is shown only once it has somewhere to be', () => {
    const fakePopup = () => ({
        style: { visibility: 'hidden' },
        getBoundingClientRect: () => ({ width: 260, height: 120 }),
    });

    afterEach(() => {
        vi.useRealTimers();
        treasureTracker.popup = null;
        document.body.innerHTML = '';
    });

    test('beside the dialog, and visible, as soon as the dialog is there', () => {
        const dialog = document.createElement('div');
        dialog.className = 'Modal_modal__1';
        dialog.getBoundingClientRect = () => ({ left: 300, right: 700, top: 100, width: 400, height: 300 });
        document.body.appendChild(dialog);
        treasureTracker.popup = fakePopup();

        treasureTracker._placeBesideDialog(0);

        expect(treasureTracker.popup.style.left).toBe('712px');
        expect(treasureTracker.popup.style.top).toBe('100px');
        expect(treasureTracker.popup.style.visibility).toBe('');
    });

    test('a quiet re-placement while the dialog is still rendering neither retries nor reveals', () => {
        vi.useFakeTimers();
        treasureTracker.popup = fakePopup();

        treasureTracker._placeBesideDialog(12, { quiet: true });
        vi.advanceTimersByTime(60 * 20);

        expect(treasureTracker.popup.style.visibility).toBe('hidden');
        expect(treasureTracker.popup.style.left).toBeUndefined();
    });

    test('a geometry restore that fails still reveals the popup rather than leaving it hidden', async () => {
        geometry.restoreFails = true;
        dm.dropTables['/items/chimerical_chest'] = [{ itemHrid: '/items/coin', dropRate: 1, minCount: 1, maxCount: 1 }];
        treasureTracker.settings = { ...treasureTracker.settings, popupPinned: true };
        treasureTracker.tally = {
            '/items/chimerical_chest': { opened: 1, loot: { '/items/coin': 1 }, last: { opened: 1, loot: {} } },
        };

        treasureTracker._showOpening('/items/chimerical_chest');
        expect(treasureTracker.popup.style.visibility).toBe('hidden');

        // The rejection is handled on a later microtask
        await Promise.resolve();
        await Promise.resolve();

        expect(treasureTracker.popup.style.visibility).toBe('');
        geometry.restoreFails = false;
        treasureTracker.tally = {};
        dm.dropTables = {};
    });

    test('a restore that lands after the popup was replaced does not touch the new one', async () => {
        geometry.restoreFails = true;
        dm.dropTables['/items/chimerical_chest'] = [{ itemHrid: '/items/coin', dropRate: 1, minCount: 1, maxCount: 1 }];
        treasureTracker.settings = { ...treasureTracker.settings, popupPinned: true };
        treasureTracker.tally = {
            '/items/chimerical_chest': { opened: 1, loot: { '/items/coin': 1 }, last: { opened: 1, loot: {} } },
        };

        treasureTracker._showOpening('/items/chimerical_chest');

        // One chest closed and the next opened while the read was in flight
        const replacement = fakePopup();
        treasureTracker.popup = replacement;

        await Promise.resolve();
        await Promise.resolve();

        // The continuation belonged to a popup that is gone; the new one is
        // still waiting on its own restore and must stay hidden
        expect(replacement.style.visibility).toBe('hidden');

        geometry.restoreFails = false;
        treasureTracker.tally = {};
        dm.dropTables = {};
    });

    test('stays hidden while the dialog is still rendering, then shows in the corner when it never comes', () => {
        vi.useFakeTimers();
        treasureTracker.popup = fakePopup();

        treasureTracker._placeBesideDialog(0);
        expect(treasureTracker.popup.style.visibility).toBe('hidden');
        vi.advanceTimersByTime(60 * 5);
        expect(treasureTracker.popup.style.visibility).toBe('hidden');

        vi.advanceTimersByTime(60 * 20);
        expect(treasureTracker.popup.style.visibility).toBe('');
        expect(treasureTracker.popup.style.left).toBeUndefined();
    });
});

describe('_untradableValue at token value', () => {
    afterEach(() => {
        dm.shop = {};
        dm.labyrinthShop = {};
        tokenValue.of = () => 0;
        treasureTracker.settings.capeValue = 'token';
    });

    test('a line paid for in two currencies is charged for both', () => {
        treasureTracker.settings.capeValue = 'token';
        dm.shop = {
            cape: {
                itemHrid: '/items/cape',
                costs: [
                    { itemHrid: '/items/chimerical_token', count: 10 },
                    { itemHrid: '/items/sinister_token', count: 4 },
                ],
            },
        };
        tokenValue.of = (hrid) =>
            ({ '/items/chimerical_token': 1000, '/items/sinister_token': 2500 })[hrid] ?? null;

        // 10 x 1000 + 4 x 2500 = 20000. Reading only costs[0] gave 10000.
        expect(treasureTracker._untradableValue('/items/cape')).toBe(20_000);
    });

    test('a line whose first cost is coins prices the coins at 1, not at a token rate', () => {
        treasureTracker.settings.capeValue = 'token';
        dm.shop = {
            cape: {
                itemHrid: '/items/cape',
                costs: [
                    { itemHrid: '/items/coin', count: 5000 },
                    { itemHrid: '/items/chimerical_token', count: 3 },
                ],
            },
        };
        // If /items/coin ever reaches the token valuer it answers 1_000_000 a coin,
        // which is the plausible-looking wrong number this guards against.
        tokenValue.of = (hrid) =>
            ({ '/items/coin': 1_000_000, '/items/chimerical_token': 1000 })[hrid] ?? null;

        expect(treasureTracker._untradableValue('/items/cape')).toBe(8000); // 5000 + 3 x 1000
    });

    test('a line that hands over several splits the cost between them', () => {
        treasureTracker.settings.capeValue = 'token';
        dm.shop = {
            bundle: {
                itemHrid: '/items/cape',
                outputCount: 2,
                costs: [{ itemHrid: '/items/chimerical_token', count: 10 }],
            },
        };
        tokenValue.of = (hrid) => (hrid === '/items/chimerical_token' ? 1000 : null);

        expect(treasureTracker._untradableValue('/items/cape')).toBe(5000);
    });

    test('an unpriceable currency leaves the reward unvalued rather than cheap', () => {
        treasureTracker.settings.capeValue = 'token';
        dm.shop = {
            cape: {
                itemHrid: '/items/cape',
                costs: [
                    { itemHrid: '/items/chimerical_token', count: 10 },
                    { itemHrid: '/items/mystery_currency', count: 1 },
                ],
            },
        };
        tokenValue.of = (hrid) => (hrid === '/items/chimerical_token' ? 1000 : null);

        // market-data is mocked to price everything at 1, so the fallback answers 1
        expect(treasureTracker._untradableValue('/items/cape')).toBe(10_001);
    });
});
