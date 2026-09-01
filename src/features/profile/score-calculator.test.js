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
    workerResults: null,
    askPrices: {},
    books: {},
}));

vi.mock('../../utils/ability-cost-calculator.js', () => ({
    explainAbilityCost: () => ({ books: 0, bookPrice: null, total: null }),
}));
vi.mock('../../utils/house-cost-calculator.js', () => ({
    calculateBattleHousesCost: () => ({ totalCost: 0, breakdown: [] }),
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => mocks.clientData } }));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => mocks.enhancingParams }));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => mocks.askPrices[hrid] ?? 0,
    getItemPrices: (hrid) => mocks.books[hrid] ?? null,
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: (key) => mocks.settings[key] ?? null } }));
vi.mock('../../utils/enhancement-worker-manager.js', () => ({
    // Records what the worker would have been asked to run — the parity the
    // blessed-tea test below pins — and answers "unpriced" for every task
    calculateEnhancementBatch: async (tasks) => {
        mocks.workerTasks.push(...tasks);
        return tasks.map(() => mocks.workerResults);
    },
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    getCheapestProtectionPrice: () => ({ price: 0 }),
    // The mirror is priced out of reach so the mirror optimisation never wins:
    // the material-cost tests below are about the per-attempt material bill and
    // nothing else.
    getRealisticBaseItemPrice: (hrid) => (hrid === '/items/philosophers_mirror' ? 1e12 : 0),
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
    mocks.workerResults = null;
    mocks.askPrices = {};
    mocks.books = {};
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

describe('equipment the market cannot price', () => {
    /**
     * A profile wearing one thing, with nothing else on it.
     * @param {Object} item - `{itemHrid, enhancementLevel}`
     * @returns {Object} profileData
     */
    function profileWearing(item) {
        return {
            profile: {
                equippedAbilities: [],
                wearableItemMap: { '/item_locations/main_hand': item },
            },
        };
    }

    test('an unpriceable piece is named as unpriced rather than dropped from the breakdown', async () => {
        // Nothing prices it: no ask, no recipe, no shop line, no token table. The
        // old calculator added zero and then dropped the row for formatting to
        // "0.0", so an equipped item vanished and the total read as complete.
        mocks.clientData.itemDetailMap['/items/mystery_blade'] = { name: 'Mystery Blade', equipmentDetail: {} };

        const score = await calculateCombatScore(
            profileWearing({ itemHrid: '/items/mystery_blade', enhancementLevel: 0 })
        );

        expect(score.equipment).toBe(0);
        expect(score.equipmentUnpriced).toBe(1);
        const row = score.breakdown.equipment.find((entry) => entry.name === 'Mystery Blade');
        expect(row).toBeTruthy();
        expect(row.value).toBe('no price');
        expect(row.unpriced).toBe(true);
    });

    test('a priced piece worth less than 0.05M is still left out, and is not called unpriced', async () => {
        mocks.clientData.itemDetailMap['/items/cheap_dagger'] = { name: 'Cheap Dagger', equipmentDetail: {} };
        mocks.askPrices['/items/cheap_dagger'] = 40_000;

        const score = await calculateCombatScore(
            profileWearing({ itemHrid: '/items/cheap_dagger', enhancementLevel: 0 })
        );

        expect(score.equipment).toBeCloseTo(40_000 / 1_000_000, 10);
        expect(score.equipmentUnpriced).toBe(0);
        expect(score.breakdown.equipment).toEqual([]);
    });
});

describe('enhancement material pricing', () => {
    // Audit round 30: `getItemPrices` reports a missing side of the book as
    // `null`, never as a negative, so the calculator's `< 0` normalisation never
    // fired. A material with bids but no sellers left `price` at null, and
    // `null * count` costed it at nothing — a charm nobody was selling was free.
    /**
     * Score one +2 piece whose only enhancement material has the given book.
     * @param {Object|null} book - What `getItemPrices` answers for the charm
     * @returns {Promise<number>} The combat equipment score
     */
    async function scoreWithCharmBook(book) {
        mocks.books = { '/items/rare_charm': book };
        mocks.workerResults = { attempts: 10, protectionCount: 0 };
        mocks.clientData.itemDetailMap['/items/big_axe'] = {
            name: 'Big Axe',
            itemLevel: 60,
            equipmentDetail: {},
            enhancementCosts: [{ itemHrid: '/items/rare_charm', count: 2 }],
        };

        const score = await calculateCombatScore({
            profile: {
                equippedAbilities: [],
                wearableItemMap: { '/item_locations/main_hand': { itemHrid: '/items/big_axe', enhancementLevel: 2 } },
            },
        });
        return score.equipment;
    }

    test('a book with only bids costs what the bids say, not nothing', async () => {
        // 2 charms per attempt × 10 expected attempts × 3 coins
        expect(await scoreWithCharmBook({ ask: null, bid: 3 })).toBeCloseTo(60 / 1_000_000, 12);
    });

    test('a two-sided book is costed at the ask — replacing the material is a purchase', async () => {
        expect(await scoreWithCharmBook({ ask: 5, bid: 3 })).toBeCloseTo(100 / 1_000_000, 12);
    });

    test('no book at all falls back to the sell price, as it always did', async () => {
        mocks.clientData.itemDetailMap['/items/rare_charm'] = { sellPrice: 7 };
        expect(await scoreWithCharmBook(null)).toBeCloseTo(140 / 1_000_000, 12);
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

describe('a shrine cost nothing could price', () => {
    const UNPRICED_CREDIT = '/items/guild_credit_9';

    beforeEach(() => {
        // One level paid partly in a credit type with no conversion to gold —
        // `priceGuildCreditCosts` reports that line as `gold: null`
        mocks.clientData.guildBuffDetailMap['/guild_buffs/force_combat'].levelCosts = {
            1: {
                guildTokenCost: 10,
                creditCosts: [
                    { itemHrid: CREDIT, count: 10 },
                    { itemHrid: UNPRICED_CREDIT, count: 5 },
                ],
            },
        };
    });

    test('the priced side still counts, so one missing rate does not blank the shrine', async () => {
        const score = await calculateCombatScore(profileWithShrines({ '/guild_buffs/force_combat': 1 }));

        expect(score.guildShrine).toBeCloseTo(7_500 / 1_000_000, 10);
    });

    test('what could not be priced is counted, not silently dropped', async () => {
        const score = await calculateCombatScore(profileWithShrines({ '/guild_buffs/force_combat': 1 }));

        // The figure is short by whatever those five credits are worth. Reporting
        // it as complete is the same failure an unpriced gear piece already
        // refuses to make.
        expect(score.guildShrineUnpricedCredits).toBe(1);
        expect(score.guildShrineCombatUnpricedCredits).toBe(1);
        expect(score.skillerGuildShrineUnpricedCredits).toBe(0);
        expect(score.breakdown.guildShrinesCombat[0]).toMatchObject({ unpricedCredits: 1, partial: true });
    });

    test('a shrine every credit of which could be priced is not flagged', async () => {
        const score = await calculateCombatScore(profileWithShrines({ '/guild_buffs/scholar_skilling': 1 }));

        expect(score.guildShrineUnpricedCredits).toBe(0);
        expect(score.skillerBreakdown.guildShrines[0]).toMatchObject({ unpricedCredits: 0, partial: false });
    });
});
