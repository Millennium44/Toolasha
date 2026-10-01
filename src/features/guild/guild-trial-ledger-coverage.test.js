/**
 * Ledger coverage over two test-server weeks as they were stored on 2026-10-01.
 *
 * The shape is the live capture's: the trial ids, `at`s, `cycleAt`s, bases,
 * encounters, tiers and party sizes are the stored ones; the member names are
 * anonymized. The test server runs a cycle a day — a skilling hour at 21:00 UTC
 * and a combat hour at 22:00 — and the ledger records only the combat fight the
 * client watched, so every entry here is a cycle of its own. The current week's
 * first two entries predate cycle anchors and carry none. Some days have no
 * entry at all (Sunday 2026-09-27 among them), and coverage counts them missed.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const disk = vi.hoisted(() => ({ store: {} }));
const server = vi.hoisted(() => ({ test: true }));

vi.mock('../../utils/game-server.js', () => ({ isTestServer: () => server.test }));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (key in disk.store ? structuredClone(disk.store[key]) : fallback),
        set: async (key, value) => {
            disk.store[key] = structuredClone(value);
            return true;
        },
        delete: async (key) => {
            delete disk.store[key];
            return true;
        },
        getAllKeys: async () => Object.keys(disk.store),
    },
}));

const {
    accrueTrial,
    emptyLedgerCycle,
    foldLedgerCycles,
    ledgerCycleKey,
    ledgerCyclesByAnchor,
    loadLedgerCycles,
    observedCoverage,
} = await import('./guild-trial-ledger.js');

const SCOPE = 'SuperMoo';
const CAPTURED_AT = 1790890169467;
const LAST_WEEK = 1789689600000;
const THIS_WEEK = 1790294400000;

/** The stored entries: [weekStart, trialId start, at, basis, encounter, cycleAt, participants, member rows] */
const STORED = [
    [LAST_WEEK, 1789768361913, 1789770346166, 'stream', 'hedgehog', null, 49, 49],
    [LAST_WEEK, 1790028016781, 1790028818108, 'game', 'chameleon', null, 52, 52],
    [LAST_WEEK, 1790114422758, 1790116060886, 'stream', 'jellyfish', null, 45, 45],
    [LAST_WEEK, 1790288164236, 1790288260806, 'stream', 'swarm', null, null, 4],
    [THIS_WEEK, 1790460647703, 1790460845888, 'stream', 'jellyfish', null, 48, 48],
    [THIS_WEEK, 1790632822283, 1790634267020, 'stream', 'chameleon', null, 48, 48],
    [THIS_WEEK, 1790719219125, 1790720191043, 'game', 'swarm', 1790719217183, 55, 55],
    [THIS_WEEK, 1790805617675, 1790807367347, 'stream', 'hedgehog', 1790805617604, 50, 50],
];

/**
 * A week's record, folded the way the recorder folds it.
 * @param {number} weekStart - Which week
 * @returns {Object} The stored record
 */
function storedWeek(weekStart) {
    let record = emptyLedgerCycle(weekStart, SCOPE);
    STORED.forEach(([week, startedAt, at, basis, encounter, cycleAt, participants, rows], index) => {
        if (week !== weekStart) return;
        // Overlapping slices of a 132-member guild, as the attendance rows show
        const members = Array.from({ length: rows }, (_, i) => ({
            name: `Member${String(((index * 17 + i) % 132) + 1).padStart(3, '0')}`,
            damage: 1000 + i,
        }));
        record = accrueTrial(
            record,
            {
                trialId: `${weekStart}:${startedAt}`,
                weekStart,
                at,
                basis,
                encounter,
                cycleAt,
                tier: 21,
                seconds: 3600,
                participants,
                totals: { damage: 0 },
                members,
            },
            { perCycle: true }
        );
    });
    return record;
}

beforeEach(() => {
    server.test = true;
    disk.store = {
        [ledgerCycleKey(SCOPE, LAST_WEEK)]: storedWeek(LAST_WEEK),
        [ledgerCycleKey(SCOPE, THIS_WEEK)]: storedWeek(THIS_WEEK),
    };
});

describe('the ledger as stored on the test server on 2026-10-01', () => {
    test('every stored entry is a combat fight of its own cycle, a day or more apart', () => {
        const ats = STORED.map(([, , at]) => at);
        for (let i = 1; i < ats.length; i++) expect(ats[i] - ats[i - 1]).toBeGreaterThan(20 * 3_600_000);
    });

    test('an anchorless entry is placed by when it was recorded, not folded into the first anchored cycle', () => {
        const split = ledgerCyclesByAnchor([disk.store[ledgerCycleKey(SCOPE, THIS_WEEK)]], { perCycle: true });
        expect(split.map((cycle) => cycle.trials.map((trial) => trial.encounter))).toEqual([
            ['jellyfish'],
            ['chameleon'],
            ['swarm'],
            ['hedgehog'],
        ]);
        expect(split.map((cycle) => cycle.cycleAt)).toEqual([
            1790460845888, 1790634267020, 1790719217183, 1790805617604,
        ]);
        // Each cycle's tallies are its own fight's
        expect(split.map((cycle) => Object.keys(cycle.members).length)).toEqual([48, 48, 55, 50]);
    });

    test('a week with no anchors at all is still one cycle per recorded fight', () => {
        const split = ledgerCyclesByAnchor([disk.store[ledgerCycleKey(SCOPE, LAST_WEEK)]], { perCycle: true });
        expect(split).toHaveLength(4);
    });

    test('"Last 4 cycles" is the four days that ran and the one running; the Sunday nothing recorded is missed', async () => {
        // Thursday 21:29 UTC: Thursday's skilling hour is running. Sunday 2026-09-27 has no record
        const window = await loadLedgerCycles(SCOPE, null, { cycles: 4, now: CAPTURED_AT });
        expect(window.map((cycle) => cycle.trials[0].encounter)).toEqual(['chameleon', 'swarm', 'hedgehog']);

        const coverage = observedCoverage(window, { window: 4, now: CAPTURED_AT });
        expect(coverage).toEqual({ watched: 3, expected: 4, missed: 1, inProgress: true, daily: true, fraction: 0.75 });
        // One trial per watched cycle: the table's count and the coverage line agree
        expect(foldLedgerCycles(window).trialsRun).toBe(coverage.watched);
    });

    test('every day in a longer window with no record counts as missed', async () => {
        // Saturday 19th to Wednesday 30th: fights on the 21st, 22nd, 24th, 26th, 28th, 29th and 30th
        const window = await loadLedgerCycles(SCOPE, null, { cycles: 12, now: CAPTURED_AT });
        expect(window).toHaveLength(7);
        expect(observedCoverage(window, { window: 12, now: CAPTURED_AT })).toMatchObject({
            watched: 7,
            expected: 12,
            missed: 5,
        });
    });

    test('before the skilling hour opens nothing is running', async () => {
        const morning = Date.parse('2026-10-01T12:00:00Z');
        const window = await loadLedgerCycles(SCOPE, null, { cycles: 4, now: morning });
        expect(observedCoverage(window, { window: 4, now: morning })).toMatchObject({
            watched: 3,
            expected: 4,
            inProgress: false,
        });
    });

    test('the newest cycle is still in progress while its combat hour can be running', async () => {
        const now = 1790805617604 + 30 * 60_000;
        const window = await loadLedgerCycles(SCOPE, null, { cycles: 4, now });
        // Saturday to Tuesday ran; Wednesday's fight is shown but not counted
        expect(window.map((cycle) => cycle.trials[0].encounter)).toEqual([
            'jellyfish',
            'chameleon',
            'swarm',
            'hedgehog',
        ]);
        expect(observedCoverage(window, { window: 4, now })).toMatchObject({
            watched: 3,
            expected: 4,
            missed: 1,
            inProgress: true,
        });
    });

    test('live: one record a week, the current one left out, an unrecorded week missed', async () => {
        server.test = false;
        const window = await loadLedgerCycles(SCOPE, null, { cycles: 4, now: CAPTURED_AT });
        expect(window).toHaveLength(2);
        expect(observedCoverage(window, { window: 4, now: CAPTURED_AT })).toMatchObject({
            watched: 1,
            expected: 4,
            missed: 3,
            inProgress: true,
            daily: false,
        });
    });
});
