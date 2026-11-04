/** @vitest-environment happy-dom */

/**
 * The price target on a pin: the chip that shows it, the editor that sets it,
 * and the reader the alert sees it through.
 *
 * The chip's own reading is the panel's cache, which is allowed to be
 * approximate about *when* — the alert does the dated comparison. What these
 * pin down is the part a reader acts on: that a target is visible without a
 * hover, that setting one is a click and Enter on the current price, that an
 * empty box clears rather than storing something unreachable, and that a
 * seeded target never overwrites one somebody chose.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ prices: {} }));

vi.mock('../../../core/storage.js', () => ({
    default: {
        get: async () => null,
        getJSON: async () => null,
        tryGet: async () => ({ found: false, value: null }),
        set: async () => true,
        setJSON: async () => true,
        delete: async () => true,
        getAllKeys: async () => [],
    },
}));
vi.mock('../../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'market123',
        getCurrentCharacterGameMode: () => 'standard',
        getItemDetails: (hrid) => ({ name: hrid === '/items/cheese' ? 'Cheese' : 'Milk' }),
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
vi.mock('../../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../../utils/mobile.js', () => ({ hasCoarsePointer: () => false }));
vi.mock('./market-price-store.js', () => ({
    default: {
        initialize: async () => {},
        cleanup: () => {},
        ingestSnapshot: () => {},
        onChange: () => () => {},
        get: (itemHrid, level) => store.prices[`${itemHrid}:${level}`] || null,
    },
}));
vi.mock('./market-history-api.js', () => ({
    default: {
        connect: () => {},
        disconnect: () => {},
        fetchHistory: async () => [],
        currentSource: () => ({ key: 'mooket2', hasVolume: true, avgLabel: 'Avg' }),
    },
}));

const { default: panel, watchedPriceTargets } = await import('./index.js');

const NOW = new Date('2026-01-01T12:00:00Z').getTime();

/** The chip drawn for the first pin */
const chip = () => panel.chipRow.firstElementChild;

/** The ◎ button that opens the editor */
const editButton = () => [...chip().querySelectorAll('span')].find((el) => el.textContent === '◎' && el.title);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    store.prices = { '/items/cheese:0': { ask: 5_000_000, bid: 4_000_000, at: NOW } };
    panel.prefs = { x: 0, y: 0, w: 520, h: 300, days: 7, open: true, locked: false, mode: 'iconPrice' };
    panel.watchlist = [{ key: '/items/cheese:0', ask: 5_000_000, bid: 4_000_000, at: NOW }];
    panel.chipRow = document.createElement('div');
    panel.savePrefs = async () => {};
    // The chip's own click charts the item, which needs a panel this test has not built
    panel.showItem = async () => {};
    panel.sprite = 'sprite.svg';
});

describe('the chip', () => {
    test('shows a target on its face, not only in the tooltip', () => {
        panel.watchlist[0].target = { side: 'ask', price: 4_200_000 };
        panel.renderChips();

        expect(chip().textContent).toContain('◎4.2M');
        expect(chip().title).toContain('Target: under 4.2M ask');
    });

    test('marks a target the panel’s own reading has already reached', () => {
        panel.watchlist[0].target = { side: 'ask', price: 6_000_000 };
        panel.renderChips();
        expect(chip().title).toContain('under 6.0M ask — reached');
    });

    test('an untargeted pin says nothing about targets beyond how to set one', () => {
        panel.renderChips();
        expect(chip().textContent).not.toContain('◎4');
        expect(chip().title).not.toContain('Target:');
        expect(chip().title).toContain('◎ to set a price target');
    });

    test('the target survives the tightest display mode, where the price does not', () => {
        // Hiding it behind a display setting would make the alert unreachable
        // for exactly the people whose row is arranged tightly
        panel.prefs.mode = 'icon';
        panel.watchlist[0].target = { side: 'ask', price: 4_200_000 };
        panel.renderChips();

        expect(chip().textContent).toContain('◎');
        expect(editButton()).toBeTruthy();
    });
});

describe('the editor', () => {
    const open = () => {
        panel.renderChips();
        editButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        return chip().querySelector('input');
    };

    test('opens seeded with the current ask, so a click and Enter is enough', () => {
        const input = open();
        expect(input.value).toBe('5000000');

        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(panel.watchlist[0].target).toEqual({ side: 'ask', price: 5_000_000 });
    });

    test('a typed price wins over the seed', () => {
        const input = open();
        input.value = '4200000';
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(panel.watchlist[0].target).toEqual({ side: 'ask', price: 4_200_000 });
    });

    test('separators typed into the box are not part of the number', () => {
        const input = open();
        input.value = '4,200,000';
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(panel.watchlist[0].target).toEqual({ side: 'ask', price: 4_200_000 });
    });

    test('the side toggle reseeds from that side rather than carrying the ask across', () => {
        open();
        const toggle = chip().querySelector('[title="Swap the side this target watches"]');
        toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

        const input = chip().querySelector('input');
        expect(input.value).toBe('4000000');
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(panel.watchlist[0].target).toEqual({ side: 'bid', price: 4_000_000 });
    });

    test('the side toggle survives the blur that pressing it causes', () => {
        // In a browser, pressing a span while a text input has focus moves
        // focus off the input first: `blur` fires on mousedown, before the
        // click handler ever runs. The blur handler commits, and committing
        // closes the editor — so by the time the toggle's own handler runs the
        // input is detached, the target has been written on the side the
        // player was trying to change, and the swap is unreachable. Only a
        // synthetic click with no blur in front of it makes the toggle work.
        panel.watchlist[0].target = { side: 'ask', price: 4_200_000 };
        open();
        const toggle = chip().querySelector('[title="Swap the side this target watches"]');

        // The press, as a browser delivers it. Refusing mousedown's default is
        // the whole of what keeps focus — and therefore the editor — alive
        // until the click lands.
        const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
        toggle.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);

        toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

        // Still open, now on the other side, with nothing committed
        expect(chip().querySelector('input')).toBeTruthy();
        expect(chip().querySelector('input').value).toBe('4000000');
        expect(panel.watchlist[0].target).toEqual({ side: 'ask', price: 4_200_000 });
    });

    test('a blur that does reach the box still commits, so clicking away saves', () => {
        // The guard above must not turn the editor into something you can only
        // leave with a key: clicking anywhere else still blurs, and a blur is
        // still a commit.
        const input = open();
        input.value = '4200000';
        input.dispatchEvent(new window.FocusEvent('blur'));

        expect(panel.watchlist[0].target).toEqual({ side: 'ask', price: 4_200_000 });
        expect(chip().querySelector('input')).toBe(null);
    });

    test('an empty box clears the target', () => {
        panel.watchlist[0].target = { side: 'ask', price: 4_200_000 };
        const input = open();
        input.value = '';
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(panel.watchlist[0]).not.toHaveProperty('target');
    });

    test('an unreadable value leaves the target exactly as it was', () => {
        // Not a target, and not an instruction to clear one either
        panel.watchlist[0].target = { side: 'ask', price: 4_200_000 };
        const input = open();
        input.value = 'soon';
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(panel.watchlist[0].target).toEqual({ side: 'ask', price: 4_200_000 });
    });

    test('Escape leaves the target as it was', () => {
        panel.watchlist[0].target = { side: 'ask', price: 4_200_000 };
        const input = open();
        input.value = '1';
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(panel.watchlist[0].target).toEqual({ side: 'ask', price: 4_200_000 });
    });

    test('it opens once, however many times the button is pressed', () => {
        panel.renderChips();
        editButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        chip()
            .querySelectorAll('span')
            .forEach((el) => {
                if (el.textContent === '◎' && el.title) el.dispatchEvent(new window.MouseEvent('click'));
            });
        expect(chip().querySelectorAll('input')).toHaveLength(1);
    });
});

describe('seeding from a costed row', () => {
    beforeEach(() => {
        panel.isInitialized = true;
        panel.watchlist = [];
    });

    test('pins the item with the row’s cost as an ask target', () => {
        expect(panel.seedPriceTarget('/items/cheese', 0, 4_200_000)).toBe(true);
        expect(panel.watchlist[0]).toMatchObject({
            key: '/items/cheese:0',
            target: { side: 'ask', price: 4_200_000 },
        });
    });

    test('gives an already-pinned but untargeted item the row’s target', () => {
        panel.watchlist = [{ key: '/items/cheese:0', ask: 5_000_000, bid: 4_000_000, at: NOW }];
        expect(panel.seedPriceTarget('/items/cheese', 0, 4_200_000)).toBe(true);
        expect(panel.watchlist).toHaveLength(1);
        expect(panel.watchlist[0].target).toEqual({ side: 'ask', price: 4_200_000 });
    });

    test('never overwrites a target somebody chose — a seed is a default', () => {
        panel.watchlist = [{ key: '/items/cheese:0', target: { side: 'bid', price: 9 } }];
        expect(panel.seedPriceTarget('/items/cheese', 0, 4_200_000)).toBe(false);
        expect(panel.watchlist[0].target).toEqual({ side: 'bid', price: 9 });
    });

    test('an unpriced row seeds nothing rather than a target of zero', () => {
        expect(panel.seedPriceTarget('/items/cheese', 0, null)).toBe(false);
        expect(panel.watchlist).toHaveLength(0);
    });

    test('a panel that never started pins nothing', () => {
        // The price history feature is off by default; a pin nobody can see is
        // not a handoff
        panel.isInitialized = false;
        expect(panel.seedPriceTarget('/items/cheese', 0, 4_200_000)).toBe(false);
        expect(panel.watchlist).toHaveLength(0);
    });

    test('the level goes with it, so a +5 is not pinned as a +0', () => {
        panel.seedPriceTarget('/items/cheese', 5, 4_200_000);
        expect(panel.watchlist[0].key).toBe('/items/cheese:5');
    });
});

describe('what the alert reads', () => {
    test("a list still held for the previous character is unknown, not this character's pins", () => {
        // A switch tears the panel down but leaves the list in memory until loadPrefs() has read the new
        // character's; the alert must not look up, fire or record against the outgoing character's pins
        panel.watchlist = [{ key: '/items/cheese:0', target: { side: 'ask', price: 4_200_000 } }];
        panel.watchlistOwner = 'someone-else';
        try {
            expect(watchedPriceTargets()).toEqual([]);

            panel.watchlistOwner = 'market123';
            expect(watchedPriceTargets()).toHaveLength(1);
        } finally {
            panel.watchlistOwner = null;
        }
    });

    test('names the item the way the player sees it, level included', () => {
        panel.watchlist = [
            { key: '/items/cheese:0', target: { side: 'ask', price: 4_200_000 } },
            { key: '/items/cheese:5', target: { side: 'bid', price: 1 } },
        ];
        const pins = watchedPriceTargets();

        expect(pins[0]).toMatchObject({
            itemHrid: '/items/cheese',
            enhancementLevel: 0,
            name: 'Cheese',
            target: { side: 'ask', price: 4_200_000 },
        });
        expect(pins[1].name).toBe('Cheese +5');
    });

    test('an untargeted pin reads as one, so the alert never looks it up', () => {
        panel.watchlist = [{ key: '/items/cheese:0' }];
        expect(watchedPriceTargets()[0].target).toBeNull();
    });

    test('a stored target that cannot be honoured is no target', () => {
        panel.watchlist = [{ key: '/items/cheese:0', target: { side: 'ask', price: 0 } }];
        expect(watchedPriceTargets()[0].target).toBeNull();
    });
});

describe('a full watchlist says so where the player pressed', () => {
    const fullList = (count) => Array.from({ length: count }, (_, i) => ({ key: `/items/item_${i}:0`, ask: 1 }));

    beforeEach(() => {
        panel.isInitialized = true;
        panel.renderChips = () => {};
    });

    test('the pin button flashes that the list is full, adds nothing, and restores itself', () => {
        panel.watchlist = fullList(99);
        panel.current = { itemHrid: '/items/cheese', enhancementLevel: 0 };
        panel.buildOverlay();
        panel.pinButton.click();

        expect(panel.watchlist).toHaveLength(99);
        expect(panel.pinButton.textContent).toBe('Full (99)');
        expect(panel.pinButton.title).toContain('Unpin one');
        vi.advanceTimersByTime(2600);
        expect(panel.pinButton.textContent).toBe('\u{1F4CC}');
        panel.overlay.remove();
    });

    test('the 99th pin still goes in, and an item already pinned is not a refusal', () => {
        panel.watchlist = fullList(98);
        panel.current = { itemHrid: '/items/cheese', enhancementLevel: 0 };
        panel.buildOverlay();
        panel.pinButton.click();
        expect(panel.watchlist).toHaveLength(99);
        expect(panel.pinButton.textContent).toBe('\u{1F4CC}');

        panel.pinButton.click();
        expect(panel.watchlist).toHaveLength(99);
        expect(panel.pinButton.textContent).toBe('\u{1F4CC}');
        panel.overlay.remove();
    });

    test('a list past the limit (merged from two devices) is kept whole and refuses more', () => {
        panel.watchlist = fullList(120);
        expect(panel.watchlistFullFor('/items/new', 0)).toBe(true);
        expect(panel.watchlistFullFor('/items/item_5', 0)).toBe(false);
        expect(panel.seedPriceTarget('/items/new', 0, 1000)).toBe(false);
        expect(panel.watchlist).toHaveLength(120);
    });

    test('a panel that never started reports nothing as full', () => {
        panel.isInitialized = false;
        panel.watchlist = fullList(99);
        expect(panel.watchlistFullFor('/items/new', 0)).toBe(false);
    });
});

describe('the full flash does not outlive its moment', () => {
    const fullList = (count) => Array.from({ length: count }, (_, i) => ({ key: `/items/item_${i}:0`, ask: 1 }));

    beforeEach(() => {
        panel.isInitialized = true;
        panel.renderChips = () => {};
        panel.watchlist = fullList(99);
        panel.current = { itemHrid: '/items/cheese', enhancementLevel: 0 };
        panel.buildOverlay();
        panel.pinButton.click();
    });

    afterEach(() => {
        panel.overlay.remove();
    });

    test('is a short one-line label held inside the screen', () => {
        expect(panel.pinButton.textContent).toBe('Full (99)');
        expect(panel.pinButton.style.whiteSpace).toBe('nowrap');
        expect(panel.pinButton.style.maxWidth).not.toBe('');
        panel.resetPinButton();
        expect(panel.pinButton.style.maxWidth).toBe('');
        expect(panel.pinButton.style.fontSize).toBe('16px');
    });

    test('goes when the market item changes', () => {
        const proto = Object.getPrototypeOf(panel);
        panel.chart = null;
        // showItem is stubbed in this file; the real one sets the item first
        const real = proto.showItem;
        const reset = vi.spyOn(panel, 'resetPinButton');
        try {
            real.call(panel, '/items/milk', 0).catch(() => {});
        } catch {
            // the chart is not built here; only the reset before it matters
        }
        expect(reset).toHaveBeenCalled();
        expect(panel.pinButton.textContent).toBe('\u{1F4CC}');
    });

    test('goes when an unpin makes room, and on a pin that then succeeds', () => {
        panel.watchlist = fullList(98);
        panel.pinButton.click();
        expect(panel.watchlist).toHaveLength(99);
        expect(panel.pinButton.textContent).toBe('\u{1F4CC}');
        expect(panel.pinFlashTimer).toBeNull();
    });
});
