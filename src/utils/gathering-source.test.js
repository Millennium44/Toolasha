import { describe, test, expect } from 'vitest';
import { gatheringItemsPerSecond, isBetterGatheringSource } from './gathering-source.js';

const holyCow = {
    baseTimeCost: 30e9,
    levelRequirement: { level: 80 },
    dropTable: [{ itemHrid: '/items/holy_milk', dropRate: 1, minCount: 1, maxCount: 3 }],
};
const eternalCow = {
    baseTimeCost: 45e9,
    levelRequirement: { level: 100 },
    dropTable: [
        { itemHrid: '/items/holy_milk', dropRate: 1, minCount: 1, maxCount: 1 },
        { itemHrid: '/items/eternal_milk', dropRate: 0.1, minCount: 1, maxCount: 1 },
    ],
};

describe('gatheringItemsPerSecond', () => {
    test('is the regular table yield over the base action time', () => {
        expect(gatheringItemsPerSecond(holyCow, '/items/holy_milk')).toBeCloseTo(2 / 30, 10);
        expect(gatheringItemsPerSecond(eternalCow, '/items/eternal_milk')).toBeCloseTo(0.1 / 45, 10);
    });

    test('an action with no base time is incomparable (zero), not items per action', () => {
        expect(gatheringItemsPerSecond({ dropTable: holyCow.dropTable }, '/items/holy_milk')).toBe(0);
    });

    test('is zero for an item the table does not drop, and for no action', () => {
        expect(gatheringItemsPerSecond(holyCow, '/items/eternal_milk')).toBe(0);
        expect(gatheringItemsPerSecond(null, '/items/holy_milk')).toBe(0);
    });
});

describe('isBetterGatheringSource', () => {
    test('anything beats nothing', () => {
        expect(isBetterGatheringSource(null, eternalCow, '/items/holy_milk')).toBe(true);
    });

    test('the action that yields more per second wins whichever lists first', () => {
        expect(isBetterGatheringSource(eternalCow, holyCow, '/items/holy_milk')).toBe(true);
        expect(isBetterGatheringSource(holyCow, eternalCow, '/items/holy_milk')).toBe(false);
    });

    test('equal yield falls to the lower level, and a full tie keeps the one held', () => {
        const slower = { ...holyCow, levelRequirement: { level: 90 } };
        expect(isBetterGatheringSource(slower, holyCow, '/items/holy_milk')).toBe(true);
        expect(isBetterGatheringSource(holyCow, { ...holyCow }, '/items/holy_milk')).toBe(false);
    });
});
