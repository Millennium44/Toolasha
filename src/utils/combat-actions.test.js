import { describe, test, expect } from 'vitest';
import { compareActionQueueOrder, runningAction, runningCombatAction, lastUsedTierForZone } from './combat-actions.js';

describe('the live party-fight queue after a drag reorder', () => {
    // MillenniumTest on the test server, right after dragging Apple Gummy from
    // the last queued slot to the first. The game's own list read: Pirate Cove,
    // Apple Gummy, Philosopher's Ring, Furious Spear. Sorting by ordinal alone
    // put Apple Gummy first and the header pill judged cooking.
    const PIRATE_COVE = {
        id: 23384280,
        actionHrid: '/actions/combat/pirate_cove',
        ordinal: 0,
        partyID: 5530,
        isDone: false,
    };
    const APPLE_GUMMY = {
        id: 23502584,
        actionHrid: '/actions/cooking/apple_gummy',
        ordinal: -4294967077,
        partyID: 0,
        isDone: false,
    };
    const RING = { id: 3, actionHrid: '/actions/crafting/philosophers_ring', ordinal: 219, partyID: 0, isDone: false };
    const SPEAR = {
        id: 4,
        actionHrid: '/actions/crafting/furious_spear_refined',
        ordinal: 220,
        partyID: 0,
        isDone: false,
    };
    // The order an ordinal-only sort produced
    const queue = () => [APPLE_GUMMY, PIRATE_COVE, RING, SPEAR].map((action) => ({ ...action }));

    test('the running action is the party fight, not the lower-ordinal solo action', () => {
        expect(runningAction(queue()).actionHrid).toBe('/actions/combat/pirate_cove');
        expect(runningCombatAction(queue()).actionHrid).toBe('/actions/combat/pirate_cove');
    });

    test('sorting with the comparator reproduces the game list', () => {
        expect(
            queue()
                .sort(compareActionQueueOrder)
                .map((action) => action.id)
        ).toEqual([PIRATE_COVE.id, APPLE_GUMMY.id, RING.id, SPEAR.id]);
    });

    test('once the party fight is done, the moved action runs next', () => {
        const actions = queue().map((action) => (action.partyID ? { ...action, isDone: true } : action));
        expect(runningAction(actions).actionHrid).toBe('/actions/cooking/apple_gummy');
        expect(runningCombatAction(actions)).toBeNull();
    });

    test('a queue with no party action still runs the lowest ordinal', () => {
        const actions = [
            { ...RING },
            { ...APPLE_GUMMY },
            { id: 9, actionHrid: '/actions/combat/fly', ordinal: 0, partyID: 0, isDone: false },
        ];
        expect(runningAction(actions).actionHrid).toBe('/actions/cooking/apple_gummy');
    });
});

describe('compareActionQueueOrder', () => {
    test('party first, then ordinal; missing fields count as 0', () => {
        expect(compareActionQueueOrder({ partyID: 1, ordinal: 9 }, { partyID: 0, ordinal: -9 })).toBeLessThan(0);
        expect(compareActionQueueOrder({ partyID: 0, ordinal: -9 }, { partyID: 1, ordinal: 9 })).toBeGreaterThan(0);
        expect(compareActionQueueOrder({ ordinal: 1 }, { ordinal: 2 })).toBeLessThan(0);
        expect(compareActionQueueOrder({ partyID: 0, ordinal: 1 }, { ordinal: 1 })).toBe(0);
        expect(compareActionQueueOrder({}, { ordinal: 1 })).toBeLessThan(0);
    });
});

describe('runningCombatAction', () => {
    test('picks the lowest-ordinal unfinished combat action, not the first in the array', () => {
        // The queue that produced the "9 to boss on a dungeon" bug: a long-run
        // repeat (Sorcerer's Tower) sits first in the array with the highest
        // ordinal, while the dungeon actually running has a lower ordinal.
        const actions = [
            { actionHrid: '/actions/combat/sorcerers_tower', isDone: false, ordinal: 8589934588, difficultyTier: 0 },
            { actionHrid: '/actions/combat/chimerical_den', isDone: false, ordinal: 8589934587, difficultyTier: 2 },
            { actionHrid: '/actions/combat/chimerical_den', isDone: false, ordinal: 0, difficultyTier: 2 },
        ];
        expect(runningCombatAction(actions).actionHrid).toBe('/actions/combat/chimerical_den');
    });

    test('ignores finished combat actions by default', () => {
        const actions = [
            { actionHrid: '/actions/combat/chimerical_den', isDone: true, ordinal: 0 },
            { actionHrid: '/actions/combat/sorcerers_tower', isDone: false, ordinal: 5 },
        ];
        expect(runningCombatAction(actions).actionHrid).toBe('/actions/combat/sorcerers_tower');
    });

    test('a running combat action among other unfinished types is still found', () => {
        const actions = [
            { actionHrid: '/actions/cheesesmithing/holy_cheese', isDone: true, ordinal: 0 },
            { actionHrid: '/actions/combat/fly', isDone: false, ordinal: 3 },
        ];
        expect(runningCombatAction(actions).actionHrid).toBe('/actions/combat/fly');
    });

    test('a queued combat action behind a running non-combat one is not "running" — the live bug', () => {
        // The exact live queue that armed the dungeon tracker on a crafting
        // character: array order (foraging, dungeon, cheesesmithing) does not
        // match ordinal order, and the lowest ordinal — the one actually
        // running — is the cheesesmithing action, not the queued dungeon.
        const actions = [
            { actionHrid: '/actions/foraging/asteroid_belt', isDone: false, ordinal: -3, currentCount: 18333 },
            { actionHrid: '/actions/combat/sinister_circus', isDone: false, ordinal: -2, currentCount: 0 },
            {
                actionHrid: '/actions/cheesesmithing/griffin_bulwark',
                isDone: false,
                ordinal: -4,
                currentCount: 17,
                maxCount: 219,
            },
        ];
        // Nothing combat is running: the running action is the cheesesmithing one.
        expect(runningCombatAction(actions)).toBeNull();
    });

    test('returns null when every combat action is finished and finished are not included', () => {
        const actions = [{ actionHrid: '/actions/combat/fly', isDone: true, ordinal: 0 }];
        expect(runningCombatAction(actions)).toBeNull();
    });

    test('falls back to the lowest-ordinal finished action when includeFinished is set', () => {
        const actions = [
            { actionHrid: '/actions/combat/fly', isDone: true, ordinal: 7 },
            { actionHrid: '/actions/combat/chimerical_den', isDone: true, ordinal: 2 },
        ];
        expect(runningCombatAction(actions, { includeFinished: true }).actionHrid).toBe(
            '/actions/combat/chimerical_den'
        );
    });

    test('unfinished still wins over finished even when includeFinished is set', () => {
        const actions = [
            { actionHrid: '/actions/combat/chimerical_den', isDone: true, ordinal: 0 },
            { actionHrid: '/actions/combat/sorcerers_tower', isDone: false, ordinal: 9 },
        ];
        expect(runningCombatAction(actions, { includeFinished: true }).actionHrid).toBe(
            '/actions/combat/sorcerers_tower'
        );
    });

    test('returns null for empty or non-array input', () => {
        expect(runningCombatAction([])).toBeNull();
        expect(runningCombatAction(null)).toBeNull();
        expect(runningCombatAction(undefined)).toBeNull();
    });
});

describe('runningAction', () => {
    test('with no predicate it is the front of the whole queue, not queue[0]', () => {
        // A repeating action requeued to the front of the array with the
        // highest ordinal is exactly what queue[0] mistook for "active".
        const actions = [
            { actionHrid: '/actions/cheesesmithing/holy_cheese', isDone: false, ordinal: 8589934588 },
            { actionHrid: '/actions/combat/chimerical_den', isDone: false, ordinal: 0 },
        ];
        expect(runningAction(actions).actionHrid).toBe('/actions/combat/chimerical_den');
    });

    test('a predicate narrows to a kind of action and still picks the running one among them', () => {
        // Two enhancing actions queued for different items: array order has the
        // queued one first, execution order has the running one first. The
        // combat entry is already finished (a previous zone), so it drops out
        // of the unfinished pool entirely rather than being the running action.
        const enhance = (a) => a.actionHrid === '/actions/enhancing/enhance';
        const actions = [
            { actionHrid: '/actions/enhancing/enhance', primaryItemHash: 'queued::5', isDone: false, ordinal: 9 },
            { actionHrid: '/actions/combat/fly', isDone: true, ordinal: 1 },
            { actionHrid: '/actions/enhancing/enhance', primaryItemHash: 'running::7', isDone: false, ordinal: 3 },
        ];
        expect(runningAction(actions, enhance)?.primaryItemHash).toBe('running::7');
    });

    test('the running action is a different type than the predicate: nothing of that type is running', () => {
        // Same shape as above, but the truly running action (lowest ordinal
        // overall) is the combat one, not an enhance — the queue is a single
        // execution timeline, so neither enhance entry is "running" even
        // though both match the predicate and one has a lower ordinal than
        // the other.
        const enhance = (a) => a.actionHrid === '/actions/enhancing/enhance';
        const actions = [
            { actionHrid: '/actions/enhancing/enhance', primaryItemHash: 'queued::5', isDone: false, ordinal: 9 },
            { actionHrid: '/actions/combat/fly', isDone: false, ordinal: 1 },
            { actionHrid: '/actions/enhancing/enhance', primaryItemHash: 'also-queued::7', isDone: false, ordinal: 3 },
        ];
        expect(runningAction(actions, enhance)).toBeNull();
    });

    test('no action matching the predicate is null, even when the queue is not empty', () => {
        const actions = [{ actionHrid: '/actions/combat/fly', isDone: false, ordinal: 0 }];
        expect(runningAction(actions, (a) => a.actionHrid.startsWith('/actions/alchemy/'))).toBeNull();
    });

    test('finished matches are ignored unless includeFinished asks for them as a fallback', () => {
        const alchemy = (a) => a.actionHrid.startsWith('/actions/alchemy/');
        const finished = [{ actionHrid: '/actions/alchemy/coinify', isDone: true, ordinal: 0 }];
        expect(runningAction(finished, alchemy)).toBeNull();
        expect(runningAction(finished, alchemy, { includeFinished: true }).actionHrid).toBe('/actions/alchemy/coinify');
    });

    test('returns null for empty or non-array input', () => {
        expect(runningAction([])).toBeNull();
        expect(runningAction(null)).toBeNull();
        expect(runningAction(undefined)).toBeNull();
    });
});

describe('lastUsedTierForZone: the last tier the player set on a zone, read from their own queue', () => {
    test('a running copy of the zone reports its tier', () => {
        const actions = [{ actionHrid: '/actions/combat/gobo_planet', difficultyTier: 3, isDone: false, ordinal: 0 }];
        expect(lastUsedTierForZone(actions, '/actions/combat/gobo_planet')).toBe(3);
    });

    test('a merely queued (not yet running) copy counts just as much as a running one', () => {
        const actions = [
            { actionHrid: '/actions/cooking/apple_gummy', isDone: false, ordinal: 0 },
            { actionHrid: '/actions/combat/gobo_planet', difficultyTier: 2, isDone: false, ordinal: 9 },
        ];
        expect(lastUsedTierForZone(actions, '/actions/combat/gobo_planet')).toBe(2);
    });

    test('a zone with no difficultyTier field is a real, known T0 — not "unknown"', () => {
        const actions = [{ actionHrid: '/actions/combat/fly_zone', isDone: false, ordinal: 0 }];
        expect(lastUsedTierForZone(actions, '/actions/combat/fly_zone')).toBe(0);
    });

    test('the zone is nowhere in the queue: null, never a guessed tier', () => {
        const actions = [{ actionHrid: '/actions/combat/pirate_cove', difficultyTier: 1, isDone: false, ordinal: 0 }];
        expect(lastUsedTierForZone(actions, '/actions/combat/gobo_planet')).toBeNull();
    });

    test('two copies of the same zone in the queue: the earlier in execution order wins', () => {
        const actions = [
            { actionHrid: '/actions/combat/gobo_planet', difficultyTier: 5, isDone: false, ordinal: 9, partyID: 0 },
            { actionHrid: '/actions/combat/gobo_planet', difficultyTier: 1, isDone: false, ordinal: 0, partyID: 0 },
        ];
        expect(lastUsedTierForZone(actions, '/actions/combat/gobo_planet')).toBe(1);
    });

    test('empty, null or non-array input, or a missing zoneHrid, is null rather than throwing', () => {
        expect(lastUsedTierForZone([], '/actions/combat/gobo_planet')).toBeNull();
        expect(lastUsedTierForZone(null, '/actions/combat/gobo_planet')).toBeNull();
        expect(lastUsedTierForZone([{ actionHrid: '/actions/combat/gobo_planet' }], '')).toBeNull();
    });
});
