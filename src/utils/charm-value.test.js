import { describe, test, expect } from 'vitest';
import {
    charmTier,
    charmValue,
    rankCharms,
    upgradeValue,
    charmFocus,
    charmFamily,
    charmDisplayName,
    experiencePerMillion,
    splitByUpgrade,
    sortCharmRows,
    shopPrice,
    CHARM_TIER_EXPERIENCE,
} from './charm-value.js';

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

describe('charmFocus', () => {
    test('the part of the name that is not the tier', () => {
        expect(charmFocus('/items/expert_melee_charm')).toBe('melee');
        expect(charmFocus('/items/grandmaster_ranged_charm')).toBe('ranged');
    });

    test('a two-word focus stays whole', () => {
        expect(charmFocus('/items/basic_task_speed_charm')).toBe('task_speed');
    });

    test('anything that is not a charm is nothing', () => {
        expect(charmFocus('/items/cheese_sword')).toBeNull();
        expect(charmFocus(null)).toBeNull();
    });
});

describe('charmFamily', () => {
    test('every tier of the same focus, lowest first', () => {
        // The comparison worth making: a melee charm and a brewing charm are
        // not alternatives to each other
        expect(charmFamily('/items/expert_melee_charm')).toEqual([
            '/items/trainee_melee_charm',
            '/items/basic_melee_charm',
            '/items/advanced_melee_charm',
            '/items/expert_melee_charm',
            '/items/master_melee_charm',
            '/items/grandmaster_melee_charm',
        ]);
    });

    test('any member of the family finds the same family', () => {
        expect(charmFamily('/items/trainee_melee_charm')).toEqual(charmFamily('/items/grandmaster_melee_charm'));
    });

    test('nothing equipped is no family rather than every charm', () => {
        expect(charmFamily(undefined)).toEqual([]);
        expect(charmFamily('/items/cheese_sword')).toEqual([]);
    });
});

describe('charmDisplayName', () => {
    test('focus first, tier in brackets', () => {
        expect(charmDisplayName('/items/expert_melee_charm')).toBe('Melee (Expert)');
        expect(charmDisplayName('/items/basic_task_speed_charm')).toBe('Task Speed (Basic)');
    });

    test('something it cannot read comes back unchanged rather than as blank', () => {
        expect(charmDisplayName('/items/cheese_sword')).toBe('/items/cheese_sword');
    });
});

describe('experiencePerMillion', () => {
    test('a number a column can show', () => {
        // Per coin this is 0.000000052, which nobody can compare at a glance
        expect(experiencePerMillion(8, 155_000_000)).toBeCloseTo(0.0516, 4);
    });

    test('unpriced is nothing, which must not sort above a number', () => {
        expect(experiencePerMillion(8, 0)).toBeNull();
        expect(experiencePerMillion(0, 100)).toBeNull();
    });
});

describe('splitByUpgrade', () => {
    const rows = [
        { name: 'a', experience: 12.8 },
        { name: 'b', experience: 8 },
        { name: 'c', experience: 5 },
    ];

    test('equal counts as an upgrade', () => {
        // The same bonus for less money is the trade people are looking for
        const { upgrades, downgrades } = splitByUpgrade(rows, 8);
        expect(upgrades.map((row) => row.name)).toEqual(['a', 'b']);
        expect(downgrades.map((row) => row.name)).toEqual(['c']);
    });

    test('an empty slot makes everything an upgrade', () => {
        expect(splitByUpgrade(rows, 0).upgrades).toHaveLength(3);
    });
});

describe('sortCharmRows', () => {
    const rows = [
        { tier: 'master', enhancementLevel: 3, experience: 8.64, price: 240, experiencePerMillion: 0.036 },
        { tier: 'expert', enhancementLevel: 5, experience: 8, price: 155, experiencePerMillion: 0.052 },
        { tier: 'grandmaster', enhancementLevel: 0, experience: 8, price: 500, experiencePerMillion: 0.016 },
        { tier: 'basic', enhancementLevel: 0, experience: 2, price: 0, experiencePerMillion: null },
    ];

    test('by value per million, best first', () => {
        expect(sortCharmRows(rows, 'perMillion', 'desc').map((row) => row.tier)).toEqual([
            'expert',
            'master',
            'grandmaster',
            'basic',
        ]);
    });

    test('by name means by tier and then enhancement, not alphabetically', () => {
        // Alphabetical puts Advanced above Basic above Expert, which is not the
        // order the charms come in
        expect(sortCharmRows(rows, 'name', 'asc').map((row) => row.tier)).toEqual([
            'basic',
            'expert',
            'master',
            'grandmaster',
        ]);
    });

    test('unpriced sorts last whichever way the column points', () => {
        expect(sortCharmRows(rows, 'perMillion', 'asc')[3].tier).toBe('basic');
        expect(sortCharmRows(rows, 'price', 'desc')[3].tier).toBe('basic');
    });

    test('it does not modify the array it was given', () => {
        sortCharmRows(rows, 'price', 'asc');
        expect(rows[0].tier).toBe('master');
    });
});

describe('shopPrice', () => {
    test('the trainee charm has a price even with no listings', () => {
        // The vendor stocks it at a fixed price, so it is not unpriced — and it
        // is the floor every other tier's value per coin is judged against
        expect(shopPrice('/items/trainee_melee_charm')).toBe(250_000);
    });

    test('an enhanced trainee is enhancement work, priced by the market', () => {
        expect(shopPrice('/items/trainee_melee_charm', 5)).toBe(0);
    });

    test('every other tier with no listings is genuinely unpriced', () => {
        // Calling it free would put it top of a value-per-coin ranking
        expect(shopPrice('/items/master_melee_charm')).toBe(0);
        expect(shopPrice('/items/grandmaster_melee_charm')).toBe(0);
    });
});
