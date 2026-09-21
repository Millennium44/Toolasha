/**
 * The two replay checks answer the same question and must answer it at the
 * same bars.
 *
 * `combat-replay-check.js` and `labyrinth-replay-check.js` live in different
 * bundles, so the constants are deliberately restated rather than imported — a
 * shared import would trip `scripts/check-bundle-sharing.mjs`. Restating them
 * leaves nothing stopping them drifting apart, and two panels quietly using
 * different thresholds for "enough fights to state a verdict" is exactly the
 * kind of divergence nobody notices until a user compares the two.
 *
 * A test file is not bundled, so it can import both and pin them together.
 * This is the pin: if one moves, this fails and the other has to move with it.
 */

import { describe, expect, test } from 'vitest';

import { MIN_CHECK_FIGHTS, MIN_VERDICT_FIGHTS } from './combat-replay-check.js';
import { MIN_LAB_FIGHTS } from './labyrinth-replay-check.js';
import { MIN_REPLAY_FIGHTS } from './labyrinth-replay-inputs.js';

describe('the two replay checks share their bars', () => {
    test('the upper bar — below it neither states a verdict', () => {
        expect(MIN_VERDICT_FIGHTS).toBe(MIN_LAB_FIGHTS);
    });

    test('the lower bar — below it neither runs the comparison at all', () => {
        expect(MIN_CHECK_FIGHTS).toBe(MIN_REPLAY_FIGHTS);
    });

    test('the lower bar really is lower', () => {
        expect(MIN_CHECK_FIGHTS).toBeLessThan(MIN_VERDICT_FIGHTS);
    });
});
