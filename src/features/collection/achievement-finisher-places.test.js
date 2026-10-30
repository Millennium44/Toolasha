/**
 * Place-to-go achievements: Homeowner, Labyrinth Explorer, Dungeon Elitist, Charmed and Midas Touch
 * resolve to a `place` and are ready unless a dungeon's level gate says not.
 */

import { describe, test, expect } from 'vitest';

import { resolveAchievement, readiness } from './achievement-finisher-resolve.js';
import { PLACE_ACHIEVEMENTS as A, PLACE_DATA as D } from './__fixtures__/achievement-finisher-places.js';

const get = (slug) => A[`/achievements/${slug}`];
const ctx = (over = {}) => ({
    skillLevels: new Map(),
    combatLevel: 85,
    inventory: [],
    ironCow: false,
    buyPrice: () => null,
    houseRooms: new Map(),
    ...over,
});

describe('place-to-go achievements', () => {
    test('house and labyrinth carry the level and floor from the steam id', () => {
        expect(resolveAchievement(get('build_room_level_3'), D)).toMatchObject({
            kind: 'place',
            place: 'house',
            target: 3,
        });
        expect(resolveAchievement(get('labyrinth_floor_4'), D)).toMatchObject({
            kind: 'place',
            place: 'labyrinth',
            target: 4,
        });
    });

    test('house: the highest room built; no rooms is 0, unloaded rooms are unknown', () => {
        const res = resolveAchievement(get('build_room_level_3'), D);
        const rooms = new Map([
            ['/house_rooms/brewery', { houseRoomHrid: '/house_rooms/brewery', level: 2 }],
            ['/house_rooms/forge', { houseRoomHrid: '/house_rooms/forge', level: 1 }],
            ['/house_rooms/kitchen', { houseRoomHrid: '/house_rooms/kitchen', level: 2 }],
        ]);
        expect(readiness(res, ctx({ houseRooms: rooms })).houseLevel).toBe(2);
        expect(readiness(res, ctx({ houseRooms: new Map() })).houseLevel).toBe(0);
        expect(readiness(res, ctx({ houseRooms: null })).houseLevel).toBeNull();
    });

    test('dungeon elitist: dungeons offered at the tier, game order; target from the catalog', () => {
        const res = resolveAchievement(get('clear_t1_dungeon_10_times'), D);
        expect(res).toMatchObject({ kind: 'place', place: 'dungeon', tier: 1, target: 10 });
        expect(res.candidates.map((c) => c.actionHrid)).toEqual([
            '/actions/combat/chimerical_den',
            '/actions/combat/sinister_circus',
        ]);
    });

    test('dungeon elitist: the first dungeon whose requirement is met, else the first', () => {
        const res = resolveAchievement(get('clear_t1_dungeon_10_times'), D);
        const met = readiness(res, ctx({ combatLevel: 95 }));
        expect(met).toMatchObject({ actionHrid: '/actions/combat/chimerical_den', levelMet: true });
        // Only the later one met: it is picked over the earlier
        const reordered = {
            ...res,
            candidates: [res.candidates[1], res.candidates[0]].map((c, i) =>
                i === 0 ? { ...c, requirement: { skillHrid: '/skills/combat', level: 99 } } : c
            ),
        };
        expect(readiness(reordered, ctx({ combatLevel: 85 })).actionHrid).toBe('/actions/combat/chimerical_den');
        const none = readiness(res, ctx({ combatLevel: 50 }));
        expect(none).toMatchObject({ actionHrid: '/actions/combat/chimerical_den', levelMet: false });
        expect(none.level).toMatchObject({ need: 80, have: 50 });
        // Combat level unknown: unknown, not met
        expect(readiness(res, ctx({ combatLevel: null, skillLevels: null })).levelMet).toBeNull();
    });

    test('dungeon elitist with no dungeon offered at the tier stays unresolved', () => {
        const data = {
            ...D,
            actionDetailMap: { '/actions/combat/practice_den': D.actionDetailMap['/actions/combat/practice_den'] },
        };
        expect(resolveAchievement(get('clear_t1_dungeon_10_times'), data)).toBeNull();
    });

    test('charmed: trainee charms with a coin price, cheapest first; non-coin entries unpriced, masters out', () => {
        const res = resolveAchievement(get('buy_trainee_charm'), D);
        expect(res.candidates.map((c) => [c.itemHrid, c.coinCost])).toEqual([
            ['/items/trainee_milking_charm', 200000],
            ['/items/trainee_alchemy_charm', 250000],
            ['/items/trainee_cooking_charm', null],
        ]);
        expect(readiness(res, ctx())).toMatchObject({ charmHrid: '/items/trainee_milking_charm', cost: 200000 });
        // No shop map: still a place to go, with no charm named
        const bare = resolveAchievement(get('buy_trainee_charm'), { ...D, shopItemDetailMap: undefined });
        expect(bare.candidates).toEqual([]);
        expect(readiness(bare, ctx())).toMatchObject({ charmHrid: null, cost: null, owned: true });
    });

    test('midas touch is a place, not an alchemy item named "coins 1m"', () => {
        expect(resolveAchievement(get('coinify_coins_1m'), D)).toMatchObject({
            kind: 'place',
            place: 'coinify',
            target: 1000000,
        });
        // A missing target falls back to the 1M the id names
        expect(resolveAchievement({ ...get('coinify_coins_1m'), target: undefined }, D).target).toBe(1000000);
    });

    test('a description alone never makes a place: only the exact steam ids do', () => {
        expect(
            resolveAchievement({ ...get('labyrinth_floor_4'), steamAchievementId: 'ach_labyrinth_x' }, D)
        ).toBeNull();
        expect(resolveAchievement({ ...get('coinify_coins_1m'), steamAchievementId: '' }, D)).toBeNull();
    });
});
