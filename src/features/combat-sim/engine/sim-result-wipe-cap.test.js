/**
 * Wipe events carry up to 600 log entries each since heals and casts joined the hits, so a result
 * keeps only as many as the runner would keep when merging.
 */
import { describe, test, expect } from 'vitest';
import SimResult, { MAX_WIPE_EVENTS } from './sim-result.js';

describe('SimResult wipe events', () => {
    test('only the first MAX_WIPE_EVENTS wipes are kept', () => {
        const result = new SimResult({ hrid: '/actions/combat/sinister_circus', difficultyTier: 1 }, 5);
        for (let i = 0; i < MAX_WIPE_EVENTS + 5; i++) result.addWipeEvent([{ kind: 'hit' }], i * 1e9, i);
        expect(result.wipeEvents).toHaveLength(MAX_WIPE_EVENTS);
        expect(result.wipeEvents[0].wave).toBe(0);
        expect(result.wipeEvents.at(-1).wave).toBe(MAX_WIPE_EVENTS - 1);
    });
});
