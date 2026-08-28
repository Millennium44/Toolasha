/**
 * The fold is the whole arithmetic of this recorder — everything else is
 * storage plumbing already covered where it lives — so that is what is tested
 * here: several openings of the same chest have to accumulate rather than
 * replace, and a message that says nothing must not create a row that claims
 * something.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { foldOpening } from './chest-opening-recorder.js';

/** What the fake chunked store was handed to write, for the ownership tests below */
const hoisted = vi.hoisted(() => ({ saved: [] }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        isQuotaExceeded: () => false,
        get: async (_key, _store, fallback = null) => fallback,
        set: async () => true,
        getJSON: async (_key, _store, fallback = null) => fallback,
        setJSON: async () => true,
        flushAll: async () => {},
    },
}));

// The rows are the subject here, not where they end up; the chunked store has its
// own tests and reaching IndexedDB would only make these slower and flakier
vi.mock('../../utils/chunked-history.js', () => ({
    timeChunkId: () => '2026-08',
    createChunkedHistory: () => ({
        load: async () => [],
        save: (_charId, rows) => hoisted.saved.push(...rows),
        forget: () => {},
    }),
}));

/** A blank day row */
const row = () => ({ d: '2026-08-20', openings: {} });

describe('foldOpening', () => {
    test('records how many were opened and everything that came out', () => {
        const day = foldOpening(row(), '/items/purple_chest', 2, [
            { itemHrid: '/items/cheese', count: 10 },
            { itemHrid: '/items/coin', count: 500 },
        ]);

        expect(day.openings['/items/purple_chest']).toEqual({
            count: 2,
            gained: { '/items/cheese': 10, '/items/coin': 500 },
        });
    });

    test('a second opening of the same chest adds to the first', () => {
        const day = foldOpening(row(), '/items/purple_chest', 1, [{ itemHrid: '/items/cheese', count: 4 }]);
        foldOpening(day, '/items/purple_chest', 3, [
            { itemHrid: '/items/cheese', count: 6 },
            { itemHrid: '/items/milk', count: 1 },
        ]);

        expect(day.openings['/items/purple_chest']).toEqual({
            count: 4,
            gained: { '/items/cheese': 10, '/items/milk': 1 },
        });
    });

    test('different chests are kept apart, because they are priced apart', () => {
        const day = foldOpening(row(), '/items/purple_chest', 1, [{ itemHrid: '/items/cheese', count: 1 }]);
        foldOpening(day, '/items/blue_chest', 5, [{ itemHrid: '/items/milk', count: 2 }]);

        expect(Object.keys(day.openings)).toEqual(['/items/purple_chest', '/items/blue_chest']);
        expect(day.openings['/items/blue_chest'].count).toBe(5);
    });

    test('an opening that paid nothing is still an opening, and costs what it cost', () => {
        const day = foldOpening(row(), '/items/purple_chest', 1, []);
        expect(day.openings['/items/purple_chest']).toEqual({ count: 1, gained: {} });
    });

    test('a message with no chest or no count leaves the row untouched', () => {
        expect(foldOpening(row(), '', 2, []).openings).toEqual({});
        expect(foldOpening(row(), '/items/purple_chest', 0, []).openings).toEqual({});
        expect(foldOpening(row(), '/items/purple_chest', undefined, []).openings).toEqual({});
    });

    test('a nameless or empty gained entry is skipped rather than counted as one', () => {
        const day = foldOpening(row(), '/items/purple_chest', 1, [
            { count: 5 },
            { itemHrid: '/items/cheese', count: 0 },
            { itemHrid: '/items/milk', count: 2 },
        ]);
        expect(day.openings['/items/purple_chest'].gained).toEqual({ '/items/milk': 2 });
    });
});

/**
 * A chest the departing character opened, arriving after the switch.
 *
 * `_forget()` on `character_switching` already stops the departing character's
 * rows being written under the arriving character's key. It cannot help with
 * this one: by the time the message lands, the rows are the new character's and
 * `getCurrentCharacterId()` names the new character, so the opening is filed —
 * silently, and permanently — under whoever happened to be switched to. The only
 * thing that tells the two apart is the socket it came from.
 *
 * Driven through the real WebSocket hook rather than by calling the handler, so
 * what is covered is the whole path: hook → socket context → the ownership check
 * → the row that does or does not get written.
 */
describe('an opening from the old character’s socket', () => {
    const socketOld = { url: 'wss://api.milkywayidle.com/ws', id: 'old' };
    const socketNew = { url: 'wss://api.milkywayidle.com/ws', id: 'new' };

    /** One chest opening, as the server sends it. */
    const lootMessage = (chestHrid) =>
        JSON.stringify({
            type: 'loot_opened',
            openedItem: { itemHrid: chestHrid, count: 1 },
            gainedItems: [{ itemHrid: '/items/coin', count: 500 }],
        });

    beforeEach(async () => {
        const { default: dataManager } = await import('../../core/data-manager.js');
        const { default: recorder } = await import('./chest-opening-recorder.js');

        hoisted.saved = [];
        recorder.cleanup();
        recorder._rows = [];
        recorder._charId = null;
        recorder._loading = null;

        // The state an accepted init_character_data leaves behind: the arriving
        // character, owned by the socket that announced them
        dataManager.currentCharacterId = 'char-new';
        dataManager.activeSocket = socketNew;
    });

    afterEach(async () => {
        const { default: dataManager } = await import('../../core/data-manager.js');
        const { default: recorder } = await import('./chest-opening-recorder.js');
        recorder.cleanup();
        dataManager.activeSocket = null;
        dataManager.currentCharacterId = null;
    });

    test('is not recorded against the character that was switched to', async () => {
        const { default: webSocketHook } = await import('../../core/websocket.js');
        const { default: recorder } = await import('./chest-opening-recorder.js');
        await recorder.initialize();

        webSocketHook.processMessage(lootMessage('/items/purple_chest'), socketOld);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(recorder._rows).toEqual([]);
        expect(hoisted.saved).toEqual([]);
    });

    test("but the same opening on the active character's socket is", async () => {
        const { default: webSocketHook } = await import('../../core/websocket.js');
        const { default: recorder } = await import('./chest-opening-recorder.js');
        await recorder.initialize();

        webSocketHook.processMessage(lootMessage('/items/purple_chest'), socketNew);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(recorder._rows).toHaveLength(1);
        expect(recorder._rows[0].openings['/items/purple_chest']).toEqual({
            count: 1,
            gained: { '/items/coin': 500 },
        });
    });
});
