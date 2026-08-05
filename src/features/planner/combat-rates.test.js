/**
 * Combat income out of a saved all-zones run.
 *
 * The interesting behaviour is entirely about *trust*: a rate that was measured
 * some time ago, possibly in other gear, is still worth having as long as it
 * says so. So the tests move the clock and the gear signature and read the
 * label and the note back, rather than checking arithmetic — the only
 * arithmetic here is picking the largest number in a list.
 *
 * `combat-sim-ui.js` is mocked whole. It is a six-thousand-line panel that
 * builds workers and floating windows; what this module wants from it is one
 * stored object and one string.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const sim = vi.hoisted(() => ({
    snapshot: null,
    fingerprint: null,
    loadThrows: false,
    fingerprintThrows: false,
}));

// The default export, because that is what the module reads — see the note on
// its import for why a named import would only work in the dev build.
vi.mock('../combat-sim/combat-sim-ui.js', () => ({
    default: {
        loadAllZonesSnapshot: async () => {
            if (sim.loadThrows) throw new Error('storage is unhappy');
            return sim.snapshot;
        },
        currentGearFingerprint: async () => {
            if (sim.fingerprintThrows) throw new Error('no character');
            return sim.fingerprint;
        },
    },
}));

const { combatRatesFromSnapshot, loadCombatRates, ageLabel, STALE_AFTER_MS, NO_SNAPSHOT_NOTE } =
    await import('./combat-rates.js');

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A saved run with two zones, the second one richer.
 * @param {Object} [overrides] - Snapshot fields to replace
 * @returns {Object} A snapshot
 */
function snapshot(overrides = {}) {
    return {
        version: 1,
        savedAt: NOW - 3 * DAY,
        hours: 24,
        fingerprint: 'gear-a',
        zones: [
            {
                zoneHrid: '/actions/combat/bee',
                zoneName: 'Bee Hive',
                difficultyTier: 0,
                profitPerHour: 900_000,
                xpPerHour: 120_000,
            },
            {
                zoneHrid: '/actions/combat/fly',
                zoneName: 'Fly Zone',
                difficultyTier: 2,
                profitPerHour: 2_100_000,
                xpPerHour: 300_000,
            },
        ],
        ...overrides,
    };
}

beforeEach(() => {
    sim.snapshot = null;
    sim.fingerprint = null;
    sim.loadThrows = false;
    sim.fingerprintThrows = false;
});

describe('ageLabel', () => {
    test('says how long ago in the largest unit that is not a fraction', () => {
        expect(ageLabel(30_000)).toBe('just now');
        expect(ageLabel(20 * 60_000)).toBe('20m ago');
        expect(ageLabel(5 * HOUR)).toBe('5h ago');
        expect(ageLabel(3 * DAY)).toBe('3d ago');
        expect(ageLabel(45 * DAY)).toBe('45d ago');
    });

    test('does not invent an age it does not have', () => {
        expect(ageLabel(NaN)).toBe('at an unknown time');
        expect(ageLabel(-1)).toBe('at an unknown time');
    });
});

describe('combatRatesFromSnapshot — a run that exists', () => {
    test('offers every profitable zone, best first, and names the winner', () => {
        const { rates, best } = combatRatesFromSnapshot(snapshot(), { now: NOW });

        expect(rates.map((rate) => rate.zoneName)).toEqual(['Fly Zone', 'Bee Hive']);
        expect(best.goldPerHour).toBe(2_100_000);
        expect(best.kind).toBe('combat');
        expect(best.actionHrid).toBe('/actions/combat/fly');
    });

    test('the label says where the number came from and how old it is', () => {
        const { best } = combatRatesFromSnapshot(snapshot(), { now: NOW });
        expect(best.label).toBe('Fly Zone T2 — from your all-zones run 3d ago');
        expect(best.ageLabel).toBe('3d ago');
        expect(best.source).toBe('all-zones-sim');
    });

    test('a fresh run in the same gear has nothing to warn about', () => {
        const { status } = combatRatesFromSnapshot(snapshot(), { now: NOW, currentFingerprint: 'gear-a' });
        expect(status).toMatchObject({ hasSnapshot: true, stale: false, gearChanged: false, note: null });
    });

    test('carries the run’s experience, which is every combat skill at once', () => {
        const { best } = combatRatesFromSnapshot(snapshot(), { now: NOW });
        expect(best.xpPerHour).toBe(300_000);
    });

    test('a zone that loses money is not an earning rate', () => {
        const losing = snapshot({
            zones: [
                {
                    zoneHrid: '/actions/combat/bee',
                    zoneName: 'Bee Hive',
                    difficultyTier: 0,
                    profitPerHour: -50,
                    xpPerHour: 10,
                },
                {
                    zoneHrid: '/actions/combat/fly',
                    zoneName: 'Fly Zone',
                    difficultyTier: 0,
                    profitPerHour: 5,
                    xpPerHour: 10,
                },
            ],
        });
        const { rates } = combatRatesFromSnapshot(losing, { now: NOW });
        expect(rates.map((rate) => rate.zoneName)).toEqual(['Fly Zone']);
    });

    test('a zone whose profit was never measured is skipped, not treated as zero', () => {
        const partial = snapshot({
            zones: [{ zoneHrid: '/actions/combat/bee', zoneName: 'Bee Hive', profitPerHour: null, xpPerHour: 10 }],
        });
        const { rates, status } = combatRatesFromSnapshot(partial, { now: NOW });
        expect(rates).toEqual([]);
        expect(status.hasSnapshot).toBe(true);
        expect(status.note).toContain('no zone that turns a profit');
    });
});

describe('combatRatesFromSnapshot — a run that is old', () => {
    test('older than a week is still offered, and says so in the label and the note', () => {
        const old = snapshot({ savedAt: NOW - 9 * DAY });
        const { best, status } = combatRatesFromSnapshot(old, { now: NOW });

        expect(best.goldPerHour).toBe(2_100_000);
        expect(best.stale).toBe(true);
        expect(best.label).toBe('Fly Zone T2 — from your all-zones run 9d ago (stale)');
        expect(status.stale).toBe(true);
        expect(status.note).toContain('over a week old');
    });

    test('the line between fresh and stale is a week, not a guess', () => {
        const justInside = snapshot({ savedAt: NOW - STALE_AFTER_MS + 1000 });
        const justOutside = snapshot({ savedAt: NOW - STALE_AFTER_MS - 1000 });
        expect(combatRatesFromSnapshot(justInside, { now: NOW }).status.stale).toBe(false);
        expect(combatRatesFromSnapshot(justOutside, { now: NOW }).status.stale).toBe(true);
    });

    test('a run with no timestamp is treated as stale rather than as new', () => {
        const undated = snapshot({ savedAt: undefined });
        const { status, best } = combatRatesFromSnapshot(undated, { now: NOW });
        expect(status.stale).toBe(true);
        expect(best.label).toContain('at an unknown time');
    });
});

describe('combatRatesFromSnapshot — a run in other gear', () => {
    test('different gear is flagged without withholding the rate', () => {
        const { best, status } = combatRatesFromSnapshot(snapshot(), { now: NOW, currentFingerprint: 'gear-b' });

        expect(best.goldPerHour).toBe(2_100_000);
        expect(best.gearChanged).toBe(true);
        expect(best.label).toBe('Fly Zone T2 — from your all-zones run 3d ago (gear changed)');
        expect(status.note).toContain('different gear');
    });

    test('old and re-geared says both, once', () => {
        const old = snapshot({ savedAt: NOW - 30 * DAY });
        const { best, status } = combatRatesFromSnapshot(old, { now: NOW, currentFingerprint: 'gear-b' });
        expect(best.label).toBe('Fly Zone T2 — from your all-zones run 30d ago (stale, gear changed)');
        expect(status.note).toContain('in different gear');
    });

    test('an unsigned run cannot disagree with the gear worn now', () => {
        const unsigned = snapshot({ fingerprint: null });
        const { status } = combatRatesFromSnapshot(unsigned, { now: NOW, currentFingerprint: 'gear-b' });
        expect(status.gearChanged).toBe(false);
    });
});

describe('combatRatesFromSnapshot — no run at all', () => {
    test('offers nothing, and says which button produces some', () => {
        const { rates, best, status } = combatRatesFromSnapshot(null, { now: NOW });
        expect(rates).toEqual([]);
        expect(best).toBeNull();
        expect(status.hasSnapshot).toBe(false);
        expect(status.note).toBe(NO_SNAPSHOT_NOTE);
        expect(status.note).toContain('all-zones');
    });

    test('an empty run is the same as no run', () => {
        expect(combatRatesFromSnapshot({ zones: [] }, { now: NOW }).status.note).toBe(NO_SNAPSHOT_NOTE);
        expect(combatRatesFromSnapshot({}, { now: NOW }).status.note).toBe(NO_SNAPSHOT_NOTE);
    });
});

describe('loadCombatRates', () => {
    test('reads the stored run and signs the gear worn now', async () => {
        sim.snapshot = snapshot();
        sim.fingerprint = 'gear-b';

        const { best, status } = await loadCombatRates({ now: NOW });
        expect(best.zoneName).toBe('Fly Zone');
        expect(status.gearChanged).toBe(true);
    });

    test('skips the gear comparison when asked to', async () => {
        sim.snapshot = snapshot();
        sim.fingerprint = 'gear-b';

        const { status } = await loadCombatRates({ now: NOW, compareGear: false });
        expect(status.gearChanged).toBe(false);
    });

    test('a character the simulator cannot describe costs the comparison, not the rates', async () => {
        sim.snapshot = snapshot();
        sim.fingerprintThrows = true;
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const { best, status } = await loadCombatRates({ now: NOW });
        vi.restoreAllMocks();
        expect(best.goldPerHour).toBe(2_100_000);
        expect(status.gearChanged).toBe(false);
    });

    test('a storage failure reads as "no run", not as a crash', async () => {
        sim.loadThrows = true;
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const { rates, status } = await loadCombatRates({ now: NOW });
        expect(rates).toEqual([]);
        expect(status.note).toBe(NO_SNAPSHOT_NOTE);

        vi.restoreAllMocks();
    });
});
