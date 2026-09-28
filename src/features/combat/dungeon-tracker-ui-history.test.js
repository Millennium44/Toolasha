/** @vitest-environment happy-dom
 *
 * The run history's group headers, where a team is a list of names.
 *
 * A team-grouped header reads "Aster,Briar,cove", and each of those is a
 * player somebody might want to look up mid-argument about whose fault the
 * slow run was. So each name is its own clickable span that fills
 * "/profile <name>" into chat — without ever changing what the header says,
 * and without a name click toggling the group it sits on.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    character: { id: 'market123', name: 'Marketcow' },
}));

vi.mock('./dungeon-tracker-storage.js', () => ({
    default: {
        getAllRuns: vi.fn(async () => []),
        getRunsForCharacterOrNull: vi.fn(async () => []),
        importRuns: vi.fn(async () => ({ added: 0, alreadyPresent: 0, ok: true })),
        deleteRun: async () => true,
        getTeamKey: (names) => [...names].sort().join(','),
    },
    filterRunsForCharacter: (runs) => runs,
    currentCharacter: () => world.character,
    runIdentity: (run) => `${run?.teamKey ?? ''}|${run?.timestamp ?? ''}|${run?.duration ?? ''}`,
    runTime: (run) => {
        const time = new Date(run?.timestamp).getTime();
        return Number.isFinite(time) ? time : null;
    },
}));
vi.mock('./dungeon-tracker-chat-annotations.js', () => ({
    default: { refreshRunCounts: vi.fn(async () => {}) },
}));
vi.mock('../../utils/formatters.js', () => ({ formatDateTime: () => '04/08 10:00' }));
vi.mock('../../utils/csv-export.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, downloadFile: vi.fn() };
});

const {
    default: DungeonTrackerUIHistory,
    buildRunHistoryRows,
    DUNGEON_RUN_CSV_COLUMNS,
} = await import('./dungeon-tracker-ui-history.js');
const { default: dungeonTrackerStorage } = await import('./dungeon-tracker-storage.js');
const { default: dungeonTrackerChatAnnotations } = await import('./dungeon-tracker-chat-annotations.js');
const { downloadFile } = await import('../../utils/csv-export.js');
const { DUNGEON_RUNS_BACKUP_FORMAT, DUNGEON_RUNS_BACKUP_VERSION, MAX_IMPORT_FILE_BYTES, MAX_FUTURE_TIMESTAMP_MS } =
    await import('./dungeon-tracker-run-import.js');

/** A fresh panel state, the shape dungeon-tracker-ui-state.js hands over. */
function freshState(groupBy = 'team') {
    return {
        groupBy,
        filterDungeon: 'all',
        filterTier: 'all',
        filterTeam: 'all',
        filterCharacter: 'all',
        isDungeonFilterManual: false,
        isTierFilterManual: false,
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
    world.character = { id: 'market123', name: 'Marketcow' };
    dungeonTrackerStorage.getRunsForCharacterOrNull.mockReset().mockResolvedValue([]);
    dungeonTrackerStorage.importRuns.mockReset().mockResolvedValue({ added: 0, alreadyPresent: 0, ok: true });
    dungeonTrackerChatAnnotations.refreshRunCounts.mockReset().mockResolvedValue(undefined);
    downloadFile.mockReset();
    window.alert = vi.fn();
    window.confirm = vi.fn().mockReturnValue(true);
});

afterEach(() => {
    document.body.innerHTML = '';
});

/** A well-formed stored run, matching what `dungeon-tracker-storage.js` writes. */
function storedRun(overrides = {}) {
    return {
        recordedBy: 'market123',
        recordedByName: 'Marketcow',
        timestamp: '2026-08-04T10:00:00.000Z',
        dungeonName: 'Chimerical Den',
        dungeonHrid: '/actions/combat/chimerical_den',
        tier: 1,
        team: ['Aster', 'Briar'],
        teamKey: 'Aster,Briar',
        duration: 300_000,
        validated: true,
        startRecovered: false,
        source: 'chat',
        waveTimes: null,
        avgWaveTime: null,
        keyCountsMap: { Aster: 2, Briar: 3 },
        ...overrides,
    };
}

/** A well-formed backup envelope. */
function backupEnvelope(runs, overrides = {}) {
    return {
        format: DUNGEON_RUNS_BACKUP_FORMAT,
        version: DUNGEON_RUNS_BACKUP_VERSION,
        characterId: 'market123',
        exportedAt: 1_700_000_000_000,
        runs,
        ...overrides,
    };
}

describe('team group headers', () => {
    test('each name in the header is its own clickable span, and the label reads unchanged', () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const runList = render(history, history.groupByTeam([run('Aster,Briar,cove')]));

        const names = [...runList.querySelectorAll('.mwi-dt-player-name')];
        expect(names.map((el) => el.textContent)).toEqual(['Aster', 'Briar', 'cove']);
        expect(names.every((el) => el.style.cursor === 'pointer')).toBe(true);

        const header = runList.querySelector('.mwi-dt-group-header');
        expect(header.textContent).toContain('Aster,Briar,cove');
    });

    test('clicking a name fills "/profile <name>" into chat', () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const runList = render(history, history.groupByTeam([run('Aster,Briar')]));
        const input = document.querySelector('input');

        const mazo = [...runList.querySelectorAll('.mwi-dt-player-name')].find((el) => el.textContent === 'Briar');
        mazo.dispatchEvent(new Event('click', { bubbles: true }));

        expect(input.value).toBe('/profile Briar');
    });

    test('a name click does not also toggle the group open', () => {
        const state = freshState('team');
        const history = new DungeonTrackerUIHistory(state, (ms) => `${ms}ms`);
        const runList = render(history, history.groupByTeam([run('Aster,Briar')]));

        const runsDiv = runList.querySelector('.mwi-dt-group-runs');
        expect(runsDiv.style.display).toBe('none');

        runList.querySelector('.mwi-dt-player-name').dispatchEvent(new Event('click', { bubbles: true }));

        expect(runsDiv.style.display).toBe('none');
        expect(state.expandedGroups.size).toBe(0);
    });

    test('with no chat input on screen the click simply does nothing', () => {
        document.body.innerHTML = '';
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const runList = render(history, history.groupByTeam([run('Aster,Briar')]));

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
                team: ['Aster', 'Briar'],
                teamKey: 'Aster,Briar',
                keyCountsMap: { Briar: 3, Aster: 2 },
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
                team: 'Aster, Briar',
                teamSize: 2,
                keyCounts: 'Aster: 2; Briar: 3',
                validated: true,
            },
            {
                timestamp: '2026-08-03T09:30:00.000Z',
                dungeon: 'Pirate Cove',
                tier: null,
                durationSeconds: 240,
                team: 'Solo',
                teamSize: 1,
                keyCounts: '',
                // Only an explicit `validated: false` is unvalidated; a legacy run
                // carrying no such field is left as the trusted kind it always was
                validated: true,
            },
        ]);
    });

    test('every column names a field the rows carry', () => {
        const [row] = buildRunHistoryRows([run('Aster,Briar')]);
        for (const column of DUNGEON_RUN_CSV_COLUMNS) {
            expect(row).toHaveProperty(column.key);
        }
    });

    test('the export bar carries a button wired to the runs it was built over', () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const bar = history.csvExportBar([run('Aster,Briar')]);

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
        // Import has to be reachable with nothing recorded yet — that is
        // exactly when restoring a backup is the point
        expect(container.querySelector('[data-json-backup]')).not.toBeNull();
    });
});

describe('the JSON backup export/import bar', () => {
    test('carries an Export button and an Import button', () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const bar = history.historyBackupBar();
        const labels = [...bar.querySelectorAll('button')].map((b) => b.textContent);

        expect(bar.dataset.jsonBackup).toBe('dungeon-runs');
        expect(labels).toEqual(['Export', 'Import']);
    });

    test('the Export button is honest about its scope — this character, not the whole account', () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const bar = history.historyBackupBar();
        const [exportButton] = bar.querySelectorAll('button');

        expect(exportButton.title).toMatch(/THIS CHARACTER/);
        expect(exportButton.title).not.toMatch(/ENTIRE/i);
        // It points at the one place a whole-account export actually lives
        expect(exportButton.title).toMatch(/Back Up Everything/);
    });
});

describe('exportRunHistoryBackup', () => {
    test('downloads every run this character recorded, unfiltered, in an envelope', async () => {
        const runs = [storedRun(), storedRun({ timestamp: '2026-08-03T09:00:00.000Z' })];
        dungeonTrackerStorage.getRunsForCharacterOrNull.mockResolvedValue(runs);
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.exportRunHistoryBackup();

        expect(dungeonTrackerStorage.getRunsForCharacterOrNull).toHaveBeenCalledWith('mine');
        expect(downloadFile).toHaveBeenCalledTimes(1);
        const [filename, text, mime] = downloadFile.mock.calls[0];
        expect(filename).toMatch(/^toolasha-dungeon-runs-backup-\d{8}-\d{4}\.json$/);
        expect(mime).toBe('application/json;charset=utf-8;');
        expect(JSON.parse(text)).toEqual({
            format: DUNGEON_RUNS_BACKUP_FORMAT,
            version: DUNGEON_RUNS_BACKUP_VERSION,
            characterId: 'market123',
            exportedAt: expect.any(Number),
            runs,
        });
    });

    test('refuses to export, downloading nothing, when the store could not be read', async () => {
        dungeonTrackerStorage.getRunsForCharacterOrNull.mockResolvedValue(null);
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.exportRunHistoryBackup();

        expect(downloadFile).not.toHaveBeenCalled();
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Export refused'));
    });
});

describe('importBackupFile — the size cap', () => {
    test('a file over the cap is refused before it is ever read', async () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const text = vi.fn(async () => '{}');
        const file = { size: MAX_IMPORT_FILE_BYTES + 1, text };

        await history.importBackupFile(file);

        expect(text).not.toHaveBeenCalled();
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('too large'));
        expect(dungeonTrackerStorage.importRuns).not.toHaveBeenCalled();
    });

    test('a file at or under the cap is read normally', async () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const text = vi.fn(async () => JSON.stringify(backupEnvelope([storedRun()])));
        const file = { size: MAX_IMPORT_FILE_BYTES, text };
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 1, alreadyPresent: 0, ok: true });

        await history.importBackupFile(file);

        expect(text).toHaveBeenCalledTimes(1);
        expect(dungeonTrackerStorage.importRuns).toHaveBeenCalled();
    });
});

describe('importBackupText', () => {
    test('an export → import round trip into empty storage adds every run', async () => {
        const runs = [storedRun()];
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 1, alreadyPresent: 0, ok: true });

        await history.importBackupText(JSON.stringify(backupEnvelope(runs)));

        expect(dungeonTrackerStorage.importRuns).toHaveBeenCalledWith(runs);
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Imported 1 run(s)'));
    });

    test('a re-import is a no-op — the summary says so and storage reports nothing new', async () => {
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 0, alreadyPresent: 1, ok: true });
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(JSON.stringify(backupEnvelope([storedRun()])));

        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Imported 0 run(s), 1 already present'));
    });

    test('a merge with overlapping runs reports the overlap, exactly as storage folded it', async () => {
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 2, alreadyPresent: 3, ok: true });
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(JSON.stringify(backupEnvelope([storedRun(), storedRun(), storedRun()])));

        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Imported 2 run(s), 3 already present'));
    });

    test('a bad format is refused with no write', async () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(JSON.stringify(backupEnvelope([storedRun()], { format: 'not-this' })));

        expect(dungeonTrackerStorage.importRuns).not.toHaveBeenCalled();
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Import refused'));
    });

    test('a version this copy of Toolasha does not read is refused with no write', async () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(
            JSON.stringify(backupEnvelope([storedRun()], { version: DUNGEON_RUNS_BACKUP_VERSION + 1 }))
        );

        expect(dungeonTrackerStorage.importRuns).not.toHaveBeenCalled();
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Import refused'));
    });

    test('invalid JSON is refused with no write', async () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText('{not json');

        expect(dungeonTrackerStorage.importRuns).not.toHaveBeenCalled();
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Import refused'));
    });

    test('an absurd 1608-minute run is rejected, not written, and the rest of the file still imports', async () => {
        const good = storedRun();
        const absurd = storedRun({ timestamp: '2026-08-05T10:00:00.000Z', duration: 1608 * 60 * 1000 });
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 1, alreadyPresent: 0, ok: true });
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(JSON.stringify(backupEnvelope([good, absurd])));

        expect(dungeonTrackerStorage.importRuns).toHaveBeenCalledWith([good]);
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('1 rejected'));
    });

    test('a non-positive duration and a missing dungeon are rejected the same way', async () => {
        const nonPositive = storedRun({ timestamp: '2026-08-05T10:00:00.000Z', duration: 0 });
        const noDungeon = storedRun({ timestamp: '2026-08-06T10:00:00.000Z', dungeonName: '' });
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 0, alreadyPresent: 0, ok: true });
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(JSON.stringify(backupEnvelope([nonPositive, noDungeon])));

        expect(dungeonTrackerStorage.importRuns).toHaveBeenCalledWith([]);
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('2 rejected'));
    });

    test('a different characterId is imported only after confirmation', async () => {
        window.confirm.mockReturnValue(false);
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(JSON.stringify(backupEnvelope([storedRun()], { characterId: 'someone-else' })));

        expect(window.confirm).toHaveBeenCalled();
        expect(dungeonTrackerStorage.importRuns).not.toHaveBeenCalled();
    });

    test('the character-mismatch dialog says ownership stays put — "All characters", not "CURRENT character"', async () => {
        window.confirm.mockReturnValue(false);
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(JSON.stringify(backupEnvelope([storedRun()], { characterId: 'someone-else' })));

        const [message] = window.confirm.mock.calls[0];
        expect(message).toMatch(/All characters/);
        expect(message).toMatch(/keep their original owner/);
        expect(message).not.toMatch(/CURRENT character's history/);
    });

    test('a different characterId proceeds once confirmed', async () => {
        window.confirm.mockReturnValue(true);
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 1, alreadyPresent: 0, ok: true });
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(JSON.stringify(backupEnvelope([storedRun()], { characterId: 'someone-else' })));

        expect(dungeonTrackerStorage.importRuns).toHaveBeenCalled();
    });

    test('a character switch during import writes nothing to the new character', async () => {
        // The switch lands while the confirmation dialog is "open" — the
        // moment `importBackupText` cannot see coming, and exactly the window
        // the character-swap guard exists for.
        window.confirm.mockImplementation(() => {
            world.character = { id: 'someone-new', name: 'NewCow' };
            return true;
        });
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(JSON.stringify(backupEnvelope([storedRun()])));

        expect(dungeonTrackerStorage.importRuns).not.toHaveBeenCalled();
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('active character changed'));
    });

    test('a failed write is reported as a failure, not a success with zero runs', async () => {
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 0, alreadyPresent: 0, ok: false });
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(JSON.stringify(backupEnvelope([storedRun()])));

        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Import failed'));
        expect(dungeonTrackerChatAnnotations.refreshRunCounts).not.toHaveBeenCalled();
    });

    test('a write that failed after merging still redraws — the merge already happened in memory', async () => {
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 1, alreadyPresent: 0, ok: false });
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const onImport = vi.fn();
        history.onImport(onImport);

        await history.importBackupText(JSON.stringify(backupEnvelope([storedRun()])));

        // Not the generic "nothing was written" message — the merge did
        // happen, only the write to storage did not land
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('did not land'));
        expect(window.alert).not.toHaveBeenCalledWith(expect.stringContaining('Nothing was written'));
        expect(dungeonTrackerChatAnnotations.refreshRunCounts).toHaveBeenCalledTimes(1);
        expect(onImport).toHaveBeenCalledTimes(1);
    });

    test('a successful import redraws the panel through the onImport callback', async () => {
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 1, alreadyPresent: 0, ok: true });
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        const onImport = vi.fn();
        history.onImport(onImport);

        await history.importBackupText(JSON.stringify(backupEnvelope([storedRun()])));

        expect(onImport).toHaveBeenCalledTimes(1);
    });

    test('a run timestamped more than a day in the future is rejected', async () => {
        const future = new Date(Date.now() + MAX_FUTURE_TIMESTAMP_MS + 60_000).toISOString();
        const good = storedRun();
        const tooFarAhead = storedRun({ timestamp: future });
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 1, alreadyPresent: 0, ok: true });
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(JSON.stringify(backupEnvelope([good, tooFarAhead])));

        expect(dungeonTrackerStorage.importRuns).toHaveBeenCalledWith([good]);
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('1 rejected'));
    });

    test('a legacy run with only totalTime is imported with duration normalized to match', async () => {
        const legacy = { ...storedRun(), totalTime: 240_000 };
        delete legacy.duration;
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 1, alreadyPresent: 0, ok: true });
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(JSON.stringify(backupEnvelope([legacy])));

        // Normalized before it ever reaches storage, so runIdentity (which only
        // reads `duration`) sees the same value validation just checked
        expect(dungeonTrackerStorage.importRuns).toHaveBeenCalledWith([{ ...legacy, duration: 240_000 }]);
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Imported 1 run(s)'));
    });

    test('a successful import refreshes chat annotation run counts, same as Backfill and Delete-all', async () => {
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 1, alreadyPresent: 0, ok: true });
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(JSON.stringify(backupEnvelope([storedRun()])));

        expect(dungeonTrackerChatAnnotations.refreshRunCounts).toHaveBeenCalledTimes(1);
    });

    test('a refused import never touches chat annotation run counts', async () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText('{not json');

        expect(dungeonTrackerChatAnnotations.refreshRunCounts).not.toHaveBeenCalled();
    });

    test('a failed write does not refresh chat annotation run counts either', async () => {
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 0, alreadyPresent: 0, ok: false });
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.importBackupText(JSON.stringify(backupEnvelope([storedRun()])));

        expect(dungeonTrackerChatAnnotations.refreshRunCounts).not.toHaveBeenCalled();
    });
});

describe('dispose', () => {
    test('removes the hidden file input from the document', () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        history.triggerImportBackup();
        expect(document.querySelector('input[type="file"]')).not.toBeNull();

        history.dispose();

        expect(document.querySelector('input[type="file"]')).toBeNull();
        expect(history.importInput).toBeNull();
    });

    test('disposing before Import was ever clicked is a no-op, not a throw', () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        expect(() => history.dispose()).not.toThrow();
    });

    test('a file picked through a stale input after teardown does not import', async () => {
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        history.triggerImportBackup();
        // Captured before dispose — a picker dialog left open across a
        // character switch resolves against exactly this detached element
        const input = document.querySelector('input[type="file"]');

        history.dispose();

        const file = { text: async () => JSON.stringify(backupEnvelope([storedRun()])) };
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(dungeonTrackerStorage.importRuns).not.toHaveBeenCalled();
    });

    test('a change on a live (non-disposed) input still imports, for contrast', async () => {
        dungeonTrackerStorage.importRuns.mockResolvedValue({ added: 1, alreadyPresent: 0, ok: true });
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);
        history.triggerImportBackup();
        const input = document.querySelector('input[type="file"]');

        const file = { text: async () => JSON.stringify(backupEnvelope([storedRun()])) };
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(dungeonTrackerStorage.importRuns).toHaveBeenCalledWith([storedRun()]);
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

/** A container with the run list plus the three filter dropdowns update() rebuilds. */
function buildFilterContainer() {
    const container = document.createElement('div');
    container.innerHTML = `
        <div id="mwi-dt-run-list"></div>
        <select id="mwi-dt-filter-dungeon"><option value="all">All Dungeons</option></select>
        <select id="mwi-dt-filter-tier"><option value="all">All Tiers</option></select>
        <select id="mwi-dt-filter-team"><option value="all">All Teams</option></select>
    `;
    document.body.appendChild(container);
    return container;
}

describe('filter dropdowns and an auto-scoped run with no history yet', () => {
    afterEach(() => {
        dungeonTrackerStorage.getAllRuns.mockReset().mockResolvedValue([]);
    });

    test('an auto-scoped dungeon/tier absent from history keeps its value and gets its own option', async () => {
        // Only Chimerical Den has ever been run — Pirate Cove T2 is what the
        // panel just auto-scoped to for a run in progress, its first ever
        dungeonTrackerStorage.getAllRuns.mockResolvedValue([run('Aster', 'Chimerical Den')]);
        const state = freshState('team');
        state.filterDungeon = 'Pirate Cove';
        state.filterTier = '2';
        // isDungeonFilterManual / isTierFilterManual stay false — this is what
        // autoScopeToRun leaves behind, not a dropdown pick
        const history = new DungeonTrackerUIHistory(state, (ms) => `${ms}ms`);
        const container = buildFilterContainer();

        await history.update(container);

        expect(state.filterDungeon).toBe('Pirate Cove');
        expect(state.filterTier).toBe('2');
        expect(container.querySelector('#mwi-dt-filter-dungeon').value).toBe('Pirate Cove');
        expect(container.querySelector('#mwi-dt-filter-tier').value).toBe('2');
        expect(
            [...container.querySelector('#mwi-dt-filter-dungeon').options].some((o) => o.value === 'Pirate Cove')
        ).toBe(true);
        expect([...container.querySelector('#mwi-dt-filter-tier').options].some((o) => o.value === '2')).toBe(true);
        // No runs match yet — the empty state, not a silent fall-back to 'all'
        expect(container.querySelector('#mwi-dt-run-list').textContent).toContain('No runs match filters');
    });

    test('a saved team filter survives the first render after a reload', async () => {
        dungeonTrackerStorage.getAllRuns.mockResolvedValue([run('Aster'), run('Aster,Briar')]);
        const state = freshState('team');
        state.filterTeam = 'Aster';
        const history = new DungeonTrackerUIHistory(state, (ms) => `${ms}ms`);
        // A freshly built panel: the select still reads "all"
        const container = buildFilterContainer();

        await history.update(container);

        expect(state.filterTeam).toBe('Aster');
        expect(container.querySelector('#mwi-dt-filter-team').value).toBe('Aster');
    });

    test('a manually-chosen dungeon/tier absent from history resets to all, as before', async () => {
        dungeonTrackerStorage.getAllRuns.mockResolvedValue([run('Aster', 'Chimerical Den')]);
        const state = freshState('team');
        state.filterDungeon = 'Pirate Cove';
        state.filterTier = '2';
        state.isDungeonFilterManual = true;
        state.isTierFilterManual = true;
        const history = new DungeonTrackerUIHistory(state, (ms) => `${ms}ms`);
        const container = buildFilterContainer();

        await history.update(container);

        expect(state.filterDungeon).toBe('all');
        expect(state.filterTier).toBe('all');
        expect(container.querySelector('#mwi-dt-filter-dungeon').value).toBe('all');
        expect(container.querySelector('#mwi-dt-filter-tier').value).toBe('all');
    });

    test('resetting a stale manual dungeon/tier to all also clears the manual flag, so auto-scope resumes', async () => {
        dungeonTrackerStorage.getAllRuns.mockResolvedValue([run('Aster', 'Chimerical Den')]);
        const state = freshState('team');
        state.filterDungeon = 'Pirate Cove';
        state.filterTier = '2';
        state.isDungeonFilterManual = true;
        state.isTierFilterManual = true;
        const history = new DungeonTrackerUIHistory(state, (ms) => `${ms}ms`);
        const container = buildFilterContainer();

        await history.update(container);

        expect(state.isDungeonFilterManual).toBe(false);
        expect(state.isTierFilterManual).toBe(false);
        // The caller is told, once, so it can redraw and save what read the old filter
        expect(history.consumeFilterReset()).toBe(true);
        expect(history.consumeFilterReset()).toBe(false);
    });

    test('an update that resets nothing reports no reset', async () => {
        dungeonTrackerStorage.getAllRuns.mockResolvedValue([run('Aster', 'Chimerical Den')]);
        const history = new DungeonTrackerUIHistory(freshState('team'), (ms) => `${ms}ms`);

        await history.update(buildFilterContainer());

        expect(history.consumeFilterReset()).toBe(false);
    });
});
