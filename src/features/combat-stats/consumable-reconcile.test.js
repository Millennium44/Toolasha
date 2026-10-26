/**
 * The pure rules for reconciling consumable counts against a `new_battle` snapshot.
 */

import { describe, test, expect } from 'vitest';
import {
    classifyItem,
    reconcileSnapshot,
    wavesElapsed,
    estimateFightingSeconds,
    UNOBSERVED_GAP_SECONDS,
    MIN_WAVE_SAMPLES,
} from './consumable-reconcile.js';

const FOOD_RATE = 1 / 60; // 60 s cooldown
const DRINK_RATE = 345.6 / 86400; // 300 s / 1.2 concentration

describe('classifyItem', () => {
    test('an item never seen before only takes a baseline', () => {
        for (const lastKnown of [undefined, null]) {
            expect(
                classifyItem({ lastKnown, snapshot: 5, effectiveGapSeconds: 600, maxRatePerSecond: FOOD_RATE })
            ).toEqual({ action: 'baseline', credited: 0, missed: 0 });
        }
    });

    test('an unchanged count changes nothing', () => {
        expect(
            classifyItem({ lastKnown: 7, snapshot: 7, effectiveGapSeconds: 600, maxRatePerSecond: FOOD_RATE })
        ).toEqual({
            action: 'none',
            credited: 0,
            missed: 0,
        });
    });

    test('a count that went up is a refill and never consumption', () => {
        expect(
            classifyItem({ lastKnown: 1961, snapshot: 2262, effectiveGapSeconds: 3600, maxRatePerSecond: FOOD_RATE })
        ).toEqual({ action: 'restock', credited: 0, missed: -301 });
    });

    test('a drop within 1.5x the cooldown limit is credited in full', () => {
        // Five hours of food at one a minute is 300; 1.5x allows 450
        expect(
            classifyItem({ lastKnown: 1000, snapshot: 550, effectiveGapSeconds: 5 * 3600, maxRatePerSecond: FOOD_RATE })
        ).toEqual({ action: 'credit', credited: 450, missed: 450 });
    });

    test('a drop beyond it is rejected', () => {
        expect(
            classifyItem({ lastKnown: 1000, snapshot: 549, effectiveGapSeconds: 5 * 3600, maxRatePerSecond: FOOD_RATE })
        ).toEqual({ action: 'reject', credited: 0, missed: 451 });
        expect(
            classifyItem({
                lastKnown: 5552,
                snapshot: 1667,
                effectiveGapSeconds: 11 * 3600,
                maxRatePerSecond: DRINK_RATE,
            }).action
        ).toBe('reject');
    });

    test('one use is always believable, even over no time at all', () => {
        expect(
            classifyItem({ lastKnown: 3, snapshot: 2, effectiveGapSeconds: 0, maxRatePerSecond: FOOD_RATE }).action
        ).toBe('credit');
        expect(
            classifyItem({ lastKnown: 3, snapshot: 1, effectiveGapSeconds: 0, maxRatePerSecond: FOOD_RATE }).action
        ).toBe('reject');
    });
});

describe('reconcileSnapshot', () => {
    const item = (lastKnown, snapshot, itemHrid = '/items/dragon_fruit_gummy') => ({
        itemHrid,
        lastKnown,
        snapshot,
        maxRatePerSecond: FOOD_RATE,
    });

    test('with no previous observation everything is a baseline and no time is excluded', () => {
        const result = reconcileSnapshot({ items: [item(1000, 900)], gapSeconds: null, fightingSeconds: null });
        expect(result.items[0].action).toBe('baseline');
        expect(result.excludeSeconds).toBe(0);
        expect(result.unobserved).toBe(false);
    });

    test('an ordinary gap is never excluded, whatever the counts did', () => {
        const result = reconcileSnapshot({
            items: [item(1000, 2000)],
            gapSeconds: UNOBSERVED_GAP_SECONDS,
            fightingSeconds: null,
        });
        expect(result.unobserved).toBe(false);
        expect(result.excludeSeconds).toBe(0);
    });

    test('an unobserved gap with credited use keeps its time when it was all spent fighting', () => {
        const result = reconcileSnapshot({ items: [item(1000, 940)], gapSeconds: 3600, fightingSeconds: 4500 });
        expect(result.items[0]).toMatchObject({ action: 'credit', credited: 60 });
        expect(result.excludeSeconds).toBe(0);
    });

    test('an unobserved gap with no fighting estimate credits nothing and is excluded whole', () => {
        for (const fightingSeconds of [null, 0]) {
            const result = reconcileSnapshot({ items: [item(1000, 999)], gapSeconds: 8 * 3600, fightingSeconds });
            expect(result.items[0]).toMatchObject({ action: 'reject', credited: 0, missed: 1 });
            expect(result.excludeSeconds).toBe(8 * 3600);
        }
    });

    test('an unobserved gap keeps only the time spent fighting when that is known', () => {
        const result = reconcileSnapshot({ items: [item(1000, 980)], gapSeconds: 3600, fightingSeconds: 1200 });
        expect(result.items[0].action).toBe('credit');
        expect(result.excludeSeconds).toBe(2400);
    });

    test('an unobserved gap with nothing credited is excluded whole', () => {
        for (const items of [[item(1000, 1500)], [item(1000, 0)], [item(1000, 1000)], []]) {
            expect(reconcileSnapshot({ items, gapSeconds: 3600, fightingSeconds: 1200 }).excludeSeconds).toBe(3600);
        }
    });

    test('items are judged separately against the same gap', () => {
        const result = reconcileSnapshot({
            items: [item(1000, 940, '/items/a'), item(10, 500, '/items/b'), item(1000, 1, '/items/c')],
            gapSeconds: 3600,
            fightingSeconds: 4500,
        });
        expect(result.items.map((entry) => entry.action)).toEqual(['credit', 'restock', 'reject']);
        expect(result.excludeSeconds).toBe(0);
    });

    test('a negative gap (clock moved back) counts as no time', () => {
        const result = reconcileSnapshot({ items: [item(10, 9)], gapSeconds: -50, fightingSeconds: null });
        expect(result.items[0].action).toBe('credit');
        expect(result.excludeSeconds).toBe(0);
    });
});

describe('wavesElapsed', () => {
    test('ordinary zones: one battleId per wave', () => {
        expect(
            wavesElapsed({ previousBattleId: 10, previousWave: 0, battleId: 25, wave: 0, dungeonMaxWaves: null })
        ).toBe(15);
    });

    test('dungeons: runs times max waves plus the wave change', () => {
        expect(
            wavesElapsed({ previousBattleId: 30, previousWave: 40, battleId: 32, wave: 5, dungeonMaxWaves: 65 })
        ).toBe(2 * 65 - 35);
    });

    test('nothing to go on, or no progress, is null', () => {
        expect(wavesElapsed({ previousBattleId: null, previousWave: null, battleId: 5, wave: 0 })).toBeNull();
        expect(wavesElapsed({ previousBattleId: 5, previousWave: 0, battleId: 5, wave: 0 })).toBeNull();
        expect(wavesElapsed({ previousBattleId: 9, previousWave: 0, battleId: 1, wave: 0 })).toBeNull();
        expect(
            wavesElapsed({ previousBattleId: 1, previousWave: null, battleId: 2, wave: 3, dungeonMaxWaves: 65 })
        ).toBeNull();
    });
});

describe('estimateFightingSeconds', () => {
    test('waves times the average ordinary wave interval', () => {
        expect(estimateFightingSeconds(130, { sum: 60, count: 4 })).toBe(1950);
    });

    test('too few samples, or no waves, is unknown', () => {
        expect(estimateFightingSeconds(130, { sum: 30, count: MIN_WAVE_SAMPLES - 1 })).toBeNull();
        expect(estimateFightingSeconds(null, { sum: 60, count: 4 })).toBeNull();
        expect(estimateFightingSeconds(130, null)).toBeNull();
    });
});
