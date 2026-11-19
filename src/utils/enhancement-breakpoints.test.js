import { describe, test, expect } from 'vitest';
import {
    BREAKPOINTS_BACK,
    BREAKPOINTS_DEFAULT,
    BREAKPOINTS_JEWELRY,
    BREAKPOINTS_REFINED,
    breakpointsFor,
} from './enhancement-breakpoints.js';

describe('breakpointsFor', () => {
    test('the four lists are the ones the advisor and the optimizer always used', () => {
        expect(BREAKPOINTS_DEFAULT).toEqual([7, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
        expect(BREAKPOINTS_JEWELRY).toEqual([5, 7, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
        expect(BREAKPOINTS_BACK).toEqual([3, 5, 7, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
        expect(BREAKPOINTS_REFINED).toEqual([10, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    });

    test('picks by kind of item', () => {
        expect(breakpointsFor('/items/sword')).toBe(BREAKPOINTS_DEFAULT);
        expect(breakpointsFor('/items/ring', { isJewelry: true })).toBe(BREAKPOINTS_JEWELRY);
        expect(breakpointsFor('/items/cape', { isBack: true })).toBe(BREAKPOINTS_BACK);
        expect(breakpointsFor('/items/x_refined')).toBe(BREAKPOINTS_REFINED);
    });

    test('a refined back item follows the caller order: the advisor checks back first, the optimizer refined first', () => {
        expect(breakpointsFor('/items/cape_refined', { isBack: true, backFirst: true })).toBe(BREAKPOINTS_BACK);
        expect(breakpointsFor('/items/cape_refined', { isBack: true })).toBe(BREAKPOINTS_REFINED);
        expect(breakpointsFor('/items/ring_refined', { isJewelry: true })).toBe(BREAKPOINTS_REFINED);
    });
});
