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
    settings: {},
    enhancingParams: { teas: {} },
    workerTasks: [],
    workerResults: null,
    // The pricing options every input was priced with, to prove a side is named
    pricingOptions: [],
    askPrices: {},
    books: {},
    mirrorCalls: [],
    basePrices: {},
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
// The shared enhancement input rule: the base item costs one coin and the mirror is priced out of reach
// so the mirror optimization never wins; the material tests below are about the per-attempt bill, which
// reads the book the test sets (the ask, else the bid, else unpriced - never the vendor price)
vi.mock('../../utils/enhancement-input-pricing.js', () => ({
    priceBase: (hrid, options) => {
        mocks.pricingOptions.push(options);
        return { price: mocks.basePrices[hrid] ?? 1, unpriced: false, estimated: false };
    },
    priceMirror: (options) => {
        mocks.pricingOptions.push(options);
        return { price: 1e12, unpriced: false, estimated: false };
    },
    priceProtection: (_hrid, options) => {
        mocks.pricingOptions.push(options);
        return { price: null, itemHrid: null, unpriced: true, estimated: false };
    },
    perAttemptMaterialCost: (details, options) => {
        mocks.pricingOptions.push(options);
        let cost = 0;
        let hasMissingPrices = false;
        let hasPartialPrices = false;
        for (const material of details.enhancementCosts || []) {
            const book = mocks.books[material.itemHrid];
            if (book?.partial) hasPartialPrices = true;
            const price = book?.ask > 0 ? book.ask : book?.bid > 0 ? book.bid : 0;
            if (price > 0) cost += price * material.count;
            else hasMissingPrices = true;
        }
        return { cost, hasCost: cost > 0, hasMissingPrices, hasPartialPrices };
    },
}));
vi.mock('../../utils/game-lookups.js', () => ({ getShopCoinOnlyCost: () => 0, getShopCoinCost: () => 0 }));
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

// A passthrough that records what the mirror sweep was asked, to pin that a refined piece forwards its copy lineage
vi.mock('../../utils/enhancement-calculator.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        applyMirrorOptimization: (...args) => {
            mocks.mirrorCalls.push(args.map((arg) => (Array.isArray(arg) ? [...arg] : arg)));
            return actual.applyMirrorOptimization(...args);
        },
    };
});

const { calculateCombatScore } = await import('./score-calculator.js');

const CREDIT = '/items/guild_credit_1';

beforeEach(() => {
    mocks.settings = {};
    mocks.enhancingParams = { teas: {} };
    mocks.workerTasks = [];
    mocks.workerResults = null;
    mocks.pricingOptions = [];
    mocks.askPrices = {};
    mocks.books = {};
    mocks.mirrorCalls = [];
    mocks.basePrices = {};
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

describe('crafting-cost fallback for a piece with no ask', () => {
    function worldWithRecipes() {
        const actionDetailMap = {};
        for (let i = 0; i < 300; i++) {
            actionDetailMap[`/actions/filler_${i}`] = { outputItems: [{ itemHrid: `/items/filler_${i}`, count: 1 }] };
        }
        // Earlier action has the blade as a SECOND output and prices to nothing (input nobody prices);
        // the scan must go on to the later action that does price it
        actionDetailMap['/actions/a_dud'] = {
            inputItems: [{ itemHrid: '/items/mystery_dust', count: 2 }],
            outputItems: [
                { itemHrid: '/items/other', count: 1 },
                { itemHrid: '/items/blade', count: 1 },
            ],
        };
        actionDetailMap['/actions/b_real'] = {
            inputItems: [
                { itemHrid: '/items/ingot', count: 4 },
                { itemHrid: '/items/mystery_dust', count: 1 },
            ],
            upgradeItemHrid: '/items/old_blade',
            outputItems: [{ itemHrid: '/items/blade', count: 2 }],
        };
        // the ingot has no ask either and is itself crafted (recursion), by two actions, the first priced 0
        actionDetailMap['/actions/c_ingot_dud'] = {
            inputItems: [],
            outputItems: [{ itemHrid: '/items/ingot', count: 1 }],
        };
        actionDetailMap['/actions/d_ingot'] = {
            inputItems: [{ itemHrid: '/items/ore', count: 5 }],
            outputItems: [{ itemHrid: '/items/ingot', count: 1 }],
        };
        mocks.clientData.actionDetailMap = actionDetailMap;
        mocks.clientData.itemDetailMap['/items/blade'] = { name: 'Blade', equipmentDetail: {} };
        mocks.askPrices['/items/ore'] = 10;
        mocks.askPrices['/items/old_blade'] = 1_000_000;
        return actionDetailMap;
    }

    const wearing = (...hrids) => ({
        profile: {
            equippedAbilities: [],
            wearableItemMap: Object.fromEntries(
                hrids.map((itemHrid, i) => [`/item_locations/slot_${i}`, { itemHrid, enhancementLevel: 0 }])
            ),
        },
    });

    test('prices from the first action that prices it, recursing into inputs, and does not rescan the map per piece', async () => {
        const map = worldWithRecipes();
        mocks.clientData.itemDetailMap['/items/blade2'] = { name: 'Blade Two', equipmentDetail: {} };
        const spy = vi.spyOn(Object, 'values');

        const score = await calculateCombatScore(wearing('/items/blade', '/items/blade2'));
        const scans = spy.mock.calls.filter((c) => c[0] === map).length;
        spy.mockRestore();

        // ingot = 5 ore * 10 * 0.9 = 45; blade = ((4 * 45 + 0) * 0.9 + 1,000,000) / 2
        const expected = (4 * 45 * 0.9 + 1_000_000) / 2;
        expect(score.equipment).toBeCloseTo(expected / 1_000_000, 10);
        expect(score.equipmentUnpriced).toBe(1); // blade2 has no recipe at all
        expect(scans).toBeLessThanOrEqual(1);
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
        expect(await scoreWithCharmBook({ ask: null, bid: 3 })).toBeCloseTo(61 / 1_000_000, 12);
    });

    test('a two-sided book is costed at the ask — replacing the material is a purchase', async () => {
        expect(await scoreWithCharmBook({ ask: 5, bid: 3 })).toBeCloseTo(101 / 1_000_000, 12);
    });

    test('a material priced from a craft with an unpriced input leaves the piece unpriced, not cheap', async () => {
        expect(await scoreWithCharmBook({ ask: 5, bid: 3, partial: true })).toBe(0);
    });

    test('no book at all leaves the piece unpriced - the vendor price is not a stand-in', async () => {
        mocks.clientData.itemDetailMap['/items/rare_charm'] = { sellPrice: 7 };
        expect(await scoreWithCharmBook(null)).toBe(0);
    });
});

describe('a score is priced at the ask, whoever is looking', () => {
    test('every enhancement input is priced with the mode forced to ask, never the viewer profit mode', async () => {
        mocks.books = { '/items/rare_charm': { ask: 5, bid: 3 } };
        mocks.workerResults = { attempts: 10, protectionCount: 2 };
        mocks.clientData.itemDetailMap['/items/big_axe'] = {
            name: 'Big Axe',
            itemLevel: 60,
            equipmentDetail: {},
            enhancementCosts: [{ itemHrid: '/items/rare_charm', count: 2 }],
        };
        await calculateCombatScore({
            profile: {
                equippedAbilities: [],
                wearableItemMap: { '/item_locations/main_hand': { itemHrid: '/items/big_axe', enhancementLevel: 4 } },
            },
        });

        expect(mocks.pricingOptions.length).toBeGreaterThan(0);
        for (const options of mocks.pricingOptions) expect(options).toEqual({ mode: 'ask' });
    });
});

describe('a refined piece is mirrored with plain copies', () => {
    const wearRefined = (hrid) => ({
        profile: {
            equippedAbilities: [],
            wearableItemMap: { '/item_locations/main_hand': { itemHrid: hrid, enhancementLevel: 14 } },
        },
    });

    test('the mirror sweep gets the copy lineage priced from the unrefined base', async () => {
        mocks.settings = { networth_highEnhancementUseCost: true, networth_highEnhancementMinLevel: 13 };
        mocks.workerResults = { attempts: 10, protectionCount: 0 };
        mocks.basePrices = { '/items/big_axe': 40, '/items/big_axe_refined': 900 };
        mocks.clientData.itemDetailMap['/items/big_axe'] = { itemLevel: 60, equipmentDetail: {} };
        mocks.clientData.itemDetailMap['/items/big_axe_refined'] = { itemLevel: 60, equipmentDetail: {} };

        await calculateCombatScore(wearRefined('/items/big_axe_refined'));

        expect(mocks.mirrorCalls.length).toBeGreaterThan(0);
        const [targetCosts, , , copyCosts] = mocks.mirrorCalls[0];
        expect(copyCosts).toHaveLength(targetCosts.length);
        expect(copyCosts[0]).toBe(40);
        expect(targetCosts[0]).toBe(900);
        // The lineage is the refined piece's enhancement bill on the cheap +0
        expect(copyCosts[3]).toBeCloseTo(targetCosts[3] - 900 + 40, 6);
    });

    test('a plain piece, or a refined one with no unrefined twin, sends no lineage', async () => {
        mocks.settings = { networth_highEnhancementUseCost: true, networth_highEnhancementMinLevel: 13 };
        mocks.workerResults = { attempts: 10, protectionCount: 0 };
        mocks.clientData.itemDetailMap['/items/big_axe'] = { itemLevel: 60, equipmentDetail: {} };
        mocks.clientData.itemDetailMap['/items/lone_refined'] = { itemLevel: 60, equipmentDetail: {} };

        await calculateCombatScore(wearRefined('/items/big_axe'));
        await calculateCombatScore(wearRefined('/items/lone_refined'));

        expect(mocks.mirrorCalls.length).toBeGreaterThan(1);
        for (const call of mocks.mirrorCalls) expect(call[3]).toBeNull();
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
