/** @vitest-environment happy-dom */

/**
 * The reroll ledger is one character's spend.
 *
 * Under a bare key the market cow's gold rerolls and the iron cow's cowbell
 * rerolls landed in the same map, keyed only by task id — and task ids do not
 * say whose task they were. These cover the scoping, and the one-time adoption
 * of the pre-scoping record: a merged map cannot be partitioned after the fact,
 * so the whole of it goes to the main character rather than being split by a
 * guess or thrown away.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: 'market123',
    gameMode: 'standard',
}));

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        reset: () => stores.clear(),
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const held = storeFor(store).get(key);
            return held === undefined || held === null ? fallback : held;
        }),
        getJSON: vi.fn(async (key, store = 'settings', fallback = null) => {
            const held = storeFor(store).get(key);
            return held === undefined || held === null ? fallback : held;
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, value);
            return true;
        }),
        setJSON: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, value);
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => storeFor(store).delete(key)),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
});

// Adoption is consent-gated now; these suites test the data plumbing,
// so the decision is treated as already made for the main character.
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterGameMode: () => game.gameMode,
        getInitClientData: () => ({}),
        characterData: null,
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, COLOR_TEXT_SECONDARY: '#888' } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../utils/dom.js', () => ({ addStyles: () => {} }));

const { default: tracker } = await import('./task-reroll-tracker.js');
const { _resetAdoptionCache } = await import('../../utils/character-key.js');

const spend = () => storageMock.storeFor('rerollSpending');

beforeEach(() => {
    storageMock.reset();
    game.characterId = 'market123';
    game.gameMode = 'standard';
    _resetAdoptionCache();
    tracker.taskRerollData.clear();
});

describe('scoping', () => {
    test('a load reads this character’s map, not another’s', async () => {
        spend().set('taskRerollData_market123', { 1: { coinRerollCount: 2, cowbellRerollCount: 0 } });
        spend().set('taskRerollData_iron456', { 9: { coinRerollCount: 7, cowbellRerollCount: 0 } });

        await tracker.loadFromStorage();

        expect([...tracker.taskRerollData.keys()]).toEqual([1]);
    });

    test('a save writes under the key of whoever is current, resolved at write time', async () => {
        tracker.taskRerollData.set(1, { coinRerollCount: 2, cowbellRerollCount: 0 });
        await tracker.saveToStorage();

        game.characterId = 'iron456';
        tracker.taskRerollData.clear();
        tracker.taskRerollData.set(9, { coinRerollCount: 1, cowbellRerollCount: 0 });
        await tracker.saveToStorage();

        expect(Object.keys(spend().get('taskRerollData_market123'))).toEqual(['1']);
        expect(Object.keys(spend().get('taskRerollData_iron456'))).toEqual(['9']);
    });

    test('the history is scoped the same way', async () => {
        await tracker.appendToHistory([{ taskId: 1, goldSpent: 10000 }]);

        expect(spend().get('taskRerollHistory_market123')).toHaveLength(1);
        expect(spend().has('taskRerollHistory')).toBe(false);
    });
});

describe('adopting the pre-scoping record', () => {
    test('the main character inherits the merged map exactly once', async () => {
        spend().set('taskRerollData', { 1: { coinRerollCount: 3, cowbellRerollCount: 1 } });

        await tracker.loadFromStorage();

        expect(tracker.taskRerollData.get(1)).toEqual({ coinRerollCount: 3, cowbellRerollCount: 1 });
        expect(spend().get('taskRerollData_market123')).toEqual({ 1: { coinRerollCount: 3, cowbellRerollCount: 1 } });
        expect(spend().has('taskRerollData')).toBe(false);
    });

    test('the history is adopted alongside it', async () => {
        spend().set('taskRerollHistory', [{ taskId: 1, goldSpent: 10000 }]);

        expect(await tracker.loadHistory()).toEqual([{ taskId: 1, goldSpent: 10000 }]);
        expect(spend().get('taskRerollHistory_market123')).toHaveLength(1);
        expect(spend().has('taskRerollHistory')).toBe(false);
    });

    test('an iron cow starts clean and leaves the legacy record for the main', async () => {
        game.characterId = 'iron456';
        game.gameMode = 'ironcow';
        spend().set('taskRerollData', { 1: { coinRerollCount: 3, cowbellRerollCount: 1 } });

        await tracker.loadFromStorage();

        expect(tracker.taskRerollData.size).toBe(0);
        expect(spend().get('taskRerollData')).toEqual({ 1: { coinRerollCount: 3, cowbellRerollCount: 1 } });
        expect(spend().has('taskRerollData_iron456')).toBe(false);
    });
});

describe('cleanup', () => {
    test('drops the map, so the next character does not save this one’s rows', () => {
        tracker.taskRerollData.set(1, { coinRerollCount: 2, cowbellRerollCount: 0 });

        tracker.cleanup();

        expect(tracker.taskRerollData.size).toBe(0);
    });
});
