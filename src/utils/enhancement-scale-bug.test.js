/**
 * The 3.76.0 enhancement-scale exclusion (#808, #809).
 *
 * The worst failure is dropping a record that was not from 3.76.0, so each rule is pinned on both
 * sides: the exact version string and the edges of the window, and what must be kept.
 */

import { describe, it, expect } from 'vitest';
import {
    BAD_ENHANCEMENT_SCALE_FROM_MS,
    BAD_ENHANCEMENT_SCALE_TO_MS,
    isBadEnhancementScaleRecord,
    isBadEnhancementScaleObservation,
    isBadEnhancementScaleAlchemySession,
    withoutBadEnhancementScaleRecords,
    withoutBadEnhancementScaleObservations,
} from './enhancement-scale-bug.js';

const pair = (v, extra = {}) => ({ id: `p-${v}`, actionType: 'milking', predicted: 1, actual: 1, t: 1, v, ...extra });

describe('isBadEnhancementScaleRecord', () => {
    it('matches only a 3.76.0 pair', () => {
        expect(isBadEnhancementScaleRecord(pair('3.76.0'))).toBe(true);
    });

    it('keeps 3.75.x, 3.76.1, a null or missing version and a dev-build version', () => {
        expect(isBadEnhancementScaleRecord(pair('3.75.0'))).toBe(false);
        expect(isBadEnhancementScaleRecord(pair('3.75.9'))).toBe(false);
        expect(isBadEnhancementScaleRecord(pair('3.76.1'))).toBe(false);
        expect(isBadEnhancementScaleRecord(pair('3.76.10'))).toBe(false);
        expect(isBadEnhancementScaleRecord(pair(null))).toBe(false);
        const missing = pair('x');
        delete missing.v;
        expect(isBadEnhancementScaleRecord(missing)).toBe(false);
        expect(isBadEnhancementScaleRecord(pair('3.76.0.20261105140000'))).toBe(false);
    });

    it('keeps a combat pair, whose forecast never read the broken table', () => {
        expect(isBadEnhancementScaleRecord(pair('3.76.0', { actionType: 'combat' }))).toBe(false);
    });

    it('survives junk', () => {
        expect(isBadEnhancementScaleRecord(null)).toBe(false);
        expect(isBadEnhancementScaleRecord(undefined)).toBe(false);
        expect(isBadEnhancementScaleRecord('3.76.0')).toBe(false);
    });
});

describe('the window', () => {
    it('is the release and fix times of 2026-11-05', () => {
        expect(new Date(BAD_ENHANCEMENT_SCALE_FROM_MS).toISOString()).toBe('2026-11-05T13:23:42.000Z');
        expect(new Date(BAD_ENHANCEMENT_SCALE_TO_MS).toISOString()).toBe('2026-11-05T17:02:36.000Z');
    });

    it('covers an observation inside it, edges included, and nothing outside', () => {
        const at = (t) => isBadEnhancementScaleObservation({ id: 'e', t });
        expect(at(BAD_ENHANCEMENT_SCALE_FROM_MS)).toBe(true);
        expect(at(BAD_ENHANCEMENT_SCALE_TO_MS)).toBe(true);
        expect(at(Date.parse('2026-11-05T15:00:00Z'))).toBe(true);
        expect(at(BAD_ENHANCEMENT_SCALE_FROM_MS - 1)).toBe(false);
        expect(at(BAD_ENHANCEMENT_SCALE_TO_MS + 1)).toBe(false);
        expect(at(Date.parse('2026-11-04T15:00:00Z'))).toBe(false);
    });

    it('cannot place a record with no usable time, so it is kept', () => {
        for (const t of [undefined, null, NaN, '2026-11-05T15:00:00Z']) {
            expect(isBadEnhancementScaleObservation({ id: 'e', t })).toBe(false);
            expect(isBadEnhancementScaleAlchemySession({ predictedRate: 0.6, predictedAt: t })).toBe(false);
        }
        expect(isBadEnhancementScaleObservation(null)).toBe(false);
    });

    it('covers an alchemy session by its stamp time, not its start', () => {
        const inside = Date.parse('2026-11-05T14:00:00Z');
        expect(isBadEnhancementScaleAlchemySession({ predictedRate: 0.6, predictedAt: inside })).toBe(true);
        expect(isBadEnhancementScaleAlchemySession({ predictedRate: 0.6, predictedAt: 1, startTime: inside })).toBe(
            false
        );
    });
});

describe('the filters', () => {
    it('return a new array and leave the input whole', () => {
        const input = [pair('3.76.0'), pair('3.76.1'), pair(null)];
        const out = withoutBadEnhancementScaleRecords(input);
        expect(out.map((r) => r.v)).toEqual(['3.76.1', null]);
        expect(input).toHaveLength(3);
        expect(out).not.toBe(input);
    });

    it('pass null (not loaded) through as null and an empty ledger as empty', () => {
        expect(withoutBadEnhancementScaleRecords(null)).toBeNull();
        expect(withoutBadEnhancementScaleObservations(null)).toBeNull();
        expect(withoutBadEnhancementScaleRecords([])).toEqual([]);
        expect(withoutBadEnhancementScaleObservations([])).toEqual([]);
    });
});
