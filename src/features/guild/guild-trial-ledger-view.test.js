/** @vitest-environment happy-dom */

/**
 * The ledger panel, over a faked ledger.
 *
 * What is worth testing about a drawing is that it draws — `createPanel` catches
 * a failed draw and prints "could not be drawn" in place of the body, so the one
 * assertion no arithmetic test can make is that no section threw. Beyond that,
 * the table's own logic is pinned here rather than in the DOM: the sort the user
 * chose, the coverage sentence, and the cell texts that have to keep "not
 * measured" and "measured zero" apart.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    guildName: 'Nine Lives',
    members: [],
    cycles: [],
    loadouts: { players: {} },
    rows: [],
    // The real handler `simple-panel.js` registers at import time, captured
    // so a test can fire it the way a genuine character switch would.
    listeners: {},
    // Whether `reopenIfLeftOpen` should behave as if this panel was left open
    // across the switch — the panel-shell reopen path a character switch
    // takes only when it finds something to reopen.
    reopenOnSwitch: false,
    // The week's measured-vs-reported blob and the trial record whose `history`
    // carries the archived cycles, for the accuracy card
    trialStats: { weekStart: 0, trials: {} },
    trialRecord: { weekStart: 0, tiles: {}, history: [] },
}));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100, getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 7,
        getInitClientData: () => ({ abilityDetailMap: {} }),
        on: (event, handler) => {
            (world.listeners[event] ||= []).push(handler);
        },
        off: () => {},
    },
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    reopenIfLeftOpen: async (id, cb) => {
        if (world.reopenOnSwitch) await cb();
    },
    markPanelInteracted: () => {},
}));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: (definition) => world.rows.push(definition) }));
vi.mock('./guild-xp-tracker.js', () => ({
    guildXPTracker: {
        getOwnGuildName: () => world.guildName,
        getMemberList: () => world.members,
    },
}));
vi.mock('./guild-loadouts.js', () => ({ loadLoadouts: async () => world.loadouts }));
vi.mock('./guild-trial-ledger.js', async (importOriginal) => ({
    ...(await importOriginal()),
    loadLedgerCycles: async () => {
        // A queued answer, optionally gated so a test can control which of two
        // concurrent reads resolves first; falls back to the plain `world.cycles`
        const next = world.cyclesQueue?.shift();
        if (!next) return world.cycles;
        if (next.gate) await next.gate;
        return next.value;
    },
}));

// The accuracy card reads the trial store, which is IndexedDB and is never what
// these tests are about; the arithmetic behind the card lives in
// `guild-trial-accuracy.test.js`
vi.mock('./guild-trials-store.js', () => ({
    loadTrialStats: async () => world.trialStats,
    loadTrialRecord: async () => world.trialRecord,
}));

const {
    accuracyDeltaText,
    accuracyMatchText,
    accuracyMetricText,
    buildLedgerTable,
    coverageLine,
    filterLedgerRows,
    guildTrialLedgerPanel,
    lastAttendedText,
    lastCycleParticipants,
    ledgerCellText,
    ledgerTableText,
    refreshLedgerView,
    resetLedgerView,
} = await import('./guild-trial-ledger-view.js');

const WEEK = Date.parse('2026-08-03T00:00:00Z');

/**
 * A cycle record as the ledger stores one.
 * @param {number} weekStart - Which cycle
 * @param {number} trials - How many trials were recorded in it
 * @param {Object} members - name key → tally overrides
 * @returns {Object} The cycle
 */
function cycle(weekStart, trials, members) {
    const tallies = {};
    for (const [key, fields] of Object.entries(members)) {
        tallies[key] = {
            name: fields.name || key,
            trials: 1,
            damage: 0,
            healing: 0,
            damageTaken: 0,
            deaths: 0,
            manaSpent: 0,
            starvedMs: 0,
            lowManaMs: 0,
            seconds: 3600,
            firstSeen: weekStart,
            lastSeen: weekStart,
            ...fields,
        };
    }
    return {
        weekStart,
        scope: 'Nine Lives',
        members: tallies,
        trials: Array.from({ length: trials }, (_, index) => ({ trialId: `${weekStart}:${index}`, at: weekStart })),
    };
}

beforeEach(() => {
    resetLedgerView();
    world.guildName = 'Nine Lives';
    world.members = [];
    world.loadouts = { players: {} };
    world.rows = [];
    world.reopenOnSwitch = false;
    world.trialStats = { weekStart: WEEK, trials: {} };
    world.trialRecord = { weekStart: WEEK, tiles: {}, history: [] };
    world.cycles = [
        cycle(WEEK, 2, {
            alice: {
                name: 'Alice',
                trials: 2,
                damage: 9000,
                healing: 0,
                damageTaken: 100,
                deaths: 1,
                starvedMs: 60_000,
            },
            bob: { name: 'Bob', trials: 1, damage: 1000, healing: 500, damageTaken: 900 },
        }),
    ];
});

afterEach(() => {
    guildTrialLedgerPanel.hide({ remember: false });
    resetLedgerView();
});

describe('buildLedgerTable', () => {
    test('folds the cycles and sorts by the chosen column', async () => {
        await refreshLedgerView();
        const table = buildLedgerTable({ sortKey: 'damageShare', sortDirection: 'desc' });

        expect(table.trialsRun).toBe(2);
        expect(table.rows.map((row) => row.name)).toEqual(['Alice', 'Bob']);
        expect(table.rows[0].damageShare).toBeCloseTo(0.9, 6);
        expect(table.rows[0].attendance).toBe(1);
        expect(table.rows[1].attendance).toBe(0.5);
    });

    test('a rostered member the ledger never saw arrives as a no-show', async () => {
        world.members = [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }];
        await refreshLedgerView();

        const table = buildLedgerTable();
        expect(table.rows.find((row) => row.name === 'Carol')).toMatchObject({ trials: 0, noShow: true });
    });

    test('a slower, older read landing late does not overwrite a newer selection', async () => {
        // The first refresh's own read is delayed; a second refresh (the user
        // picking a different window before the first one answers) reads
        // faster and lands first. Storage reads do not resolve in call order.
        let releaseFirst;
        const firstGate = new Promise((resolve) => {
            releaseFirst = resolve;
        });
        world.cyclesQueue = [
            { gate: firstGate, value: [cycle(WEEK, 1, { alice: { name: 'Alice', damage: 111 } })] },
            { value: [cycle(WEEK, 1, { alice: { name: 'Alice', damage: 222 } })] },
        ];

        const first = refreshLedgerView();
        const second = refreshLedgerView();
        await second;
        releaseFirst();
        await first;

        const table = buildLedgerTable();
        expect(table.rows.find((row) => row.name === 'Alice').damage).toBe(222);
    });
});

describe('filterLedgerRows', () => {
    const rows = [{ name: 'Alice' }, { name: 'Bob' }, { name: 'AliceInTraining' }];

    test('blank text is not searching — everything shows', () => {
        expect(filterLedgerRows(rows, '')).toBe(rows);
        expect(filterLedgerRows(rows, '   ')).toEqual(rows);
    });

    test('matches a case-insensitive substring anywhere in the name', () => {
        expect(filterLedgerRows(rows, 'ali').map((row) => row.name)).toEqual(['Alice', 'AliceInTraining']);
        expect(filterLedgerRows(rows, 'BOB').map((row) => row.name)).toEqual(['Bob']);
    });

    test('no match is an empty table, not the whole one', () => {
        expect(filterLedgerRows(rows, 'zzz')).toEqual([]);
    });
});

describe('buildLedgerTable filtering', () => {
    test('a name filter narrows the rows without changing trials run', async () => {
        await refreshLedgerView();
        const table = buildLedgerTable({ filterText: 'alice' });

        expect(table.rows.map((row) => row.name)).toEqual(['Alice']);
        expect(table.trialsRun).toBe(2);
    });
});

describe('ledgerTableText', () => {
    test('one line per row plus a totals line, in the sorted order given', async () => {
        await refreshLedgerView();
        const table = buildLedgerTable({ sortKey: 'damageShare', sortDirection: 'desc' });

        const text = ledgerTableText(table);
        const lines = text.split('\n');
        expect(lines[0]).toBe('Guild trial ledger — 2 trials in window');
        expect(lines[1]).toContain('Alice — 2 trials (100.0%)');
        expect(lines[1]).toContain('dmg 90.0%');
        expect(lines[2]).toContain('Bob — 1 trials (50.0%)');
        expect(lines[3]).toContain('Total — 3 trials');
        expect(lines[3]).toContain('dmg 100.0%');
    });

    test('nothing to show is said plainly, not as an empty report', () => {
        expect(ledgerTableText({ rows: [], trialsRun: 0 })).toBe('No ledger rows to copy.');
        expect(ledgerTableText(null)).toBe('No ledger rows to copy.');
    });

    test('a no-show reads as a no-show rather than a bare zero', async () => {
        world.members = [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }];
        await refreshLedgerView();
        const table = buildLedgerTable();

        const carolLine = ledgerTableText(table)
            .split('\n')
            .find((line) => line.startsWith('Carol'));
        expect(carolLine).toContain('no-show');
    });
});

describe('coverageLine', () => {
    test('says what was watched against what a cycle runs', () => {
        expect(coverageLine({ observed: 2, expected: 4, cycles: 2 })).toBe('2 of 4 trials watched across 2 cycles');
        expect(coverageLine({ observed: 1, expected: 2, cycles: 1 })).toContain('1 cycle');
    });

    test('nothing recorded says so rather than printing zeros', () => {
        expect(coverageLine({ observed: 0, expected: 0, cycles: 0 })).toBe('No cycles recorded yet.');
    });

    test('the week in progress is said to be uncounted', () => {
        const line = coverageLine({ observed: 2, expected: 2, cycles: 1, inProgress: true });
        expect(line).toContain('2 of 2 trials watched across 1 cycle');
        expect(line).toContain('This week is still running and is not counted yet.');
    });

    test('a window that is only this week says there is nothing complete to measure', () => {
        const line = coverageLine({ observed: 0, expected: 0, cycles: 0, inProgress: true });
        expect(line).toContain('No completed cycles yet.');
        expect(line).toContain('not counted yet');
    });
});

describe('ledgerCellText', () => {
    test('an unmeasured share is a dash and a measured zero is 0.0%', () => {
        expect(ledgerCellText({ healingShare: null }, 'healingShare')).toBe('—');
        expect(ledgerCellText({ healingShare: 0 }, 'healingShare')).toBe('0.0%');
    });

    test('a no-show wears the label in its own cell', () => {
        expect(ledgerCellText({ name: 'Carol', noShow: true }, 'name')).toBe('Carol (no-show)');
        expect(ledgerCellText({ name: 'Alice', noShow: false }, 'name')).toBe('Alice');
    });

    test('starved time is minutes, and no starved time is a dash', () => {
        expect(ledgerCellText({ starvedMs: 90_000 }, 'starvedMs')).toBe('2m');
        expect(ledgerCellText({ starvedMs: 0 }, 'starvedMs')).toBe('—');
    });
});

describe('lastAttendedText', () => {
    test('a row with a lastSeen timestamp names the local day', () => {
        const t = new Date(2026, 7, 14, 18, 30).getTime();
        expect(lastAttendedText({ lastSeen: t })).toBe('last attended 2026-08-14');
    });

    test('a row with no lastSeen has never attended in the window, not a blank date', () => {
        expect(lastAttendedText({ lastSeen: null })).toBe('never attended in this window');
        expect(lastAttendedText({})).toBe('never attended in this window');
    });
});

describe('lastCycleParticipants', () => {
    test('names whoever joined something in the newest cycle, sorted', () => {
        expect(lastCycleParticipants(world.cycles)).toEqual(['Alice', 'Bob']);
    });

    test('a member with no trials in that cycle is not a participant of it', () => {
        const cycles = [cycle(WEEK, 1, { alice: { name: 'Alice', trials: 1 }, ghost: { name: 'Ghost', trials: 0 } })];
        expect(lastCycleParticipants(cycles)).toEqual(['Alice']);
    });

    test('no cycles is nobody', () => {
        expect(lastCycleParticipants([])).toEqual([]);
    });
});

describe('the panel', () => {
    test('draws every section without any of them failing', async () => {
        await refreshLedgerView();
        guildTrialLedgerPanel.show({ remember: false });

        const text = guildTrialLedgerPanel.panel.textContent;
        expect(text).not.toContain('could not be drawn');
        expect(text).toContain('Nine Lives');
        expect(text).toContain('Attendance and contribution');
        expect(text).toContain('Roster composition');
        expect(text).toContain('Alice');
    });

    // simple-panel.js reopens a panel left open across a character switch by
    // calling `api.show()` directly, bypassing `openTrialLedgerPanel()` (and
    // therefore `refreshLedgerView()`) entirely. Nothing in this file listens
    // for the switch itself, so the panel keeps drawing off `state.cycles` —
    // the departed guild's own ledger — until something else happens to call
    // `refreshLedgerView()` again (the window selector, or a manual reopen
    // through the row).
    test('a character switch does not leave the panel showing the departed guild’s ledger', async () => {
        await refreshLedgerView();
        guildTrialLedgerPanel.show({ remember: false });
        expect(guildTrialLedgerPanel.panel.textContent).toContain('Alice');

        // The arriving guild is a different one entirely
        world.guildName = 'Testmaxxing';
        world.cycles = [cycle(WEEK, 1, { zed: { name: 'Zed', trials: 1, damage: 500 } })];
        world.reopenOnSwitch = true;

        await world.listeners.character_switched?.[0]?.();

        const text = guildTrialLedgerPanel.panel.textContent;
        expect(text).toContain('Testmaxxing');
        expect(text).not.toContain('Alice');
        expect(text).toContain('Zed');
    });

    test('the composition box starts from the last recorded cycle', async () => {
        await refreshLedgerView();
        guildTrialLedgerPanel.show({ remember: false });

        const box = guildTrialLedgerPanel.panel.querySelector('textarea');
        expect(box.value.split('\n')).toEqual(['Alice', 'Bob']);
    });

    test('a header click re-sorts the table rather than redrawing it unchanged', async () => {
        await refreshLedgerView();
        guildTrialLedgerPanel.show({ remember: false });

        const headers = [...guildTrialLedgerPanel.panel.querySelectorAll('th')];
        const deaths = headers.find((header) => header.textContent.startsWith('Deaths'));
        deaths.click();

        const first = guildTrialLedgerPanel.panel.querySelectorAll('td')[0];
        expect(first.textContent).toBe('Alice');
        expect(buildLedgerTable().rows[0].name).toBe('Alice');
    });

    test('a row names its member’s last-attended date in its tooltip', async () => {
        await refreshLedgerView();
        guildTrialLedgerPanel.show({ remember: false });

        const rows = [...guildTrialLedgerPanel.panel.querySelectorAll('tbody tr, tr')].filter((row) =>
            row.textContent.startsWith('Alice')
        );
        expect(rows[0].title).toContain(`last attended ${lastAttendedText({ lastSeen: WEEK }).slice(-10)}`);
    });

    test('an empty ledger says so instead of drawing a headed table with no rows', async () => {
        world.cycles = [];
        await refreshLedgerView();
        guildTrialLedgerPanel.show({ remember: false });

        const text = guildTrialLedgerPanel.panel.textContent;
        expect(text).not.toContain('could not be drawn');
        expect(text).toContain('Nothing recorded yet');
    });
});

describe('the accuracy card', () => {
    /** The panel, drawn, as one string */
    async function drawn() {
        await refreshLedgerView();
        guildTrialLedgerPanel.show({ remember: false });
        return guildTrialLedgerPanel.panel.textContent;
    }

    test('names the section and states the healing/taken expectation up front', async () => {
        const text = await drawn();
        expect(text).not.toContain('could not be drawn');
        expect(text).toContain('Attribution accuracy');
        expect(text).toContain('expected to run wider than damage');
    });

    test('a week with no comparison says so rather than showing a perfect score', async () => {
        const text = await drawn();
        expect(text).toContain('No comparison recorded this week');
    });

    test("draws this week's trial with its overall delta, its metrics and its outliers", async () => {
        world.trialStats = {
            weekStart: WEEK,
            trials: {
                'Elite Trial': {
                    at: WEEK,
                    reported: {
                        Alice: { damage: 1000, healing: 100, taken: 100 },
                        Bob: { damage: 1000, healing: 100, taken: 100 },
                        Renamed: { damage: 1000, healing: 100, taken: 100 },
                    },
                    measured: {
                        Alice: { damage: 1000, healing: 100, taken: 100 },
                        Bob: { damage: 1400, healing: 100, taken: 100 },
                    },
                },
            },
        };
        const text = await drawn();

        expect(text).not.toContain('could not be drawn');
        expect(text).toContain('Elite Trial');
        // Two matched players, 2400 measured against 2000 reported
        expect(text).toContain('+20.0%');
        expect(text).toContain('2 of 3 names matched');
        expect(text).toContain('1 unmatched');
        // Bob is 40% out on damage and gets a row; Alice is exact and does not
        expect(text).toContain('Bob');
        expect(text).toContain('Damage +40.0%');
    });

    test('a clean trial says nobody was past the threshold rather than listing nothing', async () => {
        world.trialStats = {
            weekStart: WEEK,
            trials: {
                'Elite Trial': {
                    at: WEEK,
                    reported: { Alice: { damage: 1000 } },
                    measured: { Alice: { damage: 1000 } },
                },
            },
        };
        expect(await drawn()).toContain('No player past 15% on any metric');
    });

    test('an archived cycle with no accuracy renders as "no accuracy data"', async () => {
        world.trialRecord = {
            weekStart: WEEK,
            tiles: {},
            history: [{ archivedAt: WEEK, reason: 'a new cycle is scheduled', weekStart: WEEK - 1, tiles: {} }],
        };
        const text = await drawn();
        expect(text).not.toContain('could not be drawn');
        expect(text).toContain('Archived cycles');
        expect(text).toContain('no accuracy data');
    });

    test('an archived cycle carrying a summary draws its damage median', async () => {
        world.trialRecord = {
            weekStart: WEEK,
            tiles: {},
            history: [
                {
                    archivedAt: WEEK,
                    reason: 'a new cycle is scheduled',
                    weekStart: WEEK - 1,
                    tiles: {},
                    accuracy: {
                        elite: {
                            at: WEEK - 1,
                            players: 4,
                            matched: 4,
                            unmatched: 0,
                            measuredOnly: 0,
                            metrics: {
                                damage: { median: 3.5, worst: -9, players: 4 },
                                healing: { median: null, worst: null, players: 0 },
                                taken: { median: null, worst: null, players: 0 },
                            },
                        },
                    },
                },
            ],
        };
        const text = await drawn();
        expect(text).not.toContain('no accuracy data');
        expect(text).toContain('dmg +3.5%');
    });
});

describe('the accuracy card’s text helpers', () => {
    test('a delta reads with its sign, and the cases a number would lie about read as words', () => {
        expect(accuracyDeltaText(3.14)).toBe('+3.1%');
        expect(accuracyDeltaText(-11)).toBe('-11.0%');
        expect(accuracyDeltaText(Infinity)).toBe('unreported');
        expect(accuracyDeltaText(null)).toBe('—');
    });

    test('the match line names unmatched and measured-only counts, and omits them at zero', () => {
        expect(accuracyMatchText({ players: 10, matched: 9, unmatched: 1, measuredOnly: 2 })).toBe(
            '9 of 10 names matched · 1 unmatched · 2 measured only'
        );
        expect(accuracyMatchText({ players: 10, matched: 10, unmatched: 0, measuredOnly: 0 })).toBe(
            '10 of 10 names matched'
        );
        expect(accuracyMatchText({ players: 0 })).toBe('No names to match');
    });

    test('a metric nothing was reported for says so rather than showing zeros', () => {
        expect(accuracyMetricText({ median: null, worst: null, players: 0 })).toBe('nothing reported');
        expect(accuracyMetricText({ median: 2.1, worst: -18.4, players: 8 })).toBe(
            'median +2.1% · worst -18.4% (8 players)'
        );
        expect(accuracyMetricText({ median: 0, worst: 0, players: 1 })).toBe('median +0.0% · worst +0.0% (1 player)');
    });
});
