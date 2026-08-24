/**
 * The attendance ledger's accrual and its table.
 *
 * Three claims here are load-bearing. A session's snapshots are cumulative, so a
 * contribution is read off the last one and never summed — summing them would
 * multiply the first minute by the number of snapshots. A trial folded twice
 * would put a member's attendance above the number of trials that happened, so
 * the fold is idempotent on the session's own start. And a share is never
 * stored: 30% of one trial and 10% of another is not 20% of the two unless the
 * two were the same size, so every share is recomputed over whichever window is
 * being looked at.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const disk = vi.hoisted(() => ({ store: {}, failNextRead: false }));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => {
            if (disk.failNextRead) {
                disk.failNextRead = false;
                throw new Error('IndexedDB is having a day');
            }
            return key in disk.store ? structuredClone(disk.store[key]) : fallback;
        },
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
    LEDGER_CSV_COLUMNS,
    MAX_LEDGER_CYCLES,
    accrueTrial,
    clearLedger,
    emptyLedgerCycle,
    foldLedgerCycles,
    ledgerCsvRows,
    ledgerCycleKey,
    ledgerCyclesInKeys,
    ledgerScope,
    loadLedgerCycles,
    observedCoverage,
    recordFinishedTrial,
    sessionContribution,
    sortLedgerRows,
} = await import('./guild-trial-ledger.js');
const { trialWeekStart } = await import('./guild-trials-math.js');

const WEEK = Date.parse('2026-08-03T00:00:00Z');

/**
 * One recorder snapshot row, with only the fields a test cares about set.
 * @param {string} name - Who
 * @param {Object} fields - Their figures
 * @returns {Object} A snapshot player row
 */
function player(name, fields = {}) {
    return {
        index: name,
        name,
        damage: 0,
        deaths: 0,
        healingDone: 0,
        damageTaken: 0,
        manaSpent: 0,
        starvedMs: 0,
        lowManaMs: 0,
        ...fields,
    };
}

/**
 * A finished session as the recorder writes one.
 * @param {Array<Array<Object>>} snapshots - Player rows per snapshot, oldest first
 * @param {Object} overrides - Session fields
 * @returns {Object} The session
 */
function session(snapshots, overrides = {}) {
    return {
        startedAt: WEEK + 1000,
        endedAt: WEEK + 3_600_000,
        weekStart: WEEK,
        snapshots: snapshots.map((players, index) => ({
            t: WEEK + 1000 + index * 15_000,
            seconds: (index + 1) * 15,
            players,
        })),
        ...overrides,
    };
}

beforeEach(() => {
    disk.store = {};
    disk.failNextRead = false;
});

describe('ledgerScope and its keys', () => {
    test('the guild names the scope, and the character is the fallback', () => {
        expect(ledgerScope('Nine Lives', 42)).toBe('Nine Lives');
        expect(ledgerScope(null, 42)).toBe('char_42');
        expect(ledgerScope(null, null)).toBe('default');
    });

    test('a cycle stamp is parsed back out of a key even from a guild with an underscore', () => {
        const keys = [
            ledgerCycleKey('Nine_Lives', WEEK),
            ledgerCycleKey('Nine_Lives', WEEK - 604_800_000),
            ledgerCycleKey('Other Guild', WEEK),
            'guildTrials_Nine_Lives',
            'somethingElse',
        ];
        expect(ledgerCyclesInKeys(keys, 'Nine_Lives')).toEqual([WEEK - 604_800_000, WEEK]);
    });
});

describe('sessionContribution', () => {
    test('reads the last snapshot, not the sum of them', () => {
        const contribution = sessionContribution(
            session([
                [player('Alice', { damage: 100 })],
                [player('Alice', { damage: 400 })],
                [player('Alice', { damage: 900, deaths: 1, healingDone: 20, damageTaken: 55, starvedMs: 4000 })],
            ])
        );

        expect(contribution.members).toHaveLength(1);
        expect(contribution.members[0]).toMatchObject({ name: 'Alice', damage: 900, deaths: 1, starvedMs: 4000 });
        expect(contribution.totals.damage).toBe(900);
        expect(contribution.seconds).toBe(45);
    });

    test('a member the game rostered but nothing attributed is present at zero', () => {
        const contribution = sessionContribution(session([[player('Alice', { damage: 900 })]]), {
            roster: ['Alice', 'Bob'],
        });

        const names = contribution.members.map((member) => member.name).sort();
        expect(names).toEqual(['Alice', 'Bob']);
        expect(contribution.members.find((member) => member.name === 'Bob').damage).toBe(0);
    });

    test('a session that recorded nobody folds nothing', () => {
        expect(sessionContribution(session([]))).toBeNull();
        expect(sessionContribution(null)).toBeNull();
    });

    test('the trial id is the session, so two sessions in a week are two trials', () => {
        const first = sessionContribution(session([[player('Alice')]]));
        const second = sessionContribution(session([[player('Alice')]], { startedAt: WEEK + 5_000_000 }));
        expect(first.trialId).not.toBe(second.trialId);
    });
});

describe('accrueTrial', () => {
    test('adds a member row and counts the trial', () => {
        const contribution = sessionContribution(
            session([[player('Alice', { damage: 900, deaths: 1 }), player('Bob', { damage: 100 })]])
        );
        const cycle = accrueTrial(emptyLedgerCycle(WEEK, 'Nine Lives'), contribution);

        expect(cycle.trials).toHaveLength(1);
        expect(cycle.members.alice).toMatchObject({ name: 'Alice', trials: 1, damage: 900, deaths: 1 });
        expect(cycle.members.bob).toMatchObject({ trials: 1, damage: 100 });
    });

    test('two trials accumulate rather than replace', () => {
        const one = sessionContribution(session([[player('Alice', { damage: 900 })]]));
        const two = sessionContribution(session([[player('Alice', { damage: 300 })]], { startedAt: WEEK + 5_000_000 }));

        let cycle = accrueTrial(emptyLedgerCycle(WEEK, 'g'), one);
        cycle = accrueTrial(cycle, two);

        expect(cycle.trials).toHaveLength(2);
        expect(cycle.members.alice).toMatchObject({ trials: 2, damage: 1200 });
    });

    test('folding the same session twice is a no-op, and says so by identity', () => {
        const contribution = sessionContribution(session([[player('Alice', { damage: 900 })]]));
        const once = accrueTrial(emptyLedgerCycle(WEEK, 'g'), contribution);
        const twice = accrueTrial(once, contribution);

        expect(twice).toBe(once);
        expect(twice.members.alice.trials).toBe(1);
    });

    test('the freshest spelling of a name wins', () => {
        const one = sessionContribution(session([[player('alice', { damage: 1 })]]));
        const two = sessionContribution(session([[player('Alice', { damage: 1 })]], { startedAt: WEEK + 9 }));
        const cycle = accrueTrial(accrueTrial(emptyLedgerCycle(WEEK, 'g'), one), two);
        expect(cycle.members.alice.name).toBe('Alice');
    });
});

describe('foldLedgerCycles', () => {
    /**
     * @param {number} weekStart - Which cycle
     * @param {Array<Array<Object>>} trials - Player rows per trial
     * @returns {Object} A cycle with those trials folded in
     */
    function cycleOf(weekStart, trials) {
        let cycle = emptyLedgerCycle(weekStart, 'g');
        trials.forEach((players, index) => {
            cycle = accrueTrial(
                cycle,
                sessionContribution(session([players], { weekStart, startedAt: weekStart + index }))
            );
        });
        return cycle;
    }

    test('shares are of the window, not an average of stored shares', () => {
        // One trial where Alice did 30% of 1,000, one where she did 10% of
        // 9,000. Averaging the stored shares would say 20%; the truth is 12%.
        const cycles = [
            cycleOf(WEEK, [[player('Alice', { damage: 300 }), player('Bob', { damage: 700 })]]),
            cycleOf(WEEK + 604_800_000, [[player('Alice', { damage: 900 }), player('Bob', { damage: 8100 })]]),
        ];

        const folded = foldLedgerCycles(cycles);
        const alice = folded.rows.find((row) => row.name === 'Alice');
        expect(alice.damage).toBe(1200);
        expect(alice.damageShare).toBeCloseTo(1200 / 10_000, 6);
        expect(folded.trialsRun).toBe(2);
        expect(alice.attendance).toBe(1);
    });

    test('a rostered member who joined nothing is a no-show row', () => {
        const folded = foldLedgerCycles([cycleOf(WEEK, [[player('Alice', { damage: 300 })]])], {
            rosterNames: ['Alice', 'Carol'],
        });

        const carol = folded.rows.find((row) => row.name === 'Carol');
        expect(carol).toMatchObject({ trials: 0, noShow: true, missed: 1 });
        expect(carol.damageShare).toBe(0);
        expect(folded.rows.find((row) => row.name === 'Alice').noShow).toBe(false);
    });

    test('with no trials at all nobody is accused of anything', () => {
        const folded = foldLedgerCycles([], { rosterNames: ['Alice'] });
        expect(folded.trialsRun).toBe(0);
        expect(folded.rows[0]).toMatchObject({ noShow: false, attendance: null });
    });

    test('a member measured by nothing gets a null share rather than a zero', () => {
        const folded = foldLedgerCycles([cycleOf(WEEK, [[player('Alice', { damage: 0 })]])]);
        expect(folded.rows[0].damageShare).toBeNull();
    });
});

describe('sortLedgerRows', () => {
    const rows = [
        { name: 'Alice', damageShare: 0.5, trials: 2 },
        { name: 'Bob', damageShare: null, trials: 1 },
        { name: 'Carol', damageShare: 0.9, trials: 3 },
    ];

    test('descending puts the biggest first and the unmeasured last', () => {
        expect(sortLedgerRows(rows, 'damageShare', 'desc').map((row) => row.name)).toEqual(['Carol', 'Alice', 'Bob']);
    });

    test('ascending keeps the unmeasured last too — a blank is not a small number', () => {
        expect(sortLedgerRows(rows, 'damageShare', 'asc').map((row) => row.name)).toEqual(['Alice', 'Carol', 'Bob']);
    });

    test('names sort as text', () => {
        expect(sortLedgerRows(rows, 'name', 'asc').map((row) => row.name)).toEqual(['Alice', 'Bob', 'Carol']);
    });
});

describe('observedCoverage', () => {
    test('counts the trials seen against the two a cycle runs', () => {
        const cycles = [
            { trials: [{ trialId: 'a' }, { trialId: 'b' }] },
            { trials: [{ trialId: 'c' }] },
            { trials: [] },
        ];
        expect(observedCoverage(cycles, { now: Date.parse('2020-01-01T00:00:00Z') })).toEqual({
            observed: 3,
            expected: 6,
            cycles: 3,
            inProgress: false,
            fraction: 0.5,
        });
    });

    test('the week in progress is left out of the ratio, not scored against itself', () => {
        const now = Date.parse('2026-08-23T12:00:00Z');
        const thisWeek = trialWeekStart(now);
        const lastWeek = thisWeek - 7 * 24 * 60 * 60 * 1000;

        // Last week ran both; this week has run one so far and the panel saw it
        const coverage = observedCoverage(
            [
                { weekStart: lastWeek, trials: [{ trialId: 'a' }, { trialId: 'b' }] },
                { weekStart: thisWeek, trials: [{ trialId: 'c' }] },
            ],
            { now }
        );

        expect(coverage).toEqual({ observed: 2, expected: 2, cycles: 1, inProgress: true, fraction: 1 });
    });

    test('a trial missed this week cannot hide behind seen-of-seen', () => {
        const now = Date.parse('2026-08-23T12:00:00Z');
        const thisWeek = trialWeekStart(now);
        const lastWeek = thisWeek - 7 * 24 * 60 * 60 * 1000;

        // The panel was shut for one of last week's two, and saw nothing at all
        // this week. Charging the current cycle only for what it saw used to
        // report the whole window as perfect
        const coverage = observedCoverage(
            [
                { weekStart: lastWeek, trials: [{ trialId: 'a' }] },
                { weekStart: thisWeek, trials: [] },
            ],
            { now }
        );

        expect(coverage.fraction).toBe(0.5);
        expect(coverage.inProgress).toBe(true);
    });

    test('a duplicate recording cannot push a cycle past what a cycle holds', () => {
        const coverage = observedCoverage(
            [{ weekStart: 0, trials: [{ trialId: 'a' }, { trialId: 'b' }, { trialId: 'b' }] }],
            { now: Date.parse('2026-08-23T12:00:00Z') }
        );

        expect(coverage.observed).toBe(2);
        expect(coverage.fraction).toBe(1);
    });

    test('no cycles is no fraction rather than zero', () => {
        expect(observedCoverage([]).fraction).toBeNull();
    });

    test('a window that is only the week in progress has nothing to measure', () => {
        const now = Date.parse('2026-08-23T12:00:00Z');
        const coverage = observedCoverage([{ weekStart: trialWeekStart(now), trials: [{ trialId: 'a' }] }], { now });

        expect(coverage).toEqual({ observed: 0, expected: 0, cycles: 0, inProgress: true, fraction: null });
    });
});

describe('ledgerCsvRows', () => {
    test('carries raw numbers and turns milliseconds into seconds', () => {
        const [row] = ledgerCsvRows(
            [
                {
                    name: 'Alice',
                    trials: 2,
                    missed: 1,
                    attendance: 2 / 3,
                    damage: 1234.6,
                    damageShare: 0.4,
                    healing: 10,
                    healingShare: null,
                    damageTaken: 5,
                    tankShare: 0.1,
                    deaths: 1,
                    manaSpent: 90,
                    starvedMs: 90_000,
                    lowManaMs: 30_000,
                    noShow: false,
                },
            ],
            3
        );

        expect(row).toMatchObject({ trialsRun: 3, damage: 1235, starvedSeconds: 90, lowManaSeconds: 30 });
        expect(row.healingShare).toBeNull();
        expect(LEDGER_CSV_COLUMNS.every((column) => column.key in row)).toBe(true);
    });
});

describe('the ledger on disk', () => {
    test('a finished session writes exactly one cycle record, and reads back', async () => {
        const written = await recordFinishedTrial({
            session: session([[player('Alice', { damage: 900 }), player('Bob', { damage: 100 })]]),
            guildName: 'Nine Lives',
            characterId: 7,
            encounter: 'Chameleon',
            tier: 5,
        });

        expect(written).not.toBeNull();
        expect(Object.keys(disk.store)).toEqual([ledgerCycleKey('Nine Lives', WEEK)]);

        const cycles = await loadLedgerCycles('Nine Lives', 7);
        expect(cycles).toHaveLength(1);
        expect(cycles[0].members.alice.damage).toBe(900);
        expect(cycles[0].trials[0]).toMatchObject({ encounter: 'Chameleon', tier: 5 });
    });

    test('the same session recorded twice is folded once', async () => {
        const finished = session([[player('Alice', { damage: 900 })]]);
        await recordFinishedTrial({ session: finished, guildName: 'g' });
        const second = await recordFinishedTrial({ session: finished, guildName: 'g' });

        expect(second).toBeNull();
        const [cycle] = await loadLedgerCycles('g');
        expect(cycle.members.alice.trials).toBe(1);
    });

    test('two guilds in one tab never read each other back', async () => {
        await recordFinishedTrial({ session: session([[player('Alice', { damage: 5 })]]), guildName: 'First' });
        await recordFinishedTrial({ session: session([[player('Bob', { damage: 5 })]]), guildName: 'Second' });

        expect((await loadLedgerCycles('First'))[0].members).toHaveProperty('alice');
        expect((await loadLedgerCycles('First'))[0].members).not.toHaveProperty('bob');
    });

    test('the window reads only the most recent cycles', async () => {
        for (let index = 0; index < 5; index += 1) {
            const weekStart = WEEK + index * 604_800_000;
            await recordFinishedTrial({
                session: session([[player('Alice', { damage: 1 })]], { weekStart, startedAt: weekStart }),
                guildName: 'g',
            });
        }

        expect(await loadLedgerCycles('g', null, { cycles: 2 })).toHaveLength(2);
        expect(await loadLedgerCycles('g')).toHaveLength(5);
    });

    test('cycles past the cap are pruned, oldest first', async () => {
        for (let index = 0; index < MAX_LEDGER_CYCLES + 3; index += 1) {
            const weekStart = WEEK + index * 604_800_000;
            await recordFinishedTrial({
                session: session([[player('Alice', { damage: 1 })]], { weekStart, startedAt: weekStart }),
                guildName: 'g',
            });
        }

        const cycles = await loadLedgerCycles('g');
        expect(cycles).toHaveLength(MAX_LEDGER_CYCLES);
        expect(cycles[0].weekStart).toBe(WEEK + 3 * 604_800_000);
    });

    test('a read that throws costs the table, never the recording', async () => {
        disk.failNextRead = true;
        await expect(
            recordFinishedTrial({ session: session([[player('Alice', { damage: 1 })]]), guildName: 'g' })
        ).resolves.toBeNull();
    });

    test('clearing takes one guild and leaves the other', async () => {
        await recordFinishedTrial({ session: session([[player('Alice')]]), guildName: 'First' });
        await recordFinishedTrial({ session: session([[player('Bob')]]), guildName: 'Second' });

        expect(await clearLedger('First')).toBe(1);
        expect(await loadLedgerCycles('First')).toHaveLength(0);
        expect(await loadLedgerCycles('Second')).toHaveLength(1);
    });
});
