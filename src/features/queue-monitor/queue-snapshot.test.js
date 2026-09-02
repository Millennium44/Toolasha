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
    calculateActionStats: () => game.stats,
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

    test('an action with no resolvable details is skipped rather than crashing', async () => {
        game.actions = [
            { actionHrid: '/actions/unknown/x', isDone: false, hasMaxCount: true, maxCount: 1, currentCount: 0 },
        ];
        queueSnapshot.initialize();
        await Promise.resolve();

        expect(() => game.dmHandlers.character_switching({ oldId: 'char1', oldName: 'Someone' })).not.toThrow();
        expect(queueSnapshot.getSnapshot('char1').actions).toHaveLength(0);
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
});
