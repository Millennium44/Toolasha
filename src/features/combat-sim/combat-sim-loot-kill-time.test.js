/**
 * Loot is valued at the stats each player held when the kill landed.
 *
 * Consumable buffs (Lucky Coffee: combat drop rate; rare find; drop quantity)
 * come and go mid-run. The result used to keep only the end-of-run multipliers
 * and price every kill at them, so an hour with Lucky Coffee up for 67 of 97
 * kills was priced at 1.0 because the buff had lapsed at the cutoff.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => null,
        getItemDetails: (hrid) => ({ name: hrid.split('/').pop() }),
        getPartyMembers: () => ({ members: [], source: 'none', updatedAt: 1 }),
        battleData: null,
        characterData: null,
        characterEquipment: new Map(),
        personalActionTypeBuffsMap: null,
    },
}));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => [] } }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => null, getSettingValue: (_k, d) => d } }));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../api/marketplace.js', () => ({ default: {} }));
vi.mock('../market/expected-value-calculator.js', () => ({ default: {} }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 0, getItemPrices: () => ({}) }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({ getProductionCost: () => 0 }));

const { calculateExpectedDrops } = await import('./combat-sim-adapter.js');
const { default: CombatSimulator } = await import('./engine/combat-simulator.js');
const { default: SimResult } = await import('./engine/sim-result.js');

const ZONE = { hrid: '/actions/combat/swamp_planet', difficultyTier: 0, isDungeon: false };
const GATOR = '/monsters/alligator';
const COMMON = '/items/gator_hide';
const RARE = '/items/gator_tooth';

/** Lucky Coffee's combat drop rate, as the buff folds into combatStats */
const LUCKY = 0.15;

const zoneGameData = {
    actionDetailMap: {},
    combatMonsterDetailMap: {
        [GATOR]: {
            dropTable: [{ itemHrid: COMMON, dropRate: 0.4, minCount: 1, maxCount: 3 }],
            rareDropTable: [{ itemHrid: RARE, dropRate: 0.01, minCount: 1, maxCount: 1 }],
        },
    },
};

/** A party member whose loot stats a test moves between kills, as a buff would. */
function player(hrid, stats = {}) {
    return {
        hrid,
        isPlayer: true,
        debuffOnLevelGap: 0,
        taskMonsterHrids: new Set(),
        taskMonsterRemaining: new Map(),
        taskMonsterKills: null,
        combatDetails: {
            combatStats: { combatDropRate: 0, combatRareFind: 0, combatDropQuantity: 0, ...stats },
        },
    };
}

const gator = () => ({ hrid: GATOR, isPlayer: false });

/** Finish a run the way the simulator does: end-of-run multipliers, then the result */
function finish(simulator) {
    for (const p of simulator.players) simulator.simResult.setDropRateMultipliers(p);
    return simulator.simResult;
}

/** Expected common drops for `kills` at drop rate `dr` and quantity `qty`, solo, no gap */
const commons = (kills, dr = 0, qty = 0) => kills * Math.min(1, 0.4 * (1 + dr)) * 2 * (1 + qty);

describe('a drink with partial uptime', () => {
    test('67 of 97 kills under Lucky Coffee, lapsed at the cutoff, are priced kill by kill', () => {
        const me = player('player1');
        const simulator = new CombatSimulator([me], ZONE);

        me.combatDetails.combatStats.combatDropRate = LUCKY;
        for (let i = 0; i < 67; i++) simulator.recordDeath(gator());
        me.combatDetails.combatStats.combatDropRate = 0; // the coffee runs out
        for (let i = 0; i < 30; i++) simulator.recordDeath(gator());

        const drops = calculateExpectedDrops(finish(simulator), zoneGameData);
        // Before: 97 x 0.4 x 2 = 77.6, every kill at the lapsed state
        expect(drops.get(COMMON)).toBeCloseTo(commons(67, LUCKY) + commons(30), 10);
        expect(drops.get(COMMON)).toBeCloseTo(85.64, 10);
    });

    test('and a buff that came up only at the end does not lift the kills before it', () => {
        const me = player('player1');
        const simulator = new CombatSimulator([me], ZONE);

        for (let i = 0; i < 90; i++) simulator.recordDeath(gator());
        me.combatDetails.combatStats.combatDropRate = LUCKY;
        me.combatDetails.combatStats.combatDropQuantity = 0.1;
        me.combatDetails.combatStats.combatRareFind = 0.5;
        for (let i = 0; i < 10; i++) simulator.recordDeath(gator());

        const drops = calculateExpectedDrops(finish(simulator), zoneGameData);
        expect(drops.get(COMMON)).toBeCloseTo(commons(90) + commons(10, LUCKY, 0.1), 10);
        expect(drops.get(RARE)).toBeCloseTo(90 * 0.01 + 10 * 0.01 * 1.5 * 1.1, 10);
    });

    test('each party member is priced at their own stats, split by party size', () => {
        const me = player('player1', { combatDropRate: LUCKY });
        const mate = player('player2');
        const simulator = new CombatSimulator([me, mate], ZONE);

        for (let i = 0; i < 40; i++) simulator.recordDeath(gator());
        me.combatDetails.combatStats.combatDropRate = 0;
        mate.combatDetails.combatStats.combatDropRate = LUCKY;
        for (let i = 0; i < 60; i++) simulator.recordDeath(gator());

        const result = finish(simulator);
        expect(calculateExpectedDrops(result, zoneGameData, 'player1').get(COMMON)).toBeCloseTo(
            (commons(40, LUCKY) + commons(60)) / 2,
            10
        );
        expect(calculateExpectedDrops(result, zoneGameData, 'player2').get(COMMON)).toBeCloseTo(
            (commons(40) + commons(60, LUCKY)) / 2,
            10
        );
    });

    test('the level gap still applies to every bucket', () => {
        const me = player('player1', { combatDropRate: LUCKY });
        me.debuffOnLevelGap = -0.3;
        const simulator = new CombatSimulator([me], ZONE);
        for (let i = 0; i < 10; i++) simulator.recordDeath(gator());
        me.combatDetails.combatStats.combatDropRate = 0;
        for (let i = 0; i < 10; i++) simulator.recordDeath(gator());

        const drops = calculateExpectedDrops(finish(simulator), zoneGameData);
        expect(drops.get(COMMON)).toBeCloseTo((commons(10, LUCKY) + commons(10)) * 0.7, 10);
    });
});

describe('the certainty cap applies per bucket', () => {
    test('a buffed stretch past certainty pays certainty, the rest pays its own rate', () => {
        const sure = {
            actionDetailMap: {},
            combatMonsterDetailMap: {
                [GATOR]: {
                    dropTable: [{ itemHrid: COMMON, dropRate: 0.8, minCount: 1, maxCount: 1 }],
                    rareDropTable: [{ itemHrid: RARE, dropRate: 0.6, minCount: 1, maxCount: 1 }],
                },
            },
        };
        const me = player('player1', { combatDropRate: 0.5, combatRareFind: 1 });
        const simulator = new CombatSimulator([me], ZONE);
        for (let i = 0; i < 20; i++) simulator.recordDeath(gator());
        me.combatDetails.combatStats.combatDropRate = 0;
        me.combatDetails.combatStats.combatRareFind = 0;
        for (let i = 0; i < 80; i++) simulator.recordDeath(gator());

        const drops = calculateExpectedDrops(finish(simulator), sure);
        // 0.8 x 1.5 = 1.2 caps at 1 for the 20 buffed kills only
        expect(drops.get(COMMON)).toBeCloseTo(20 * 1 + 80 * 0.8, 10);
        expect(drops.get(RARE)).toBeCloseTo(20 * 1 + 80 * 0.6, 10);
    });
});

describe('a revived monster is valued once, at its final death', () => {
    test('the revive takes back the tuple the first death recorded', () => {
        const me = player('player1', { combatDropRate: LUCKY });
        const simulator = new CombatSimulator([me], ZONE);
        const boss = gator();

        simulator.recordDeath(boss);
        expect(simulator.simResult.lootStates.player1[GATOR]).toEqual({ '0.15|0|0': 1 });

        me.combatDetails.combatStats.combatDropRate = 0;
        simulator.undoRecordedDeath(boss, 0);
        expect(simulator.simResult.lootStates.player1[GATOR]).toEqual({});
        simulator.recordDeath(boss);

        expect(simulator.simResult.deaths[GATOR]).toBe(1);
        expect(simulator.simResult.lootStates.player1[GATOR]).toEqual({ '0|0|0': 1 });
        expect(calculateExpectedDrops(finish(simulator), zoneGameData).get(COMMON)).toBeCloseTo(commons(1), 10);
    });

    test('player deaths record no loot state', () => {
        const me = player('player1');
        const simulator = new CombatSimulator([me], ZONE);
        simulator.recordDeath(me);
        expect(simulator.simResult.lootStates).toEqual({});
    });
});

describe('chunks with different end states', () => {
    test('a merged histogram prices exactly as the chunks priced separately', () => {
        // Chunk A ends with the coffee up, chunk B with it down; mergeSimResults
        // sums the histograms (combat-sim-runner.test.js), and the sum prices
        // as the two halves did
        const runChunk = (buffedFirst) => {
            const me = player('player1', { combatDropRate: buffedFirst ? LUCKY : 0 });
            const simulator = new CombatSimulator([me], ZONE);
            for (let i = 0; i < 30; i++) simulator.recordDeath(gator());
            me.combatDetails.combatStats.combatDropRate = buffedFirst ? 0 : LUCKY;
            for (let i = 0; i < 20; i++) simulator.recordDeath(gator());
            return finish(simulator);
        };
        const a = runChunk(false);
        const b = runChunk(true);
        const merged = structuredClone(a);
        merged.deaths[GATOR] += b.deaths[GATOR];
        for (const [key, kills] of Object.entries(b.lootStates.player1[GATOR])) {
            merged.lootStates.player1[GATOR][key] = (merged.lootStates.player1[GATOR][key] || 0) + kills;
        }

        const sum =
            calculateExpectedDrops(a, zoneGameData).get(COMMON) + calculateExpectedDrops(b, zoneGameData).get(COMMON);
        expect(calculateExpectedDrops(merged, zoneGameData).get(COMMON)).toBeCloseTo(sum, 10);
        expect(sum).toBeCloseTo(commons(50) + commons(50, LUCKY), 10);
    });
});

const DEN = '/actions/combat/chimerical_den';
const CHEST = '/items/chimerical_chest';
const TOKEN = '/items/chimerical_token';
const dungeonGameData = {
    combatMonsterDetailMap: {},
    actionDetailMap: {
        [DEN]: {
            combatZoneInfo: {
                dungeonInfo: {
                    rewardDropTable: [
                        { itemHrid: CHEST, dropRate: 1, minCount: 1, maxCount: 1 },
                        { itemHrid: TOKEN, dropRate: 0.5, minCount: 10, maxCount: 10 },
                    ],
                },
            },
        },
    },
};

describe('dungeon completions by drop quantity', () => {
    function dungeonRun(qtyByCompletion, finalQty) {
        const me = player('player1');
        const result = new SimResult({ hrid: DEN, difficultyTier: 0 }, 1);
        result.isDungeon = true;
        for (const qty of qtyByCompletion) {
            me.combatDetails.combatStats.combatDropQuantity = qty;
            result.addDungeonQtyStates([me]);
        }
        result.dungeonsCompleted = qtyByCompletion.length;
        me.combatDetails.combatStats.combatDropQuantity = finalQty;
        result.setDropRateMultipliers(me);
        return result;
    }

    test('each completion pays chests at the quantity held when it cleared', () => {
        // Solo: five shares a completion, raised by the quantity bonus
        const drops = calculateExpectedDrops(dungeonRun([0.1, 0.1, 0.1, 0, 0], 0), dungeonGameData);
        expect(drops.get(CHEST)).toBeCloseTo(3 * 5 * 1.1 + 2 * 5, 10);
        // A sub-1 reward is not touched by quantity
        expect(drops.get(TOKEN)).toBeCloseTo(5 * 0.5 * 10, 10);
    });

    test('without a quantity buff the completions price as before', () => {
        const drops = calculateExpectedDrops(dungeonRun([0, 0, 0], 0), dungeonGameData);
        expect(drops.get(CHEST)).toBeCloseTo(3 * 5, 10);
    });
});

describe('a result without kill-time histograms', () => {
    test('a legacy zone result prices exactly as before, at its end-of-run multipliers', () => {
        const legacy = {
            isDungeon: false,
            numberOfPlayers: 2,
            difficultyTier: 0,
            dropRateMultiplier: { player1: 1.15 },
            rareFindMultiplier: { player1: 1.4 },
            combatDropQuantity: { player1: 0.05 },
            debuffOnLevelGap: { player1: -0.1 },
            deaths: { [GATOR]: 97, player1: 2 },
        };
        const drops = calculateExpectedDrops(legacy, zoneGameData);
        expect(drops.get(COMMON)).toBe((97 * Math.min(1.0, 0.4 * 1.15) * 2 * (1 + -0.1) * (1 + 0.05)) / 2);
        expect(drops.get(RARE)).toBe((97 * Math.min(1.0, 0.01 * 1.4) * 1 * (1 + -0.1) * (1 + 0.05)) / 2);
    });

    test('a legacy dungeon result prices exactly as before', () => {
        const legacy = {
            isDungeon: true,
            dungeonsCompleted: 7,
            zoneName: DEN,
            numberOfPlayers: 1,
            difficultyTier: 0,
            dropRateMultiplier: { player1: 1 },
            rareFindMultiplier: { player1: 1 },
            combatDropQuantity: { player1: 0.295 },
            debuffOnLevelGap: { player1: 0 },
            deaths: {},
        };
        const drops = calculateExpectedDrops(legacy, dungeonGameData);
        expect(drops.get(CHEST)).toBeCloseTo(7 * 5 * 1.295, 12);
        expect(drops.get(TOKEN)).toBe(7 * 0.5 * 10);
    });
});
