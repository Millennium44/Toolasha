/**
 * Tests for the guild shrine component of the build score.
 *
 * The rest of the score is priced from the marketplace and covered by the
 * modules that do that pricing. This part is arithmetic over a cost table —
 * every level bought so far, its credits valued at the cheapest conversion —
 * and it is only ever computed for your own character, which is the part most
 * worth pinning down: reading the current character's shrines while showing
 * somebody else's card would put your guild's investment on their score.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ clientData: null }));

vi.mock('../../utils/ability-cost-calculator.js', () => ({ calculateAbilityCost: () => 0 }));
vi.mock('../../utils/house-cost-calculator.js', () => ({
    calculateBattleHousesCost: () => ({ totalCost: 0, breakdown: [] }),
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => mocks.clientData } }));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({ teas: {} }) }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 0, getItemPrices: () => null }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => null } }));
vi.mock('../../utils/enhancement-worker-manager.js', () => ({ calculateEnhancementBatch: async () => [] }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    getCheapestProtectionPrice: () => ({ price: 0 }),
    getRealisticBaseItemPrice: () => 0,
}));
vi.mock('../../utils/game-lookups.js', () => ({ getShopCoinCost: () => 0 }));
vi.mock('../../utils/guild-credit-pricing.js', () => ({
    buildGoldPerCredit: () => ({ '/items/guild_credit_1': 750 }),
    priceGuildCreditCosts: (costs, { goldPerCredit }) => ({
        lines: (costs || []).map(({ itemHrid, count }) => {
            const each = goldPerCredit[itemHrid] ?? null;
            return { itemHrid, name: itemHrid, count, goldEach: each, gold: each === null ? null : each * count };
        }),
        total: null,
        unpriced: [],
    }),
}));

const { calculateCombatScore } = await import('./score-calculator.js');

const CREDIT = '/items/guild_credit_1';

beforeEach(() => {
    mocks.clientData = {
        itemDetailMap: {},
        guildBuffDetailMap: {
            '/guild_buffs/force_combat': {
                shrineHrid: '/guild_shrines/force',
                isCombat: true,
                levelCosts: {
                    1: { guildTokenCost: 10, creditCosts: [{ itemHrid: CREDIT, count: 10 }] },
                    2: { guildTokenCost: 20, creditCosts: [{ itemHrid: CREDIT, count: 20 }] },
                    3: { guildTokenCost: 30, creditCosts: [{ itemHrid: CREDIT, count: 40 }] },
                },
            },
            '/guild_buffs/scholar_skilling': {
                shrineHrid: '/guild_shrines/scholar',
                isCombat: false,
                levelCosts: { 1: { guildTokenCost: 5, creditCosts: [{ itemHrid: CREDIT, count: 4 }] } },
            },
        },
    };
});

/**
 * A profile payload carrying shrine levels, as `ownProfileData` assembles it.
 * @param {Object} levels - buffHrid → level
 * @returns {Object} profileData
 */
function profileWithShrines(levels) {
    const characterGuildBuffMap = {};
    for (const [hrid, level] of Object.entries(levels)) characterGuildBuffMap[hrid] = { guildBuffHrid: hrid, level };
    return { profile: { characterGuildBuffMap, equippedAbilities: [], wearableItemMap: {} } };
}

describe('guild shrine score', () => {
    test('sums the credits of every level bought so far, in millions', async () => {
        const score = await calculateCombatScore(profileWithShrines({ '/guild_buffs/force_combat': 2 }));

        // (10 + 20) credits at 750 each
        expect(score.guildShrine).toBeCloseTo(22_500 / 1_000_000, 10);
        expect(score.guildShrineTokens).toBe(30);
    });

    test('counts skilling shrines too — they were paid for the same way', async () => {
        const score = await calculateCombatScore(
            profileWithShrines({ '/guild_buffs/force_combat': 1, '/guild_buffs/scholar_skilling': 1 })
        );

        expect(score.guildShrine).toBeCloseTo((7500 + 3000) / 1_000_000, 10);
        expect(score.breakdown.guildShrines.map((row) => row.name)).toEqual(['Force 1', 'Scholar 1']);
    });

    test('stays out of the combat total, which has to mean the same thing on every card', async () => {
        const score = await calculateCombatScore(profileWithShrines({ '/guild_buffs/force_combat': 3 }));

        expect(score.guildShrine).toBeGreaterThan(0);
        expect(score.total).toBe(score.house + score.ability + score.equipment);
    });

    test('a profile without shrine levels scores none, rather than borrowing yours', async () => {
        const score = await calculateCombatScore({ profile: { equippedAbilities: [], wearableItemMap: {} } });

        expect(score.guildShrine).toBe(0);
        expect(score.breakdown.guildShrines).toEqual([]);
    });

    test('an unpurchased shrine contributes nothing', async () => {
        const score = await calculateCombatScore(profileWithShrines({ '/guild_buffs/force_combat': 0 }));

        expect(score.guildShrine).toBe(0);
        expect(score.breakdown.guildShrines).toEqual([]);
    });
});
