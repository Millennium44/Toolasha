/** @vitest-environment happy-dom
 *
 * The run history's group headers, where a team is a list of names.
 *
 * A team-grouped header reads "Aster,Player11,cove", and each of those is a
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

const DungeonTrackerUIHistory = (await import('./dungeon-tracker-ui-history.js')).default;

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
        const runList = render(history, history.groupByTeam([run('Aster,Player11,cove')]));

        const names = [...runList.querySelectorAll('.mwi-dt-player-name')];
        expect(names.map((el) => el.textContent)).toEqual(['Aster', 'Player11', 'cove']);
        expect(names.every((el) => el.style.cursor === 'pointer')).toBe(true);

        const header = runList.querySelector('.mwi-dt-group-header');
        expect(header.textContent).toContain('Aster,Player11,cove');
    });

    test('clicking a name fills "/profile <name>" into chat', () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const runList = render(history, history.groupByTeam([run('Aster,Player11')]));
        const input = document.querySelector('input');

        const mazo = [...runList.querySelectorAll('.mwi-dt-player-name')].find((el) => el.textContent === 'Player11');
        mazo.dispatchEvent(new Event('click', { bubbles: true }));

        expect(input.value).toBe('/profile Player11');
    });

    test('a name click does not also toggle the group open', () => {
        const state = freshState('team');
        const history = new DungeonTrackerUIHistory(state, (ms) => `${ms}ms`);
        const runList = render(history, history.groupByTeam([run('Aster,Player11')]));

        const runsDiv = runList.querySelector('.mwi-dt-group-runs');
        expect(runsDiv.style.display).toBe('none');

        runList.querySelector('.mwi-dt-player-name').dispatchEvent(new Event('click', { bubbles: true }));

        expect(runsDiv.style.display).toBe('none');
        expect(state.expandedGroups.size).toBe(0);
    });

    test('with no chat input on screen the click simply does nothing', () => {
        document.body.innerHTML = '';
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const runList = render(history, history.groupByTeam([run('Aster,Player11')]));

        expect(() => {
            runList.querySelector('.mwi-dt-player-name').dispatchEvent(new Event('click', { bubbles: true }));
        }).not.toThrow();
    });

    test('a malformed name in the key stays plain text while its teammates stay clickable', () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const runList = render(history, history.groupByTeam([run('Aster,<b>Not A Name</b>')]));

        const names = [...runList.querySelectorAll('.mwi-dt-player-name')];
        expect(names.map((el) => el.textContent)).toEqual(['Aster']);
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

describe('dungeon group headers', () => {
    test('a dungeon name is never wrapped, one-word or not', () => {
        const history = new DungeonTrackerUIHistory(freshState('dungeon'), (ms) => `${ms}ms`);
        const runList = render(history, history.groupByDungeon([run('Aster', 'Pirate Cove')]));

        expect(runList.textContent).toContain('Pirate Cove');
        expect(runList.querySelector('.mwi-dt-player-name')).toBeNull();
    });
});
