/** @vitest-environment happy-dom
 *
 * Weighing a house room in the Lab Sim.
 *
 * A room level is the one upgrade the labyrinth analyses cannot install for
 * themselves: the shared candidate applier knows equipment, abilities, skill
 * levels, shrines and drinks, and a house candidate handed to it falls through
 * to the equipment branch and changes nothing — so the row would come back a
 * confident +0.00%. The panel therefore runs its own pass, and the thing most
 * worth asserting is the thing that used to be silently wrong: that the level
 * actually reaches the character the simulation is handed.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const advisor = vi.hoisted(() => ({
    houseCandidates: [],
    scan: { rooms: 0, withBuffs: 0, combatRelevant: 0, belowCap: 0 },
    costs: {},
}));
const sim = vi.hoisted(() => ({ calls: [], winRates: {}, baselineWinRate: 0.5 }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_k, d) => d, setSetting: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ abilityDetailMap: {} }),
        getInventory: () => [],
        getItemDetails: () => null,
        characterItems: [],
        characterEquipment: new Map(),
        characterData: { characterAbilities: [] },
    },
}));

vi.mock('./combat-sim-ui.js', () => ({
    default: {
        upgradeRowPurchase: () => null,
        upgradeRowActionsHtml: () => '',
        wireUpgradeRowActions: () => {},
    },
}));

vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => ({ itemDetailMap: {}, houseRoomDetailMap: {} }),
    buildAllPlayerDTOs: async () => ({ players: [] }),
    getCombatZones: () => [{ hrid: '/actions/combat/fly' }],
    getCommunityBuffs: () => ({}),
    getLabyrinthMonsters: () => [],
}));

// One attempt count for every run, so the pass's paired trial rule is the same
// number in the baseline and in every candidate — the win rates are what differ
vi.mock('./combat-sim-runner.js', () => ({
    runLabyrinthSimulation: async (params) => {
        sim.calls.push(params);
        const rooms = params.playerDTOs[0]?.houseRooms || {};
        const changed = Object.keys(rooms).find((hrid) => rooms[hrid] !== sim.baseRooms?.[hrid]);
        const winRate = changed ? (sim.winRates[changed] ?? sim.baselineWinRate) : sim.baselineWinRate;
        return { labyAttemptCount: 200, encounters: Math.round(200 * winRate) };
    },
    cancelSimulation: () => {},
    getMaxWorkers: () => 2,
}));

vi.mock('./upgrade-advisor.js', () => ({
    runLabyrinthUpgradeAnalysis: async () => ({ baseline: null, results: [] }),
    runLabyrinthAllFightsAnalysis: async () => ({ baseline: null, results: [] }),
    computeSkillingClearRatesFromEditor: async () => ({}),
    runSkillingUpgradeAnalysis: async () => ({ results: [] }),
    getStyleExcludedSkills: () => [],
    planWithinBudget: () => ({ picks: [], skipped: [], totalCost: 0, attemptsSaved: 0 }),
    runLabyrinthCombinationCheck: async () => ({}),
    generateCandidates: () => [],
    generateHouseCandidates: () => advisor.houseCandidates.map((c) => ({ ...c })),
    describeHouseScan: () => advisor.scan,
    calculateUpgradeCost: (candidate) => advisor.costs[candidate.roomHrid] ?? null,
    explainUpgradeCost: (candidate) => ({
        buys: [],
        credits: [],
        gross: advisor.costs[candidate.roomHrid] ?? null,
        credit: 0,
        net: advisor.costs[candidate.roomHrid] ?? null,
        unpriced: [],
        creditApplied: false,
        source: 'craft',
    }),
}));

const { default: ui } = await import('./lab-sim-ui.js');

const DAIRY = '/house_rooms/dairy_barn';
const GARDEN = '/house_rooms/garden';

const room = (roomHrid, currentLevel, upgradeLevel, name) => ({
    type: 'house',
    slot: `house|${roomHrid}`,
    roomHrid,
    currentLevel,
    upgradeLevel,
    description: `${name} Lv${currentLevel} → Lv${upgradeLevel}`,
});

const player = (houseRooms = {}) => ({ hrid: 'p1', equipment: {}, abilities: [], houseRooms });

const runPass = (dto) =>
    ui._runHouseUpgradePass({
        playerDTO: dto,
        gameData: { itemDetailMap: {}, houseRoomDetailMap: {} },
        monsterHrid: '/monsters/mimic',
        roomLevel: 140,
        crates: [],
        hours: 3,
        communityBuffs: {},
        labyrinthCombatBuffs: [],
    });

beforeEach(() => {
    ui._upgradeAborted = false;
    sim.calls = [];
    sim.winRates = {};
    sim.baselineWinRate = 0.5;
    sim.baseRooms = { [DAIRY]: 4, [GARDEN]: 2 };
    advisor.houseCandidates = [room(DAIRY, 4, 5, 'Dairy Barn'), room(GARDEN, 2, 3, 'Garden')];
    advisor.costs = { [DAIRY]: 40_000_000, [GARDEN]: 10_000_000 };
    advisor.scan = { rooms: 20, withBuffs: 18, combatRelevant: 11, belowCap: 2 };
});

describe('the level actually reaches the character', () => {
    test('each room is simulated with its own level raised, and nothing else moved', async () => {
        await runPass(player({ [DAIRY]: 4, [GARDEN]: 2 }));

        // One baseline plus one run per room
        expect(sim.calls).toHaveLength(3);
        expect(sim.calls[0].playerDTOs[0].houseRooms).toEqual({ [DAIRY]: 4, [GARDEN]: 2 });

        const rooms = sim.calls.slice(1).map((call) => call.playerDTOs[0].houseRooms);
        expect(rooms).toContainEqual({ [DAIRY]: 5, [GARDEN]: 2 });
        expect(rooms).toContainEqual({ [DAIRY]: 4, [GARDEN]: 3 });
    });

    test('the panel’s own character is never touched by it', async () => {
        const dto = player({ [DAIRY]: 4, [GARDEN]: 2 });
        await runPass(dto);

        expect(dto.houseRooms).toEqual({ [DAIRY]: 4, [GARDEN]: 2 });
    });

    test('a room sitting at level 0 is not in the map yet, and is still simulated', async () => {
        advisor.houseCandidates = [room(DAIRY, 0, 1, 'Dairy Barn')];
        sim.baseRooms = {};

        await runPass({ hrid: 'p1', equipment: {}, abilities: [] });

        expect(sim.calls[1].playerDTOs[0].houseRooms).toEqual({ [DAIRY]: 1 });
    });
});

describe('what the rows say', () => {
    test('a room that helps ranks on the same win rate and Gold per 1% as everything else', async () => {
        sim.baselineWinRate = 0.5;
        sim.winRates = { [DAIRY]: 0.52, [GARDEN]: 0.51 };

        const { results } = await runPass(player({ [DAIRY]: 4, [GARDEN]: 2 }));

        const dairy = results.find((r) => r.candidate.roomHrid === DAIRY);
        expect(dairy).toMatchObject({ costType: 'gold', cost: 40_000_000, metricType: 'winRate' });
        expect(dairy.winRate).toBeCloseTo(0.52, 10);
        expect(dairy.winRateDelta).toBeCloseTo(0.02, 10);
        // 40M for two points of win rate is 20M per point
        expect(dairy.goldPerWinRate).toBeCloseTo(20_000_000, 6);

        // The cheaper room buying a smaller gain is the better value, and the
        // column that decides the table says so
        const garden = results.find((r) => r.candidate.roomHrid === GARDEN);
        expect(garden.goldPerWinRate).toBeLessThan(dairy.goldPerWinRate);
    });

    test('a room that does nothing is not sold as free value', async () => {
        sim.winRates = { [DAIRY]: 0.5 };

        const { results } = await runPass(player({ [DAIRY]: 4, [GARDEN]: 2 }));

        expect(results.find((r) => r.candidate.roomHrid === DAIRY).goldPerWinRate).toBe(Infinity);
    });

    test('a room with no price ranks as unknown rather than as free', async () => {
        advisor.costs = {};
        sim.winRates = { [DAIRY]: 0.6 };

        const { results } = await runPass(player({ [DAIRY]: 4, [GARDEN]: 2 }));
        const dairy = results.find((r) => r.candidate.roomHrid === DAIRY);

        expect(dairy.cost).toBeNull();
        expect(dairy.goldPerWinRate).toBe(Infinity);
    });

    test('every candidate run is paired to the baseline’s fight count', async () => {
        await runPass(player({ [DAIRY]: 4, [GARDEN]: 2 }));

        // The baseline runs on time; the rest play exactly its number of fights,
        // with the headroom to get there
        expect(sim.calls[0].precision).toBeUndefined();
        for (const call of sim.calls.slice(1)) {
            expect(call.precision).toEqual({ minTrials: 200, maxTrials: 200 });
            expect(call.hours).toBeGreaterThan(3);
        }
    });
});

describe('when there is nothing to weigh', () => {
    test('every combat room already maxed says so rather than reading as no upgrades', async () => {
        advisor.houseCandidates = [];
        advisor.scan = { rooms: 20, withBuffs: 18, combatRelevant: 11, belowCap: 0 };

        const result = await runPass(player());

        expect(result.results).toEqual([]);
        expect(result.note).toMatch(/all 11 combat house rooms are already maxed/);
        expect(sim.calls).toHaveLength(0);
    });

    test('and a game with no combat-relevant rooms is a different answer', async () => {
        advisor.houseCandidates = [];
        advisor.scan = { rooms: 20, withBuffs: 18, combatRelevant: 0, belowCap: 0 };

        expect((await runPass(player())).note).toMatch(/no combat-relevant house rooms/);
    });

    test('Stop between the baseline and the rooms leaves no half-measured rows', async () => {
        ui._upgradeAborted = true;

        const result = await runPass(player({ [DAIRY]: 4, [GARDEN]: 2 }));

        expect(result.results).toEqual([]);
    });
});
