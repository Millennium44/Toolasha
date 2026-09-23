/**
 * `calculateExpectedDrops`: what a simulated run is credited with.
 *
 * The arithmetic here is what the Results view's revenue, the dungeon ROI board
 * and every profit figure downstream are built on, so a term left out of it is
 * not a rounding error — it is the whole of a cost line or a whole level-gap
 * penalty.
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

const DEN = '/actions/combat/chimerical_den';
const CHEST = '/items/chimerical_chest';
const TOKEN = '/items/chimerical_token';

/** A dungeon whose table pays a guaranteed chest and a sub-1 token roll. */
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

function dungeonResult(overrides = {}) {
    return {
        isDungeon: true,
        dungeonsCompleted: 10,
        zoneName: DEN,
        numberOfPlayers: 5,
        difficultyTier: 0,
        dropRateMultiplier: { player1: 1 },
        rareFindMultiplier: { player1: 1 },
        combatDropQuantity: { player1: 0 },
        debuffOnLevelGap: { player1: 0 },
        deaths: {},
        ...overrides,
    };
}

describe('dungeon chests per completion', () => {
    test('a five-player split with no bonuses is one chest each', () => {
        const drops = calculateExpectedDrops(dungeonResult(), dungeonGameData);
        expect(drops.get(CHEST)).toBeCloseTo(10);
        // A sub-1 reward rolls at its rate and is not multiplied by the split
        expect(drops.get(TOKEN)).toBeCloseTo(10 * 0.5 * 10);
    });

    test('a solo run is paid the whole five shares, raised by the quantity bonus', () => {
        const drops = calculateExpectedDrops(
            dungeonResult({ numberOfPlayers: 1, combatDropQuantity: { player1: 0.295 } }),
            dungeonGameData
        );
        expect(drops.get(CHEST)).toBeCloseTo(10 * 5 * 1.295);
    });

    test('the level gap cuts the chest count, the same way the chest-luck reading does', () => {
        // The adapter used to leave `debuffOnLevelGap` out of the dungeon
        // branch entirely, so the sim credited a gapped player a full share
        // while `chestsPerCompletion` — the same figure the live chest-luck
        // panel measures them against — gave a tenth of one. Both now go
        // through that one helper.
        //
        // The multiplier itself is an assumption rather than a measured rule;
        // see the comment at the call site and claim 4 of
        // docs/sim-claim-verification.md. What this test pins is that the two
        // callers cannot disagree about it.
        const drops = calculateExpectedDrops(dungeonResult({ debuffOnLevelGap: { player1: -0.9 } }), dungeonGameData);
        expect(drops.get(CHEST)).toBeCloseTo(10 * 0.1, 10);
    });
});

const MONSTER = '/monsters/jackalope';
const COMMON = '/items/hide';
const RARE = '/items/jackalope_antler';

/** One monster, one common drop and one rare, both at half a chance. */
const zoneGameData = {
    actionDetailMap: {},
    combatMonsterDetailMap: {
        [MONSTER]: {
            dropTable: [{ itemHrid: COMMON, dropRate: 0.5, minCount: 1, maxCount: 1 }],
            rareDropTable: [{ itemHrid: RARE, dropRate: 0.5, minCount: 1, maxCount: 1 }],
        },
    },
};

function zoneResult(overrides = {}) {
    return {
        isDungeon: false,
        numberOfPlayers: 1,
        difficultyTier: 0,
        dropRateMultiplier: { player1: 1 },
        rareFindMultiplier: { player1: 1 },
        combatDropQuantity: { player1: 0 },
        debuffOnLevelGap: { player1: 0 },
        deaths: { [MONSTER]: 100 },
        ...overrides,
    };
}

describe('a drop rate cannot pass certainty', () => {
    test('rare find raises the rate, up to but not past one drop a kill', () => {
        // A rate is the chance of one roll landing, so 0.5 x 4 is certainty and
        // not two antlers a kill. The regular-drop path has always capped; the
        // rare path multiplied and never did, so a heavy rare-find build was
        // credited drops the game cannot pay.
        const doubled = calculateExpectedDrops(zoneResult({ rareFindMultiplier: { player1: 1.5 } }), zoneGameData);
        expect(doubled.get(RARE)).toBeCloseTo(100 * 0.75);

        const overshot = calculateExpectedDrops(zoneResult({ rareFindMultiplier: { player1: 4 } }), zoneGameData);
        expect(overshot.get(RARE)).toBeCloseTo(100);
    });

    test('the regular path caps the same way, which is the convention being matched', () => {
        const overshot = calculateExpectedDrops(zoneResult({ dropRateMultiplier: { player1: 4 } }), zoneGameData);
        expect(overshot.get(COMMON)).toBeCloseTo(100);
    });
});

describe('tiered rare-drop rewards', () => {
    test('a rare rate does not move with tier, only a regular one does', () => {
        // The client's monster tooltip scales `dropTable` by tier but reads
        // `rareDropTable` at its raw rate - no `getScaledDropRate` call at all.
        // A per-tier step is included on the rare entry only to prove it is
        // ignored; the tier *gate* (`minDifficultyTier`) still applies to both.
        const tieredData = {
            ...zoneGameData,
            combatMonsterDetailMap: {
                [MONSTER]: {
                    dropTable: [
                        { itemHrid: COMMON, dropRate: 0.2, dropRatePerDifficultyTier: 0.05, minCount: 1, maxCount: 1 },
                    ],
                    rareDropTable: [
                        { itemHrid: RARE, dropRate: 0.2, dropRatePerDifficultyTier: 0.05, minCount: 1, maxCount: 1 },
                    ],
                },
            },
        };
        const drops = calculateExpectedDrops(zoneResult({ difficultyTier: 2 }), tieredData);
        expect(drops.get(COMMON)).toBeCloseTo(100 * (0.2 + 2 * 0.05) * 1.2);
        expect(drops.get(RARE)).toBeCloseTo(100 * 0.2);
    });
});

describe('dungeon reward tier scaling', () => {
    test('a refinement chest step is raised by the tenth-per-tier multiplier too', () => {
        // Regression for the dungeon reward path having applied only the flat
        // per-tier step and missing the client's `(1 + 0.1 * tier)` factor
        // (`getScaledDropRate`) that both the monster tooltip and the dungeon
        // reward display apply.
        const step = 0.1;
        const tieredDungeonData = {
            combatMonsterDetailMap: {},
            actionDetailMap: {
                [DEN]: {
                    combatZoneInfo: {
                        dungeonInfo: {
                            rewardDropTable: [
                                {
                                    itemHrid: '/items/chimerical_refinement_chest',
                                    dropRate: 0,
                                    dropRatePerDifficultyTier: step,
                                    minCount: 1,
                                    maxCount: 1,
                                },
                            ],
                        },
                    },
                },
            },
        };
        const drops = calculateExpectedDrops(
            dungeonResult({ dungeonsCompleted: 1, difficultyTier: 2 }),
            tieredDungeonData
        );
        expect(drops.get('/items/chimerical_refinement_chest')).toBeCloseTo(1.2 * 2 * step);
    });
});
