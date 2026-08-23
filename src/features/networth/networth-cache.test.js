/**
 * The enhancement-cost cache, and whose cost it is holding.
 *
 * The key was the item and the target level, which is only half the question:
 * what a +10 costs depends on the enhancer — their level, gear, tea and
 * Observatory. Two characters, or one character before and after re-gearing,
 * asked the same question and got each other's answer.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
    characterId: 'alice',
    params: { level: 140, tea: 'blessed' },
    switchHandler: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => state.characterId,
        on: (event, handler) => {
            if (event === 'character_switching') state.switchHandler = handler;
        },
    },
}));
vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: () => state.params,
}));

const networthCache = (await import('./networth-cache.js')).default;

/**
 * Move past the window the params fingerprint is memoised for.
 *
 * The fingerprint is held for a moment so a sweep of hundreds of items does not
 * rebuild it per item; a test changing the enhancer has to outlive that.
 */
function afterTheMemo() {
    vi.advanceTimersByTime(2000);
}

beforeEach(() => {
    vi.useFakeTimers();
    state.characterId = 'alice';
    state.params = { level: 140, tea: 'blessed' };
    networthCache.clear();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the cache key', () => {
    test('separates two characters asking the same question', () => {
        networthCache.set('/items/sword', 10, 5000);
        expect(networthCache.get('/items/sword', 10)).toBe(5000);

        state.characterId = 'bob';
        afterTheMemo();
        expect(networthCache.get('/items/sword', 10)).toBeNull();

        networthCache.set('/items/sword', 10, 9000);
        expect(networthCache.get('/items/sword', 10)).toBe(9000);

        state.characterId = 'alice';
        afterTheMemo();
        expect(networthCache.get('/items/sword', 10)).toBe(5000);
    });

    test('separates one character before and after their enhancing setup changes', () => {
        networthCache.set('/items/sword', 10, 5000);

        state.params = { level: 40, tea: 'none' };
        afterTheMemo();
        expect(networthCache.get('/items/sword', 10)).toBeNull();

        state.params = { level: 140, tea: 'blessed' };
        afterTheMemo();
        expect(networthCache.get('/items/sword', 10)).toBe(5000);
    });

    test('does not read the params afresh for every item of a sweep', () => {
        const key = networthCache.generateKey('/items/a', 1);
        state.params = { level: 40, tea: 'none' };
        // Same moment, so the memoised fingerprint still stands
        expect(networthCache.generateKey('/items/a', 1)).toBe(key);
    });
});

describe('a character switch', () => {
    test('empties the cache rather than leaving the old entries to age out', () => {
        networthCache.set('/items/sword', 10, 5000);
        expect(networthCache.getStats().size).toBe(1);

        state.switchHandler({ oldId: 'alice', newId: 'bob' });

        expect(networthCache.getStats().size).toBe(0);
    });
});
