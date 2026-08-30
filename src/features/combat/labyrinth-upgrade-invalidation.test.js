import { describe, test, expect } from 'vitest';

import {
    isGearCandidate,
    applyGearCandidate,
    wornFingerprintInput,
    projectedFingerprint,
    roomOfCacheKey,
    rankInvalidatedRooms,
    describeInvalidatedRooms,
    CLOSE_TO_BAR_PP,
} from './labyrinth-upgrade-invalidation.js';

/**
 * The djb2 hash `labyrinth-recommendation.js` uses, standing in for the live
 * one. Only its determinism matters here — the projection is tested by whether
 * it hashes the same input the real change would.
 * @param {string} value - What to hash
 * @returns {string}
 */
function hash(value) {
    let h = 5381;
    for (let i = 0; i < value.length; i++) h = (h * 33) ^ value.charCodeAt(i);
    return String(h >>> 0);
}

/** One worn item */
const equip = (itemHrid, enhancementLevel = 0) => ({ itemHrid, enhancementLevel });

/** A cached room result */
const entry = (key, clearChance, over = {}) => ({
    key,
    result: { clearChance, monsterName: 'Imp', roomLevel: 200, trials: 4000, halfWidth: 0.01, ...over },
});

describe('coverage', () => {
    test('worn-item and enhancement candidates are covered', () => {
        expect(isGearCandidate({ type: 'enhancement', upgradeHrid: '/items/sword', upgradeLevel: 5 })).toBe(true);
        expect(isGearCandidate({ type: 'tier', upgradeHrid: '/items/better_sword' })).toBe(true);
        expect(isGearCandidate({ type: 'cross_slot', addedSlots: {}, removedItems: [] })).toBe(true);
    });

    test('a house, ability, level, drink, shrine or buff candidate is not', () => {
        for (const type of [
            'house',
            'ability_level',
            'ability_swap',
            'combat_level',
            'drink',
            'guild_shrine',
            'community_buff',
            'scroll',
            'labyrinth_buff',
        ]) {
            expect(isGearCandidate({ type, upgradeHrid: '/items/thing' })).toBe(false);
        }
        expect(isGearCandidate(null)).toBe(false);
        expect(isGearCandidate({ type: 'tier' })).toBe(false);
    });
});

describe('the fingerprint delta', () => {
    const loadouts = [[equip('/items/sword', 3), equip('/items/hat', 0)], [equip('/items/sword', 3)]];
    const stored = '{"a":1}';

    test('an enhancement candidate replaces the worn item at its level', () => {
        const after = applyGearCandidate(loadouts[0], {
            type: 'enhancement',
            currentHrid: '/items/sword',
            currentLevel: 3,
            upgradeHrid: '/items/sword',
            upgradeLevel: 5,
        });
        expect(wornFingerprintInput([after])).toBe('/items/hat+0,/items/sword+5');
    });

    test('a tier candidate swaps the item and keeps the level', () => {
        const after = applyGearCandidate(loadouts[0], {
            type: 'tier',
            currentHrid: '/items/sword',
            currentLevel: 3,
            upgradeHrid: '/items/better_sword',
            upgradeLevel: 3,
        });
        expect(wornFingerprintInput([after])).toBe('/items/hat+0,/items/better_sword+3');
    });

    test('a cross-slot candidate removes both hands and adds the two-hander', () => {
        const hands = [equip('/items/main', 2), equip('/items/off', 1), equip('/items/hat', 0)];
        const after = applyGearCandidate(hands, {
            type: 'cross_slot',
            currentHrid: '/items/main',
            currentLevel: 2,
            upgradeHrid: '/items/two_hander',
            upgradeLevel: 2,
            addedSlots: { '/equipment_types/two_hand': { hrid: '/items/two_hander', enhancementLevel: 2 } },
            removedItems: [
                { hrid: '/items/main', enhancementLevel: 2 },
                { hrid: '/items/off', enhancementLevel: 1 },
            ],
        });
        expect(wornFingerprintInput([after])).toBe('/items/hat+0,/items/two_hander+2');
    });

    test('a loadout not wearing the item comes back untouched', () => {
        const other = [equip('/items/staff', 0)];
        const after = applyGearCandidate(other, {
            type: 'enhancement',
            currentHrid: '/items/sword',
            currentLevel: 3,
            upgradeHrid: '/items/sword',
            upgradeLevel: 5,
        });
        expect(after).toEqual(other);
    });

    test('the projected fingerprint differs from the current one for a real change', () => {
        const current = hash(`${stored}||${wornFingerprintInput(loadouts)}`);
        const projected = projectedFingerprint(
            { stored, loadouts },
            {
                type: 'enhancement',
                currentHrid: '/items/sword',
                currentLevel: 3,
                upgradeHrid: '/items/sword',
                upgradeLevel: 5,
            },
            hash
        );

        expect(projected).not.toBe(current);
    });

    test('a candidate that changes nothing worn hashes to the same fingerprint', () => {
        const current = hash(`${stored}||${wornFingerprintInput(loadouts)}`);
        // An upgrade for an item this character does not wear in any loadout
        const projected = projectedFingerprint(
            { stored, loadouts },
            {
                type: 'tier',
                currentHrid: '/items/spear',
                currentLevel: 0,
                upgradeHrid: '/items/better_spear',
                upgradeLevel: 0,
            },
            hash
        );

        expect(projected).toBe(current);
    });

    test('the snapshot half is hashed alongside the worn half, as the spec pins', () => {
        const candidate = {
            type: 'enhancement',
            currentHrid: '/items/sword',
            currentLevel: 3,
            upgradeHrid: '/items/sword',
            upgradeLevel: 5,
        };
        expect(projectedFingerprint({ stored, loadouts }, candidate, hash)).not.toBe(
            projectedFingerprint({ stored: '{"a":2}', loadouts }, candidate, hash)
        );
    });
});

describe('ranking by closeness to the bar', () => {
    test('one room per cache key prefix, closest to the bar first', () => {
        const summary = rankInvalidatedRooms(
            [
                entry('imp:200:1:1pp:', 0.95),
                entry('cow:150:1:1pp:', 0.705, { monsterName: 'Cow', roomLevel: 150 }),
                entry('rat:100:1:1pp:', 0.6, { monsterName: 'Rat', roomLevel: 100 }),
            ],
            { targetRate: 0.7 }
        );

        expect(summary.rooms).toBe(3);
        expect(summary.ranked.map((room) => room.name)).toEqual(['Cow', 'Rat', 'Imp']);
        expect(summary.ranked[0].gapPp).toBeCloseTo(0.5, 6);
    });

    test('a room with several cached entries is ranked by its closest one', () => {
        const summary = rankInvalidatedRooms([entry('imp:200:1:1pp:', 0.95), entry('imp:200:2:0.5pp:', 0.71)], {
            targetRate: 0.7,
        });

        expect(summary.rooms).toBe(1);
        expect(summary.ranked[0].gapPp).toBeCloseTo(1, 6);
    });

    test('counts how many sit within the closeness bound', () => {
        const summary = rankInvalidatedRooms(
            [
                entry('imp:200:1:1pp:', 0.71),
                entry('cow:150:1:1pp:', 0.69),
                entry('rat:100:1:1pp:', 0.6),
                entry('boar:120:1:1pp:', 0.95),
            ],
            { targetRate: 0.7 }
        );

        expect(summary.rooms).toBe(4);
        expect(summary.within).toBe(2);
        expect(summary.withinPp).toBe(CLOSE_TO_BAR_PP);
    });

    test('the closeness bound is injectable, and the boundary counts as within', () => {
        const entries = [entry('imp:200:1:1pp:', 0.72)];
        expect(rankInvalidatedRooms(entries, { targetRate: 0.7, withinPp: 2 }).within).toBe(1);
        expect(rankInvalidatedRooms(entries, { targetRate: 0.7, withinPp: 1.9 }).within).toBe(0);
    });

    test('carries the trial count and precision each result was decided on', () => {
        const summary = rankInvalidatedRooms([entry('imp:200:1:1pp:', 0.71)], { targetRate: 0.7 });
        expect(summary.ranked[0].trials).toBe(4000);
        expect(summary.ranked[0].halfWidthPp).toBeCloseTo(1, 6);
    });

    test('an entry with no clear chance is not a cached room result', () => {
        const summary = rankInvalidatedRooms([entry('imp:200:1:1pp:', null), { key: 'x' }, null], {
            targetRate: 0.7,
        });
        expect(summary.rooms).toBe(0);
    });

    test('an empty cache is no rooms rather than a crash', () => {
        expect(rankInvalidatedRooms(null, { targetRate: 0.7 }).rooms).toBe(0);
        expect(rankInvalidatedRooms([], { targetRate: 0.7 }).ranked).toEqual([]);
    });

    test('roomOfCacheKey keeps the monster and level and drops the rest', () => {
        expect(roomOfCacheKey('/monsters/imp:200:1:1pp:')).toBe('/monsters/imp:200');
    });
});

describe('the line', () => {
    test('names the rooms and how many are near their bar, and decides nothing', () => {
        const summary = rankInvalidatedRooms(
            [
                entry('a:1:x:', 0.71),
                entry('b:1:x:', 0.69),
                entry('c:1:x:', 0.5),
                entry('d:1:x:', 0.95),
                entry('e:1:x:', 0.3),
                entry('f:1:x:', 0.99),
            ],
            { targetRate: 0.7 }
        );

        const text = describeInvalidatedRooms(summary, true);
        expect(text).toBe('would stale 6 cached rooms, 2 within 2pp of their bar');
        // Nothing in the sentence claims an outcome for any of them
        expect(text).not.toMatch(/would (clear|fail|pass|improve)/);
    });

    test('drops the second clause when nothing is near the bar', () => {
        const summary = rankInvalidatedRooms([entry('a:1:x:', 0.95)], { targetRate: 0.7 });
        expect(describeInvalidatedRooms(summary, true)).toBe('would stale 1 cached room');
    });

    test('says nothing when the candidate would not change the fingerprint', () => {
        const summary = rankInvalidatedRooms([entry('a:1:x:', 0.95)], { targetRate: 0.7 });
        expect(describeInvalidatedRooms(summary, false)).toBe('');
    });

    test('says nothing when there is no cache to stale', () => {
        expect(describeInvalidatedRooms(rankInvalidatedRooms([], { targetRate: 0.7 }), true)).toBe('');
        expect(describeInvalidatedRooms(null, true)).toBe('');
    });
});
