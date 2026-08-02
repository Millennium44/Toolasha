import { describe, test, expect } from 'vitest';
import { charmTier, charmValue, rankCharms, upgradeValue, CHARM_TIER_EXPERIENCE } from './charm-value.js';

/** A stand-in for the game's enhancement curve */
const multiplierOf = (level) => [1, 1.1, 1.21][level] ?? 1;

describe('charmTier', () => {
    test('reads the tier out of the name', () => {
        expect(charmTier('/items/expert_task_charm')).toBe('expert');
        expect(charmTier('/items/grandmaster_alchemy_charm')).toBe('grandmaster');
    });

    test('something that is not a charm has no tier', () => {
        expect(charmTier('/items/cheese')).toBeNull();
        expect(charmTier(null)).toBeNull();
    });

    test('every tier in the table is findable', () => {
        // A tier the table knows but the reader cannot spot would silently price
        // that whole class of charm at nothing
        for (const tier of Object.keys(CHARM_TIER_EXPERIENCE)) {
            expect(charmTier(`/items/${tier}_task_charm`)).toBe(tier);
        }
    });
});

describe('charmValue', () => {
    test('scales the tier bonus by the enhancement level', () => {
        const charm = charmValue({ itemHrid: '/items/expert_task_charm', enhancementLevel: 2, multiplierOf });
        expect(charm.experience).toBeCloseTo(5 * 1.21, 6);
    });

    test('the game’s own figure beats the reconstructed table', () => {
        // The table is a reconstruction; a number from the game is a fact
        const charm = charmValue({ itemHrid: '/items/expert_task_charm', experience: 99, multiplierOf });
        expect(charm.experience).toBe(99);
    });

    test('experience per coin is the thing worth ranking on', () => {
        const charm = charmValue({ itemHrid: '/items/basic_task_charm', price: 1000, multiplierOf });
        expect(charm.experiencePerCoin).toBeCloseTo(2 / 1000, 9);
    });

    test('an unpriced charm has no ratio rather than an infinite one', () => {
        expect(charmValue({ itemHrid: '/items/basic_task_charm', multiplierOf }).experiencePerCoin).toBeNull();
    });

    test('something that is not a charm is not valued', () => {
        expect(charmValue({ itemHrid: '/items/cheese', price: 10 })).toBeNull();
    });
});

describe('rankCharms', () => {
    const charms = [
        charmValue({ itemHrid: '/items/grandmaster_task_charm', price: 10_000_000, multiplierOf }),
        charmValue({ itemHrid: '/items/basic_task_charm', price: 1000, multiplierOf }),
        charmValue({ itemHrid: '/items/master_task_charm', multiplierOf }),
    ];

    test('best value first, not biggest bonus', () => {
        // Ranking by bonus recommends the grandmaster every time, which is true
        // and useless
        expect(rankCharms(charms)[0].tier).toBe('basic');
    });

    test('an unpriced charm cannot sort above a priced one', () => {
        expect(rankCharms(charms)[rankCharms(charms).length - 1].tier).toBe('master');
    });

    test('it does not modify the array it was given', () => {
        rankCharms(charms);
        expect(charms[0].tier).toBe('grandmaster');
    });
});

describe('upgradeValue', () => {
    const expert = charmValue({ itemHrid: '/items/expert_task_charm', price: 500, multiplierOf });
    const master = charmValue({ itemHrid: '/items/master_task_charm', price: 1000, multiplierOf });

    test('an upgrade buys the difference, not the whole bonus', () => {
        // Paying for 6.5 when the swap buys 1.5 is how people overpay
        expect(upgradeValue(master, expert).gain).toBeCloseTo(1.5, 6);
    });

    test('an empty slot buys the whole thing', () => {
        expect(upgradeValue(master, null).gain).toBeCloseTo(6.5, 6);
    });

    test('a sidegrade or downgrade has no value per coin', () => {
        expect(upgradeValue(expert, master).gainPerCoin).toBeNull();
        expect(upgradeValue(expert, expert).gainPerCoin).toBeNull();
    });
});
