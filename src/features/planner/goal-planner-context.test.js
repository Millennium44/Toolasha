/**
 * The join between the game and the planner, tested at the join.
 *
 * `goal-planner.test.js` covers what the planner decides given rates;
 * `alchemy-rankings.test.js` and `combat-rates.test.js` cover what each
 * provider says. What is left — and what nothing else can catch — is the
 * *wiring*: that four sources of income end up in one ranked list, that a
 * provider with nothing to say leaves a note rather than a silence, and that
 * adding alchemy and combat did not quietly corrupt the per-action gold map the
 * experience rates read.
 *
 * Every calculator is mocked. This file is about plumbing, and a plumbing test
 * that also runs the profit calculators is a slow test of somebody else's file.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    actionDetailMap: {},
    skills: [],
    inventory: [],
    itemDetailMap: {},
    drinkSlots: {},
    levelExperienceTable: null,
}));

const loadout = vi.hoisted(() => ({ drinks: null, equipment: null }));

const rates = vi.hoisted(() => ({
    gathering: {},
    production: {},
    alchemy: [],
    combat: { rates: [], best: null, status: { note: null } },
    /** What each mocked provider was asked, so a test can see it was asked once */
    alchemyCalls: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            actionDetailMap: game.actionDetailMap,
            itemDetailMap: game.itemDetailMap,
            levelExperienceTable: game.levelExperienceTable || [0, 1, 2],
        }),
        getItemDetails: () => null,
        getActionDetails: (hrid) => game.actionDetailMap[hrid] || null,
        getSkills: () => game.skills,
        getEquipment: () => new Map(),
        getInventory: () => game.inventory,
        getHouseRoomLevel: () => 0,
        getActionDrinkSlots: (actionType) => game.drinkSlots[actionType] || [],
    },
}));
// The saved-loadout store resolveActionContext consults; null = no saved loadout
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: {
        getSnapshotDrinksForSkill: () => loadout.drinks,
        getSnapshotForSkill: () => loadout.equipment,
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: async () => {}, lastFetchTimestamp: 12345 },
}));
vi.mock('../actions/gathering-profit.js', () => ({
    calculateGatheringProfit: async (hrid) => rates.gathering[hrid] || null,
}));
vi.mock('../actions/production-profit.js', () => ({
    calculateProductionProfit: async (hrid) => rates.production[hrid] || null,
}));
vi.mock('../alchemy/alchemy-rankings.js', () => ({
    alchemyGoldRates: (options) => {
        rates.alchemyCalls.push(options);
        return rates.alchemy;
    },
}));
vi.mock('./combat-rates.js', () => ({ loadCombatRates: async () => rates.combat }));
const liquidity = vi.hoisted(() => ({ measured: true, throttle: {} }));
// Bounding rates by market volume reaches a third-party history server, and what
// this file is about is which rates get ranked, not how fast they sell. The
// liquidity bound has its own tests; here it passes everything through and says
// it measured, so the "not being checked" note stays out of the note assertions.
vi.mock('./market-liquidity.js', () => ({
    // A test can thin an item's book with `liquidity.throttle[itemHrid] = share`; absent = unmeasured
    applyLiquidityLimits: async (rates) => ({
        rates: rates.map((rate) => {
            const share = Math.min(1, ...(rate.sells || []).map((sold) => liquidity.throttle[sold.itemHrid] ?? 1));
            return share < 1 ? { ...rate, goldPerHour: rate.goldPerHour * share } : rate;
        }),
        measured: liquidity.measured,
    }),
}));
vi.mock('../crafting-plan/crafting-plan-calculator.js', () => ({ computeBestCraftingPlan: () => null }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    calculateEnhancementPath: () => null,
    getProductionChainTime: () => 0,
    getCheapestProtectionPrice: () => null,
    getEnhancementMaterialPrice: () => 0,
}));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateSuccessXP: () => 0, calculateFailureXP: () => 0 }));
vi.mock('../enhancement/enhancement-params-source.js', () => ({
    getTooltipEnhancementParams: () => ({ enhancingLevel: 1, houseLevel: 0 }),
    describeEnhancementSource: () => ({ kind: 'own', detail: '' }),
}));
vi.mock('../../utils/house-cost-calculator.js', () => ({
    initialize: async () => {},
    calculateCumulativeCost: async () => null,
    getItemName: () => '',
}));
vi.mock('../../utils/enhancement-calculator.js', () => ({
    calculateEnhancement: () => null,
    blessedMirrorChance: () => 0,
    mirrorLandingOdds: (usedMirror) => usedMirror.map(() => 1),
}));
vi.mock('../../utils/experience-calculator.js', () => ({
    calculateExpPerHour: () => ({
        expPerHour: 1000,
        modifiedXP: 10,
        actionTime: 10,
        totalEfficiency: 0,
        actionsPerHour: 360,
    }),
    // A flat climb: 100 completions of 10 s each, whatever the levels
    calculateMultiLevelProgress: () => ({ actionsNeeded: 360, timeNeeded: 3600 }),
}));
vi.mock('../../utils/market-data.js', () => ({ getPriceAgeString: () => 'a moment ago' }));

/**
 * The reservation ledger, doubled at the seam the context uses it through.
 * `utils/inventory-reservations.test.js` owns the arithmetic; what matters here
 * is that the context passes the asking goal's own owner id, so a goal is never
 * deducted from itself.
 */
const reservations = vi.hoisted(() => ({ claims: {}, calls: [] }));
vi.mock('../../utils/inventory-reservations.js', () => ({
    onReservationsChanged: () => () => {},
    effectiveInventory: (itemHrid, level, { excludeOwner, held } = {}) => {
        reservations.calls.push({ itemHrid, excludeOwner, held });
        let elsewhere = 0;
        for (const [owner, byItem] of Object.entries(reservations.claims)) {
            if (owner === excludeOwner) continue;
            elsewhere += byItem[itemHrid] || 0;
        }
        return Math.max(0, held - elsewhere);
    },
    shortfallNote: (short, itemHrid, level, { excludeOwner } = {}) =>
        excludeOwner === 'goal:mine' ? '' : `${short} short — reserved`,
}));

const { buildPlannerContext, gatheringSells } = await import('./goal-planner-context.js');
const { planGoal } = await import('./goal-planner.js');

/**
 * A combat provider result with one zone.
 * @param {number} goldPerHour - What the zone pays
 * @param {Object} [extra] - Extra fields on the rate
 * @returns {Object} What `loadCombatRates` would return
 */
function combat(goldPerHour, extra = {}) {
    const rate = {
        actionHrid: '/actions/combat/fly',
        label: 'Fly Zone T2 — from your all-zones run 3d ago',
        goldPerHour,
        kind: 'combat',
        ...extra,
    };
    return { rates: [rate], best: rate, status: { note: null } };
}

beforeEach(() => {
    reservations.claims = {};
    reservations.calls = [];
    liquidity.measured = true;
    liquidity.throttle = {};
    game.actionDetailMap = {
        '/actions/milking/cow': {
            type: '/action_types/milking',
            name: 'Milk a Cow',
            levelRequirement: { skillHrid: '/skills/milking', level: 1 },
            experienceGain: { skillHrid: '/skills/milking', value: 10 },
        },
        '/actions/cooking/stew': {
            type: '/action_types/cooking',
            name: 'Cook Stew',
            levelRequirement: { skillHrid: '/skills/cooking', level: 1 },
            experienceGain: { skillHrid: '/skills/cooking', value: 20 },
        },
        '/actions/alchemy/transmute': {
            type: '/action_types/alchemy',
            name: 'Transmute',
            experienceGain: { skillHrid: '/skills/alchemy', value: 30 },
        },
    };
    game.skills = [
        { skillHrid: '/skills/milking', level: 50, experience: 0 },
        { skillHrid: '/skills/cooking', level: 50, experience: 0 },
        { skillHrid: '/skills/alchemy', level: 50, experience: 0 },
    ];
    game.inventory = [];
    game.itemDetailMap = {};
    game.drinkSlots = {};
    game.levelExperienceTable = null;
    loadout.drinks = null;
    loadout.equipment = null;

    rates.gathering = { '/actions/milking/cow': { profitPerHour: 100_000 } };
    rates.production = { '/actions/cooking/stew': { profitPerHour: 50_000 } };
    rates.alchemy = [];
    rates.combat = { rates: [], best: null, status: { note: null } };
    rates.alchemyCalls = [];
});

describe('gatheringSells', () => {
    test('a Processing run sells the Cheese it makes and only the Milk it keeps', () => {
        // Shaped as gathering-profit.js returns it
        const profit = {
            baseOutputs: [{ itemHrid: '/items/milk', name: 'Milk', itemsPerHour: 1000 }],
            processingConversions: [
                {
                    rawItemHrid: '/items/milk',
                    processedItemHrid: '/items/cheese',
                    rawItem: 'Milk',
                    processedItem: 'Cheese',
                    conversionsPerHour: 100,
                    rawConsumedPerHour: 200,
                },
            ],
        };
        expect(gatheringSells(profit)).toEqual([
            { itemHrid: '/items/milk', name: 'Milk', unitsPerHour: 800 },
            { itemHrid: '/items/cheese', name: 'Cheese', unitsPerHour: 100 },
        ]);
    });

    test('without Processing it is the drop table', () => {
        expect(
            gatheringSells({
                baseOutputs: [
                    { itemHrid: '/items/egg', name: 'Egg', itemsPerHour: 50 },
                    { itemHrid: '/items/wheat', name: 'Wheat', itemsPerHour: 0 },
                ],
            })
        ).toEqual([{ itemHrid: '/items/egg', name: 'Egg', unitsPerHour: 50 }]);
    });
});

describe('goldRates — four providers, one ranking', () => {
    test('carries the market snapshot time, not the time the context was built', async () => {
        const context = await buildPlannerContext();

        expect(context.pricedAt).toBe(12345);
    });

    test('ranks alchemy against gathering and production on the one number', async () => {
        rates.alchemy = [
            { actionHrid: '/actions/alchemy/transmute', label: 'Transmute Ore', goldPerHour: 400_000, kind: 'alchemy' },
        ];

        const context = await buildPlannerContext();
        const ranked = context.goldRates();

        expect(ranked.map((rate) => rate.kind)).toEqual(['alchemy', 'gathering', 'production']);
        expect(ranked[0].label).toBe('Transmute Ore');
    });

    test('combat joins the same ranking and wins when it wins', async () => {
        rates.alchemy = [
            { actionHrid: '/actions/alchemy/transmute', label: 'Transmute Ore', goldPerHour: 400_000, kind: 'alchemy' },
        ];
        rates.combat = combat(2_100_000);

        const context = await buildPlannerContext();
        const [best] = context.goldRates();

        expect(best.kind).toBe('combat');
        expect(best.label).toContain('all-zones run 3d ago');
    });

    test('alchemy that loses to milking sorts below it rather than being hidden', async () => {
        rates.alchemy = [
            { actionHrid: '/actions/alchemy/transmute', label: 'Transmute Ore', goldPerHour: 1_000, kind: 'alchemy' },
        ];

        const context = await buildPlannerContext();
        expect(context.goldRates().map((rate) => rate.kind)).toEqual(['gathering', 'production', 'alchemy']);
    });

    test('a provider with nothing to offer simply is not in the list', async () => {
        const context = await buildPlannerContext();
        expect(context.goldRates().map((rate) => rate.kind)).toEqual(['gathering', 'production']);
    });

    test('a production action the character currently cannot start (Artisan Tea) is not ranked', async () => {
        // Level 50 clears the bare requirement of 45 by 5 — but the character's real,
        // currently-active Artisan Tea raises the requirement by 6, not the level.
        game.actionDetailMap['/actions/cooking/stew'].levelRequirement = { skillHrid: '/skills/cooking', level: 45 };
        game.itemDetailMap['/items/artisan_tea'] = {
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/action_level', flatBoost: 6 }] },
        };
        game.drinkSlots['/action_types/cooking'] = [{ itemHrid: '/items/artisan_tea' }];
        game.inventory = [{ itemHrid: '/items/artisan_tea', count: 5 }];

        const context = await buildPlannerContext();
        expect(context.goldRates().map((rate) => rate.actionHrid)).not.toContain('/actions/cooking/stew');
    });

    test('the alchemy ranking is told which market fetch it is pricing against', async () => {
        await buildPlannerContext();
        expect(rates.alchemyCalls).toEqual([{ priceStamp: 12345 }]);
    });
});

describe('a cost that could not be priced is not a cost of zero', () => {
    test('a production margin with an unpriceable material is dropped, not quoted', async () => {
        rates.production = {
            '/actions/cooking/stew': {
                profitPerHour: 7_400_000_000,
                materialCosts: [{ itemHrid: '/items/truffle', missingPrice: true }],
            },
        };

        const context = await buildPlannerContext();
        expect(context.goldRates().map((rate) => rate.kind)).toEqual(['gathering']);
        expect(context.rateNotes[0]).toContain('no market listing');
    });

    test('and the experience rates lose its gold with it, rather than inheriting a fantasy', async () => {
        rates.production = {
            '/actions/cooking/stew': {
                profitPerHour: 7_400_000_000,
                materialCosts: [{ itemHrid: '/items/truffle', missingPrice: true }],
            },
        };

        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        // Unknown, not free
        expect(cooking.goldPerHour).toBeNull();
        expect(cooking.goldKnown).toBe(false);
    });

    test('an unpriceable drink costs a gathering rate its place too', async () => {
        rates.gathering = {
            '/actions/milking/cow': { profitPerHour: 100_000, drinkCosts: [{ missingPrice: true }] },
        };

        const context = await buildPlannerContext();
        expect(context.goldRates().map((rate) => rate.kind)).toEqual(['production']);
    });

    test('a missing output price is conservative, so the rate is kept', async () => {
        // `hasMissingPrices` would be true here; only the cost side is fatal
        rates.production = {
            '/actions/cooking/stew': { profitPerHour: 50_000, hasMissingPrices: true, materialCosts: [{}] },
        };

        const context = await buildPlannerContext();
        expect(context.goldRates().map((rate) => rate.kind)).toEqual(['gathering', 'production']);
        expect(context.rateNotes).toEqual([]);
    });

    test('gathering and production say they have no ceiling, since they have none', async () => {
        const context = await buildPlannerContext();
        for (const rate of context.goldRates()) {
            expect(rate.sustainable).toEqual({ unbounded: true });
        }
    });
});

describe('rateNotes — what the panel says about a provider', () => {
    test('carries the combat provider’s note when there is no saved run', async () => {
        rates.combat = { rates: [], best: null, status: { note: 'Combat is not ranked — run an all-zones sim.' } };

        const context = await buildPlannerContext();
        expect(context.rateNotes).toEqual(['Combat is not ranked — run an all-zones sim.']);
    });

    test('carries a staleness note alongside the rates it is about', async () => {
        rates.combat = combat(2_100_000);
        rates.combat.status.note = 'Combat rates are from an all-zones run 9d ago — over a week old.';

        const context = await buildPlannerContext();
        expect(context.goldRates()).toHaveLength(3);
        expect(context.rateNotes[0]).toContain('9d ago');
    });

    test('says nothing when every provider is happy', async () => {
        rates.combat = combat(2_100_000);
        const context = await buildPlannerContext();
        expect(context.rateNotes).toEqual([]);
    });

    test('says out loud when market volume could not be checked at all', async () => {
        // The pooled-history setting is off, or the server did not answer. A rate
        // here is then what its output is *worth*, which is not the same claim.
        rates.combat = combat(2_100_000);
        liquidity.measured = false;

        const context = await buildPlannerContext();
        expect(context.rateNotes.join(' ')).toContain('Market volume is not being checked');
    });

    test('a provider that throws is reported rather than swallowed', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        rates.combat = null; // loadCombatRates resolves to null → reading .rates throws

        const context = await buildPlannerContext();
        expect(context.rateNotes).toEqual(['Combat could not be ranked — see the console.']);
        expect(context.goldRates().map((rate) => rate.kind)).toEqual(['gathering', 'production']);
        vi.restoreAllMocks();
    });
});

describe('the per-action gold map the experience rates read', () => {
    test('an experience rate is paired with its own action’s gold', async () => {
        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.goldPerHour).toBe(50_000);
    });

    test('alchemy rates do not leak into it, since many of them share one action', async () => {
        rates.alchemy = [
            { actionHrid: '/actions/alchemy/transmute', label: 'Transmute Ore', goldPerHour: 400_000, kind: 'alchemy' },
            { actionHrid: '/actions/alchemy/transmute', label: 'Transmute Milk', goldPerHour: 7, kind: 'alchemy' },
        ];

        const context = await buildPlannerContext();
        const [alchemy] = context.xpRates('/skills/alchemy');

        // Not 7 — the worst of two rates against the same action is not what
        // transmuting pays, and it is what a naive map would have stored
        expect(alchemy.goldPerHour).toBe(0);
    });
});

describe('measureRates: false', () => {
    test('skips every provider, which is the point of it', async () => {
        const context = await buildPlannerContext({ measureRates: false });
        expect(context.goldRates()).toEqual([]);
        expect(context.rateNotes).toEqual([]);
        expect(rates.alchemyCalls).toEqual([]);
    });
});

describe('what one goal may plan against', () => {
    /**
     * @returns {Promise<Object>} A context over a bag holding 500 logs
     */
    async function contextOver500Logs() {
        game.inventory = [
            { itemHrid: '/items/log', itemLocationHrid: '/item_locations/inventory', enhancementLevel: 0, count: 500 },
        ];
        return buildPlannerContext();
    }

    test('with nothing claimed, `owned` is the bag', async () => {
        const context = await contextOver500Logs();
        expect(context.owned('/items/log', 'a')).toBe(500);
    });

    test('another goal’s claim comes off; the asking goal’s own does not', async () => {
        reservations.claims = { 'goal:mine': { '/items/log': 200 }, 'goal:other': { '/items/log': 300 } };
        const context = await contextOver500Logs();

        expect(context.owned('/items/log', 'mine')).toBe(200);
        expect(context.owned('/items/log', 'other')).toBe(300);
    });

    test('the ledger is asked with the goal’s own owner id and the bag count', async () => {
        const context = await contextOver500Logs();
        context.owned('/items/log', 'mine');

        expect(reservations.calls.at(-1)).toEqual({
            itemHrid: '/items/log',
            excludeOwner: 'goal:mine',
            held: 500,
        });
    });

    test('an equipped or enhanced copy is not stock, as it never was', async () => {
        game.inventory = [
            { itemHrid: '/items/log', itemLocationHrid: '/item_locations/inventory', enhancementLevel: 0, count: 500 },
            { itemHrid: '/items/log', itemLocationHrid: '/item_locations/equipment', enhancementLevel: 0, count: 9 },
            { itemHrid: '/items/log', itemLocationHrid: '/item_locations/inventory', enhancementLevel: 3, count: 4 },
        ];
        const context = await buildPlannerContext();
        expect(context.owned('/items/log', 'mine')).toBe(500);
    });

    test('the visibility line is asked under the goal’s own owner id too', async () => {
        const context = await contextOver500Logs();
        expect(context.reservationNote(120, '/items/log', 'mine')).toBe('');
        expect(context.reservationNote(120, '/items/log', 'other')).toBe('120 short — reserved');
    });
});

describe('training rates keep the signed margin the rankings drop', () => {
    test('a fully priced loss is carried as a negative rate, and stays out of the rankings', async () => {
        rates.production = { '/actions/cooking/stew': { profitPerHour: -50_000, materialCosts: [{}] } };

        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.goldPerHour).toBe(-50_000);
        expect(cooking.goldKnown).toBe(true);
        expect(context.goldRates().map((rate) => rate.kind)).toEqual(['gathering']);
    });

    test('a genuine zero margin is a known zero', async () => {
        rates.production = { '/actions/cooking/stew': { profitPerHour: 0 } };

        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.goldPerHour).toBe(0);
        expect(cooking.goldKnown).toBe(true);
    });

    test('a positive margin is carried as before', async () => {
        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.goldPerHour).toBe(50_000);
        expect(cooking.goldKnown).toBe(true);
    });

    test('a loss with an unpriced material is unknown, not a quoted loss', async () => {
        rates.production = {
            '/actions/cooking/stew': { profitPerHour: -1, materialCosts: [{ missingPrice: true }] },
        };

        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.goldPerHour).toBeNull();
        expect(cooking.goldKnown).toBe(false);
    });

    test('an action the calculator returned nothing for is unknown, not free', async () => {
        rates.production = {};

        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.goldPerHour).toBeNull();
        expect(cooking.goldKnown).toBe(false);
    });

    test('a non-finite margin is unknown', async () => {
        rates.production = { '/actions/cooking/stew': { profitPerHour: NaN } };

        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.goldKnown).toBe(false);
    });
});

describe('training rates carry the drink bonuses the start rule needs', () => {
    test('Artisan Tea Action Level bonus rides on the rate apart from the raw requirement', async () => {
        game.actionDetailMap['/actions/cooking/stew'].levelRequirement = { skillHrid: '/skills/cooking', level: 45 };
        game.itemDetailMap['/items/artisan_tea'] = {
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/action_level', flatBoost: 6 }] },
        };
        game.drinkSlots['/action_types/cooking'] = [{ itemHrid: '/items/artisan_tea' }];
        game.inventory = [{ itemHrid: '/items/artisan_tea', count: 5 }];

        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.requiredLevel).toBe(45);
        expect(cooking.actionLevelBonus).toBe(6);
        expect(cooking.teaSkillLevelBonus).toBe(0);
    });

    test('a skill-level tea is a different field from an Action Level tea', async () => {
        game.itemDetailMap['/items/cooking_tea'] = {
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/cooking_level', flatBoost: 3 }] },
        };
        game.drinkSlots['/action_types/cooking'] = [{ itemHrid: '/items/cooking_tea' }];
        game.inventory = [{ itemHrid: '/items/cooking_tea', count: 5 }];

        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.teaSkillLevelBonus).toBe(3);
        expect(cooking.actionLevelBonus).toBe(0);
    });
});

describe('training rates carry completions per hour', () => {
    test('the margin and the completions it was measured over travel together', async () => {
        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.actionsPerHour).toBe(360);
        expect(cooking.goldPerHour).toBe(50_000);
    });
});

describe('training rates carry the per-hour drink bill inside the margin', () => {
    test('gathering reports it as drinkCostPerHour', async () => {
        rates.gathering = { '/actions/milking/cow': { profitPerHour: 100_000, drinkCostPerHour: 7_000 } };

        const context = await buildPlannerContext();
        const [milking] = context.xpRates('/skills/milking');
        expect(milking.drinkCostPerHour).toBe(7_000);
        expect(milking.goldPerHour).toBe(100_000);
    });

    test('production reports it as totalTeaCostPerHour', async () => {
        rates.production = { '/actions/cooking/stew': { profitPerHour: -50_000, totalTeaCostPerHour: 9_000 } };

        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.drinkCostPerHour).toBe(9_000);
        expect(cooking.goldPerHour).toBe(-50_000);
    });

    test('a result with no drink field has none to split out', async () => {
        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.drinkCostPerHour).toBe(0);
    });
});

describe('training rates carry the cost of starting one completion', () => {
    test('production carries one action of materials, as the ranking does', async () => {
        rates.production = { '/actions/cooking/stew': { profitPerHour: -1000, totalMaterialCost: 100_000 } };

        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.upfrontCost).toBe(100_000);
        expect(context.xpRates('/skills/cooking')[0].upfrontCost).toBe(
            (await buildPlannerContext()).xpRates('/skills/cooking')[0].upfrontCost
        );
    });

    test('the ranking and the training rate agree on the same recipe', async () => {
        rates.production = { '/actions/cooking/stew': { profitPerHour: 50_000, totalMaterialCost: 2_500 } };

        const context = await buildPlannerContext();
        const ranked = context.goldRates().find((rate) => rate.kind === 'production');
        expect(ranked.upfrontCost).toBe(2_500);
        expect(context.xpRates('/skills/cooking')[0].upfrontCost).toBe(ranked.upfrontCost);
    });

    test('gathering consumes nothing', async () => {
        const context = await buildPlannerContext();
        expect(context.xpRates('/skills/milking')[0].upfrontCost).toBe(0);
    });
});

describe('which drinks count toward starting an action', () => {
    const artisan = () => {
        game.actionDetailMap['/actions/cooking/stew'].levelRequirement = { skillHrid: '/skills/cooking', level: 45 };
        game.itemDetailMap['/items/artisan_tea'] = {
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/action_level', flatBoost: 6 }] },
        };
    };
    const levelTea = () => {
        // Level 50 is short of an action that needs 52; a +3 cooking tea would clear it
        game.actionDetailMap['/actions/cooking/stew'].levelRequirement = { skillHrid: '/skills/cooking', level: 52 };
        game.itemDetailMap['/items/cooking_tea'] = {
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/cooking_level', flatBoost: 3 }] },
        };
    };
    const ranked = async () => (await buildPlannerContext()).goldRates().map((rate) => rate.actionHrid);

    test('an out-of-stock skill-level tea does not unlock a locked action', async () => {
        levelTea();
        game.drinkSlots['/action_types/cooking'] = [{ itemHrid: '/items/cooking_tea' }];
        game.inventory = [];

        expect(await ranked()).not.toContain('/actions/cooking/stew');
        const context = await buildPlannerContext();
        expect(context.xpRates('/skills/cooking')[0].teaSkillLevelBonus).toBe(0);
    });

    test('the same tea in stock does unlock it', async () => {
        levelTea();
        game.drinkSlots['/action_types/cooking'] = [{ itemHrid: '/items/cooking_tea' }];
        game.inventory = [{ itemHrid: '/items/cooking_tea', count: 2 }];

        expect(await ranked()).toContain('/actions/cooking/stew');
    });

    test('an out-of-stock Artisan Tea does not raise the requirement', async () => {
        artisan();
        game.drinkSlots['/action_types/cooking'] = [{ itemHrid: '/items/artisan_tea' }];
        game.inventory = [];

        expect(await ranked()).toContain('/actions/cooking/stew');
        const context = await buildPlannerContext();
        expect(context.xpRates('/skills/cooking')[0].actionLevelBonus).toBe(0);
    });

    test('a tea still running on its last cup counts even with the stack gone', async () => {
        artisan();
        game.drinkSlots['/action_types/cooking'] = [{ itemHrid: '/items/artisan_tea', isActive: true, duration: 60 }];
        game.inventory = [];

        expect(await ranked()).not.toContain('/actions/cooking/stew');
    });

    test('a saved loadout drink is honored the way the rate calculators honor it', async () => {
        artisan();
        // Nothing slotted right now; the saved loadout would auto-equip Artisan Tea
        game.drinkSlots['/action_types/cooking'] = [];
        loadout.drinks = [{ itemHrid: '/items/artisan_tea' }];
        game.inventory = [{ itemHrid: '/items/artisan_tea', count: 3 }];

        expect(await ranked()).not.toContain('/actions/cooking/stew');
        const context = await buildPlannerContext();
        expect(context.xpRates('/skills/cooking')[0].actionLevelBonus).toBe(6);
    });
});

describe('training margins are held to what the market absorbs', () => {
    const stew = {
        itemHrid: '/items/stew',
        totalItemsPerHour: 100,
        revenuePerHour: 100_000,
        marketTax: 4_000,
        profitPerHour: 56_000,
    };

    test('a thin-market output loses the proceeds of the units that cannot be sold', async () => {
        rates.production = { '/actions/cooking/stew': stew };
        liquidity.throttle['/items/stew'] = 0.25;

        const [cooking] = (await buildPlannerContext()).xpRates('/skills/cooking');
        // 96k net proceeds, a quarter sells: 56k - 72k
        expect(cooking.goldPerHour).toBe(-16_000);
        expect(cooking.upfrontCost).toBe(0);
    });

    test('a loss-making craft does not improve when the book is thin', async () => {
        rates.production = { '/actions/cooking/stew': { ...stew, profitPerHour: -10_000 } };
        liquidity.throttle['/items/stew'] = 0.5;

        const [cooking] = (await buildPlannerContext()).xpRates('/skills/cooking');
        expect(cooking.goldPerHour).toBe(-58_000);
    });

    test('a liquid output is unchanged', async () => {
        rates.production = { '/actions/cooking/stew': stew };

        const [cooking] = (await buildPlannerContext()).xpRates('/skills/cooking');
        expect(cooking.goldPerHour).toBe(56_000);
    });

    test('missing volume data leaves the margin as the earning path leaves its rate', async () => {
        rates.production = { '/actions/cooking/stew': stew };
        liquidity.measured = false;

        const context = await buildPlannerContext();
        expect(context.xpRates('/skills/cooking')[0].goldPerHour).toBe(56_000);
        expect(context.goldRates()[0].goldPerHour).toBe(100_000);
    });

    test('a gathering drop table is held the same way', async () => {
        rates.gathering = {
            '/actions/milking/cow': {
                baseOutputs: [{ itemHrid: '/items/milk', itemsPerHour: 200, priceEach: 500 }],
                revenuePerHour: 100_000,
                excludeSellTax: true,
                marketTax: 0,
                profitPerHour: 100_000,
            },
        };
        liquidity.throttle['/items/milk'] = 0.1;

        const context = await buildPlannerContext();
        expect(context.xpRates('/skills/milking')[0].goldPerHour).toBe(10_000);
    });

    test('the training step and its funding follow the capped margin', async () => {
        rates.production = { '/actions/cooking/stew': stew };
        game.skills = game.skills.map((skill) =>
            skill.skillHrid === '/skills/cooking' ? { ...skill, level: 1, experience: 0 } : skill
        );
        game.levelExperienceTable = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 100_000_000];
        const goal = { type: 'skill', skillHrid: '/skills/cooking', targetLevel: 11 };

        const open = planGoal(goal, await buildPlannerContext());
        liquidity.throttle['/items/stew'] = 0.25;
        const thin = planGoal(goal, await buildPlannerContext());

        const goldOf = (plan) => plan.steps.find((step) => step.kind === 'train').goldDelta;
        expect(goldOf(thin)).toBeLessThan(goldOf(open));
        expect(thin.totals.netGold).toBeLessThan(open.totals.netGold);
    });

    test('a taxable bonus drop does not shrink the main output proceeds that get cut', async () => {
        // revenuePerHour is the main item only; marketTax also taxes 50k of bonus drops (4% of 150k)
        rates.production = {
            '/actions/cooking/stew': { ...stew, marketTax: 6_000, profitPerHour: 144_000 },
        };
        liquidity.throttle['/items/stew'] = 0.25;

        const [cooking] = (await buildPlannerContext()).xpRates('/skills/cooking');
        // main proceeds 100k - 4k tax = 96k, a quarter sells: 144k - 72k
        expect(cooking.goldPerHour).toBe(72_000);
    });

    test('bonus tax above the main revenue still bounds the main output', async () => {
        rates.production = {
            '/actions/cooking/stew': { ...stew, revenuePerHour: 1_000, marketTax: 5_000, profitPerHour: 90_000 },
        };
        liquidity.throttle['/items/stew'] = 0.5;

        const [cooking] = (await buildPlannerContext()).xpRates('/skills/cooking');
        // 1k - 40 tax = 960 net, half unsold
        expect(cooking.goldPerHour).toBe(89_520);
    });

    test('a production result that excluded the sell tax has untaxed main proceeds', async () => {
        rates.production = {
            '/actions/cooking/stew': { ...stew, marketTax: 0, excludeSellTax: true, profitPerHour: 100_000 },
        };
        liquidity.throttle['/items/stew'] = 0.5;

        const [cooking] = (await buildPlannerContext()).xpRates('/skills/cooking');
        expect(cooking.goldPerHour).toBe(50_000);
    });

    test('a thin milk book does not cut the logs that still sell, and bonus drops survive', async () => {
        rates.gathering = {
            '/actions/milking/cow': {
                baseOutputs: [
                    { itemHrid: '/items/milk', itemsPerHour: 200, priceEach: 100 },
                    { itemHrid: '/items/log', itemsPerHour: 100, priceEach: 100 },
                ],
                // 30k of bonus drops sit in revenue but in no sold output
                revenuePerHour: 60_000,
                excludeSellTax: true,
                marketTax: 0,
                profitPerHour: 60_000,
            },
        };
        liquidity.throttle['/items/milk'] = 0.5;

        const context = await buildPlannerContext();
        // Only milk's 20k is halved; logs and the 30k of bonus stay: 60k - 10k
        expect(context.xpRates('/skills/milking')[0].goldPerHour).toBe(50_000);
    });

    test('Processing: the thin processed item loses its own proceeds, not the raw milk', async () => {
        rates.gathering = {
            '/actions/milking/cow': {
                baseOutputs: [{ itemHrid: '/items/milk', itemsPerHour: 200, priceEach: 100 }],
                processingConversions: [
                    {
                        rawItemHrid: '/items/milk',
                        processedItemHrid: '/items/cheese',
                        rawConsumedPerHour: 50,
                        rawPriceEach: 100,
                        conversionsPerHour: 50,
                        processedPriceEach: 400,
                    },
                ],
                revenuePerHour: 35_000,
                excludeSellTax: true,
                marketTax: 0,
                profitPerHour: 35_000,
            },
        };
        liquidity.throttle['/items/cheese'] = 0.5;

        const context = await buildPlannerContext();
        // 150 milk (15k) sells; 50 cheese (20k) is half unsold
        expect(context.xpRates('/skills/milking')[0].goldPerHour).toBe(25_000);
    });
});
