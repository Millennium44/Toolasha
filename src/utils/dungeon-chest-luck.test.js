/**
 * Luck in a dungeon, which is a different question from luck in a zone.
 *
 * A dungeon pays once on completion, so there is no per-monster distribution to
 * place a haul in. What there *is* is the Combat Drop Quantity bonus, which
 * turns a guaranteed chest into a guaranteed chest plus a chance of another —
 * and that chance is the only randomness in a dungeon payout, which makes it the
 * whole of the luck.
 *
 * The cases worth a test are the ones where a plausible-looking answer would be
 * meaningless: a whole-number mean, where nothing is random and a percentile
 * would be invented; and a first sighting, where somebody's existing chests
 * would otherwise read as a windfall.
 */

import { describe, test, expect } from 'vitest';
import {
    chestsPerCompletion,
    binomialAtMost,
    chestLuck,
    noteChestCount,
    newChestTally,
    countDungeonChests,
    dungeonChestItems,
} from './dungeon-chest-luck.js';

describe('what a completion is worth', () => {
    test('five people split five chests, one each', () => {
        expect(chestsPerCompletion({ partySize: 5, dropQuantity: 0 })).toBe(1);
    });

    test('and the quantity bonus is the chance of a second', () => {
        // +29.5% on one chest is one chest and a 29.5% chance of another, which
        // is the buff people describe as "double chests sometimes"
        expect(chestsPerCompletion({ partySize: 5, dropQuantity: 0.295 })).toBeCloseTo(1.295, 6);
    });

    test('solo takes all five', () => {
        expect(chestsPerCompletion({ partySize: 1, dropQuantity: 0 })).toBe(5);
    });

    test('nothing sensible given, nothing silly returned', () => {
        expect(chestsPerCompletion()).toBe(5);
        expect(chestsPerCompletion({ partySize: 0, dropQuantity: -1 })).toBe(5);
    });
});

describe('the binomial the extras come from', () => {
    test('a fair coin over ten trials is symmetric', () => {
        expect(binomialAtMost(10, 10, 0.5)).toBeCloseTo(1, 10);
        expect(binomialAtMost(4, 10, 0.5) + binomialAtMost(4, 10, 0.5)).toBeLessThan(1);
        expect(binomialAtMost(5, 10, 0.5)).toBeCloseTo(0.623046875, 9);
    });

    test('it holds together at a hundred trials', () => {
        // Where factorials would have overflowed, which is why the terms are
        // built from each other rather than from n!
        expect(binomialAtMost(100, 100, 0.3)).toBeCloseTo(1, 10);
        expect(binomialAtMost(29, 100, 0.3)).toBeGreaterThan(0.4);
        expect(binomialAtMost(29, 100, 0.3)).toBeLessThan(0.6);
    });

    test('the impossible and the certain', () => {
        expect(binomialAtMost(-1, 10, 0.5)).toBe(0);
        expect(binomialAtMost(3, 10, 0)).toBe(1);
        expect(binomialAtMost(3, 10, 1)).toBe(0);
        expect(binomialAtMost(0, 0, 0.5)).toBe(1);
    });
});

describe('placing a run of dungeons', () => {
    const mean = 1.295;

    test('exactly the expected number of extras is about even', () => {
        const luck = chestLuck({ completions: 100, chests: 130, mean });

        expect(luck.extras).toBe(30);
        expect(luck.expectedExtras).toBeCloseTo(29.5, 6);
        expect(luck.percentile).toBeGreaterThan(0.4);
        expect(luck.percentile).toBeLessThan(0.75);
    });

    test('no second chest in fifty runs is as unlucky as it sounds', () => {
        const luck = chestLuck({ completions: 50, chests: 50, mean });

        expect(luck.extras).toBe(0);
        expect(luck.percentile).toBeLessThan(0.001);
    });

    test('a second chest every time is the other end', () => {
        expect(chestLuck({ completions: 50, chests: 100, mean }).percentile).toBe(1);
    });

    test('the expectation is the mean times the runs', () => {
        expect(chestLuck({ completions: 40, chests: 52, mean }).expected).toBeCloseTo(51.8, 6);
    });

    test('a whole-number mean has no luck in it, and says so', () => {
        // Without the bonus every completion pays the same. A percentile there
        // would be a verdict on something that never varied.
        const luck = chestLuck({ completions: 30, chests: 30, mean: 1 });

        expect(luck.percentile).toBeNull();
        expect(luck.chests).toBe(30);
        expect(luck.expected).toBe(30);
    });

    test('nothing completed yet is nothing to place', () => {
        expect(chestLuck({ completions: 0, chests: 0, mean })).toBeNull();
        expect(chestLuck({ completions: 5, chests: 5, mean: 0 })).toBeNull();
        expect(chestLuck()).toBeNull();
    });

    test('a chest seen before its completion does not go negative', () => {
        // Mid-run the loot can be ahead of the count, and a negative extras is
        // not a percentile
        expect(chestLuck({ completions: 1, chests: 0, mean }).percentile).toBeGreaterThanOrEqual(0);
    });
});

describe('counting completions by watching the chests', () => {
    test('the first sighting starts the count rather than paying out', () => {
        // Somebody may walk in holding a hundred chests from yesterday
        const tally = noteChestCount(newChestTally(), 100);

        expect(tally.completions).toBe(0);
        expect(tally.chests).toBe(0);
    });

    test('a rise is one completion paying what it rose by', () => {
        let tally = newChestTally();
        tally = noteChestCount(tally, 0);
        tally = noteChestCount(tally, 1);
        tally = noteChestCount(tally, 3);

        expect(tally.completions).toBe(2);
        expect(tally.chests).toBe(3);
        expect(tally.byPayout).toEqual({ 1: 1, 2: 1 });
    });

    test('a count that has not moved is not a completion', () => {
        // Which is most ticks, since the loot is reported constantly
        let tally = newChestTally();
        for (const count of [4, 4, 4, 4]) tally = noteChestCount(tally, count);

        expect(tally.completions).toBe(0);
    });

    test('chests going down is somebody opening them, not un-completing a run', () => {
        let tally = newChestTally();
        tally = noteChestCount(tally, 10);
        tally = noteChestCount(tally, 2);
        tally = noteChestCount(tally, 3);

        expect(tally.completions).toBe(1);
        expect(tally.chests).toBe(1);
    });

    test('nonsense is ignored rather than counted', () => {
        let tally = newChestTally();
        tally = noteChestCount(tally, 5);
        tally = noteChestCount(tally, NaN);
        tally = noteChestCount(tally, -3);

        expect(tally.seen).toBe(5);
        expect(tally.completions).toBe(0);
    });
});

describe('finding the chests in a loot map', () => {
    test('the four dungeon chests count', () => {
        const loot = {
            a: { itemHrid: '/items/chimerical_chest', count: 2 },
            b: { itemHrid: '/items/pirate_chest', count: 1 },
        };
        expect(countDungeonChests(loot)).toBe(3);
    });

    test('and nothing else does', () => {
        // Plenty of things are openable; a treasure chest from a gathering node
        // is not a dungeon completion, and counting it would put a run's worth
        // of luck onto the wrong scale
        const loot = {
            a: { itemHrid: '/items/purples_gift', count: 5 },
            b: { itemHrid: '/items/chimerical_refinement_chest', count: 4 },
            c: { itemHrid: '/items/coin', count: 1000 },
        };
        expect(countDungeonChests(loot)).toBe(0);
    });

    test('no loot is no chests', () => {
        expect(countDungeonChests(null)).toBe(0);
        expect(countDungeonChests({})).toBe(0);
    });
});

describe('asking the zone which item is the chest', () => {
    const zone = (rewardDropTable) => ({ combatZoneInfo: { dungeonInfo: { rewardDropTable } } });

    test('the guaranteed reward is the chest', () => {
        // Which is the same test the simulator applies when it multiplies a
        // reward by the chests a completion pays rather than by its drop rate
        const items = dungeonChestItems(
            zone([
                { itemHrid: '/items/chimerical_chest', dropRate: 1 },
                { itemHrid: '/items/task_token', dropRate: 0.05 },
            ])
        );

        expect([...items]).toEqual(['/items/chimerical_chest']);
    });

    test('a reward the difficulty tier makes certain counts too', () => {
        const table = [
            { itemHrid: '/items/pirate_chest', dropRate: 1 },
            { itemHrid: '/items/bonus_box', dropRate: 0.5, dropRatePerDifficultyTier: 0.25 },
        ];

        expect(dungeonChestItems(zone(table), 0).has('/items/bonus_box')).toBe(false);
        expect(dungeonChestItems(zone(table), 2).has('/items/bonus_box')).toBe(true);
    });

    test('with no zone data it falls back to the known chests', () => {
        // Better a stale list than counting nothing, and a dungeon whose data
        // has not loaded is a dungeon whose chests still landed
        expect(dungeonChestItems(null).has('/items/sinister_chest')).toBe(true);
        expect(
            dungeonChestItems(zone([{ itemHrid: '/items/coin', dropRate: 0.1 }])).has('/items/enchanted_chest')
        ).toBe(true);
    });
});
