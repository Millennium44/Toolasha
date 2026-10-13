import { describe, test, expect } from 'vitest';
import { upgradeOutputLevels } from './upgrade-enhancement.js';

describe('upgradeOutputLevels', () => {
    test('a +0 input stays +0', () => {
        expect(upgradeOutputLevels(0)).toEqual([{ level: 0, weight: 1 }]);
    });

    test('70% of the level, with the decimal as the chance of one more', () => {
        const levels = upgradeOutputLevels(5);
        expect(levels.map((l) => l.level)).toEqual([3, 4]);
        expect(levels[0].weight).toBeCloseTo(0.5, 10);
        expect(levels[1].weight).toBeCloseTo(0.5, 10);

        const ten = upgradeOutputLevels(10);
        expect(ten).toEqual([{ level: 7, weight: 1 }]);

        const three = upgradeOutputLevels(3);
        expect(three[0].level).toBe(2);
        expect(three[1].weight).toBeCloseTo(0.1, 10);
    });

    test('a retaining recipe keeps the full level', () => {
        expect(upgradeOutputLevels(7, { retainAll: true })).toEqual([{ level: 7, weight: 1 }]);
    });
});
