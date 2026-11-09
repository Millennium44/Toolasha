import { describe, test, expect, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: {}, prices: {}, inventory: null, actions: [] }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_id, fallback) => fallback },
}));
vi.mock('../../core/websocket.js', () => ({
    default: { on: () => {}, off: () => {}, onSocketEvent: () => {}, offSocketEvent: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.items[hrid] ?? null,
        getCurrentCharacterId: () => 'char-1',
        getCurrentActions: () => game.actions,
        get characterItems() {
            return game.inventory;
        },
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => (hrid in game.prices ? game.prices[hrid] : null),
    getItemPrices: () => null,
    getItemPriceInfo: (hrid) => {
        const price = hrid in game.prices ? game.prices[hrid] : null;
        return { price, source: price === null ? null : 'book', estimated: false };
    },
}));
vi.mock('./alchemy-session-store.js', () => ({
    createAlchemySessionStore: () => ({
        load: async () => [],
        save: async () => {},
        clear: async () => {},
        setCharacter: () => {},
        forget: () => {},
    }),
    mergeSessionCopies: (a) => a,
    NO_CHARACTER: 'none',
}));

const { coinifyHistoryTracker } = await import('./coinify-history-tracker.js');
const { decomposeHistoryTracker } = await import('./decompose-history-tracker.js');
const { transmuteHistoryTracker } = await import('./transmute-history-tracker.js');

const ITEM = '/items/enhancers_top';

// These are the formats already accepted by the shared parser. Preserve the full
// game tuple while giving every caller the same handling of compact or absent slots.
describe.each([coinifyHistoryTracker, decomposeHistoryTracker, transmuteHistoryTracker])(
    'alchemy history item hashes',
    (tracker) => {
        test.each([
            `161296::/item_locations/inventory::${ITEM}::5`,
            `/item_locations/inventory::${ITEM}::5`,
            `/item_locations/inventory::${ITEM}`,
            ITEM,
        ])('reads the selected item from %s', (hash) => {
            expect(tracker.extractItemHrid(hash)).toBe(ITEM);
        });

        test.each([undefined, null, '', 42, {}, '161296::/item_locations/inventory::5'])(
            'ignores a slot that does not name an item: %s',
            (hash) => expect(tracker.extractItemHrid(hash)).toBeNull()
        );
    }
);

describe.each([coinifyHistoryTracker, decomposeHistoryTracker])('alchemy history enhancement levels', (tracker) => {
    test.each([
        [`161296::/item_locations/inventory::${ITEM}::5`, 5],
        [`/item_locations/inventory::${ITEM}::5`, 5],
        [`161296::/item_locations/inventory::${ITEM}::-3`, 0],
        [`161296::/item_locations/inventory::${ITEM}::invalid`, 0],
        [ITEM, 0],
        [null, 0],
        [42, 0],
    ])('keeps the level policy for %s', (hash, expected) => {
        expect(tracker.extractEnhancementLevel(hash)).toBe(expected);
    });
});
