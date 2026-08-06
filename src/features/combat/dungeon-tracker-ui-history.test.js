/** @vitest-environment happy-dom
 *
 * The run history's group headers, where a team is a list of names.
 *
 * A team-grouped header reads "Irokez,Mazo,groezy", and each of those is a
 * player somebody might want to look up mid-argument about whose fault the
 * slow run was. So each name is its own clickable span that fills
 * "/profile <name>" into chat — without ever changing what the header says,
 * and without a name click toggling the group it sits on.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./dungeon-tracker-storage.js', () => ({
    default: { getAllRuns: async () => [], getTeamKey: (names) => [...names].sort().join(',') },
    filterRunsForCharacter: (runs) => runs,
    currentCharacter: () => 'me',
}));
vi.mock('../../core/storage.js', () => ({ default: { setJSON: vi.fn(async () => true) } }));
vi.mock('../../utils/formatters.js', () => ({ formatDateTime: () => '04/08 10:00' }));

const {
    default: DungeonTrackerUIHistory,
    buildRunHistoryRows,
    DUNGEON_RUN_CSV_COLUMNS,
} = await import('./dungeon-tracker-ui-history.js');

/** A fresh panel state, the shape dungeon-tracker-ui-state.js hands over. */
function freshState(groupBy = 'team') {
    return {
        groupBy,
        filterDungeon: 'all',
        filterTeam: 'all',
        filterCharacter: 'all',
        expandedGroups: new Set(),
    };
}

function run(teamKey, dungeonName = 'Chimerical Den') {
    return { teamKey, dungeonName, duration: 300_000, timestamp: '2026-08-04T10:00:00.000Z' };
}

/** Render one grouped list into a fresh run-list element and hand it back. */
function render(history, groups) {
    const runList = document.createElement('div');
    document.body.appendChild(runList);
    history.renderGroupedRuns(runList, groups);
    return runList;
}

beforeEach(() => {
    document.body.innerHTML = '<div class="Chat_chatInputContainer__c"><input /></div>';
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('team group headers', () => {
    test('each name in the header is its own clickable span, and the label reads unchanged', () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const runList = render(history, history.groupByTeam([run('Irokez,Mazo,groezy')]));

        const names = [...runList.querySelectorAll('.mwi-dt-player-name')];
        expect(names.map((el) => el.textContent)).toEqual(['Irokez', 'Mazo', 'groezy']);
        expect(names.every((el) => el.style.cursor === 'pointer')).toBe(true);

        const header = runList.querySelector('.mwi-dt-group-header');
        expect(header.textContent).toContain('Irokez,Mazo,groezy');
    });

    test('clicking a name fills "/profile <name>" into chat', () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const runList = render(history, history.groupByTeam([run('Irokez,Mazo')]));
        const input = document.querySelector('input');

        const mazo = [...runList.querySelectorAll('.mwi-dt-player-name')].find((el) => el.textContent === 'Mazo');
        mazo.dispatchEvent(new Event('click', { bubbles: true }));

        expect(input.value).toBe('/profile Mazo');
    });

    test('a name click does not also toggle the group open', () => {
        const state = freshState('team');
        const history = new DungeonTrackerUIHistory(state, (ms) => `${ms}ms`);
        const runList = render(history, history.groupByTeam([run('Irokez,Mazo')]));

        const runsDiv = runList.querySelector('.mwi-dt-group-runs');
        expect(runsDiv.style.display).toBe('none');

        runList.querySelector('.mwi-dt-player-name').dispatchEvent(new Event('click', { bubbles: true }));

        expect(runsDiv.style.display).toBe('none');
        expect(state.expandedGroups.size).toBe(0);
    });

    test('with no chat input on screen the click simply does nothing', () => {
        document.body.innerHTML = '';
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const runList = render(history, history.groupByTeam([run('Irokez,Mazo')]));

        expect(() => {
            runList.querySelector('.mwi-dt-player-name').dispatchEvent(new Event('click', { bubbles: true }));
        }).not.toThrow();
    });

    test('a malformed name in the key stays plain text while its teammates stay clickable', () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const runList = render(history, history.groupByTeam([run('Irokez,<b>Not A Name</b>')]));

        const names = [...runList.querySelectorAll('.mwi-dt-player-name')];
        expect(names.map((el) => el.textContent)).toEqual(['Irokez']);
        // Escaped, not parsed: the label still reads as the key was written
        expect(runList.querySelector('.mwi-dt-group-header b')).toBeNull();
    });

    test('the Solo bucket is not a player name', () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const runList = render(history, history.groupByTeam([run(null)]));

        expect(runList.textContent).toContain('Solo Runs');
        expect(runList.querySelector('.mwi-dt-player-name')).toBeNull();
    });
});

describe('the CSV export', () => {
    test('no runs is no rows, not a header-only file pretending otherwise', () => {
        expect(buildRunHistoryRows([])).toEqual([]);
        expect(buildRunHistoryRows(null)).toEqual([]);
    });

    test('one row per run, timestamps ISO, duration in seconds, key counts flattened', () => {
        const runs = [
            {
                timestamp: '2026-08-04T10:00:00.000Z',
                dungeonName: 'Chimerical Den',
                tier: 1,
                duration: 300_000,
                team: ['Irokez', 'Mazo'],
                teamKey: 'Irokez,Mazo',
                keyCountsMap: { Mazo: 3, Irokez: 2 },
            },
            // A legacy websocket-recorded run: totalTime instead of duration,
            // no team array, no tier, no key counts
            { timestamp: '2026-08-03T09:30:00.000Z', dungeonName: 'Pirate Cove', totalTime: 240_000 },
        ];

        expect(buildRunHistoryRows(runs)).toEqual([
            {
                timestamp: '2026-08-04T10:00:00.000Z',
                dungeon: 'Chimerical Den',
                tier: 1,
                durationSeconds: 300,
                team: 'Irokez, Mazo',
                teamSize: 2,
                keyCounts: 'Irokez: 2; Mazo: 3',
            },
            {
                timestamp: '2026-08-03T09:30:00.000Z',
                dungeon: 'Pirate Cove',
                tier: null,
                durationSeconds: 240,
                team: 'Solo',
                teamSize: 1,
                keyCounts: '',
            },
        ]);
    });

    test('every column names a field the rows carry', () => {
        const [row] = buildRunHistoryRows([run('Irokez,Mazo')]);
        for (const column of DUNGEON_RUN_CSV_COLUMNS) {
            expect(row).toHaveProperty(column.key);
        }
    });

    test('the export bar carries a button wired to the runs it was built over', () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const bar = history.csvExportBar([run('Irokez,Mazo')]);

        expect(bar.dataset.csvExport).toBe('dungeon-runs');
        expect(bar.querySelector('button').textContent).toBe('Export CSV');
    });

    test('an empty history renders no export button at all', async () => {
        // getAllRuns is mocked to [], which is the empty-history case
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const container = document.createElement('div');
        container.innerHTML = '<div id="mwi-dt-run-list"></div>';
        document.body.appendChild(container);

        await history.update(container);

        expect(container.textContent).toContain('No runs yet');
        expect(container.querySelector('[data-csv-export]')).toBeNull();
    });
});

describe('dungeon group headers', () => {
    test('a dungeon name is never wrapped, one-word or not', () => {
        const history = new DungeonTrackerUIHistory(freshState('dungeon'), (ms) => `${ms}ms`);
        const runList = render(history, history.groupByDungeon([run('Irokez', 'Pirate Cove')]));

        expect(runList.textContent).toContain('Pirate Cove');
        expect(runList.querySelector('.mwi-dt-player-name')).toBeNull();
    });
});
