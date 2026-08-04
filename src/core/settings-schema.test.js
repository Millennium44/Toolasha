/**
 * Tests for the settings schema.
 *
 * Only the defaults that are a judgement call get pinned here — a default that
 * quietly flips changes what every new install does, and there is nothing else
 * in the codebase that would notice.
 */

import { describe, test, expect } from 'vitest';
import { getSettingDefinition } from './settings-schema.js';

describe('labyrinth defaults', () => {
    test('the path planner assumes the worst about a room it cannot see', () => {
        const setting = getSettingDefinition('labyrinthPathUnknownMode');
        // An optimistic default routes you through rooms that turn out to need
        // a shroud you did not bring; the pessimistic one only ever overpays
        expect(setting.default).toBe('shroud');
        expect(setting.options.map((o) => o.value)).toContain('shroud');
    });

    test('replaying the live fight is opt-in, not something every player pays for', () => {
        // It runs the real combat engine hundreds of times mid-fight
        expect(getSettingDefinition('labyrinthLiveCombatSim').default).toBe(false);
    });

    test('the sim precision help describes the stopping rule it actually governs', () => {
        const help = getSettingDefinition('labyrinthSimPrecision').help;
        expect(help).toContain('percentage points');
        expect(help).toMatch(/confidence interval/i);
    });
});
