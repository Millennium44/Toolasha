import { describe, test, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    quests: [],
    characterId: 'char-1',
    switching: false,
    actions: [],
    runSimulation: vi.fn(),
    buildAllPlayerDTOs: vi.fn(),
    gameData: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterQuests() {
            return h.quests;
        },
        getCurrentActions: () => h.actions,
        getCurrentCharacterId: () => h.characterId,
        getIsCharacterSwitching: () => h.switching,
    },
}));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    buildAllPlayerDTOs: h.buildAllPlayerDTOs,
    buildGameDataPayload: () => h.gameData,
    getCommunityBuffs: () => ({}),
}));
vi.mock('../combat-sim/combat-sim-runner.js', () => ({ runSimulation: h.runSimulation }));

import { computeAllZoneProgress } from './task-zone-progress.js';

const ZONE_A = '/actions/combat/zone_a';
const ZONE_B = '/actions/combat/zone_b';

/** A non-dungeon combat zone spawning these monsters, shaped like the game's action detail. */
const zone = (name, spawns, bossSpawns = []) => ({
    name,
    type: '/action_types/combat',
    combatZoneInfo: {
        isDungeon: false,
        fightInfo: {
            randomSpawnInfo: { spawns: spawns.map((combatMonsterHrid) => ({ combatMonsterHrid })) },
            bossSpawns: bossSpawns.map((combatMonsterHrid) => ({ combatMonsterHrid })),
        },
    },
});

const quest = (monsterHrid, goalCount = 100, currentCount = 0, extra = {}) => ({
    category: '/quest_category/random_task',
    status: '/quest_status/in_progress',
    monsterHrid,
    goalCount,
    currentCount,
    ...extra,
});

beforeEach(() => {
    vi.clearAllMocks();
    h.characterId = 'char-1';
    h.switching = false;
    h.actions = [];
    h.quests = [];
    h.gameData = {
        actionDetailMap: {
            [ZONE_A]: zone('Zone A', ['/monsters/slime', '/monsters/ooze']),
            [ZONE_B]: zone('Zone B', ['/monsters/imp']),
        },
        combatMonsterDetailMap: {
            '/monsters/slime': { name: 'Slime' },
            '/monsters/ooze': { name: 'Ooze' },
            '/monsters/imp': { name: 'Imp' },
        },
    };
    h.buildAllPlayerDTOs.mockResolvedValue({ players: [{ hrid: 'player1' }] });
});

describe('computeAllZoneProgress', () => {
    test('runs no sim when there are no combat tasks', async () => {
        expect(await computeAllZoneProgress()).toEqual([]);
        expect(h.runSimulation).not.toHaveBeenCalled();
    });

    test('ignores non-combat, finished and zoneless quests', async () => {
        h.quests = [
            quest('/monsters/slime', 100, 0, { status: '/quest_status/completed' }),
            quest(undefined),
            quest('/monsters/unknown'),
        ];
        expect(await computeAllZoneProgress()).toEqual([]);
        expect(h.runSimulation).not.toHaveBeenCalled();
    });

    test('groups tasks by zone, picks each zone bottleneck by hrid and sorts soonest first', async () => {
        h.quests = [quest('/monsters/slime', 100), quest('/monsters/ooze', 500), quest('/monsters/imp', 50)];
        h.runSimulation.mockImplementation(async ({ zoneHrid }) =>
            zoneHrid === ZONE_A
                ? { deaths: { '/monsters/slime': 100, '/monsters/ooze': 100 }, encounters: 50 }
                : { deaths: { '/monsters/imp': 100 }, encounters: 100 }
        );

        const rows = await computeAllZoneProgress();

        expect(h.runSimulation).toHaveBeenCalledTimes(2);
        expect(rows.map((r) => r.zoneHrid)).toEqual([ZONE_B, ZONE_A]);
        expect(rows[0]).toMatchObject({ zoneName: 'Zone B', bottleneckHrid: '/monsters/imp', fightsNeeded: 50 });
        // ooze 500 / 100 per hour = 5h at 50 fights/hour
        expect(rows[1]).toMatchObject({
            zoneName: 'Zone A',
            bottleneckHrid: '/monsters/ooze',
            bottleneckName: 'Ooze',
            hoursNeeded: 5,
            fightsNeeded: 250,
        });
    });

    test('duplicate tasks for one monster sum', async () => {
        h.quests = [quest('/monsters/slime', 100), quest('/monsters/slime', 100)];
        h.runSimulation.mockResolvedValue({ deaths: { '/monsters/slime': 100 }, encounters: 20 });
        const [row] = await computeAllZoneProgress();
        expect(row.hoursNeeded).toBe(2);
        expect(row.taskCount).toBe(2);
    });

    test('simulates at the zone last-used tier with per-monster task damage, without preempting', async () => {
        h.quests = [quest('/monsters/imp')];
        h.actions = [{ actionHrid: ZONE_B, difficultyTier: 3, ordinal: 1 }];
        h.runSimulation.mockResolvedValue({ deaths: { '/monsters/imp': 10 }, encounters: 10 });

        const [row] = await computeAllZoneProgress();

        const [params, , options] = h.runSimulation.mock.calls[0];
        expect(params).toMatchObject({ zoneHrid: ZONE_B, difficultyTier: 3, taskDamageMode: 'perMonster', hours: 1 });
        expect(options).toEqual({ preempt: false });
        expect(row.tier).toBe(3);
    });

    test('a bottleneck monster never killed gives Infinity, sorted last', async () => {
        h.quests = [quest('/monsters/slime'), quest('/monsters/imp', 10)];
        h.runSimulation.mockImplementation(async ({ zoneHrid }) =>
            zoneHrid === ZONE_A ? { deaths: {}, encounters: 5 } : { deaths: { '/monsters/imp': 10 }, encounters: 10 }
        );
        const rows = await computeAllZoneProgress();
        expect(rows.map((r) => r.zoneHrid)).toEqual([ZONE_B, ZONE_A]);
        expect(rows[1].hoursNeeded).toBe(Infinity);
        expect(rows[1].fightsNeeded).toBe(Infinity);
    });

    test('a failed zone sim is skipped, the rest still show', async () => {
        h.quests = [quest('/monsters/slime'), quest('/monsters/imp', 10)];
        vi.spyOn(console, 'error').mockImplementation(() => {});
        h.runSimulation.mockImplementation(async ({ zoneHrid }) => {
            if (zoneHrid === ZONE_A) throw new Error('boom');
            return { deaths: { '/monsters/imp': 10 }, encounters: 10 };
        });
        const rows = await computeAllZoneProgress();
        expect(rows.map((r) => r.zoneHrid)).toEqual([ZONE_B]);
    });

    test('cancelling mid-compute stops before the next zone and returns null', async () => {
        h.quests = [quest('/monsters/slime'), quest('/monsters/imp')];
        let cancelled = false;
        h.runSimulation.mockImplementation(async () => {
            cancelled = true;
            return { deaths: { '/monsters/slime': 10, '/monsters/imp': 10 }, encounters: 10 };
        });
        const onProgress = vi.fn();

        const result = await computeAllZoneProgress({ isCancelled: () => cancelled, onProgress });

        expect(result).toBe(null);
        expect(h.runSimulation).toHaveBeenCalledTimes(1);
        expect(onProgress).not.toHaveBeenCalled();
    });

    test('a character swap during a sim discards the result', async () => {
        h.quests = [quest('/monsters/slime'), quest('/monsters/imp')];
        h.runSimulation.mockImplementation(async () => {
            h.characterId = 'char-2';
            return { deaths: { '/monsters/slime': 10, '/monsters/imp': 10 }, encounters: 10 };
        });

        expect(await computeAllZoneProgress()).toBe(null);
        expect(h.runSimulation).toHaveBeenCalledTimes(1);
    });

    test('a character swap while the player data builds discards the run before any sim', async () => {
        h.quests = [quest('/monsters/slime')];
        h.buildAllPlayerDTOs.mockImplementation(async () => {
            h.switching = true;
            return { players: [{ hrid: 'player1' }] };
        });

        expect(await computeAllZoneProgress()).toBe(null);
        expect(h.runSimulation).not.toHaveBeenCalled();
    });

    test('a monster shared between zones counts toward each zone, and the rows are flagged', async () => {
        h.gameData.actionDetailMap[ZONE_B] = zone('Zone B', ['/monsters/imp', '/monsters/slime']);
        h.quests = [quest('/monsters/slime', 100), quest('/monsters/imp', 20)];
        h.runSimulation.mockImplementation(async ({ zoneHrid }) =>
            zoneHrid === ZONE_A
                ? { deaths: { '/monsters/slime': 100 }, encounters: 100 }
                : { deaths: { '/monsters/slime': 50, '/monsters/imp': 50 }, encounters: 100 }
        );

        const rows = await computeAllZoneProgress();

        expect(rows).toHaveLength(2);
        const a = rows.find((r) => r.zoneHrid === ZONE_A);
        const b = rows.find((r) => r.zoneHrid === ZONE_B);
        expect(a).toMatchObject({ bottleneckHrid: '/monsters/slime', hoursNeeded: 1, shared: true });
        // slime 100 / 50 per hour = 2h in zone B, imp 20 / 50 = 0.4h
        expect(b).toMatchObject({ bottleneckHrid: '/monsters/slime', hoursNeeded: 2, shared: true });
    });

    test('a boss-only spawn counts as the zone hosting the monster', async () => {
        h.gameData.actionDetailMap[ZONE_B] = zone('Zone B', ['/monsters/imp'], ['/monsters/ooze']);
        h.quests = [quest('/monsters/ooze', 10)];
        h.runSimulation.mockResolvedValue({ deaths: { '/monsters/ooze': 10 }, encounters: 10 });
        const rows = await computeAllZoneProgress();
        expect(rows.map((r) => r.zoneHrid).sort()).toEqual([ZONE_A, ZONE_B]);
    });

    test('unshared zones are not flagged', async () => {
        h.quests = [quest('/monsters/slime', 10), quest('/monsters/imp', 10)];
        h.runSimulation.mockResolvedValue({ deaths: { '/monsters/slime': 10, '/monsters/imp': 10 }, encounters: 10 });
        const rows = await computeAllZoneProgress();
        expect(rows.every((r) => r.shared === false)).toBe(true);
    });

    test('zones whose tasks are all complete are skipped, and no sim runs for them', async () => {
        h.quests = [quest('/monsters/slime', 100, 100), quest('/monsters/imp', 20, 5)];
        h.runSimulation.mockResolvedValue({ deaths: { '/monsters/imp': 10 }, encounters: 10 });

        const rows = await computeAllZoneProgress();

        expect(rows.map((r) => r.zoneHrid)).toEqual([ZONE_B]);
        expect(h.runSimulation).toHaveBeenCalledTimes(1);
    });

    test('with every task complete there is nothing to compute', async () => {
        h.quests = [quest('/monsters/slime', 100, 100)];
        expect(await computeAllZoneProgress()).toEqual([]);
        expect(h.runSimulation).not.toHaveBeenCalled();
    });

    test('dungeon zones are never rows', async () => {
        h.gameData.actionDetailMap[ZONE_B].combatZoneInfo.isDungeon = true;
        h.quests = [quest('/monsters/imp', 10)];
        expect(await computeAllZoneProgress()).toEqual([]);
    });
});
