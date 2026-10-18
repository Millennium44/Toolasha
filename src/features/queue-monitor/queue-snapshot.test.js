import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    currentCharacterId: 'char1',
    actions: [],
    skills: [{ skillHrid: '/skills/milking', level: 10 }],
    equipment: [],
    itemDetailMap: { '/items/x': {} },
    actionDetails: {},
    stats: { totalEfficiency: 0, actionTime: 10 },
    storedKeys: [],
    stored: {},
    dmHandlers: {},
    calls: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.currentCharacterId,
        getCurrentActions: () => game.actions,
        getSkills: () => game.skills,
        getEquipment: () => game.equipment,
        getInitClientData: () => ({ itemDetailMap: game.itemDetailMap }),
        getActionDetails: (hrid) => game.actionDetails[hrid],
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        set: (key, value, _storeName) => {
            game.stored[key] = value;
            if (!game.storedKeys.includes(key)) game.storedKeys.push(key);
        },
        get: async (key) => game.stored[key],
        getAllKeys: async () => game.storedKeys,
        getAll: async () => {
            const result = {};
            for (const key of game.storedKeys) result[key] = game.stored[key];
            return result;
        },
        delete: async (key) => {
            delete game.stored[key];
            game.storedKeys = game.storedKeys.filter((k) => k !== key);
        },
    },
}));
vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: (details, options) => {
        game.calls.push({ details, options });
        return game.stats;
    },
}));

const queueSnapshot = (await import('./queue-snapshot.js')).default;

describe('queue snapshot', () => {
    beforeEach(() => {
        game.currentCharacterId = 'char1';
        game.actions = [];
        game.skills = [{ skillHrid: '/skills/milking', level: 10 }];
        game.actionDetails = {};
        game.stats = { totalEfficiency: 0, actionTime: 10 };
        game.storedKeys = [];
        game.stored = {};
        game.dmHandlers = {};
        game.calls = [];
        queueSnapshot.snapshots = new Map();
        queueSnapshot._boundOnSwitching = null;
    });

    test('a finite action estimates remaining seconds from stats and remaining count', async () => {
        game.actionDetails['/actions/milking/basic'] = { name: 'Basic Milking' };
        game.actions = [
            {
                actionHrid: '/actions/milking/basic',
                isDone: false,
                hasMaxCount: true,
                maxCount: 100,
                currentCount: 50,
            },
        ];
        game.stats = { totalEfficiency: 0, actionTime: 10 };
        queueSnapshot.initialize();
        await Promise.resolve();

        game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' });

        const snapshot = queueSnapshot.getSnapshot('char1');
        // remaining 50, effectiveRate = 1, actionTime 10 -> 50 * 10 = 500
        expect(snapshot.actions[0].estimatedSeconds).toBe(500);
        expect(snapshot.totalQueueSeconds).toBe(500);
        expect(snapshot.hasInfiniteAction).toBe(false);
    });

    test('efficiency above zero speeds up the estimate proportionally', async () => {
        game.actionDetails['/actions/milking/basic'] = { name: 'Basic Milking' };
        game.actions = [
            { actionHrid: '/actions/milking/basic', isDone: false, hasMaxCount: true, maxCount: 100, currentCount: 0 },
        ];
        // 100% efficiency -> effectiveRate 2, so half the items needed per cycle
        game.stats = { totalEfficiency: 100, actionTime: 10 };
        queueSnapshot.initialize();
        await Promise.resolve();

        game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' });

        expect(queueSnapshot.getSnapshot('char1').actions[0].estimatedSeconds).toBe(500);
    });

    test('a counted fight is left untimed and the snapshot says its end is unknown', async () => {
        // Its count is battles; charging the stats' action time per battle read a 20-battle
        // queue as a minute of work and let the idle alert fire on a character still fighting
        game.actionDetails['/actions/combat/fly'] = { name: 'Fly', type: '/action_types/combat' };
        game.actionDetails['/actions/milking/basic'] = { name: 'Basic Milking' };
        game.actions = [
            { actionHrid: '/actions/combat/fly', isDone: false, hasMaxCount: true, maxCount: 20, currentCount: 0 },
            {
                actionHrid: '/actions/milking/basic',
                isDone: false,
                hasMaxCount: true,
                maxCount: 10,
                currentCount: 0,
                ordinal: 1,
            },
        ];
        queueSnapshot.initialize();
        await Promise.resolve();

        game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' });

        const snapshot = queueSnapshot.getSnapshot('char1');
        expect(snapshot.actions[0].estimatedSeconds).toBeNull();
        expect(snapshot.totalQueueSeconds).toBe(100);
        expect(snapshot.hasUnknownAction).toBe(true);
    });

    test('a counted action with no rate, or no details, is flagged unknown', async () => {
        game.actionDetails['/actions/milking/basic'] = { name: 'Basic Milking' };
        game.actions = [
            { actionHrid: '/actions/milking/basic', isDone: false, hasMaxCount: true, maxCount: 10, currentCount: 0 },
        ];
        game.stats = null;
        queueSnapshot.initialize();
        await Promise.resolve();
        game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' });
        expect(queueSnapshot.getSnapshot('char1').hasUnknownAction).toBe(true);

        game.stats = { totalEfficiency: 0, actionTime: 10 };
        game.actionDetails = {};
        game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' });
        expect(queueSnapshot.getSnapshot('char1').hasUnknownAction).toBe(true);
    });

    test('a counted action with no game data stays in the list as an untimed placeholder', async () => {
        game.actions = [
            { actionHrid: '/actions/mystery/x', isDone: false, hasMaxCount: true, maxCount: 10, currentCount: 0 },
        ];
        queueSnapshot.initialize();
        await Promise.resolve();

        game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' });

        const snapshot = queueSnapshot.getSnapshot('char1');
        expect(snapshot.actions).toHaveLength(1);
        expect(snapshot.actions[0].estimatedSeconds).toBeNull();
        expect(snapshot.actions[0].actionName).toBe('/actions/mystery/x');
        expect(snapshot.hasUnknownAction).toBe(true);
        expect(snapshot.totalQueueSeconds).toBe(0);
    });

    test('an endless action with no game data counts as endless, not as an empty queue', async () => {
        game.actions = [{ actionHrid: '/actions/mystery/x', isDone: false, hasMaxCount: false }];
        queueSnapshot.initialize();
        await Promise.resolve();

        game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' });

        const snapshot = queueSnapshot.getSnapshot('char1');
        expect(snapshot.actions).toHaveLength(1);
        expect(snapshot.hasInfiniteAction).toBe(true);
        expect(snapshot.hasUnknownAction).toBe(false);
    });

    test('untimed work behind an endless action is not flagged — nothing behind it runs', async () => {
        game.actionDetails['/actions/combat/fly'] = { name: 'Fly', type: '/action_types/combat' };
        game.actionDetails['/actions/milking/basic'] = { name: 'Basic Milking' };
        game.actions = [
            { actionHrid: '/actions/milking/basic', isDone: false, hasMaxCount: false, ordinal: 0 },
            { actionHrid: '/actions/combat/fly', isDone: false, hasMaxCount: true, maxCount: 20, ordinal: 1 },
        ];
        queueSnapshot.initialize();
        await Promise.resolve();

        game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' });

        expect(queueSnapshot.getSnapshot('char1').hasUnknownAction).toBe(false);
    });

    test('lists the queue in execution order, not the array’s insertion order', async () => {
        // A repeating action requeued to the front of the array with the
        // highest ordinal, ahead of the one actually running: the snapshot used
        // to list it first
        game.actionDetails['/actions/milking/basic'] = { name: 'Basic Milking' };
        game.actionDetails['/actions/combat/fly'] = { name: 'Fly' };
        game.actions = [
            { actionHrid: '/actions/milking/basic', isDone: false, hasMaxCount: false, ordinal: 8589934588 },
            { actionHrid: '/actions/combat/fly', isDone: false, hasMaxCount: false, ordinal: 0 },
        ];
        queueSnapshot.initialize();
        await Promise.resolve();

        game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' });

        const hrids = queueSnapshot.getSnapshot('char1').actions.map((entry) => entry.actionHrid);
        expect(hrids).toEqual(['/actions/combat/fly', '/actions/milking/basic']);
    });

    test('an infinite action contributes no seconds but is flagged', async () => {
        game.actionDetails['/actions/milking/basic'] = { name: 'Basic Milking' };
        game.actions = [{ actionHrid: '/actions/milking/basic', isDone: false, hasMaxCount: false }];
        queueSnapshot.initialize();
        await Promise.resolve();

        game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' });

        const snapshot = queueSnapshot.getSnapshot('char1');
        expect(snapshot.actions[0].isInfinite).toBe(true);
        expect(snapshot.actions[0].estimatedSeconds).toBeNull();
        expect(snapshot.hasInfiniteAction).toBe(true);
        expect(snapshot.totalQueueSeconds).toBe(0);
    });

    test.each([false, true])('total stops at the unbounded action, with finite prefix: %s', async (withPrefix) => {
        game.actionDetails['/actions/milking/basic'] = { name: 'Basic Milking' };
        const counted = (ordinal, maxCount, currentCount = 0) => ({
            actionHrid: '/actions/milking/basic',
            isDone: false,
            hasMaxCount: true,
            ordinal,
            maxCount,
            currentCount,
        });
        // Insertion order differs from execution order. Keep the trailing action
        // in the saved details, but it cannot delay reaching the infinite one.
        game.actions = [
            counted(2, 60),
            { actionHrid: '/actions/milking/basic', isDone: false, hasMaxCount: false, ordinal: 1 },
            ...(withPrefix ? [counted(0, 12, 6)] : []),
        ];

        await queueSnapshot._onCharacterSwitching({ oldId: 'char1', oldName: 'Someone' });

        const snapshot = queueSnapshot.getSnapshot('char1');
        expect(snapshot.hasInfiniteAction).toBe(true);
        expect(snapshot.totalQueueSeconds).toBe(withPrefix ? 60 : 0);
        expect(snapshot.actions.at(-1).estimatedSeconds).toBe(600);
        expect(snapshot.actions).toHaveLength(withPrefix ? 3 : 2);
        expect(game.stored.queueSnapshot_char1.totalQueueSeconds).toBe(withPrefix ? 60 : 0);
    });

    test('completed actions are excluded from the snapshot entirely', async () => {
        game.actionDetails['/actions/milking/basic'] = { name: 'Basic Milking' };
        game.actions = [
            { actionHrid: '/actions/milking/basic', isDone: true, hasMaxCount: true, maxCount: 10, currentCount: 10 },
        ];
        queueSnapshot.initialize();
        await Promise.resolve();

        game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' });

        expect(queueSnapshot.getSnapshot('char1').actions).toHaveLength(0);
    });

    test('an action with no resolvable details is kept as a placeholder rather than crashing', async () => {
        game.actions = [
            { actionHrid: '/actions/unknown/x', isDone: false, hasMaxCount: true, maxCount: 1, currentCount: 0 },
        ];
        queueSnapshot.initialize();
        await Promise.resolve();

        expect(() => game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' })).not.toThrow();
        expect(queueSnapshot.getSnapshot('char1').actions).toHaveLength(1);
    });

    test('an event with no oldId is ignored', async () => {
        queueSnapshot.initialize();
        await Promise.resolve();

        game.dmHandlers.character_switching({ oldId: null });

        expect(queueSnapshot.getSnapshot('char1')).toBeNull();
    });

    test('missing skills or item data aborts the snapshot without throwing', async () => {
        game.skills = null;
        queueSnapshot.initialize();
        await Promise.resolve();

        expect(() => game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' })).not.toThrow();
        expect(queueSnapshot.getSnapshot('char1')).toBeNull();
    });

    test('getOtherCharacterSnapshots excludes the currently active character', async () => {
        queueSnapshot.initialize();
        await Promise.resolve();
        game.actionDetails['/actions/milking/basic'] = { name: 'Basic Milking' };
        game.actions = [];

        game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'One' });
        game.dmHandlers.character_switching({ oldId: 'char2', oldName: 'Two' });

        game.currentCharacterId = 'char1';
        const others = queueSnapshot.getOtherCharacterSnapshots();

        expect(others.map((s) => s.characterId)).toEqual(['char2']);
    });

    test('deleteSnapshot removes it from memory and storage', async () => {
        queueSnapshot.initialize();
        await Promise.resolve();
        game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'One' });
        expect(queueSnapshot.getSnapshot('char1')).not.toBeNull();

        await queueSnapshot.deleteSnapshot('char1');

        expect(queueSnapshot.getSnapshot('char1')).toBeNull();
        expect(game.stored['queueSnapshot_char1']).toBeUndefined();
    });

    test('loadSnapshots keeps the newer of two snapshots for the same character', async () => {
        game.stored['queueSnapshot_char1_old'] = {
            characterId: 'char1',
            timestamp: 100,
            actions: [],
            totalQueueSeconds: 1,
        };
        game.stored['queueSnapshot_char1_new'] = {
            characterId: 'char1',
            timestamp: 200,
            actions: [],
            totalQueueSeconds: 2,
        };
        game.storedKeys = ['queueSnapshot_char1_old', 'queueSnapshot_char1_new'];

        await queueSnapshot._loadSnapshots();

        expect(queueSnapshot.getSnapshot('char1').totalQueueSeconds).toBe(2);
    });

    describe('snapshots saved before hasUnknownAction existed', () => {
        const row = (actionHrid, estimatedSeconds, extra = {}) => ({
            actionHrid,
            actionName: actionHrid,
            maxCount: 10,
            currentCount: 0,
            hasMaxCount: true,
            estimatedSeconds,
            isInfinite: false,
            ...extra,
        });
        const load = async (snapshot) => {
            game.stored['queueSnapshot_char9'] = { characterId: 'char9', timestamp: 1, ...snapshot };
            game.storedKeys = ['queueSnapshot_char9'];
            await queueSnapshot._loadSnapshots();
            return queueSnapshot.getSnapshot('char9');
        };

        test('a counted fight ahead of everything is untimed and leaves the total', async () => {
            const snap = await load({
                actions: [row('/actions/combat/fly', 100), row('/actions/milking/basic', 30)],
                totalQueueSeconds: 130,
                hasInfiniteAction: false,
            });
            expect(snap.hasUnknownAction).toBe(true);
            expect(snap.totalQueueSeconds).toBe(30);
            expect(snap.actions[0].estimatedSeconds).toBeNull();
            expect(snap.actions[1].estimatedSeconds).toBe(30);
        });

        test('a fight behind the first endless row is untimed but the total and flag are left alone', async () => {
            const snap = await load({
                actions: [
                    row('/actions/milking/basic', 30),
                    row('/actions/foraging/x', null, { isInfinite: true, hasMaxCount: false, maxCount: null }),
                    row('/actions/combat/fly', 100),
                ],
                totalQueueSeconds: 30,
                hasInfiniteAction: true,
            });
            expect(snap.hasUnknownAction).toBe(false);
            expect(snap.totalQueueSeconds).toBe(30);
            expect(snap.actions[2].estimatedSeconds).toBeNull();
        });

        test('a fight found by action type, and three fights, all leave the total', async () => {
            game.actionDetails['/actions/dungeon/odd'] = { type: '/action_types/combat' };
            const snap = await load({
                actions: [
                    row('/actions/combat/fly', 100),
                    row('/actions/dungeon/odd', 50),
                    row('/actions/combat/bear', 25),
                ],
                totalQueueSeconds: 175,
            });
            expect(snap.totalQueueSeconds).toBe(0);
            expect(snap.actions.map((a) => a.estimatedSeconds)).toEqual([null, null, null]);
            expect(snap.hasUnknownAction).toBe(true);
        });

        test('an all-timed legacy queue is just marked as having no unknown work', async () => {
            const snap = await load({ actions: [row('/actions/milking/basic', 30)], totalQueueSeconds: 30 });
            expect(snap.hasUnknownAction).toBe(false);
            expect(snap.totalQueueSeconds).toBe(30);
        });

        test('a legacy untimed row before the first endless one sets the flag; an empty queue stays empty', async () => {
            const a = await load({ actions: [row('/actions/x/y', null)], totalQueueSeconds: 0 });
            expect(a.hasUnknownAction).toBe(true);
            const b = await load({ actions: [], totalQueueSeconds: 0 });
            expect(b.hasUnknownAction).toBe(false);
        });

        test('a snapshot that already carries the flag is not touched', async () => {
            const snap = await load({
                actions: [row('/actions/combat/fly', 100)],
                totalQueueSeconds: 100,
                hasUnknownAction: false,
            });
            expect(snap.totalQueueSeconds).toBe(100);
            expect(snap.actions[0].estimatedSeconds).toBe(100);
        });
    });

    test('the character_switching listener survives disable() (it must fire during feature teardown)', async () => {
        queueSnapshot.initialize();
        await Promise.resolve();

        queueSnapshot.disable();

        game.actionDetails['/actions/milking/basic'] = { name: 'Basic Milking' };
        game.actions = [];
        expect(() => game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'One' })).not.toThrow();
        expect(queueSnapshot.getSnapshot('char1')).not.toBeNull();
    });

    test('initialize does not double-register the switching listener', async () => {
        queueSnapshot.initialize();
        await Promise.resolve();
        const firstHandler = queueSnapshot._boundOnSwitching;

        queueSnapshot.initialize();
        await Promise.resolve();

        expect(queueSnapshot._boundOnSwitching).toBe(firstHandler);
    });

    test('each alchemy action is measured from its own item level, enhanced or not', async () => {
        game.itemDetailMap = { '/items/low': { itemLevel: 10 }, '/items/high': { itemLevel: 100 } };
        game.actionDetails['/actions/alchemy/coinify'] = { name: 'Coinify', type: '/action_types/alchemy' };
        game.actionDetails['/actions/milking/basic'] = { name: 'Basic Milking', type: '/action_types/milking' };
        const alchemy = (hash) => ({
            actionHrid: '/actions/alchemy/coinify',
            primaryItemHash: hash,
            isDone: false,
            hasMaxCount: true,
            maxCount: 100,
            currentCount: 0,
        });
        game.actions = [
            alchemy('/item_locations/inventory::/items/low::0'),
            alchemy('161296::/item_locations/inventory::/items/high::5'),
            { actionHrid: '/actions/milking/basic', isDone: false, hasMaxCount: true, maxCount: 5, currentCount: 0 },
        ];
        queueSnapshot.initialize();
        await Promise.resolve();

        game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' });

        expect(game.calls.map((c) => c.options.levelRequirementOverride)).toEqual([10, 100, undefined]);
    });
});
