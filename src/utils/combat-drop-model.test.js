import { describe, test, expect } from 'vitest';
import {
    effectiveDropRate,
    dropQuantityMultiplier,
    monsterDropList,
    splitBattles,
    buildCombatSession,
    lootValue,
    sessionMean,
    expectedItemCounts,
    percentOfExpected,
} from './combat-drop-model.js';

const priceOf = (hrid) => ({ '/items/a': 100, '/items/rare': 50000, '/items/worthless': 0 })[hrid] ?? null;

const monsterDetailMap = {
    '/monsters/grunt': {
        dropTable: [{ itemHrid: '/items/a', dropRate: 0.5, minCount: 1, maxCount: 3 }],
        rareDropTable: [{ itemHrid: '/items/rare', dropRate: 0.001, minCount: 1, maxCount: 1 }],
    },
    '/monsters/boss': {
        dropTable: [{ itemHrid: '/items/a', dropRate: 1, minCount: 5, maxCount: 5 }],
    },
};

const zone = {
    combatZoneInfo: {
        isDungeon: false,
        fightInfo: {
            randomSpawnInfo: {
                spawns: [{ combatMonsterHrid: '/monsters/grunt', rate: 1, strength: 1 }],
                maxSpawnCount: 2,
                maxTotalStrength: 2,
            },
            bossSpawns: [{ combatMonsterHrid: '/monsters/boss' }],
        },
    },
};

describe('effectiveDropRate', () => {
    test('a plain drop at tier zero is its own rate', () => {
        expect(effectiveDropRate({ dropRate: 0.25 }, 0)).toBeCloseTo(0.25, 12);
    });

    test('difficulty raises the rate twice over', () => {
        // A flat per-tier step the drop carries, and a tenth of the base per tier
        expect(effectiveDropRate({ dropRate: 0.2, dropRatePerDifficultyTier: 0.05 }, 2)).toBeCloseTo(0.36, 12);
    });

    test('a common drop answers to drop rate and a rare one to rare find', () => {
        // Mixing these up makes a rare-find build read as permanently lucky on
        // rares and unlucky on everything else
        const bonuses = { combatDropRate: 1, combatRareFind: 3 };
        expect(effectiveDropRate({ dropRate: 0.1, isRare: false }, 0, bonuses)).toBeCloseTo(0.2, 12);
        expect(effectiveDropRate({ dropRate: 0.1, isRare: true }, 0, bonuses)).toBeCloseTo(0.4, 12);
    });

    test('never exceeds certainty or falls below nothing', () => {
        expect(effectiveDropRate({ dropRate: 0.9 }, 0, { combatDropRate: 5 })).toBe(1);
        expect(effectiveDropRate({ dropRate: -1 }, 0)).toBe(0);
    });
});

describe('dropQuantityMultiplier', () => {
    test('a solo player with no bonuses changes nothing', () => {
        expect(dropQuantityMultiplier()).toBe(1);
    });

    test('a party splits the loot', () => {
        expect(dropQuantityMultiplier({ combatDropQuantity: 0 }, 5)).toBeCloseTo(0.2, 12);
    });

    test('a dungeon pays five times over, nearly cancelling a full party', () => {
        expect(dropQuantityMultiplier({ combatDropQuantity: 0 }, 5, true)).toBeCloseTo(1, 12);
    });

    test('a party of nobody is a party of one', () => {
        expect(dropQuantityMultiplier({}, 0)).toBe(1);
    });
});

describe('monsterDropList', () => {
    test('merges both tables and keeps the rare flag', () => {
        const drops = monsterDropList(monsterDetailMap['/monsters/grunt']);
        expect(drops).toHaveLength(2);
        expect(drops[0].isRare).toBe(false);
        expect(drops[1].isRare).toBe(true);
    });

    test('survives a monster with no tables at all', () => {
        expect(monsterDropList(undefined)).toEqual([]);
        expect(monsterDropList({})).toEqual([]);
    });
});

describe('splitBattles', () => {
    test('every tenth battle is a boss', () => {
        expect(splitBattles(25, 10)).toEqual({ normalCount: 23, bossCount: 2 });
    });

    test('a zone with no boss is all ordinary battles', () => {
        expect(splitBattles(25, 0)).toEqual({ normalCount: 25, bossCount: 0 });
    });

    test('the two always add back to the total', () => {
        for (const battles of [0, 1, 9, 10, 11, 100]) {
            const { normalCount, bossCount } = splitBattles(battles, 10);
            expect(normalCount + bossCount).toBe(battles);
        }
    });
});

describe('buildCombatSession', () => {
    const build = (overrides = {}) =>
        buildCombatSession({
            actionDetail: zone,
            monsterDetailMap,
            battles: 100,
            priceOf,
            ...overrides,
        });

    test('prices the drops and splits the battles', () => {
        const session = build();
        expect(session.normalCount).toBe(90);
        expect(session.bossCount).toBe(10);
        expect(session.monsterDrops['/monsters/grunt']).toHaveLength(2);
        expect(session.bossDrops['/monsters/boss'][0].price).toBe(100);
    });

    test('an item with no price is left out rather than counted as free', () => {
        // Counting it as zero would make every session containing one look unlucky
        const withJunk = {
            '/monsters/grunt': {
                dropTable: [
                    { itemHrid: '/items/a', dropRate: 0.5, minCount: 1, maxCount: 1 },
                    { itemHrid: '/items/worthless', dropRate: 1, minCount: 1, maxCount: 1 },
                    { itemHrid: '/items/unknown', dropRate: 1, minCount: 1, maxCount: 1 },
                ],
            },
        };
        const session = build({ monsterDetailMap: withJunk, actionDetail: zone });
        expect(session.monsterDrops['/monsters/grunt']).toHaveLength(1);
    });

    test('bonuses reach the drops', () => {
        const session = build({ bonuses: { combatDropRate: 1, combatRareFind: 0, combatDropQuantity: 1 } });
        const common = session.monsterDrops['/monsters/grunt'][0];
        expect(common.dropRate).toBeCloseTo(1, 12);
        expect(common.maxCount).toBeCloseTo(6, 12);
    });

    test('refuses a dungeon rather than modelling it wrong', () => {
        // Dungeons pay from a reward table on completion, not per monster
        const dungeon = { combatZoneInfo: { ...zone.combatZoneInfo, isDungeon: true } };
        expect(build({ actionDetail: dungeon })).toBeNull();
    });

    test('refuses what it cannot model', () => {
        expect(build({ actionDetail: null })).toBeNull();
        expect(build({ actionDetail: { combatZoneInfo: { fightInfo: {} } } })).toBeNull();
        expect(build({ battles: 0 })).toBeNull();
        expect(build({ monsterDetailMap: null })).toBeNull();
    });

    test('a zone with no boss puts every battle in the ordinary count', () => {
        const bossless = {
            combatZoneInfo: {
                isDungeon: false,
                fightInfo: { randomSpawnInfo: zone.combatZoneInfo.fightInfo.randomSpawnInfo },
            },
        };
        const session = build({ actionDetail: bossless });
        expect(session).toMatchObject({ normalCount: 100, bossCount: 0 });
        expect(session.bossDrops).toEqual({});
    });
});

describe('lootValue', () => {
    test('adds up what the loot was worth', () => {
        const loot = { 0: { itemHrid: '/items/a', count: 3 }, 1: { itemHrid: '/items/rare', count: 1 } };
        expect(lootValue(loot, priceOf)).toBe(50300);
    });

    test('skips what it cannot price, matching what the model left out', () => {
        const loot = { 0: { itemHrid: '/items/a', count: 1 }, 1: { itemHrid: '/items/unknown', count: 99 } };
        expect(lootValue(loot, priceOf)).toBe(100);
    });

    test('survives no loot at all', () => {
        expect(lootValue(null, priceOf)).toBe(0);
    });
});

describe('sessionMean', () => {
    // One monster, always spawning once, dropping one item worth 100 at a rate
    // of one in ten — so ten waves are owed 100
    const session = {
        spawnInfo: { maxSpawnCount: 1, spawns: [{ combatMonsterHrid: '/m/a', rate: 1 }] },
        monsterDrops: { '/m/a': [{ minCount: 1, maxCount: 1, dropRate: 0.1, price: 100 }] },
        normalCount: 10,
        bossCount: 0,
    };

    test('pays rate times count times price, per wave', () => {
        expect(sessionMean(session)).toBeCloseTo(100, 6);
    });

    test('a count range pays its midpoint', () => {
        const ranged = {
            ...session,
            monsterDrops: { '/m/a': [{ minCount: 1, maxCount: 3, dropRate: 1, price: 10 }] },
        };
        expect(sessionMean(ranged)).toBeCloseTo(200, 6);
    });

    test('bosses are counted outright, not weighted by a spawn rate', () => {
        // Every boss in the table turns up on a boss wave
        const withBoss = {
            ...session,
            normalCount: 0,
            bossCount: 4,
            bossDrops: { '/m/b': [{ minCount: 2, maxCount: 2, dropRate: 0.5, price: 1000 }] },
        };
        expect(sessionMean(withBoss)).toBeCloseTo(4000, 6);
    });

    test('a monster with no priced drops contributes nothing rather than throwing', () => {
        expect(sessionMean({ ...session, monsterDrops: {} })).toBe(0);
    });
});

describe('expectedItemCounts', () => {
    // The same session sessionMean is tested against, so the two can be checked
    // to agree: one item worth 100 at a rate of one in ten, over ten waves
    const session = {
        spawnInfo: { maxSpawnCount: 1, spawns: [{ combatMonsterHrid: '/m/a', rate: 1 }] },
        monsterDrops: { '/m/a': [{ itemHrid: '/items/a', minCount: 1, maxCount: 1, dropRate: 0.1, price: 100 }] },
        normalCount: 10,
        bossCount: 0,
    };

    test('counts rather than coins', () => {
        expect(expectedItemCounts(session)).toEqual({ '/items/a': expect.closeTo(1, 6) });
    });

    test('it agrees with sessionMean when the counts are priced back up', () => {
        // Two models of one session that could disagree is the whole risk here
        const counts = expectedItemCounts(session);
        expect(counts['/items/a'] * 100).toBeCloseTo(sessionMean(session), 6);
    });

    test('a count range contributes its midpoint', () => {
        const ranged = {
            ...session,
            monsterDrops: { '/m/a': [{ itemHrid: '/items/a', minCount: 1, maxCount: 3, dropRate: 1, price: 10 }] },
        };
        expect(expectedItemCounts(ranged)['/items/a']).toBeCloseTo(20, 6);
    });

    test('two monsters dropping the same item add up under it', () => {
        const shared = {
            ...session,
            spawnInfo: {
                maxSpawnCount: 2,
                spawns: [
                    { combatMonsterHrid: '/m/a', rate: 1 },
                    { combatMonsterHrid: '/m/b', rate: 1 },
                ],
            },
            monsterDrops: {
                '/m/a': [{ itemHrid: '/items/a', minCount: 1, maxCount: 1, dropRate: 0.1, price: 100 }],
                '/m/b': [{ itemHrid: '/items/a', minCount: 1, maxCount: 1, dropRate: 0.1, price: 100 }],
            },
        };
        expect(Object.keys(expectedItemCounts(shared))).toEqual(['/items/a']);
    });

    test('bosses are counted outright, not weighted by a spawn rate', () => {
        const withBoss = {
            ...session,
            normalCount: 0,
            bossCount: 4,
            bossDrops: { '/m/b': [{ itemHrid: '/items/key', minCount: 2, maxCount: 2, dropRate: 0.5, price: 1 }] },
        };
        expect(expectedItemCounts(withBoss)['/items/key']).toBeCloseTo(4, 6);
    });

    test('a drop with no item is skipped rather than counted under undefined', () => {
        const nameless = {
            ...session,
            monsterDrops: { '/m/a': [{ minCount: 1, maxCount: 1, dropRate: 1, price: 1 }] },
        };
        expect(expectedItemCounts(nameless)).toEqual({});
    });
});

describe('percentOfExpected', () => {
    test('signed against zero rather than expressed as a fraction of expectation', () => {
        // "+36%" is read at a glance and "136%" is read twice
        expect(percentOfExpected(136, 100)).toBeCloseTo(36, 6);
        expect(percentOfExpected(50, 100)).toBeCloseTo(-50, 6);
        expect(percentOfExpected(100, 100)).toBeCloseTo(0, 6);
    });

    test('nothing to compare against is nothing, not a triumph', () => {
        // A zero expectation with drops in hand is a model that does not cover
        // this zone, rather than infinite luck
        expect(percentOfExpected(500, 0)).toBeNull();
        expect(percentOfExpected(0, 0)).toBeNull();
    });
});
