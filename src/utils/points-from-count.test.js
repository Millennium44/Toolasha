/**
 * The points ladder shared by the Bestiary and the Collections log — the
 * client's `calculatePointsFromCount`.
 */

import { describe, test, expect } from 'vitest';
import { pointsFromCount, nextPointCount } from './points-from-count.js';
import * as bestiary from './bestiary.js';

describe('pointsFromCount', () => {
    test('pays 1 at 1, +2 at 10, +3 at 100, +4 at 1,000', () => {
        expect(pointsFromCount(0)).toBe(0);
        expect(pointsFromCount(1)).toBe(1);
        expect(pointsFromCount(9)).toBe(1);
        expect(pointsFromCount(10)).toBe(3);
        expect(pointsFromCount(100)).toBe(6);
        expect(pointsFromCount(1000)).toBe(10);
    });

    test('331 Umbral Hoods are 6 points, as the game tooltip shows', () => {
        expect(pointsFromCount(331)).toBe(6);
    });

    test('the next rung is the first power of ten past the count', () => {
        expect(nextPointCount(0)).toBe(1);
        expect(nextPointCount(1)).toBe(10);
        expect(nextPointCount(331)).toBe(1000);
    });

    test('bestiary.js still exports the same functions', () => {
        expect(bestiary.pointsFromCount).toBe(pointsFromCount);
        expect(bestiary.nextPointCount).toBe(nextPointCount);
    });
});
