import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    saved: {},
    actionDetails: {},
    characterId: 'market123',
    characterName: 'MarketCow',
    // Flipped to stand in for a dropped IndexedDB connection
    unreadable: false,
    // Every write, as [key, immediate]
    writes: [],
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        tryGet: async (key, storeName) => {
            if (game.unreadable) return null;
            const value = game.saved[storeName]?.[key];
            return value == null ? { found: false, value: null } : { found: true, value };
        },
        getJSON: async (key, storeName, defaultValue) => game.saved[storeName]?.[key] ?? defaultValue,
        setJSON: async (key, value, storeName, immediate = false) => {
            game.writes.push([key, immediate]);
            game.saved[storeName] = game.saved[storeName] || {};
            // What IndexedDB would hold: a copy, not the live array
            game.saved[storeName][key] = structuredClone(value);
            return true;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: (hrid) => game.actionDetails[hrid],
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterName: () => game.characterName,
    },
}));

const {
    default: dungeonTrackerStorage,
    runMatchesCharacter,
    filterRunsForCharacter,
} = await import('./dungeon-tracker-storage.js');

function seedRuns(runs) {
    game.saved.unifiedRuns = { allRuns: runs };
    dungeonTrackerStorage._resetCache();
}

beforeEach(() => {
    game.unreadable = false;
    game.writes = [];
    dungeonTrackerStorage._resetCache();
});

describe('getDungeonKey', () => {
    test('combines dungeon hrid and tier', () => {
        expect(dungeonTrackerStorage.getDungeonKey('/actions/combat/chimerical_den', 1)).toBe(
            '/actions/combat/chimerical_den::T1'
        );
    });
});

describe('getDungeonInfo', () => {
    beforeEach(() => {
        game.actionDetails = {};
    });

    test('returns null for an unknown dungeon', () => {
        expect(dungeonTrackerStorage.getDungeonInfo('/actions/combat/nope')).toBeNull();
    });

    test('reads name and maxWaves from game data when present', () => {
        game.actionDetails['/actions/combat/chimerical_den'] = {
            name: 'Chimerical Den',
            combatZoneInfo: { dungeonInfo: { maxWaves: 50 } },
        };

        expect(dungeonTrackerStorage.getDungeonInfo('/actions/combat/chimerical_den')).toEqual({
            name: 'Chimerical Den',
            maxWaves: 50,
        });
    });

    test('falls back to the hardcoded max-wave table when game data has none', () => {
        game.actionDetails['/actions/combat/pirate_cove'] = { name: 'Pirate Cove', combatZoneInfo: {} };

        expect(dungeonTrackerStorage.getDungeonInfo('/actions/combat/pirate_cove').maxWaves).toBe(65);
    });

    test('derives a title-cased name from the hrid when the game gives none', () => {
        game.actionDetails['/actions/combat/enchanted_fortress'] = { combatZoneInfo: {} };

        expect(dungeonTrackerStorage.getDungeonInfo('/actions/combat/enchanted_fortress').name).toBe(
            'Enchanted Fortress'
        );
    });
});

describe('getTeamKey', () => {
    test('sorts names into a stable, order-independent key', () => {
        expect(dungeonTrackerStorage.getTeamKey(['Zed', 'Anna', 'Mike'])).toBe('Anna,Mike,Zed');
        expect(dungeonTrackerStorage.getTeamKey(['Mike', 'Zed', 'Anna'])).toBe('Anna,Mike,Zed');
    });
});

describe('getStatsByName', () => {
    beforeEach(() => {
        game.saved = {};
    });

    test('an unknown dungeon reports all zeros rather than throwing', async () => {
        seedRuns([]);
        expect(await dungeonTrackerStorage.getStatsByName('Nowhere')).toEqual({
            totalRuns: 0,
            avgTime: 0,
            fastestTime: 0,
            slowestTime: 0,
            avgWaveTime: 0,
        });
    });

    test('averages, fastest and slowest come from that dungeon only', async () => {
        seedRuns([
            { dungeonName: 'Chimerical Den', duration: 100, avgWaveTime: 2 },
            { dungeonName: 'Chimerical Den', duration: 300, avgWaveTime: 6 },
            { dungeonName: 'Sinister Circus', duration: 9999, avgWaveTime: 99 },
        ]);

        const stats = await dungeonTrackerStorage.getStatsByName('Chimerical Den');

        expect(stats.totalRuns).toBe(2);
        expect(stats.avgTime).toBe(200);
        expect(stats.fastestTime).toBe(100);
        expect(stats.slowestTime).toBe(300);
        expect(stats.avgWaveTime).toBe(4);
    });

    test('websocket-based totalTime and chat-based duration are both understood', async () => {
        seedRuns([
            { dungeonName: 'Chimerical Den', totalTime: 120 },
            { dungeonName: 'Chimerical Den', duration: 180 },
        ]);

        const stats = await dungeonTrackerStorage.getStatsByName('Chimerical Den');

        expect(stats.avgTime).toBe(150);
    });
});

describe('saveTeamRun', () => {
    beforeEach(() => {
        game.saved = {};
    });

    test('saves a new run to the front of the list', async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 }]);

        const saved = await dungeonTrackerStorage.saveTeamRun('C,D', {
            timestamp: '2026-01-02T00:00:00Z',
            duration: 700,
            dungeonName: 'Chimerical Den',
        });

        expect(saved).toBe(true);
        const allRuns = game.saved.unifiedRuns.allRuns;
        expect(allRuns).toHaveLength(2);
        expect(allRuns[0].teamKey).toBe('C,D');
        expect(allRuns[0].team).toEqual(['C', 'D']);
        expect(allRuns[0].validated).toBe(true);
        expect(allRuns[0].source).toBe('chat');
    });

    test('a run within 10s, same team, and duration within 2s of an existing one is a duplicate', async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00.000Z', teamKey: 'A,B', duration: 500 }]);

        const saved = await dungeonTrackerStorage.saveTeamRun('A,B', {
            timestamp: '2026-01-01T00:00:05.000Z',
            duration: 501,
            dungeonName: 'Chimerical Den',
        });

        expect(saved).toBe(false);
        expect(game.saved.unifiedRuns.allRuns).toHaveLength(1);
    });

    test('a different team at the same moment is not a duplicate', async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00.000Z', teamKey: 'A,B', duration: 500 }]);

        const saved = await dungeonTrackerStorage.saveTeamRun('C,D', {
            timestamp: '2026-01-01T00:00:01.000Z',
            duration: 500,
            dungeonName: 'Chimerical Den',
        });

        expect(saved).toBe(true);
    });

    test('a similar run outside the 10s window is not a duplicate', async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00.000Z', teamKey: 'A,B', duration: 500 }]);

        const saved = await dungeonTrackerStorage.saveTeamRun('A,B', {
            timestamp: '2026-01-01T00:00:15.000Z',
            duration: 500,
            dungeonName: 'Chimerical Den',
        });

        expect(saved).toBe(true);
    });

    test('missing dungeonName defaults to Unknown', async () => {
        seedRuns([]);
        await dungeonTrackerStorage.saveTeamRun('A,B', { timestamp: '2026-01-01T00:00:00Z', duration: 500 });

        expect(game.saved.unifiedRuns.allRuns[0].dungeonName).toBe('Unknown');
    });

    test('the stored list is read once; later saves and reads work from memory', async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 }]);
        await dungeonTrackerStorage.getAllRuns();

        // Storage changing behind memory's back is not seen — memory is the truth
        game.saved.unifiedRuns.allRuns = [];
        await dungeonTrackerStorage.saveTeamRun('C,D', { timestamp: '2026-01-02T00:00:00Z', duration: 700 });

        expect((await dungeonTrackerStorage.getAllRuns()).map((r) => r.teamKey)).toEqual(['C,D', 'A,B']);
        expect(game.saved.unifiedRuns.allRuns.map((r) => r.teamKey)).toEqual(['C,D', 'A,B']);
    });

    test('every append takes the write debounce; memory is what readers see meanwhile', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-05T00:00:00Z'));
            seedRuns([]);
            await dungeonTrackerStorage.saveTeamRun('A,B', { timestamp: '2026-01-01T00:00:00Z', duration: 500 });
            await dungeonTrackerStorage.saveTeamRun('A,B', { timestamp: '2026-01-01T01:00:00Z', duration: 500 });
            await dungeonTrackerStorage.saveTeamRun('A,B', { timestamp: '2026-01-01T02:00:00Z', duration: 500 });
            expect(game.writes.map(([, immediate]) => immediate)).toEqual([false, false, false]);

            vi.setSystemTime(new Date('2026-01-05T00:01:00Z'));
            await dungeonTrackerStorage.saveTeamRun('A,B', { timestamp: '2026-01-01T03:00:00Z', duration: 500 });
            expect(game.writes.at(-1)[1]).toBe(false);
            expect(await dungeonTrackerStorage.getAllRuns()).toHaveLength(4);
            expect(game.saved.unifiedRuns.allRuns).toHaveLength(4);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a run is not written over a history that could not be read first', async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 }]);
        game.unreadable = true;

        const saved = await dungeonTrackerStorage.saveTeamRun('C,D', {
            timestamp: '2026-01-02T00:00:00Z',
            duration: 700,
        });

        expect(saved).toBe(false);
        expect(game.writes).toEqual([]);
        expect(await dungeonTrackerStorage.getAllRuns()).toEqual([]);

        // Once storage reads again the history is there and the save lands
        game.unreadable = false;
        expect(
            await dungeonTrackerStorage.saveTeamRun('C,D', { timestamp: '2026-01-02T00:00:00Z', duration: 700 })
        ).toBe(true);
        expect(game.saved.unifiedRuns.allRuns).toHaveLength(2);
    });

    test('getAllRuns hands out a copy, so a caller sorting it cannot reorder the store', async () => {
        seedRuns([
            { timestamp: '2026-01-02T00:00:00Z', teamKey: 'A,B', duration: 500 },
            { timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 },
        ]);
        const runs = await dungeonTrackerStorage.getAllRuns();
        runs.reverse();
        expect((await dungeonTrackerStorage.getAllRuns())[0].timestamp).toBe('2026-01-02T00:00:00Z');
    });
});

describe('deleting runs', () => {
    test('deleteRun drops the run at a timestamp and writes at once', async () => {
        seedRuns([
            { timestamp: '2026-01-02T00:00:00Z', teamKey: 'A,B', duration: 500 },
            { timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 },
        ]);

        await dungeonTrackerStorage.deleteRun('2026-01-01T00:00:00Z');

        expect(game.writes).toEqual([['allRuns', true]]);
        expect(game.saved.unifiedRuns.allRuns.map((r) => r.timestamp)).toEqual(['2026-01-02T00:00:00Z']);
        // The duplicate check no longer sees the deleted run either
        expect(
            await dungeonTrackerStorage.saveTeamRun('A,B', { timestamp: '2026-01-01T00:00:00Z', duration: 500 })
        ).toBe(true);
    });

    test('clearAllRuns empties the list and writes at once', async () => {
        seedRuns([{ timestamp: '2026-01-02T00:00:00Z', teamKey: 'A,B', duration: 500 }]);

        await dungeonTrackerStorage.clearAllRuns();

        expect(game.writes).toEqual([['allRuns', true]]);
        expect(game.saved.unifiedRuns.allRuns).toEqual([]);
        expect(await dungeonTrackerStorage.getAllRuns()).toEqual([]);
    });
});

describe('getFilteredRuns', () => {
    beforeEach(() => {
        game.saved = {};
        seedRuns([
            { dungeonName: 'Chimerical Den', teamKey: 'A,B' },
            { dungeonName: 'Chimerical Den', teamKey: 'C,D' },
            { dungeonName: 'Sinister Circus', teamKey: 'A,B' },
        ]);
    });

    test('with no filters, returns everything', async () => {
        expect(await dungeonTrackerStorage.getFilteredRuns()).toHaveLength(3);
    });

    test('filters by dungeon name', async () => {
        const runs = await dungeonTrackerStorage.getFilteredRuns({ dungeonName: 'Chimerical Den' });
        expect(runs).toHaveLength(2);
    });

    test('"all" as a dungeon name is treated as no filter', async () => {
        const runs = await dungeonTrackerStorage.getFilteredRuns({ dungeonName: 'all' });
        expect(runs).toHaveLength(3);
    });

    test('filters by both dungeon and team together', async () => {
        const runs = await dungeonTrackerStorage.getFilteredRuns({
            dungeonName: 'Chimerical Den',
            teamKey: 'C,D',
        });
        expect(runs).toHaveLength(1);
        expect(runs[0].teamKey).toBe('C,D');
    });
});

describe('getAllTeamStats', () => {
    beforeEach(() => {
        game.saved = {};
    });

    test('solo runs with no teamKey are excluded', async () => {
        seedRuns([
            { teamKey: null, duration: 100 },
            { teamKey: 'A,B', duration: 200 },
        ]);

        const stats = await dungeonTrackerStorage.getAllTeamStats();

        expect(stats).toHaveLength(1);
        expect(stats[0].teamKey).toBe('A,B');
    });

    test('computes average, best (min) and worst (max) time per team', async () => {
        seedRuns([
            { teamKey: 'A,B', duration: 300 },
            { teamKey: 'A,B', duration: 100 },
            { teamKey: 'A,B', duration: 200 },
        ]);

        const [stats] = await dungeonTrackerStorage.getAllTeamStats();

        expect(stats.runCount).toBe(3);
        expect(stats.avgTime).toBe(200);
        expect(stats.bestTime).toBe(100);
        expect(stats.worstTime).toBe(300);
    });
});

describe('scrubOutlierRuns', () => {
    beforeEach(() => {
        game.saved = {};
    });

    test('an empty store removes nothing', async () => {
        seedRuns([]);
        expect(await dungeonTrackerStorage.scrubOutlierRuns()).toBe(0);
    });

    test('groups smaller than 5 are left alone regardless of spread', async () => {
        seedRuns([
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 100 },
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 100 },
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 100 },
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 100000 },
        ]);

        expect(await dungeonTrackerStorage.scrubOutlierRuns()).toBe(0);
    });

    test('a run over 3x the group median is scrubbed; the rest survive', async () => {
        seedRuns([
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 100 },
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 110 },
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 90 },
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 105 },
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 95 },
            // median of the above five is 100, threshold is 300
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 5000 },
        ]);

        const removed = await dungeonTrackerStorage.scrubOutlierRuns();

        expect(removed).toBe(1);
        const remaining = game.saved.unifiedRuns.allRuns;
        expect(remaining).toHaveLength(5);
        expect(remaining.every((r) => r.duration < 1000)).toBe(true);
    });

    test('different dungeon+team groups are scrubbed independently', async () => {
        const groupA = Array.from({ length: 5 }, () => ({
            dungeonName: 'Chimerical Den',
            teamKey: 'A,B',
            duration: 100,
        }));
        const groupB = Array.from({ length: 5 }, () => ({
            dungeonName: 'Sinister Circus',
            teamKey: 'C,D',
            duration: 200,
        }));
        seedRuns([...groupA, ...groupB, { dungeonName: 'Sinister Circus', teamKey: 'C,D', duration: 5000 }]);

        const removed = await dungeonTrackerStorage.scrubOutlierRuns();

        expect(removed).toBe(1);
        expect(game.saved.unifiedRuns.allRuns).toHaveLength(10);
    });
});

describe('who recorded a run', () => {
    beforeEach(() => {
        game.saved = {};
        game.characterId = 'market123';
        game.characterName = 'MarketCow';
    });

    test('a new run is stamped with the character that recorded it', async () => {
        await dungeonTrackerStorage.saveTeamRun('MarketCow,Friend', {
            timestamp: '2026-01-02T00:00:00Z',
            duration: 700,
            dungeonName: 'Chimerical Den',
        });

        expect(game.saved.unifiedRuns.allRuns[0]).toMatchObject({
            recordedBy: 'market123',
            recordedByName: 'MarketCow',
        });
    });

    test('the stamp is read at save time, so a switch without a reload is followed', async () => {
        await dungeonTrackerStorage.saveTeamRun('MarketCow', {
            timestamp: '2026-01-02T00:00:00Z',
            duration: 700,
            dungeonName: 'Chimerical Den',
        });

        game.characterId = 'iron456';
        game.characterName = 'IronCow';
        await dungeonTrackerStorage.saveTeamRun('IronCow', {
            timestamp: '2026-01-03T00:00:00Z',
            duration: 800,
            dungeonName: 'Chimerical Den',
        });

        expect(game.saved.unifiedRuns.allRuns.map((run) => run.recordedBy)).toEqual(['iron456', 'market123']);
    });
});

describe('runMatchesCharacter', () => {
    test('the stamp decides when it is there', () => {
        const run = { recordedBy: 'market123', team: ['SomebodyElse'], teamKey: 'SomebodyElse' };
        expect(runMatchesCharacter(run, 'market123', 'MarketCow')).toBe(true);
        expect(runMatchesCharacter(run, 'iron456', 'IronCow')).toBe(false);
    });

    test('a stamped run belonging to nobody present does not match on name', () => {
        // The whole point of the stamp is that it beats the roster: two of your
        // characters in the same party recorded one run, and only one of them
        // recorded it
        const run = { recordedBy: 'market123', team: ['MarketCow', 'IronCow'] };
        expect(runMatchesCharacter(run, 'iron456', 'IronCow')).toBe(false);
    });

    test('a legacy run falls back to the roster', () => {
        expect(runMatchesCharacter({ team: ['MarketCow', 'Friend'] }, 'market123', 'MarketCow')).toBe(true);
        expect(runMatchesCharacter({ teamKey: 'MarketCow,Friend' }, 'market123', 'MarketCow')).toBe(true);
        expect(runMatchesCharacter({ team: ['Friend'] }, 'market123', 'MarketCow')).toBe(false);
    });

    test('a substring of a team-mate name is not a match', () => {
        expect(runMatchesCharacter({ teamKey: 'MarketCowboy,Friend' }, 'market123', 'MarketCow')).toBe(false);
    });

    test('with no character to compare against, nothing matches', () => {
        expect(runMatchesCharacter({ recordedBy: 'market123' }, null, null)).toBe(false);
        expect(runMatchesCharacter({ team: ['MarketCow'] }, 'market123', null)).toBe(false);
        expect(runMatchesCharacter(null, 'market123', 'MarketCow')).toBe(false);
    });
});

describe('filterRunsForCharacter', () => {
    beforeEach(() => {
        game.saved = {};
        game.characterId = 'market123';
        game.characterName = 'MarketCow';
    });

    const runs = [
        { id: 'mine', recordedBy: 'market123' },
        { id: 'theirs', recordedBy: 'iron456' },
        { id: 'legacy-mine', team: ['MarketCow', 'Friend'] },
        { id: 'legacy-theirs', team: ['Friend'] },
    ];

    test("'mine' keeps this character's runs and the legacy runs they were in", () => {
        const kept = filterRunsForCharacter(runs, 'mine', { id: 'market123', name: 'MarketCow' });
        expect(kept.map((run) => run.id)).toEqual(['mine', 'legacy-mine']);
    });

    test("'all' keeps everything", () => {
        expect(filterRunsForCharacter(runs, 'all', { id: 'market123', name: 'MarketCow' })).toHaveLength(4);
    });

    test('an empty or missing list is not an error', () => {
        expect(filterRunsForCharacter(null, 'mine', { id: 'market123', name: 'MarketCow' })).toEqual([]);
    });

    test('the storage accessor applies the same rule', async () => {
        seedRuns(runs);
        const kept = await dungeonTrackerStorage.getRunsForCharacter('mine');
        expect(kept.map((run) => run.id)).toEqual(['mine', 'legacy-mine']);
        expect(await dungeonTrackerStorage.getRunsForCharacter('all')).toHaveLength(4);
    });
});
