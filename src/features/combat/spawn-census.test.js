/**
 * @vitest-environment happy-dom
 *
 * The census is a counting instrument, so the tests are about what collapses
 * onto one row and what does not: the whole storage argument rests on identical
 * rosters costing a counter increment rather than a record, and on
 * order-of-arrival not counting as a difference. Collapse is proved by reading
 * the row count and the counter back, not by asserting a shape.
 *
 * Mocked the way combat-boss-eta.test.js is: the websocket handler is captured
 * on initialize and fed payloads by hand.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    setting: true,
    actions: [],
    actionDetails: {},
    wsHandlers: {},
    stored: null,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => game.setting },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.wsHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.wsHandlers[event] === handler) delete game.wsHandlers[event];
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async () => game.stored,
        setJSON: async (key, value) => {
            game.stored = value;
            return true;
        },
        delete: async () => true,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.actions,
        getActionDetails: (hrid) => game.actionDetails[hrid],
    },
}));

import spawnCensus, {
    monstersOf,
    rosterKey,
    durationStats,
    shortHrid,
    MAX_ROSTER_ROWS,
    NO_WAVE,
} from './spawn-census.js';

const DUNGEON = '/actions/combat/chimerical_den';
const ZONE = '/actions/combat/jungle';

/** A monster unit as `new_battle` carries it, keyed-map style. */
const monster = (name, maxHitpoints = 1000) => ({
    hrid: `/monsters/${name}`,
    combatDetails: { maxHitpoints },
});

/** Feed one wave through the live handler. */
const battle = (names, { wave = 1, at = null } = {}) => {
    if (at !== null) vi.setSystemTime(at);
    const mMap = {};
    names.forEach((name, index) => {
        mMap[String(index)] = monster(name);
    });
    game.wsHandlers.new_battle({ wave, mMap });
};

/** Set the running combat action the census reads its zone and tier off. */
const inZone = (actionHrid, difficultyTier = 0) => {
    game.actions = [{ actionHrid, difficultyTier, isDone: false, ordinal: 1 }];
};

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    game.setting = true;
    game.stored = null;
    game.actions = [];
    game.wsHandlers = {};
    game.actionDetails = {
        [DUNGEON]: { combatZoneInfo: { isDungeon: true, dungeonInfo: { maxWaves: 50 } } },
        [ZONE]: { combatZoneInfo: { isDungeon: false, fightInfo: { randomSpawnInfo: { maxSpawnCount: 3 } } } },
    };
    spawnCensus.initialized = false;
    spawnCensus._reset();
    await spawnCensus.initialize();
    inZone(DUNGEON);
});

describe('collapsing identical rosters', () => {
    test('the same monsters at the same wave are one row with a rising count', () => {
        battle(['rat', 'frog'], { wave: 3 });
        expect(spawnCensus.rosters.size).toBe(1);

        battle(['rat', 'frog'], { wave: 3 });
        battle(['rat', 'frog'], { wave: 3 });

        // The point of the whole design: three waves, still one record.
        expect(spawnCensus.rosters.size).toBe(1);
        const [row] = [...spawnCensus.rosters.values()];
        expect(row.n).toBe(3);
        expect(spawnCensus.waves).toBe(3);
    });

    test('draw order is not a difference', () => {
        battle(['snake', 'crab', 'rat'], { wave: 7 });
        battle(['rat', 'snake', 'crab'], { wave: 7 });
        battle(['crab', 'rat', 'snake'], { wave: 7 });

        expect(spawnCensus.rosters.size).toBe(1);
        expect([...spawnCensus.rosters.values()][0].n).toBe(3);
        // And the stored roster is the sorted one, so the export reads the same
        // list however the payload happened to be ordered.
        expect([...spawnCensus.rosters.keys()][0]).toBe('chimerical_den|0|7|crab,rat,snake');
    });

    test('duplicates of one species are counted, not deduplicated', () => {
        battle(['rat', 'rat'], { wave: 2 });
        battle(['rat'], { wave: 2 });

        expect(spawnCensus.rosters.size).toBe(2);
        expect(spawnCensus.rosters.get('chimerical_den|0|2|rat,rat').n).toBe(1);
        expect(spawnCensus.rosters.get('chimerical_den|0|2|rat').n).toBe(1);
    });

    test('a different wave number is a different row', () => {
        battle(['rat', 'frog'], { wave: 3 });
        battle(['rat', 'frog'], { wave: 4 });

        expect(spawnCensus.rosters.size).toBe(2);
        expect([...spawnCensus.rosters.values()].every((row) => row.n === 1)).toBe(true);
    });

    test('a different difficulty tier is a different row', () => {
        battle(['rat', 'frog'], { wave: 3 });
        inZone(DUNGEON, 2);
        battle(['rat', 'frog'], { wave: 3 });

        expect(spawnCensus.rosters.size).toBe(2);
        expect([...spawnCensus.rosters.keys()].sort()).toEqual([
            'chimerical_den|0|3|frog,rat',
            'chimerical_den|2|3|frog,rat',
        ]);
    });

    test('a non-dungeon zone is recorded under the no-wave marker', () => {
        inZone(ZONE);
        battle(['fly'], { wave: 9 });
        battle(['fly'], { wave: 12 });

        // The zone has no waves, so the server's wave field means nothing here
        // and both sightings are the same roster.
        expect(spawnCensus.rosters.size).toBe(1);
        expect([...spawnCensus.rosters.keys()][0]).toBe(`jungle|0|${NO_WAVE}|fly`);
        expect([...spawnCensus.rosters.values()][0].n).toBe(2);
    });
});

describe('reading the payload', () => {
    test('players are excluded from the roster', () => {
        game.wsHandlers.new_battle({
            wave: 5,
            mMap: {
                0: { hrid: '/monsters/rat', combatDetails: { maxHitpoints: 900 } },
                1: { hrid: '/players/someone', isPlayer: true, combatDetails: { maxHitpoints: 5000 } },
            },
        });

        expect([...spawnCensus.rosters.keys()][0]).toBe('chimerical_den|0|5|rat');
        expect([...spawnCensus.monsterHp.keys()]).toEqual(['chimerical_den|0|rat']);
    });

    test('an array payload and a keyed-map payload produce the same row', () => {
        game.wsHandlers.new_battle({ wave: 6, monsters: [monster('rat'), monster('frog')] });
        game.wsHandlers.new_battle({ wave: 6, mMap: { 0: monster('frog'), 1: monster('rat') } });

        expect(spawnCensus.rosters.size).toBe(1);
        expect([...spawnCensus.rosters.values()][0].n).toBe(2);
    });

    test('monstersOf reads hitpoints from either place, and skips units with no hrid', () => {
        expect(monstersOf({ monsters: [{ hrid: '/monsters/rat', maxHitpoints: 500 }] })).toEqual([
            { hrid: '/monsters/rat', maxHitpoints: 500 },
        ]);
        expect(monstersOf({ mMap: { 0: { combatDetails: { maxHitpoints: 500 } } } })).toEqual([]);
        expect(monstersOf({})).toEqual([]);
    });

    test('observed max hitpoints are kept per species per tier', () => {
        game.wsHandlers.new_battle({ wave: 1, mMap: { 0: monster('rat', 800) } });
        inZone(DUNGEON, 3);
        game.wsHandlers.new_battle({ wave: 1, mMap: { 0: monster('rat', 2400) } });

        expect(spawnCensus.monsterHp.get('chimerical_den|0|rat')).toBe(800);
        expect(spawnCensus.monsterHp.get('chimerical_den|3|rat')).toBe(2400);
    });
});

describe('wave durations', () => {
    test('the aggregate gives the mean and standard error of the spans', () => {
        const base = 1_700_000_000_000;
        // Announcements 1s, 3s and 5s apart, all closing wave 1, 2 and 3 in turn.
        battle(['rat'], { wave: 1, at: base });
        battle(['rat'], { wave: 2, at: base + 1000 });
        battle(['rat'], { wave: 3, at: base + 4000 });
        battle(['rat'], { wave: 4, at: base + 9000 });

        expect(durationStats(spawnCensus.durations.get('chimerical_den|0|1'))).toMatchObject({ n: 1, meanMs: 1000 });
        expect(durationStats(spawnCensus.durations.get('chimerical_den|0|2'))).toMatchObject({ n: 1, meanMs: 3000 });
        expect(durationStats(spawnCensus.durations.get('chimerical_den|0|3'))).toMatchObject({ n: 1, meanMs: 5000 });
    });

    test('durationStats matches the textbook sample mean and standard error', () => {
        // Samples 2, 4, 4, 4, 5, 5, 7, 9: mean 5, sample sd sqrt(32/7).
        const samples = [2, 4, 4, 4, 5, 5, 7, 9];
        const aggregate = samples.reduce((acc, x) => ({ n: acc.n + 1, sum: acc.sum + x, sumSq: acc.sumSq + x * x }), {
            n: 0,
            sum: 0,
            sumSq: 0,
        });
        const stats = durationStats(aggregate);
        const sd = Math.sqrt(32 / 7);
        expect(stats.n).toBe(8);
        expect(stats.meanMs).toBeCloseTo(5, 12);
        expect(stats.sdMs).toBeCloseTo(sd, 12);
        expect(stats.stderrMs).toBeCloseTo(sd / Math.sqrt(8), 12);
    });

    test('one observation has a mean but no spread, and none has neither', () => {
        expect(durationStats({ n: 1, sum: 400, sumSq: 160_000 })).toEqual({
            n: 1,
            meanMs: 400,
            sdMs: null,
            stderrMs: null,
        });
        expect(durationStats(undefined)).toEqual({ n: 0, meanMs: null, sdMs: null, stderrMs: null });
    });

    test('identical spans give a standard error of zero, not a negative root', () => {
        const stats = durationStats({ n: 3, sum: 3000, sumSq: 3_000_000 });
        expect(stats.meanMs).toBe(1000);
        expect(stats.sdMs).toBe(0);
        expect(stats.stderrMs).toBe(0);
    });

    test('a zone change does not close the previous zone as one enormous wave', () => {
        const base = 1_700_000_000_000;
        battle(['rat'], { wave: 1, at: base });
        inZone(ZONE);
        battle(['fly'], { wave: 1, at: base + 2000 });

        expect(spawnCensus.durations.size).toBe(0);
    });

    test('an idle gap longer than the cap is discarded rather than counted', () => {
        const base = 1_700_000_000_000;
        battle(['rat'], { wave: 1, at: base });
        battle(['rat'], { wave: 2, at: base + 40 * 60_000 });

        expect(spawnCensus.durations.size).toBe(0);
    });
});

describe('bounded storage', () => {
    test('the row count never exceeds the cap, and eviction drops the oldest', () => {
        const base = 1_700_000_000_000;
        // One distinct roster per wave number, each seen a millisecond after the
        // last, so recency order is insertion order.
        for (let i = 0; i < MAX_ROSTER_ROWS + 500; i++) {
            battle(['rat'], { wave: i, at: base + i });
        }

        expect(spawnCensus.rosters.size).toBeLessThanOrEqual(MAX_ROSTER_ROWS);
        expect(spawnCensus.evicted).toBeGreaterThan(0);
        // The very first roster is gone; the very last is not.
        expect(spawnCensus.rosters.has('chimerical_den|0|0|rat')).toBe(false);
        expect(spawnCensus.rosters.has(`chimerical_den|0|${MAX_ROSTER_ROWS + 499}|rat`)).toBe(true);
        // And the export says what window is left rather than implying the
        // sample still starts where the census did.
        expect(spawnCensus.retainedFrom).toBeGreaterThan(spawnCensus.startedAt);
    });

    test('a roster still being seen survives eviction however old it is', () => {
        const base = 1_700_000_000_000;
        battle(['rat'], { wave: 999_999, at: base });
        for (let i = 0; i < MAX_ROSTER_ROWS; i++) {
            battle(['rat'], { wave: i, at: base + 1 + i });
            // Touch the veteran every hundred waves: last-seen is what eviction
            // reads, so a common roster is never the oldest.
            if (i % 100 === 0) battle(['rat'], { wave: 999_999, at: base + 1 + i });
        }

        expect(spawnCensus.evicted).toBeGreaterThan(0);
        expect(spawnCensus.rosters.has('chimerical_den|0|999999|rat')).toBe(true);
    });

    test('nothing is written per wave — the flush is what writes', async () => {
        battle(['rat'], { wave: 1 });
        expect(game.stored).toBeNull();

        await spawnCensus.flush();
        expect(game.stored.rosters['chimerical_den|0|1|rat']).toEqual([1, expect.any(Number), expect.any(Number)]);

        // A flush with nothing new does not write again.
        game.stored = null;
        await spawnCensus.flush();
        expect(game.stored).toBeNull();
    });
});

describe('persistence and export', () => {
    test('a stored record is folded back in, counts and all', async () => {
        battle(['rat'], { wave: 1 });
        battle(['rat'], { wave: 1 });
        await spawnCensus.flush();
        const written = game.stored;

        spawnCensus._reset();
        spawnCensus.hydrate(written);

        expect(spawnCensus.rosters.get('chimerical_den|0|1|rat').n).toBe(2);
        expect(spawnCensus.waves).toBe(2);
        expect(spawnCensus.hrids.get('rat')).toBe('/monsters/rat');
    });

    test('the export restores full hrids and states the duration convention', () => {
        const base = 1_700_000_000_000;
        battle(['rat', 'frog'], { wave: 1, at: base });
        battle(['rat', 'frog'], { wave: 2, at: base + 2000 });

        const file = spawnCensus.exportFile();
        expect(file.type).toBe('toolasha-spawn-census');
        expect(file.rosters[0].zoneHrid).toBe(DUNGEON);
        expect(file.rosters[0].monsterHrids).toEqual(['/monsters/frog', '/monsters/rat']);
        expect(file.rowCap).toBe(MAX_ROSTER_ROWS);
        // The span includes the respawn gap, and the file has to say so.
        expect(file.conventions.duration).toMatch(/respawn gap/i);
        expect(file.durations[0]).toMatchObject({ wave: 1, n: 1, meanMs: 2000 });
        // The tables in force at recording time travel with the counts.
        expect(file.spawnTables[DUNGEON]).toMatchObject({ isDungeon: true, maxWaves: 50 });
    });

    test('a non-dungeon row exports a null wave rather than the marker', () => {
        inZone(ZONE);
        battle(['fly']);
        expect(spawnCensus.exportFile().rosters[0].wave).toBeNull();
    });

    test('the summary counts waves and distinct rosters per zone and tier', () => {
        battle(['rat'], { wave: 1 });
        battle(['rat'], { wave: 1 });
        battle(['frog'], { wave: 2 });

        const summary = spawnCensus.summary();
        expect(summary.wavesSeen).toBe(3);
        expect(summary.distinctRosters).toBe(2);
        expect(summary.zones[0]).toMatchObject({ zone: DUNGEON, tier: 0, waves: 3, distinctRosters: 2 });
    });
});

describe('wiring', () => {
    test('the setting gates the subscription', async () => {
        spawnCensus.disable();
        spawnCensus._reset();
        game.wsHandlers = {};
        game.setting = false;

        await spawnCensus.initialize();
        expect(game.wsHandlers.new_battle).toBeUndefined();
    });

    test('disable unsubscribes, stops the flush timer and writes what is pending', async () => {
        battle(['rat'], { wave: 1 });
        await spawnCensus.disable();

        expect(game.wsHandlers.new_battle).toBeUndefined();
        expect(game.stored.rosters['chimerical_den|0|1|rat'][0]).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('a wave arriving with no running combat action is ignored', () => {
        game.actions = [];
        battle(['rat'], { wave: 1 });
        expect(spawnCensus.rosters.size).toBe(0);
    });

    test('the zone is the running action, not the first queued one', () => {
        // A requeued repeat sits first in the array with a higher ordinal.
        game.actions = [
            { actionHrid: ZONE, difficultyTier: 0, isDone: false, ordinal: 9 },
            { actionHrid: DUNGEON, difficultyTier: 0, isDone: false, ordinal: 2 },
        ];
        battle(['rat'], { wave: 4 });
        expect([...spawnCensus.rosters.keys()][0]).toBe('chimerical_den|0|4|rat');
    });

    test('shortHrid and rosterKey are pure and total', () => {
        expect(shortHrid('/monsters/rat')).toBe('rat');
        expect(shortHrid(undefined)).toBe('');
        expect(rosterKey('/actions/combat/x', 1, 2, [])).toBe('x|1|2|');
    });
});
