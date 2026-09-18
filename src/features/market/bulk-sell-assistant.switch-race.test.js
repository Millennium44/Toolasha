/**
 * @vitest-environment happy-dom
 *
 * A character switch tearing the assistant down while its initialize() is
 * parked on the remembered panel position's read.
 *
 * `isInitialized` is set *before* that read, so the switch's own re-initialise
 * never early-returned — the interrupted call simply resumed after `cleanup()`
 * had dropped the order-book listener, the modal subscription and the body
 * mutation watcher and nulled the fields holding them, and re-stored its own
 * handles into those same fields. The previous set stayed live with nothing
 * left to remove it by: every order book the game pushes is then processed once
 * per leaked handler into the insta-sell / list decision, and a whole-body
 * mutation watcher keeps scanning the DOM for a feature that is gone.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside the panel-position read */
    gate: null,
    characterId: 'char1',
    /** Held open to park `_start()` inside the loadout store's readiness wait */
    loadoutGate: null,
    /** The bag `_start()` reads AFTER its awaits — i.e. whoever is current then */
    items: [],
    itemDetails: {},
}));

/** Every live dataManager listener, by event, so leaks are countable. */
const events = vi.hoisted(() => ({ handlers: {} }));
/** Modal subscriptions and body mutation watchers, opened vs. dropped. */
const modals = vi.hoisted(() => ({ registered: 0, unregistered: 0 }));
const watchers = vi.hoisted(() => ({ registered: 0, unregistered: 0 }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'market_bulkSellAssistant',
        setSetting: () => {},
        getSettingValue: (_key, fallback) => fallback,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => world.characterId,
        getInitClientData: () => ({ itemDetailMap: world.itemDetails }),
        get characterItems() {
            return world.items;
        },
        on: (event, handler) => {
            (events.handlers[event] ??= []).push(handler);
        },
        off: (event, handler) => {
            events.handlers[event] = (events.handlers[event] || []).filter((h) => h !== handler);
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => {
            modals.registered += 1;
            return () => {
                modals.unregistered += 1;
            };
        },
        register: () => () => {},
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (_key, _store, fallback = null) => {
            // The read the switch lands inside
            if (world.gate) await world.gate;
            return fallback;
        },
        set: async () => true,
        setJSON: async () => {},
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => ({ ask: 100, bid: 90 }) } }));
vi.mock('../inventory/custom-tabs/custom-tabs-data.js', () => ({
    loadConfig: async () => ({ tabs: [] }),
    findTab: () => null,
    collectTabItems: () => new Set(),
    collectItemsAboveTab: () => new Set(),
}));
vi.mock('./marketplace-shortcuts.js', () => ({
    default: {
        clickInstantActionButton: () => new Promise(() => {}),
        clickListingButton: () => new Promise(() => {}),
        findQuantityInput: () => null,
    },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: {
        getAllSnapshots: () => [],
        whenReady: async () => {
            if (world.loadoutGate) await world.loadoutGate;
            return true;
        },
    },
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: () => {},
    insertTabInOrder: (container, tab) => container?.appendChild(tab),
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: () => {
        watchers.registered += 1;
        return () => {
            watchers.unregistered += 1;
        };
    },
}));
vi.mock('../inventory/watchlist.js', () => ({ watchlistEntries: () => [] }));

const bulkSell = (await import('./bulk-sell-assistant.js')).default;

const liveBooks = () => (events.handlers['market_item_order_books_updated'] || []).length;

describe('a character switch landing inside the panel-position read', () => {
    beforeEach(() => {
        world.gate = null;
        world.characterId = 'char1';
        bulkSell.cleanup();
        events.handlers = {};
        modals.registered = 0;
        modals.unregistered = 0;
        watchers.registered = 0;
        watchers.unregistered = 0;
    });

    afterEach(() => {
        world.gate = null;
        bulkSell.cleanup();
    });

    /**
     * Start an initialize() whose read is held open, tear the assistant down
     * inside it the way `disableAllFeatures()` does, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = bulkSell.initialize();
        // `character_switching` — the feature layer comes down mid-read
        bulkSell.disable();
        // …and the arriving character is current before the read resolves
        world.characterId = 'char2';
        release();
        world.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing on the way out', async () => {
        await switchDuringInitialize();

        expect(liveBooks()).toBe(0);
        expect(modals.registered).toBe(0);
        expect(watchers.registered).toBe(0);
        expect(bulkSell.isInitialized).toBe(false);
    });

    test('a run of interrupted switches leaves the arriving character one of each', async () => {
        for (let i = 0; i < 3; i++) await switchDuringInitialize();
        // The switch's own re-initialise, which the flag never blocked
        await bulkSell.initialize();

        // A second order-book handler is every book processed twice into the
        // insta-sell / list decision; a second watcher is a second whole-body
        // MutationObserver nobody can stop
        expect(liveBooks()).toBe(1);
        expect(modals.registered - modals.unregistered).toBe(1);
        expect(watchers.registered - watchers.unregistered).toBe(1);

        // …and that one set is the one the teardown can remove
        bulkSell.cleanup();
        expect(liveBooks()).toBe(0);
        expect(modals.registered - modals.unregistered).toBe(0);
        expect(watchers.registered - watchers.unregistered).toBe(0);
    });
});

/**
 * A character switch landing inside `_start()`'s own awaits.
 *
 * `_start` waits on the inventory tab config and on the loadout store declaring
 * itself ready, and everything after those awaits reads the character in hand —
 * `dataManager.characterItems` is whoever is current when the tail resumes. A
 * run started by one character therefore built its sell queue out of the next
 * character's bag and drove straight on into `_prepareCurrent()`, navigating
 * the marketplace and prefilling a sell modal for a run nobody had started.
 */
describe('a character switch landing inside a queue build', () => {
    beforeEach(() => {
        world.gate = null;
        world.loadoutGate = null;
        world.characterId = 'char1';
        world.items = [];
        world.itemDetails = {};
        bulkSell.cleanup();
        events.handlers = {};
    });

    afterEach(() => {
        world.gate = null;
        world.loadoutGate = null;
        bulkSell.cleanup();
    });

    test('the interrupted build leaves no queue for the arriving character', async () => {
        world.itemDetails = { '/items/cheese': { name: 'Cheese', isTradable: true } };
        let release;
        world.loadoutGate = new Promise((resolve) => {
            release = resolve;
        });

        const pending = bulkSell._start();
        // The switch: the feature layer comes down, and by the time the wait
        // resolves the ARRIVING character's bag is what `characterItems` answers
        bulkSell.cleanup();
        world.characterId = 'char2';
        world.items = [{ itemHrid: '/items/cheese', itemLocationHrid: '/item_locations/inventory', count: 10 }];
        release();
        world.loadoutGate = null;
        await pending;

        expect(bulkSell.queue).toHaveLength(0);
        expect(bulkSell.state).toBe('idle');
        expect(bulkSell.current).toBeNull();
    });
});
