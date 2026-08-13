import { describe, test, expect } from 'vitest';
import { forecastLabyrinthEntries, LABYRINTH_MAX_ENTRIES } from './labyrinth-entry-forecast.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-13T04:18:00.000Z');

/** characterInfo with the fields the forecast reads */
const info = ({ entries = 1, cooldownHours = 48, lastHoursAgo = 0 } = {}) => ({
    labyrinthEntries: entries,
    labyrinthCooldownHours: cooldownHours,
    lastLabyrinthTimestamp: new Date(NOW - lastHoursAgo * HOUR).toISOString(),
});

describe('forecastLabyrinthEntries', () => {
    test('projects the next entry one cooldown after the last timestamp', () => {
        // Last entry 0.3h ago (04:00), cooldown 48h → next ~1d 23.7h out.
        const f = forecastLabyrinthEntries({ characterInfo: info({ entries: 1, lastHoursAgo: 0.3 }), now: NOW });
        expect(f.ok).toBe(true);
        expect(f.entries).toBe(1);
        expect(f.isFull).toBe(false);
        expect(f.nextEntryAt).toBe(Date.parse(info({ lastHoursAgo: 0.3 }).lastLabyrinthTimestamp) + 48 * HOUR);
        expect(f.msUntilNext).toBeGreaterThan(47 * HOUR);
        expect(f.available).toBe(false);
    });

    test('a full stock has no projected next entry', () => {
        const f = forecastLabyrinthEntries({ characterInfo: info({ entries: LABYRINTH_MAX_ENTRIES }), now: NOW });
        expect(f.isFull).toBe(true);
        expect(f.nextEntryAt).toBeNull();
        expect(f.available).toBe(false);
    });

    test('marks an entry available once its instant has passed', () => {
        // Last entry 49h ago, cooldown 48h → the next one regenerated an hour ago.
        const f = forecastLabyrinthEntries({ characterInfo: info({ entries: 1, lastHoursAgo: 49 }), now: NOW });
        expect(f.available).toBe(true);
        expect(f.msUntilNext).toBeLessThan(0);
    });

    test('reports not-ok without character info or cooldown', () => {
        expect(forecastLabyrinthEntries({ characterInfo: null }).ok).toBe(false);
        expect(forecastLabyrinthEntries({ characterInfo: { labyrinthEntries: 1 } }).ok).toBe(false);
    });
});
