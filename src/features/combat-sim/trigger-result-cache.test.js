/**
 * The remembered trigger result: its signature changes with every input that
 * decides a search, it stores only what the results box draws, and it comes back
 * only for the setup it was found on.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({ data: {} }));
vi.mock('../../utils/character-key.js', () => ({
    writeScoped: vi.fn(async (key, value, storeName) => {
        store.data[`${storeName}:${key}_char1`] = value;
        return true;
    }),
    readScoped: vi.fn(async (key, storeName, def = null) => store.data[`${storeName}:${key}_char1`] ?? def),
}));

const { TRIGGER_LAST_RESULT_KEY, triggerRunSignature, compactTriggerResult, saveTriggerResult, loadTriggerResult } =
    await import('./trigger-result-cache.js');

const setup = (over = {}) => ({
    dtoSignatures: new Map([
        ['player1', '{"a":1}'],
        ['player2', '{"b":2}'],
    ]),
    zoneHrid: '/actions/combat/swamp',
    difficultyTier: 1,
    playerIndex: 0,
    scope: 'me',
    include: 'both',
    precision: 'standard',
    minGain: 0.5,
    objective: 'balanced',
    communityBuffs: { '/community_buff_types/experience': 3 },
    ...over,
});

const result = () => ({
    scope: 'me',
    include: 'both',
    objective: 'xp',
    precision: 'standard',
    minGain: 0.5,
    simCount: 120,
    tunableCount: 2,
    reliable: true,
    stopped: false,
    baseline: { xp: 1 },
    screened: [{ key: 'k', range: 3 }],
    rejected: [{ key: 'r' }],
    changes: [
        {
            key: 'player1|abilities|/abilities/fireball|0',
            playerHrid: 'player1',
            playerName: 'Milkman',
            slotType: 'abilities',
            slotIndex: 1,
            itemHrid: '/abilities/fireball',
            itemName: 'Fireball',
            rowIndex: 0,
            dependencyHrid: 'd',
            conditionHrid: 'c',
            comparatorHrid: 'g',
            from: 1,
            to: 600,
            deltaScore: 7,
            se: 1,
            deltaXp: 10,
            deltaProfit: 0,
            deltaDeaths: 0,
            baseRows: [{ value: 1 }],
            original: 1,
        },
    ],
    combined: { deltaScore: 6, se: 1.2, deltaXp: 9, deltaProfit: 0, deltaDeaths: 0, seeds: 8, extra: 'x' },
    unchanged: [{ itemName: 'Donut', baseRows: [] }],
    unused: [{ itemName: 'Ice Spear', baseRows: [] }],
});

beforeEach(() => {
    store.data = {};
});

describe('triggerRunSignature', () => {
    test('is stable for the same setup whatever order the members come in', () => {
        const reversed = setup({
            dtoSignatures: new Map([
                ['player2', '{"b":2}'],
                ['player1', '{"a":1}'],
            ]),
        });
        expect(triggerRunSignature(reversed)).toBe(triggerRunSignature(setup()));
        expect(triggerRunSignature(setup({ dtoSignatures: { player1: '{"a":1}', player2: '{"b":2}' } }))).toBe(
            triggerRunSignature(setup())
        );
    });

    test('changes with every input that decides the answer', () => {
        const base = triggerRunSignature(setup());
        const variants = [
            { dtoSignatures: new Map([['player1', '{"a":2}']]) },
            { zoneHrid: '/actions/combat/other' },
            { difficultyTier: 2 },
            { playerIndex: 1 },
            { scope: 'party' },
            { include: 'abilities' },
            { precision: 'precise' },
            { minGain: 1 },
            { objective: 'profit' },
            { communityBuffs: {} },
            { pricing: { fetchedAt: 2, mode: 'hybrid' } },
        ];
        for (const over of variants) expect(triggerRunSignature(setup(over)), JSON.stringify(over)).not.toBe(base);
    });
});

describe('compactTriggerResult', () => {
    test('keeps what the box and its buttons read, and drops the search state', () => {
        const compact = compactTriggerResult(result());
        expect(compact.baseline).toBeUndefined();
        expect(compact.screened).toBeUndefined();
        expect(compact.rejected).toBeUndefined();
        expect(compact.changes[0].baseRows).toBeUndefined();
        expect(compact.changes[0]).toMatchObject({ itemHrid: '/abilities/fireball', rowIndex: 0, from: 1, to: 600 });
        expect(compact.combined).toEqual({
            deltaScore: 6,
            se: 1.2,
            deltaXp: 9,
            deltaProfit: 0,
            deltaDeaths: 0,
            seeds: 8,
        });
        expect(compact.unchanged).toEqual([{ itemName: 'Donut' }]);
        expect(compact.unused).toEqual([{ itemName: 'Ice Spear' }]);
        expect(compact.objective).toBe('xp');
        expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(result()).length);
    });
});

describe('saving and loading', () => {
    test('a saved result comes back for the same signature and not for another', async () => {
        const signature = triggerRunSignature(setup());
        expect(await saveTriggerResult(signature, result())).toBe(true);
        expect(store.data[`settings:${TRIGGER_LAST_RESULT_KEY}_char1`].signature).toBe(signature);
        expect((await loadTriggerResult(signature)).changes[0].to).toBe(600);
        expect(await loadTriggerResult(triggerRunSignature(setup({ minGain: 2 })))).toBeNull();
    });

    test('a stopped or missing result is not remembered', async () => {
        const signature = triggerRunSignature(setup());
        expect(await saveTriggerResult(signature, { ...result(), stopped: true })).toBe(false);
        expect(await saveTriggerResult(signature, null)).toBe(false);
        expect(await loadTriggerResult(signature)).toBeNull();
    });

    test('a remembered result expires after half an hour, since prices move on their own', async () => {
        const signature = triggerRunSignature(setup());
        await saveTriggerResult(signature, result());
        const key = `settings:${TRIGGER_LAST_RESULT_KEY}_char1`;
        store.data[key].savedAt = Date.now() - 31 * 60 * 1000;
        expect(await loadTriggerResult(signature)).toBeNull();
        store.data[key].savedAt = Date.now() - 5 * 60 * 1000;
        expect(await loadTriggerResult(signature)).not.toBeNull();
    });

    test('a different script or game version is a different setup', () => {
        const base = triggerRunSignature(setup({ scriptVersion: '3.67.0', gameVersion: 'v1' }));
        expect(triggerRunSignature(setup({ scriptVersion: '3.67.1', gameVersion: 'v1' }))).not.toBe(base);
        expect(triggerRunSignature(setup({ scriptVersion: '3.67.0', gameVersion: 'v2' }))).not.toBe(base);
    });
});
