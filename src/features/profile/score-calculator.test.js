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

const mocks = vi.hoisted(() => ({
    clientData: null,
    patchLive: true,
    settings: {},
    enhancingParams: { teas: {} },
    workerTasks: [],
}));

vi.mock('../../utils/ability-cost-calculator.js', () => ({
    explainAbilityCost: () => ({ books: 0, bookPrice: null, total: null }),
}));
vi.mock('../../utils/house-cost-calculator.js', () => ({
    calculateBattleHousesCost: () => ({ totalCost: 0, breakdown: [] }),
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => mocks.clientData } }));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => mocks.enhancingParams }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 0, getItemPrices: () => null }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: (key) => mocks.settings[key] ?? null } }));
vi.mock('../../utils/enhancement-worker-manager.js', () => ({
    // Records what the worker would have been asked to run — the parity the
    // blessed-tea test below pins — and answers "unpriced" for every task
    calculateEnhancementBatch: async (tasks) => {
        mocks.workerTasks.push(...tasks);
        return tasks.map(() => null);
    },
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    getCheapestProtectionPrice: () => ({ price: 0 }),
    getRealisticBaseItemPrice: () => 0,
}));
vi.mock('../../utils/game-lookups.js', () => ({ getShopCoinCost: () => 0 }));
// The shrine fold into the total is gated on the marketplace patch being live.
// Default the gate on, so the folding assertions test the patched behaviour; a
// single test flips it off to pin the pre-patch (comparable-score) rule.
vi.mock('../../utils/server-gate.js', () => ({ isMarketplacePatchLive: () => mocks.patchLive }));
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
    mocks.patchLive = true;
    mocks.settings = {};
    mocks.enhancingParams = { teas: {} };
    mocks.workerTasks = [];
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

    test('folds into the combat and skiller totals, the same as house and gear', async () => {
        const score = await calculateCombatScore(
            profileWithShrines({ '/guild_buffs/force_combat': 3, '/guild_buffs/scholar_skilling': 1 })
        );

        expect(score.guildShrineCombat).toBeGreaterThan(0);
        expect(score.total).toBeCloseTo(score.house + score.ability + score.equipment + score.guildShrineCombat, 10);
        expect(score.skillerTotal).toBeCloseTo(score.skillerEquipment + score.skillerGuildShrine, 10);
    });

    test('before the patch is live everywhere, the shrine stays out of the total', async () => {
        // Gated on the server: on live (pre-patch) shrines are known only for your
        // own character, so they are kept on their own line and the total stays
        // comparable with everyone else's card.
        mocks.patchLive = false;
        const score = await calculateCombatScore(
            profileWithShrines({ '/guild_buffs/force_combat': 3, '/guild_buffs/scholar_skilling': 1 })
        );

        expect(score.guildShrineCombat).toBeGreaterThan(0); // still computed and shown
        expect(score.total).toBeCloseTo(score.house + score.ability + score.equipment, 10);
        expect(score.skillerTotal).toBeCloseTo(score.skillerEquipment, 10);
    });

    test("reads a shared profile's guildBuffLevelMap (bare-number levels) the same as your own map", async () => {
        // The game now exposes other players' shrine levels on their profile as
        // { buffHrid: level }, not { buffHrid: { level } }. Both must score.
        const score = await calculateCombatScore({
            profile: {
                guildBuffLevelMap: { '/guild_buffs/force_combat': 2 },
                equippedAbilities: [],
                wearableItemMap: {},
            },
        });

        expect(score.guildShrineKnown).toBe(true);
        expect(score.guildShrineCombat).toBeCloseTo(22_500 / 1_000_000, 10);
        expect(score.total).toBeCloseTo(score.house + score.ability + score.equipment + score.guildShrineCombat, 10);
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

    describe('combat and skilling are scored apart', () => {
        test('each shrine lands in the bucket its isCombat flag names', async () => {
            const score = await calculateCombatScore(
                profileWithShrines({ '/guild_buffs/force_combat': 2, '/guild_buffs/scholar_skilling': 1 })
            );

            // Force levels 1+2 = 30 credits at 750; Scholar level 1 = 4 credits
            expect(score.guildShrineCombat).toBeCloseTo(22_500 / 1_000_000, 10);
            expect(score.guildShrineCombatTokens).toBe(30);
            expect(score.skillerGuildShrine).toBeCloseTo(3000 / 1_000_000, 10);
            expect(score.skillerGuildShrineTokens).toBe(5);
            expect(score.guildShrine).toBeCloseTo(score.guildShrineCombat + score.skillerGuildShrine, 10);
        });

        test('each breakdown carries only its own shrines', async () => {
            const score = await calculateCombatScore(
                profileWithShrines({ '/guild_buffs/force_combat': 1, '/guild_buffs/scholar_skilling': 1 })
            );

            expect(score.breakdown.guildShrinesCombat.map((row) => row.name)).toEqual(['Force 1']);
            expect(score.skillerBreakdown.guildShrines.map((row) => row.name)).toEqual(['Scholar 1']);
        });
    });

    describe('knowing versus having none', () => {
        test('a payload carrying levels is known', async () => {
            const score = await calculateCombatScore(profileWithShrines({ '/guild_buffs/force_combat': 1 }));
            expect(score.guildShrineKnown).toBe(true);
        });

        test("another player's profile is not, so no line can be drawn", async () => {
            const score = await calculateCombatScore({ profile: { equippedAbilities: [], wearableItemMap: {} } });

            expect(score.guildShrineKnown).toBe(false);
            expect(score.guildShrineCombat).toBe(0);
            expect(score.skillerGuildShrine).toBe(0);
            expect(score.breakdown.guildShrinesCombat).toEqual([]);
            expect(score.skillerBreakdown.guildShrines).toEqual([]);
        });

        test('an empty map is the same as no map — guild traffic has not arrived', async () => {
            const score = await calculateCombatScore({
                profile: { characterGuildBuffMap: {}, equippedAbilities: [], wearableItemMap: {} },
            });

            expect(score.guildShrineKnown).toBe(false);
        });

        test('the levels being all zero is a real reading, not an absent one', async () => {
            const score = await calculateCombatScore(profileWithShrines({ '/guild_buffs/force_combat': 0 }));

            expect(score.guildShrineKnown).toBe(true);
            expect(score.guildShrineCombat).toBe(0);
        });
    });
});

describe('enhancement worker task parity', () => {
    // The worker's chain defaults blessedTeaBonus to the stock 1% when the task omits it, while
    // every main-thread sweep (tooltip, savings card) forwards the live double-jump chance read
    // from item data. Audit round 24 found the score calculator's tasks dropping the field, so a
    // profile score and a tooltip could price the same +14 piece from two different chains.
    test('worker tasks carry the live blessed tea chance, not the stock default', async () => {
        mocks.settings = { networth_highEnhancementUseCost: true, networth_highEnhancementMinLevel: 13 };
        mocks.enhancingParams = {
            enhancingLevel: 120,
            toolBonus: 5,
            speedBonus: 10,
            guzzlingBonus: 1.12,
            blessedTeaBonus: 0.011,
            teas: { blessed: true },
        };
        mocks.clientData.itemDetailMap['/items/big_axe'] = { itemLevel: 60, equipmentDetail: {} };

        await calculateCombatScore({
            profile: {
                equippedAbilities: [],
                wearableItemMap: {
                    '/item_locations/main_hand': { itemHrid: '/items/big_axe', enhancementLevel: 14 },
                },
            },
        });

        expect(mocks.workerTasks.length).toBeGreaterThan(0);
        for (const task of mocks.workerTasks) {
            expect(task.blessedTea).toBe(true);
            expect(task.guzzlingBonus).toBe(1.12);
            expect(task.blessedTeaBonus).toBe(0.011);
        }
    });
});
