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
    isRefinementChest,
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

    test('a level gap cuts it, and a mean below one becomes a chance', () => {
        // One chest each at a 90% penalty is 0.1, and a tenth of a chest is not
        // something the game can hand over — so nine completions in ten pay
        // nothing and the tenth pays one. That is what being level-gapped looks
        // like from the inside: not always zero, just usually.
        expect(chestsPerCompletion({ partySize: 5, levelGap: -0.9 })).toBeCloseTo(0.1, 10);
        expect(chestsPerCompletion({ partySize: 1, levelGap: -0.5 })).toBeCloseTo(2.5, 10);
    });

    test('an unknown gap is not a penalty, and a nonsense one cannot go negative', () => {
        expect(chestsPerCompletion({ partySize: 5, levelGap: null })).toBe(1);
        expect(chestsPerCompletion({ partySize: 5, levelGap: -4 })).toBe(0);
        // Being above the party is not a bonus
        expect(chestsPerCompletion({ partySize: 5, levelGap: 3 })).toBe(1);
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

    test('a gapped character is placed among the runs they could have had', () => {
        // Mean 0.1, so nothing is guaranteed and every chest is an extra. Two in
        // ten is a shade above par; none in thirty is a genuinely bad run and
        // reads as one rather than as the model being wrong.
        const gapped = 0.1;

        expect(chestLuck({ completions: 10, chests: 2, mean: gapped }).expected).toBeCloseTo(1, 10);
        expect(chestLuck({ completions: 10, chests: 2, mean: gapped }).percentile).toBeGreaterThan(0.9);
        expect(chestLuck({ completions: 30, chests: 0, mean: gapped }).percentile).toBeLessThan(0.06);
    });

    test('a chest seen before its completion does not go negative', () => {
        // Mid-run the loot can be ahead of the count, and a negative extras is
        // not a percentile
        expect(chestLuck({ completions: 1, chests: 0, mean }).percentile).toBeGreaterThanOrEqual(0);
    });
});

describe('counting completions by watching the chests', () => {
    test('a session already under way keeps its chests', () => {
        // `totalLootMap` is the session's loot, not the character's inventory,
        // and the server re-sends all of it after a refresh. Treating the first
        // sighting as a baseline threw the whole session away every reload.
        const tally = noteChestCount(newChestTally(), 63);

        expect(tally.chests).toBe(63);
        // What a count alone cannot say is how many runs produced them
        expect(tally.completions).toBe(0);
        expect(tally.unwatched).toBe(63);
    });

    test('a rise is one completion paying what it rose by', () => {
        let tally = newChestTally();
        tally = noteChestCount(tally, 0);
        tally = noteChestCount(tally, 1);
        tally = noteChestCount(tally, 3);

        expect(tally.completions).toBe(2);
        expect(tally.chests).toBe(3);
        expect(tally.watchedChests).toBe(3);
        expect(tally.byPayout).toEqual({ 1: 1, 2: 1 });
    });

    test('chests seen arriving are kept apart from chests already there', () => {
        // So a percentile can be computed over the part that has completions to
        // go with it, while the tile still shows the session's real total
        let tally = newChestTally();
        tally = noteChestCount(tally, 63);
        tally = noteChestCount(tally, 65);

        expect(tally.chests).toBe(65);
        expect(tally.watchedChests).toBe(2);
        expect(tally.completions).toBe(1);
    });

    test('a count that has not moved is not a completion', () => {
        // Which is most ticks, since the loot is reported constantly
        let tally = newChestTally();
        for (const count of [4, 4, 4, 4]) tally = noteChestCount(tally, count);

        expect(tally.completions).toBe(0);
    });

    test('a fall is a new session, not a run un-completing', () => {
        // Session loot only ever grows, so a drop means the action restarted.
        // The caller resets on that; nothing is counted in the meantime.
        let tally = newChestTally();
        tally = noteChestCount(tally, 10);
        tally = noteChestCount(tally, 2);

        expect(tally.completions).toBe(0);
        expect(tally.chests).toBe(2);
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

describe('refinement chests are not completions', () => {
    test('they are not counted as the chest a completion pays', () => {
        // A refinement chest takes a chest key to open like any other, and no
        // entry key at all, because it is not the per-completion payout.
        // Counting one would invent a run that never happened.
        const loot = {
            a: { itemHrid: '/items/chimerical_chest', count: 3 },
            b: { itemHrid: '/items/chimerical_refinement_chest', count: 4 },
        };

        expect(countDungeonChests(loot)).toBe(3);
    });

    test('and the zone cannot volunteer one either', () => {
        const zone = {
            combatZoneInfo: {
                dungeonInfo: {
                    rewardDropTable: [
                        { itemHrid: '/items/pirate_chest', dropRate: 1 },
                        { itemHrid: '/items/pirate_refinement_chest', dropRate: 1 },
                    ],
                },
            },
        };

        expect([...dungeonChestItems(zone)]).toEqual(['/items/pirate_chest']);
    });

    test('matched by name, so a dungeon added later needs no list edit', () => {
        expect(isRefinementChest('/items/newly_added_refinement_chest')).toBe(true);
        expect(isRefinementChest('/items/newly_added_chest')).toBe(false);
        expect(isRefinementChest(null)).toBe(false);
    });
});
