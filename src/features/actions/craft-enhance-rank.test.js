/**
 * The Craft & Enhance arithmetic. No game and no market: every price is an argument.
 *
 * The rule under test above all others: a missing price is never a 0. An unpriced input, an unpriced +N
 * sale and an unpriced enhancement run each make a row's profit `null`, so it cannot rank as profitable;
 * and a sunk input (a deliberate 0) is a different thing from an unpriced one.
 */

import { describe, test, expect } from 'vitest';
import {
    OWNED_MODES,
    arrangeCraftEnhanceRows,
    buildCraftEnhanceRow,
    buildDungeonInputIndex,
    bestLevelOf,
    buildHeldPool,
    capProfitByVolume,
    chooseEnhanceRoute,
    craftUnitFigures,
    dungeonInputKind,
    evaluateLevel,
    hasDungeonInput,
    normalizeOwnedMode,
    normalizeTargetLevel,
    priceCraftMaterials,
} from './craft-enhance-rank.js';
import {
    DUNGEON_CRAFT_GAME_DATA,
    GRIFFIN_TUNIC_ACTION,
    MANTICORE_SHIELD_ACTION,
} from '../../__fixtures__/wire/dungeon-craft-inputs.js';

/** A small slice of the game's data, in the shapes it emits */
const gameData = {
    actionDetailMap: {
        '/actions/combat/chimerical_den': {
            name: 'Chimerical Den',
            combatZoneInfo: {
                isDungeon: true,
                dungeonInfo: {
                    rewardDropTable: [{ itemHrid: '/items/chimerical_chest' }, { itemHrid: '/items/coin' }],
                },
            },
        },
        '/actions/combat/fly': { name: 'Fly', combatZoneInfo: { isDungeon: false, fightInfo: {} } },
        // An ordinary action: what it makes is a generic material even when a chest also holds it
        '/actions/foraging/cheese': { name: 'Cheese', outputItems: [{ itemHrid: '/items/cheese', count: 1 }] },
    },
    itemDetailMap: {},
    openableLootDropMap: {
        '/items/chimerical_chest': [
            { itemHrid: '/items/chimerical_essence' },
            { itemHrid: '/items/griffin_leather' },
            { itemHrid: '/items/cheese' },
            { itemHrid: '/items/mini_chest' },
            { itemHrid: '/items/coin' },
        ],
        // A chest inside the chest
        '/items/mini_chest': [{ itemHrid: '/items/tiny_gem' }],
    },
    shopItemDetailMap: {
        a: { itemHrid: '/items/shop_cloth', costs: [{ itemHrid: '/items/sinister_token', count: 30 }], outputCount: 2 },
        // A line that also asks for coins says nothing clean about a token
        b: {
            itemHrid: '/items/mixed_line',
            costs: [
                { itemHrid: '/items/sinister_token', count: 5 },
                { itemHrid: '/items/coin', count: 100 },
            ],
        },
        // Priced in something that is not a dungeon token
        c: { itemHrid: '/items/task_thing', costs: [{ itemHrid: '/items/task_token', count: 5 }] },
        // The test server's Tester tab is not a real shop
        d: {
            itemHrid: '/items/tester_item',
            category: 'tester',
            costs: [{ itemHrid: '/items/sinister_token', count: 1 }],
        },
    },
};

const index = buildDungeonInputIndex(gameData);

describe('buildDungeonInputIndex', () => {
    test('a dungeon reward chest, its contents and the chests inside it are drops; coins and ordinary zones are not', () => {
        expect([...index.drops.keys()].sort()).toEqual([
            '/items/chimerical_chest',
            '/items/chimerical_essence',
            '/items/griffin_leather',
            '/items/mini_chest',
            '/items/tiny_gem',
        ]);
        expect(index.drops.get('/items/griffin_leather').dungeons).toEqual(['Chimerical Den']);
    });

    test('only single-token dungeon-shop lines count, and the tester tab does not', () => {
        expect([...index.tokenShop.keys()]).toEqual(['/items/shop_cloth']);
        expect(index.tokenShop.get('/items/shop_cloth')).toEqual({
            tokenHrid: '/items/sinister_token',
            tokenCount: 30,
            outputCount: 2,
        });
    });

    test('a generic material a chest also holds is not a dungeon input: it is bought like any other', () => {
        expect(index.drops.has('/items/cheese')).toBe(false);
        expect(dungeonInputKind('/items/cheese', index)).toBeNull();
    });

    test('a chest that holds itself does not loop', () => {
        const loop = buildDungeonInputIndex({
            ...gameData,
            openableLootDropMap: { '/items/chimerical_chest': [{ itemHrid: '/items/chimerical_chest' }] },
        });
        expect([...loop.drops.keys()]).toEqual(['/items/chimerical_chest']);
    });

    test('a shop line that spells its cost as a single `cost` is read too', () => {
        const single = buildDungeonInputIndex({
            ...gameData,
            shopItemDetailMap: {
                x: { itemHrid: '/items/lone_cloth', cost: { itemHrid: '/items/sinister_token', count: 9 } },
            },
        });
        expect(single.tokenShop.get('/items/lone_cloth')).toEqual({
            tokenHrid: '/items/sinister_token',
            tokenCount: 9,
            outputCount: 1,
        });
    });

    test('an empty game answers empty', () => {
        const empty = buildDungeonInputIndex(null);
        expect(empty.drops.size).toBe(0);
        expect(empty.tokenShop.size).toBe(0);
    });
});

describe('what qualifies a recipe', () => {
    test('dungeonInputKind names drop and token membership', () => {
        expect(dungeonInputKind('/items/griffin_leather', index)).toEqual({ drop: true, token: false });
        expect(dungeonInputKind('/items/shop_cloth', index)).toEqual({ drop: false, token: true });
        expect(dungeonInputKind('/items/cheese', index)).toBeNull();
    });

    test('only a DIRECT input counts, the upgrade item included', () => {
        expect(hasDungeonInput({ inputItems: [{ itemHrid: '/items/griffin_leather' }] }, index)).toBe(true);
        expect(hasDungeonInput({ inputItems: [{ itemHrid: '/items/cheese' }] }, index)).toBe(false);
        // An intermediate that is itself made from a drop is one level too deep
        expect(hasDungeonInput({ inputItems: [{ itemHrid: '/items/refined_leather' }] }, index)).toBe(false);
        expect(hasDungeonInput({ inputItems: [], upgradeItemHrid: '/items/griffin_leather' }, index)).toBe(true);
        expect(hasDungeonInput({}, index)).toBe(false);
    });
});

describe('the index on real test-server data', () => {
    const real = buildDungeonInputIndex(DUNGEON_CRAFT_GAME_DATA);
    const has = (map, name) => map.has(`/items/${name}`);

    test('gear materials inside the chest are drops, the chest-only gems too', () => {
        for (const name of [
            'griffin_leather',
            'manticore_sting',
            'jackalope_antler',
            'dodocamel_plume',
            'griffin_talon',
        ])
            expect(has(real.drops, name)).toBe(true);
        // Reached through the large treasure chest inside the chimerical chest
        expect(has(real.drops, 'garnet')).toBe(true);
        expect(has(real.drops, 'chimerical_refinement_shard')).toBe(true);
        expect(real.drops.get('/items/griffin_leather').dungeons).toEqual(['Chimerical Den']);
    });

    test('gear a crafting action also makes is not a drop, and coins never are', () => {
        for (const name of ['griffin_tunic', 'manticore_shield', 'chimerical_chest_key', 'coin'])
            expect(has(real.drops, name)).toBe(false);
    });

    test('token-shop lines read in the game shape, with their real token counts', () => {
        expect(real.tokenShop.get('/items/griffin_leather')).toEqual({
            tokenHrid: '/items/chimerical_token',
            tokenCount: 600,
            outputCount: 1,
        });
        expect(real.tokenShop.get('/items/chimerical_quiver').tokenCount).toBe(35000);
        expect(real.tokenShop.size).toBe(7);
    });

    test('the real griffin and manticore recipes qualify; one with only holy cheese would not', () => {
        expect(hasDungeonInput(GRIFFIN_TUNIC_ACTION, real)).toBe(true);
        expect(hasDungeonInput(MANTICORE_SHIELD_ACTION, real)).toBe(true);
        expect(dungeonInputKind('/items/holy_cheese', real)).toBeNull();
        expect(dungeonInputKind('/items/manticore_sting', real)).toEqual({ drop: true, token: true });
    });
});

describe('normalizers', () => {
    test('target level is clamped, and nonsense falls back to +5', () => {
        expect(normalizeTargetLevel(7)).toBe(7);
        expect(normalizeTargetLevel('3')).toBe(3);
        expect(normalizeTargetLevel(0)).toBe(5);
        expect(normalizeTargetLevel(-2)).toBe(5);
        expect(normalizeTargetLevel(null)).toBe(5);
        expect(normalizeTargetLevel('x')).toBe(5);
        expect(normalizeTargetLevel(99)).toBe(10);
    });

    test('owned mode falls back to market', () => {
        expect(normalizeOwnedMode('sunk')).toBe('sunk');
        expect(normalizeOwnedMode('market')).toBe('market');
        expect(normalizeOwnedMode('buy')).toBe('buy');
        expect(normalizeOwnedMode('weird')).toBe('market');
        expect(normalizeOwnedMode(undefined)).toBe('market');
    });
});

/** Calculator material lines, as `calculateMaterialCosts` shapes them */
const mat = (itemHrid, amount, price, extra = {}) => ({
    itemHrid,
    amount,
    baseAmount: Math.ceil(amount),
    totalCost: price * amount,
    askPrice: price,
    missingPrice: false,
    ...extra,
});

describe('priceCraftMaterials: buy mode and estimates', () => {
    const valueToken = (hrid) => ({ '/items/shop_cloth': 480 })[hrid] ?? null;

    test('a dungeon drop is priced at the buy price, untaxed, not at its sale value', () => {
        const priced = priceCraftMaterials({
            materials: [mat('/items/griffin_leather', 2, 1000)],
            index,
            ownedMode: OWNED_MODES.BUY,
            valueDrop: () => 960,
            valueToken,
        });
        expect(priced.costPerAction).toBe(2000);
        expect(priced.dungeonInputs[0]).toEqual(expect.objectContaining({ via: 'buy', unitValue: 1000, sunk: false }));
    });

    test('a token-shop item takes the cheaper of the buy price and the token route', () => {
        const dear = priceCraftMaterials({
            materials: [mat('/items/shop_cloth', 1, 900)],
            index,
            ownedMode: OWNED_MODES.BUY,
            valueToken,
        });
        expect(dear.costPerAction).toBe(480);
        expect(dear.dungeonInputs[0].via).toBe('token');
        const cheap = priceCraftMaterials({
            materials: [mat('/items/shop_cloth', 1, 300)],
            index,
            ownedMode: OWNED_MODES.BUY,
            valueToken,
        });
        expect(cheap.costPerAction).toBe(300);
        expect(cheap.dungeonInputs[0].via).toBe('buy');
    });

    test('no buy price and no token route is unpriced, never 0', () => {
        const priced = priceCraftMaterials({
            materials: [mat('/items/griffin_leather', 2, 0, { missingPrice: true })],
            index,
            ownedMode: OWNED_MODES.BUY,
            valueToken,
        });
        expect(priced.unpriced).toEqual([{ itemHrid: '/items/griffin_leather', reason: 'dungeon-input' }]);
        // A token route still prices a shop item whose market price is missing
        const viaToken = priceCraftMaterials({
            materials: [mat('/items/shop_cloth', 1, 0, { missingPrice: true })],
            index,
            ownedMode: OWNED_MODES.BUY,
            valueToken,
        });
        expect(viaToken.costPerAction).toBe(480);
    });

    test('an input priced from the value estimate is listed, in ordinary and buy-mode inputs alike', () => {
        const priced = priceCraftMaterials({
            materials: [
                mat('/items/cheese', 1, 5, { estimatedPrice: true }),
                mat('/items/griffin_leather', 1, 1000, { estimatedPrice: true }),
                mat('/items/other', 1, 1),
            ],
            index,
            ownedMode: OWNED_MODES.BUY,
            valueToken,
        });
        expect(priced.estimated.sort()).toEqual(['/items/cheese', '/items/griffin_leather']);
    });
});

/** A pool that holds far more of everything than any recipe uses: every dungeon input is owned */
const plenty = new Map(
    ['/items/griffin_leather', '/items/chimerical_essence', '/items/shop_cloth'].map((hrid) => [`${hrid}:0`, 1000])
);

describe('priceCraftMaterials', () => {
    const valueDrop = (hrid) => ({ '/items/griffin_leather': 960 })[hrid] ?? null;
    const valueToken = (hrid) => ({ '/items/shop_cloth': 480 })[hrid] ?? null;

    test('market mode: a non-dungeon input keeps its buy price, a drop is valued at its after-tax sale', () => {
        const priced = priceCraftMaterials({
            materials: [mat('/items/cheese', 10, 5), mat('/items/griffin_leather', 2, 1000)],
            index,
            ownedMode: OWNED_MODES.MARKET,
            heldPool: plenty,
            valueDrop,
            valueToken,
        });
        // 10 cheese at 5, and 2 leather at the 960 after-tax figure (not the 1000 buy price)
        expect(priced.costPerAction).toBe(50 + 1920);
        expect(priced.unpriced).toEqual([]);
        expect(priced.dungeonInputs).toEqual([
            expect.objectContaining({ itemHrid: '/items/griffin_leather', unitValue: 960, sunk: false, via: 'sale' }),
        ]);
    });

    test('a token-shop input is valued through its tokens', () => {
        const priced = priceCraftMaterials({
            materials: [mat('/items/shop_cloth', 3, 9999)],
            index,
            ownedMode: OWNED_MODES.MARKET,
            heldPool: plenty,
            valueDrop,
            valueToken,
        });
        expect(priced.costPerAction).toBe(3 * 480);
        expect(priced.dungeonInputs[0]).toEqual(expect.objectContaining({ via: 'token', unitValue: 480 }));
    });

    test('a drop the market will not price is UNPRICED, never 0', () => {
        const priced = priceCraftMaterials({
            materials: [mat('/items/chimerical_essence', 4, 3)],
            index,
            ownedMode: OWNED_MODES.MARKET,
            heldPool: plenty,
            valueDrop: () => null,
            valueToken: () => null,
        });
        expect(priced.unpriced).toEqual([{ itemHrid: '/items/chimerical_essence', reason: 'dungeon-input' }]);
        expect(priced.dungeonInputs).toEqual([]);
        // The partial bill is not a quote: callers read `unpriced` first
        expect(priced.costPerAction).toBe(0);
    });

    test('an ordinary input with no price is unpriced, not folded in at 0', () => {
        const priced = priceCraftMaterials({
            materials: [mat('/items/cheese', 1, 0, { missingPrice: true })],
            index,
            ownedMode: OWNED_MODES.MARKET,
            heldPool: plenty,
            valueDrop,
            valueToken,
        });
        expect(priced.unpriced).toEqual([{ itemHrid: '/items/cheese', reason: 'input' }]);
    });

    test('sunk mode counts dungeon inputs at a real 0, flagged sunk, and leaves ordinary inputs alone', () => {
        const priced = priceCraftMaterials({
            materials: [
                mat('/items/cheese', 10, 5),
                mat('/items/griffin_leather', 2, 1000),
                mat('/items/shop_cloth', 1, 70),
            ],
            index,
            ownedMode: OWNED_MODES.SUNK,
            heldPool: plenty,
            valueDrop,
            valueToken,
        });
        expect(priced.costPerAction).toBe(50);
        expect(priced.unpriced).toEqual([]);
        expect(priced.dungeonInputs.every((input) => input.sunk && input.unitValue === 0)).toBe(true);
    });

    test('sunk does not hide a missing price on an ordinary input', () => {
        const priced = priceCraftMaterials({
            materials: [mat('/items/cheese', 1, 0, { missingPrice: true }), mat('/items/griffin_leather', 2, 1)],
            index,
            ownedMode: OWNED_MODES.SUNK,
            heldPool: plenty,
            valueDrop,
            valueToken,
        });
        expect(priced.unpriced).toHaveLength(1);
    });

    test('sunk does not need a valuation at all, so an unpriceable drop is still sunk, not unpriced', () => {
        const priced = priceCraftMaterials({
            materials: [mat('/items/chimerical_essence', 4, 0, { missingPrice: true })],
            index,
            ownedMode: OWNED_MODES.SUNK,
            heldPool: plenty,
            valueDrop: () => null,
            valueToken: () => null,
        });
        expect(priced.unpriced).toEqual([]);
        expect(priced.dungeonInputs[0].sunk).toBe(true);
    });

    test('duplicate lines of one item are each priced and summed', () => {
        const priced = priceCraftMaterials({
            materials: [mat('/items/griffin_leather', 1, 1), mat('/items/griffin_leather', 3, 1)],
            index,
            ownedMode: OWNED_MODES.MARKET,
            heldPool: plenty,
            valueDrop,
            valueToken,
        });
        expect(priced.costPerAction).toBe(960 * 4);
        expect(priced.dungeonInputs).toHaveLength(2);
    });

    test('Artisan: the reduced amount is what is priced, including a fractional one on a count-1 input', () => {
        const priced = priceCraftMaterials({
            materials: [mat('/items/griffin_leather', 0.888, 1000, { baseAmount: 1 })],
            index,
            ownedMode: OWNED_MODES.MARKET,
            heldPool: plenty,
            valueDrop,
            valueToken,
        });
        expect(priced.costPerAction).toBeCloseTo(960 * 0.888, 6);
    });

    test('a drop that is also a shop item falls back to the token route when the market has no sale', () => {
        const both = buildDungeonInputIndex({
            ...gameData,
            shopItemDetailMap: {
                a: { itemHrid: '/items/griffin_leather', costs: [{ itemHrid: '/items/sinister_token', count: 10 }] },
            },
        });
        const priced = priceCraftMaterials({
            materials: [mat('/items/griffin_leather', 1, 1)],
            index: both,
            ownedMode: OWNED_MODES.MARKET,
            heldPool: plenty,
            valueDrop: () => null,
            valueToken: () => 700,
        });
        expect(priced.costPerAction).toBe(700);
        expect(priced.dungeonInputs[0].via).toBe('token');
    });
});

/** A calculator answer for a plain recipe: 2 actions a minute... keep the numbers round instead */
const profit = (over = {}) => ({
    totalItemsPerHour: 100,
    outputAmount: 1,
    gourmetBonus: 0,
    totalTeaCostPerHour: 1000,
    materialCostPerHour: 5000,
    revenuePerHour: 100 * 200,
    // 20000 revenue, taxed 4%: 19200, less 5000 materials and 1000 tea
    profitPerHour: 19200 - 5000 - 1000,
    ...over,
});

describe('craftUnitFigures', () => {
    test('craft cost per unit is materials plus tea, and the seconds follow the rate', () => {
        const figures = craftUnitFigures({ materialCostPerAction: 50, profit: profit(), taxRate: 0.04 });
        expect(figures.craftCostPerUnit).toBeCloseTo(50 + 10, 6);
        expect(figures.secondsPerUnit).toBeCloseTo(36, 6);
        // Nothing beyond the sale, materials and tea: no bonus drops
        expect(figures.otherNetPerUnit).toBeCloseTo(0, 6);
    });

    test('gourmet copies share the inputs, so they divide the material cost', () => {
        const figures = craftUnitFigures({
            materialCostPerAction: 50,
            profit: profit({ gourmetBonus: 0.25 }),
            taxRate: 0.04,
        });
        expect(figures.craftCostPerUnit).toBeCloseTo(50 / 1.25 + 10, 6);
    });

    test('a bonus-drop stream the calculator counted is carried as other net, independent of the sale', () => {
        // 500 a unit of bonus, after its own tax, on top of the plain figures
        const figures = craftUnitFigures({
            materialCostPerAction: 50,
            profit: profit({ profitPerHour: 19200 - 5000 - 1000 + 100 * 500 }),
            taxRate: 0.04,
        });
        expect(figures.otherNetPerUnit).toBeCloseTo(500, 6);
    });

    test('a recipe with no output rate has no figures', () => {
        expect(
            craftUnitFigures({ materialCostPerAction: 1, profit: profit({ totalItemsPerHour: 0 }), taxRate: 0 })
        ).toBeNull();
    });
});

describe('evaluateLevel', () => {
    const base = {
        craftCostPerUnit: 60,
        unpricedInputs: [],
        secondsPerUnit: 36,
        otherNetPerUnit: 0,
        craftXpPerUnit: 20,
    };

    test('+0: sale minus craft cost, rated per hour on the craft time alone', () => {
        const level = evaluateLevel({ ...base, level: 0, enhance: null, saleAfterTax: 200 });
        expect(level.status).toBe('ok');
        expect(level.profitPerUnit).toBe(140);
        expect(level.unitsPerHour).toBeCloseTo(100, 6);
        expect(level.profitPerHour).toBeCloseTo(14000, 6);
        expect(level.craftXpPerHour).toBeCloseTo(2000, 6);
        expect(level.enhanceXpPerHour).toBe(0);
    });

    test('+N: the enhancement run adds its cost and its time, and earns its own XP', () => {
        const level = evaluateLevel({
            ...base,
            level: 5,
            enhance: { cost: 40, seconds: 36, xp: 30 },
            saleAfterTax: 300,
        });
        expect(level.profitPerUnit).toBe(300 - 60 - 40);
        // 72 seconds a unit
        expect(level.unitsPerHour).toBeCloseTo(50, 6);
        expect(level.profitPerHour).toBeCloseTo(200 * 50, 6);
        expect(level.craftXpPerHour).toBeCloseTo(1000, 6);
        expect(level.enhanceXpPerHour).toBeCloseTo(1500, 6);
    });

    test('an unpriced drink keeps its own reason, apart from an unpriced input', () => {
        const level = evaluateLevel({
            ...base,
            craftCostPerUnit: null,
            unpricedInputs: [{ itemHrid: '/items/tea', reason: 'tea' }],
            level: 0,
            enhance: null,
            saleAfterTax: 200,
        });
        expect(level.reasons).toEqual(['tea']);
        expect(level.craftCostPerUnit).toBeNull();
    });

    test('an unpriced +N sale makes the profit null, never sale-less arithmetic', () => {
        const level = evaluateLevel({
            ...base,
            level: 5,
            enhance: { cost: 40, seconds: 36, xp: 30 },
            saleAfterTax: null,
        });
        expect(level.status).toBe('unpriced');
        expect(level.reasons).toEqual(['sale']);
        expect(level.profitPerUnit).toBeNull();
        expect(level.profitPerHour).toBeNull();
        expect(level.saleAfterTax).toBeNull();
    });

    test('a sale of 0 is no quote either', () => {
        expect(evaluateLevel({ ...base, level: 0, enhance: null, saleAfterTax: 0 }).status).toBe('unpriced');
    });

    test('an enhancement run that cannot be priced makes +N unpriced but leaves the cost null, not 0', () => {
        const level = evaluateLevel({ ...base, level: 5, enhance: null, saleAfterTax: 300 });
        expect(level.status).toBe('unpriced');
        expect(level.reasons).toEqual(['enhance']);
        expect(level.enhanceCost).toBeNull();
        expect(level.profitPerHour).toBeNull();
    });

    test('an unpriced input nulls the craft cost and the profit', () => {
        const level = evaluateLevel({
            ...base,
            craftCostPerUnit: null,
            unpricedInputs: [{ itemHrid: '/items/x', reason: 'input' }],
            level: 0,
            enhance: null,
            saleAfterTax: 200,
        });
        expect(level.status).toBe('unpriced');
        expect(level.craftCostPerUnit).toBeNull();
        expect(level.profitPerUnit).toBeNull();
    });

    test('a loss is a real number, not unpriced', () => {
        const level = evaluateLevel({ ...base, level: 0, enhance: null, saleAfterTax: 10 });
        expect(level.status).toBe('ok');
        expect(level.profitPerUnit).toBe(-50);
    });

    test('unknown enhancing XP (a skipped run) is null, not 0', () => {
        const level = evaluateLevel({
            ...base,
            level: 5,
            enhance: { cost: 40, seconds: 0, xp: 0, xpKnown: false },
            saleAfterTax: 300,
        });
        expect(level.status).toBe('ok');
        expect(level.enhanceXpPerHour).toBeNull();
    });

    test('unknown crafting XP stays null', () => {
        const level = evaluateLevel({ ...base, craftXpPerUnit: null, level: 0, enhance: null, saleAfterTax: 200 });
        expect(level.craftXpPerHour).toBeNull();
    });

    test('no output rate is its own reason', () => {
        const level = evaluateLevel({ ...base, secondsPerUnit: 0, level: 0, enhance: null, saleAfterTax: 200 });
        expect(level.reasons).toContain('rate');
        expect(level.craftCostPerUnit).toBeNull();
    });
});

const recipe = (name, skillHrid = '/skills/cheesesmithing', levelMet = true) => ({
    itemHrid: `/items/${name}`,
    itemName: name,
    actionHrid: `/actions/x/${name}`,
    actionName: name,
    skillHrid,
    skillLabel: skillHrid,
    requiredLevel: 1,
    level: 50,
    levelMet,
});

const row = (
    name,
    { sale0 = 200, saleN = 300, cost = 60, enhance = { cost: 40, seconds: 36, xp: 30 }, over = {} } = {}
) =>
    buildCraftEnhanceRow({
        recipe: recipe(name),
        priced: { costPerAction: 0, unpriced: [], dungeonInputs: [] },
        figures: { craftCostPerUnit: cost, secondsPerUnit: 36, otherNetPerUnit: 0 },
        craftXpPerUnit: 20,
        targetLevel: 5,
        enhance,
        saleBase: sale0,
        saleTarget: saleN,
        ...over,
    });

describe('buildCraftEnhanceRow', () => {
    test('a priced row has both levels rated', () => {
        const built = row('sword');
        expect(built.base.status).toBe('ok');
        expect(built.target.status).toBe('ok');
        expect(built.target.profitPerUnit).toBe(200);
        expect(built.sunkInputs).toEqual([]);
        expect(built.volume).toBeNull();
    });

    test('an unpriced input nulls BOTH levels', () => {
        const built = row('sword', {
            over: {
                priced: {
                    costPerAction: 0,
                    unpriced: [{ itemHrid: '/items/x', reason: 'input' }],
                    dungeonInputs: [],
                },
            },
        });
        expect(built.base.profitPerHour).toBeNull();
        expect(built.target.profitPerHour).toBeNull();
        expect(built.target.craftCostPerUnit).toBeNull();
    });

    test('an unpriced +N leaves +0 priced', () => {
        const built = row('sword', { saleN: null });
        expect(built.base.status).toBe('ok');
        expect(built.target.status).toBe('unpriced');
    });

    test('sunk inputs are listed on the row, and are not unpriced reasons', () => {
        const built = row('sword', {
            over: {
                priced: {
                    costPerAction: 0,
                    unpriced: [],
                    dungeonInputs: [
                        { itemHrid: '/items/griffin_leather', amount: 1, unitValue: 0, sunk: true },
                        { itemHrid: '/items/other', amount: 1, unitValue: 5, sunk: false },
                    ],
                },
            },
        });
        expect(built.sunkInputs).toEqual(['/items/griffin_leather']);
        expect(built.target.status).toBe('ok');
        expect(built.target.reasons).toEqual([]);
    });

    test('a recipe with no figures is unpriced on its rate, not on a price', () => {
        const built = row('sword', { over: { figures: null } });
        expect(built.target.reasons).toContain('rate');
        expect(built.target.reasons).not.toContain('input');
    });
});

describe('arrangeCraftEnhanceRows', () => {
    const good = row('good', { saleN: 400 });
    const better = row('better', { saleN: 900 });
    const losing = row('losing', { saleN: 80 });
    const noQuote = row('noquote', { saleN: null });
    // The worst case: the one row whose missing price WOULD have made it look best
    const unpricedInput = row('unpricedinput', {
        saleN: 100000,
        over: {
            priced: { costPerAction: 0, unpriced: [{ itemHrid: '/items/x', reason: 'input' }], dungeonInputs: [] },
        },
    });
    const all = [noQuote, losing, unpricedInput, good, better];

    test('sorts by profit per hour, best first, with unpriced rows behind every priced one', () => {
        const names = arrangeCraftEnhanceRows(all).map((r) => r.itemName);
        expect(names.slice(0, 3)).toEqual(['better', 'good', 'losing']);
        expect(names.slice(3).sort()).toEqual(['noquote', 'unpricedinput']);
    });

    test('an unpriced row stays last whichever way and whatever key', () => {
        for (const sort of ['hour', 'unit', 'craftXp', 'enhanceXp', 'base']) {
            for (const descending of [true, false]) {
                const names = arrangeCraftEnhanceRows(all, { sort, descending }).map((r) => r.itemName);
                expect(names.slice(-2).sort()).toEqual(['noquote', 'unpricedinput']);
            }
        }
    });

    test('sorting by +0 places a row by its +0 figure even when its +N is unpriced', () => {
        const base = arrangeCraftEnhanceRows([noQuote, unpricedInput], { sort: 'base' }).map((r) => r.itemName);
        // unpricedinput has no priced level at all: it goes behind noquote, whose +0 is priced
        expect(base).toEqual(['noquote', 'unpricedinput']);
    });

    test('ascending puts the worst priced row first', () => {
        const names = arrangeCraftEnhanceRows(all, { descending: false }).map((r) => r.itemName);
        expect(names[0]).toBe('losing');
    });

    test('profitable only drops losses and every unpriced row', () => {
        const names = arrangeCraftEnhanceRows(all, { profitableOnly: true }).map((r) => r.itemName);
        expect(names).toEqual(['better', 'good']);
    });

    test('profitable only never lets a row with a missing price through, even with a huge sale', () => {
        expect(arrangeCraftEnhanceRows([unpricedInput], { profitableOnly: true })).toEqual([]);
        expect(arrangeCraftEnhanceRows([noQuote], { profitableOnly: true })).toEqual([]);
    });

    test('a zero-profit row is not profitable', () => {
        const flat = row('flat', { saleN: 100 });
        expect(flat.target.profitPerUnit).toBe(0);
        expect(arrangeCraftEnhanceRows([flat], { profitableOnly: true })).toEqual([]);
    });

    test('filters by skill, name and craftability', () => {
        const tailor = buildCraftEnhanceRow({
            ...{
                recipe: recipe('robe', '/skills/tailoring', false),
                priced: { costPerAction: 0, unpriced: [], dungeonInputs: [] },
                figures: { craftCostPerUnit: 60, secondsPerUnit: 36, otherNetPerUnit: 0 },
                craftXpPerUnit: 20,
                targetLevel: 5,
                enhance: { cost: 40, seconds: 36, xp: 30 },
                saleBase: 200,
                saleTarget: 300,
            },
        });
        const rows = [good, tailor];
        expect(arrangeCraftEnhanceRows(rows, { skillHrid: '/skills/tailoring' }).map((r) => r.itemName)).toEqual([
            'robe',
        ]);
        expect(arrangeCraftEnhanceRows(rows, { query: ' GOO ' }).map((r) => r.itemName)).toEqual(['good']);
        expect(arrangeCraftEnhanceRows(rows, { craftableOnly: true }).map((r) => r.itemName)).toEqual(['good']);
    });

    test('an unknown sort key falls back to profit per hour, and empty input is fine', () => {
        expect(arrangeCraftEnhanceRows(all, { sort: 'nope' })[0].itemName).toBe('better');
        expect(arrangeCraftEnhanceRows(null)).toEqual([]);
    });

    test('rows missing only the sort key sink behind rows that have it', () => {
        const noXp = row('noxp', { saleN: 900, enhance: { cost: 40, seconds: 36, xp: 0, xpKnown: false } });
        const names = arrangeCraftEnhanceRows([noXp, good], { sort: 'enhanceXp' }).map((r) => r.itemName);
        expect(names).toEqual(['good', 'noxp']);
    });

    test('zero units a day is not the same as unpriced: a measured zero volume does not touch the ranking', () => {
        const flagged = { ...better, volume: { known: true, unitsPerDay: 0 } };
        expect(arrangeCraftEnhanceRows([good, flagged])[0].itemName).toBe('better');
    });
});

describe('chooseEnhanceRoute', () => {
    const run = (cost, extra = {}) => ({ cost, seconds: 60, xp: 10, xpKnown: true, ...extra });

    test('the cheaper priced route wins and says what it saves', () => {
        expect(chooseEnhanceRoute({ level: 5, direct: run(500), viaBase: run(300) })).toEqual(
            expect.objectContaining({ route: 'refine-base', directCost: 500, baseCost: 300, saved: 200 })
        );
        expect(chooseEnhanceRoute({ level: 5, direct: run(300), viaBase: run(500) })).toEqual(
            expect.objectContaining({ route: 'craft', saved: 200 })
        );
    });

    test('a tie keeps the direct route', () => {
        const chosen = chooseEnhanceRoute({ level: 5, direct: run(400), viaBase: run(400) });
        expect(chosen.route).toBe('craft');
        expect(chosen.saved).toBe(0);
    });

    test('a route that cannot be priced is not a candidate, never a free one', () => {
        expect(chooseEnhanceRoute({ level: 5, direct: run(500), viaBase: null }).enhance.cost).toBe(500);
        const baseOnly = chooseEnhanceRoute({ level: 5, direct: null, viaBase: run(300) });
        expect(baseOnly).toEqual(expect.objectContaining({ route: 'refine-base', directCost: null, saved: 0 }));
        const none = chooseEnhanceRoute({ level: 5, direct: null, viaBase: null });
        expect(none.route).toBeNull();
        expect(none.enhance).toBeNull();
    });

    test('a cost of 0 is a priced route, not a missing one', () => {
        expect(chooseEnhanceRoute({ level: 5, direct: run(500), viaBase: run(0) }).route).toBe('refine-base');
    });

    test('at +0 or below nothing is enhanced, so there is no route', () => {
        for (const level of [0, -1]) {
            const chosen = chooseEnhanceRoute({ level, direct: run(500), viaBase: run(300) });
            expect(chosen.route).toBeNull();
            expect(chosen.enhance).toBeNull();
        }
    });
});

describe('buildCraftEnhanceRow with a base route', () => {
    const run = (cost, seconds) => ({ cost, seconds, xp: 10, xpKnown: true });

    test('the base route replaces the direct run at +N, and +0 is untouched', () => {
        const built = row('ring', { over: { enhance: run(500, 36), viaBase: run(300, 20), baseHrid: '/items/ring' } });
        expect(built.route).toEqual(expect.objectContaining({ route: 'refine-base', offered: true }));
        expect(built.target.enhanceCost).toBe(300);
        expect(built.target.profitPerUnit).toBe(300 - 60 - 300);
        expect(built.base.enhanceCost).toBe(0);
        expect(built.base.profitPerUnit).toBe(200 - 60);
    });

    test('a row built the old way (no base) is unchanged and says no route was offered', () => {
        const built = row('sword');
        expect(built.route.offered).toBe(false);
        expect(built.route.route).toBe('craft');
        expect(built.target.enhanceCost).toBe(40);
    });

    test('target +0 has no route and rates the craft alone', () => {
        const built = row('ring', {
            over: { targetLevel: 0, enhance: run(500, 36), viaBase: run(300, 20), baseHrid: '/items/ring' },
        });
        expect(built.route.route).toBeNull();
        expect(built.target.enhanceCost).toBe(0);
        expect(built.target.status).toBe('ok');
    });

    test('a priced route does not rescue an unpriced input', () => {
        const built = row('ring', {
            over: {
                enhance: null,
                viaBase: run(300, 20),
                baseHrid: '/items/ring',
                priced: {
                    costPerAction: 0,
                    unpriced: [{ itemHrid: '/items/ring', reason: 'input' }],
                    dungeonInputs: [],
                },
            },
        });
        expect(built.target.status).toBe('unpriced');
        expect(built.target.craftCostPerUnit).toBeNull();
    });
});

describe('priceCraftMaterials with amountOf (Artisan worst case)', () => {
    const line = (itemHrid, baseAmount, amount, askPrice) => ({
        itemHrid,
        baseAmount,
        amount,
        askPrice,
        totalCost: amount * askPrice,
        missingPrice: false,
    });

    test('an ordinary input is billed at the supplied amount times its buy price', () => {
        const priced = priceCraftMaterials({
            materials: [line('/items/cheese', 8, 6.8, 5)],
            index: { drops: new Map(), tokenShop: new Map() },
            ownedMode: OWNED_MODES.MARKET,
            heldPool: plenty,
            amountOf: () => 7,
        });
        expect(priced.costPerAction).toBe(35);
    });

    test('a dungeon input is billed at the supplied amount at its own value', () => {
        const priced = priceCraftMaterials({
            materials: [line('/items/griffin_leather', 2, 1.7, 1000)],
            index: { drops: new Map([['/items/griffin_leather', { dungeons: ['Den'] }]]), tokenShop: new Map() },
            ownedMode: OWNED_MODES.MARKET,
            heldPool: plenty,
            valueDrop: () => 960,
            amountOf: () => 2,
        });
        expect(priced.costPerAction).toBe(1920);
        expect(priced.dungeonInputs[0].amount).toBe(2);
    });

    test('without amountOf the calculator figures stand', () => {
        const priced = priceCraftMaterials({
            materials: [line('/items/cheese', 8, 6.8, 5)],
            index: { drops: new Map(), tokenShop: new Map() },
            ownedMode: OWNED_MODES.MARKET,
            heldPool: plenty,
        });
        expect(priced.costPerAction).toBeCloseTo(34, 9);
    });

    test('an unpriced input stays unpriced whatever the amount', () => {
        const priced = priceCraftMaterials({
            materials: [{ ...line('/items/cheese', 8, 6.8, 0), missingPrice: true }],
            index: { drops: new Map(), tokenShop: new Map() },
            ownedMode: OWNED_MODES.MARKET,
            heldPool: plenty,
            amountOf: () => 7,
        });
        expect(priced.unpriced).toEqual([{ itemHrid: '/items/cheese', reason: 'input' }]);
    });
});

describe('buildHeldPool', () => {
    const stack = (itemHrid, count, enhancementLevel = 0, itemLocationHrid = '/item_locations/inventory') => ({
        itemHrid,
        count,
        enhancementLevel,
        itemLocationHrid,
    });

    test('no inventory loaded is null, not an empty pool', () => {
        expect(buildHeldPool(null)).toBeNull();
        expect(buildHeldPool(undefined)).toBeNull();
        expect(buildHeldPool([])).toEqual(new Map());
    });

    test('only inventory stacks count, summed per item and level; equipped and empty stacks do not', () => {
        const pool = buildHeldPool([
            stack('/items/griffin_leather', 2),
            stack('/items/griffin_leather', 3),
            stack('/items/griffin_leather', 4, 3),
            stack('/items/griffin_leather', 9, 0, '/item_locations/main_hand'),
            stack('/items/cheese', 0),
        ]);
        expect(pool.get('/items/griffin_leather:0')).toBe(5);
        expect(pool.get('/items/griffin_leather:3')).toBe(4);
        expect(pool.has('/items/cheese:0')).toBe(false);
    });
});

describe('priceCraftMaterials: what is held versus bought within one recipe', () => {
    const valueDrop = (hrid) => ({ '/items/griffin_leather': 960 })[hrid] ?? null;
    const valueToken = (hrid) => ({ '/items/shop_cloth': 480 })[hrid] ?? null;
    const held = (count, hrid = '/items/griffin_leather') => new Map([[`${hrid}:0`, count]]);
    const price = (over) =>
        priceCraftMaterials({
            materials: [mat('/items/griffin_leather', 2, 1000)],
            index,
            ownedMode: OWNED_MODES.MARKET,
            valueDrop,
            valueToken,
            ...over,
        });

    test('2 needed, 1 held: one unit at the owned price, one at the buy price', () => {
        const priced = price({ heldPool: held(1) });
        expect(priced.costPerAction).toBe(960 + 1000);
        expect(priced.dungeonInputs).toEqual([
            expect.objectContaining({ amount: 1, unitValue: 960, via: 'sale', held: true }),
            expect.objectContaining({ amount: 1, unitValue: 1000, via: 'buy', held: false }),
        ]);
        expect(priced.heldInputs).toEqual([
            { itemHrid: '/items/griffin_leather', needed: 2, held: 1, bought: 1, stock: 1 },
        ]);
    });

    test('0 held, an empty inventory: everything is bought', () => {
        const priced = price({ heldPool: new Map() });
        expect(priced.costPerAction).toBe(2000);
        expect(priced.dungeonInputs.every((input) => !input.held)).toBe(true);
    });

    test('exactly enough, and more than enough: all owned, nothing bought', () => {
        for (const count of [2, 50]) {
            const priced = price({ heldPool: held(count) });
            expect(priced.costPerAction).toBe(1920);
            expect(priced.dungeonInputs).toEqual([expect.objectContaining({ amount: 2, held: true })]);
            expect(priced.heldInputs[0]).toEqual(expect.objectContaining({ held: 2, bought: 0, stock: count }));
        }
    });

    test('no inventory loaded holds nothing (the safe direction), and the pool handed in is not drawn down', () => {
        const pool = held(5);
        expect(price({ heldPool: null }).costPerAction).toBe(2000);
        expect(price({ heldPool: pool }).costPerAction).toBe(1920);
        expect(pool.get('/items/griffin_leather:0')).toBe(5);
    });

    test('one stack serves two lines of one recipe once, never twice', () => {
        const priced = price({
            materials: [mat('/items/griffin_leather', 1, 1000), mat('/items/griffin_leather', 2, 1000)],
            heldPool: held(2),
        });
        // 3 needed, 2 held: 2 owned and 1 bought, not 3 owned
        expect(priced.costPerAction).toBe(2 * 960 + 1000);
        expect(priced.heldInputs).toEqual([
            { itemHrid: '/items/griffin_leather', needed: 3, held: 2, bought: 1, stock: 2 },
        ]);
    });

    test('a fractional (Artisan) amount splits fractionally', () => {
        const priced = price({ materials: [mat('/items/griffin_leather', 1.7, 1000)], heldPool: held(1) });
        expect(priced.costPerAction).toBeCloseTo(960 + 0.7 * 1000, 9);
    });

    test('an enhanced stack is not a +0 input', () => {
        const priced = price({ heldPool: new Map([['/items/griffin_leather:3', 9]]) });
        expect(priced.costPerAction).toBe(2000);
    });

    test('sunk: the held units are 0 and the shortfall is bought', () => {
        const priced = price({ ownedMode: OWNED_MODES.SUNK, heldPool: held(1) });
        expect(priced.costPerAction).toBe(1000);
        expect(priced.dungeonInputs).toEqual([
            expect.objectContaining({ amount: 1, unitValue: 0, sunk: true, held: true }),
            expect.objectContaining({ amount: 1, unitValue: 1000, sunk: false, held: false }),
        ]);
    });

    test('buy mode ignores a full inventory', () => {
        const priced = price({ ownedMode: OWNED_MODES.BUY, heldPool: held(99) });
        expect(priced.costPerAction).toBe(2000);
        expect(priced.dungeonInputs).toEqual([expect.objectContaining({ amount: 2, via: 'buy', held: false })]);
        expect(priced.heldInputs).toEqual([]);
    });

    test('the shortfall of a token-shop item takes the cheaper token route', () => {
        const priced = price({
            materials: [mat('/items/shop_cloth', 3, 9999)],
            heldPool: held(1, '/items/shop_cloth'),
            valueDrop: () => null,
        });
        // 1 held at its token value, 2 bought through tokens (cheaper than the 9999 ask)
        expect(priced.costPerAction).toBe(3 * 480);
    });

    test('an unpriced shortfall makes the whole line unpriced, never a partial sum', () => {
        const priced = price({
            materials: [mat('/items/griffin_leather', 2, 0, { missingPrice: true })],
            heldPool: held(1),
        });
        expect(priced.unpriced).toEqual([{ itemHrid: '/items/griffin_leather', reason: 'dungeon-input' }]);
        expect(priced.dungeonInputs).toEqual([]);
    });

    test('an unpriced held part makes the whole line unpriced even when the shortfall has a price', () => {
        const priced = price({ valueDrop: () => null, heldPool: held(1) });
        expect(priced.unpriced).toEqual([{ itemHrid: '/items/griffin_leather', reason: 'dungeon-input' }]);
    });

    test('a line wholly held needs no buy price, and a line wholly bought needs no sale value', () => {
        const noAsk = [mat('/items/griffin_leather', 2, 0, { missingPrice: true })];
        expect(price({ materials: noAsk, heldPool: held(2) }).unpriced).toEqual([]);
        expect(price({ valueDrop: () => null, heldPool: new Map() }).unpriced).toEqual([]);
    });
});

describe('buildCraftEnhanceRow with a held base', () => {
    const run = (cost, seconds = 20) => ({ cost, seconds, xp: 10, xpKnown: true });
    const held = (over = {}) => ({
        level: 3,
        count: 1,
        unitValue: 50,
        via: 'sale',
        enhance: run(100),
        craftCostPerUnit: 40,
        secondsPerUnit: 30,
        otherNetPerUnit: 0,
        craftXpPerUnit: 15,
        ...over,
    });
    const via = (heldBases, over = {}) =>
        row('ring', { over: { enhance: run(500), viaBase: run(300), baseHrid: '/items/ring', heldBases, ...over } });

    test('a held base that is cheaper in craft plus enhancement wins and rates the target with its own figures', () => {
        const built = via([held()]);
        expect(built.route.route).toBe('held-base');
        // Fresh best is 60 + 300 = 360; the held base is 40 + 100 = 140
        expect(built.route.heldBase).toEqual(expect.objectContaining({ level: 3, total: 140, saved: 220 }));
        expect(built.target.craftCostPerUnit).toBe(40);
        expect(built.target.enhanceCost).toBe(100);
        expect(built.target.craftXpPerHour).toBeCloseTo((15 * 3600) / (30 + 20), 6);
    });

    test('a held base never lowers the +0 figure', () => {
        expect(via([held({ level: 3 })]).base).toEqual(via([]).base);
    });

    test('compared on craft plus enhancement: a cheap enhancement does not win when the base costs more', () => {
        const built = via([held({ unitValue: 900, craftCostPerUnit: 900, enhance: run(10) })]);
        expect(built.route.route).toBe('refine-base');
        expect(built.target.craftCostPerUnit).toBe(60);
    });

    test('the cheapest of several held levels wins; a tie keeps the fresh route', () => {
        const built = via([
            held({ level: 1, enhance: run(250), craftCostPerUnit: 40 }),
            held({ level: 4, enhance: run(30), craftCostPerUnit: 45 }),
        ]);
        expect(built.route.heldBase.level).toBe(4);
        const tie = via([held({ enhance: run(300), craftCostPerUnit: 60 })]);
        expect(tie.route.route).toBe('refine-base');
    });

    test('an unpriceable candidate is never chosen and never counts as free', () => {
        expect(via([held({ enhance: null })]).route.route).toBe('refine-base');
        expect(via([held({ craftCostPerUnit: null })]).route.route).toBe('refine-base');
    });

    test('when the fresh routes cannot be priced, a priceable held base is the answer and nothing was compared', () => {
        const built = via([held()], { enhance: null, viaBase: null });
        expect(built.route.route).toBe('held-base');
        expect(built.route.heldBase.saved).toBeNull();
        expect(built.target.status).toBe('ok');
    });

    test('an unpriced bought input does not block a held base, which was priced without it', () => {
        const built = via([held()], {
            priced: { costPerAction: 0, unpriced: [{ itemHrid: '/items/ring', reason: 'input' }], dungeonInputs: [] },
        });
        expect(built.route.route).toBe('held-base');
        expect(built.base.status).toBe('unpriced');
        expect(built.target.status).toBe('ok');
    });

    test('with no held base the row is as before', () => {
        const built = via([]);
        expect(built.route.route).toBe('refine-base');
        expect(built.route.heldBase).toBeNull();
    });

    test('sunk hrids are listed once, and only for units actually counted', () => {
        const built = row('ring', {
            over: {
                priced: {
                    costPerAction: 0,
                    unpriced: [],
                    dungeonInputs: [
                        { itemHrid: '/items/a', amount: 1, unitValue: 0, sunk: true, held: true },
                        { itemHrid: '/items/a', amount: 1, unitValue: 5, sunk: false, held: false },
                        { itemHrid: '/items/b', amount: 0, unitValue: 0, sunk: true, held: true },
                    ],
                },
            },
        });
        expect(built.sunkInputs).toEqual(['/items/a']);
    });
});

describe('priceCraftMaterials: the stock is spread over one hour of crafts', () => {
    const valueDrop = (hrid) => ({ '/items/griffin_leather': 960 })[hrid] ?? null;
    const held = (count, hrid = '/items/griffin_leather') => new Map([[`${hrid}:0`, count]]);
    const price = (over) =>
        priceCraftMaterials({
            materials: [mat('/items/griffin_leather', 2, 1000)],
            index,
            ownedMode: OWNED_MODES.MARKET,
            valueDrop,
            valueToken: () => null,
            craftsPerHour: 10,
            ...over,
        });

    test('stock below the hour need: 2 a craft, 1 held, 10 crafts is 1 owned and 19 bought, over 10 crafts', () => {
        const priced = price({ heldPool: held(1) });
        expect(priced.costPerAction).toBeCloseTo((960 + 19 * 1000) / 10, 9);
        expect(priced.heldInputs).toEqual([
            { itemHrid: '/items/griffin_leather', needed: 20, held: 1, bought: 19, stock: 1 },
        ]);
        // Never below what the hour costs: it is not the one-craft price of 960 + 1000 either
        expect(priced.costPerAction).toBeGreaterThan((960 + 1000) / 2);
        expect(priced.perCraftFallback).toBe(false);
    });

    test('stock equal to the hour need prices every unit as owned', () => {
        const priced = price({ heldPool: held(20) });
        expect(priced.costPerAction).toBeCloseTo((20 * 960) / 10, 9);
        expect(priced.heldInputs[0]).toEqual(expect.objectContaining({ held: 20, bought: 0 }));
    });

    test('stock above the hour need is the same as equal: only the hour is priced', () => {
        const priced = price({ heldPool: held(500) });
        expect(priced.costPerAction).toBeCloseTo(1920, 9);
        expect(priced.heldInputs[0]).toEqual(expect.objectContaining({ needed: 20, held: 20, bought: 0, stock: 500 }));
    });

    test('two lines of one item share one stock over the hour', () => {
        const priced = price({
            materials: [mat('/items/griffin_leather', 1, 1000), mat('/items/griffin_leather', 2, 1000)],
            heldPool: held(15),
        });
        // 30 needed in the hour, 15 held: 15 owned and 15 bought
        expect(priced.costPerAction).toBeCloseTo((15 * 960 + 15 * 1000) / 10, 9);
        expect(priced.heldInputs).toEqual([
            { itemHrid: '/items/griffin_leather', needed: 30, held: 15, bought: 15, stock: 15 },
        ]);
    });

    test('sunk spreads the same way: held units are 0, the rest of the hour is bought', () => {
        const priced = price({ ownedMode: OWNED_MODES.SUNK, heldPool: held(5) });
        expect(priced.costPerAction).toBeCloseTo((15 * 1000) / 10, 9);
    });

    test('buy mode ignores the stock whatever the hour', () => {
        expect(price({ ownedMode: OWNED_MODES.BUY, heldPool: held(500) }).costPerAction).toBe(2000);
    });

    test('crafts per hour missing or 0 falls back to one craft and says so', () => {
        for (const craftsPerHour of [null, 0, undefined, Number.NaN]) {
            const priced = price({ craftsPerHour, heldPool: held(1) });
            expect(priced.costPerAction).toBe(960 + 1000);
            expect(priced.perCraftFallback).toBe(true);
        }
    });

    test('a fractional (Artisan) per-craft amount is spread over the hour too', () => {
        const priced = price({ materials: [mat('/items/griffin_leather', 1.7, 1000)], heldPool: held(5) });
        // 17 needed in the hour, 5 held
        expect(priced.costPerAction).toBeCloseTo((5 * 960 + 12 * 1000) / 10, 9);
    });

    test('an unpriced bought part still makes the line unpriced when the hour needs more than is held', () => {
        const priced = price({
            materials: [mat('/items/griffin_leather', 2, 0, { missingPrice: true })],
            heldPool: held(19),
        });
        expect(priced.unpriced).toHaveLength(1);
    });
});

describe('buildCraftEnhanceRow: a held base that covers part of the hour', () => {
    const run = (cost, seconds = 20) => ({ cost, seconds, xp: 10, xpKnown: true });
    const candidate = (coverage, over = {}) => ({
        level: 3,
        count: 1,
        coverage,
        unitValue: 50,
        via: 'sale',
        enhance: run(100, 10),
        craftCostPerUnit: 40,
        secondsPerUnit: 30,
        otherNetPerUnit: 0,
        craftXpPerUnit: 15,
        ...over,
    });
    const via = (heldBases, over = {}) =>
        row('ring', { over: { enhance: run(500), viaBase: run(300), baseHrid: '/items/ring', heldBases, ...over } });

    test('the held base serves its share and the rest takes the fresh route cost, blended per craft', () => {
        const built = via([candidate(0.25)]);
        // Fresh: craft 60, enhance 300 (36 s craft). Held: craft 40, enhance 100. A quarter held:
        expect(built.route.route).toBe('held-base');
        expect(built.route.heldBase.coverage).toBe(0.25);
        expect(built.target.craftCostPerUnit).toBeCloseTo(0.25 * 40 + 0.75 * 60, 9);
        expect(built.target.enhanceCost).toBeCloseTo(0.25 * 100 + 0.75 * 300, 9);
        // Never below the fully held figure, never above the fresh one
        expect(built.target.craftCostPerUnit + built.target.enhanceCost).toBeGreaterThan(140);
        expect(built.target.craftCostPerUnit + built.target.enhanceCost).toBeLessThan(360);
    });

    test('full coverage is the held figure alone', () => {
        const built = via([candidate(1)]);
        expect(built.target.craftCostPerUnit).toBe(40);
        expect(built.target.enhanceCost).toBe(100);
    });

    test('part coverage cannot be rated when the fresh routes cannot be priced: no figure for the uncovered crafts', () => {
        const built = via([candidate(0.5)], { enhance: null, viaBase: null });
        expect(built.route.route).not.toBe('held-base');
        expect(built.target.status).toBe('unpriced');
        // Full coverage has no uncovered crafts, so it still stands
        expect(via([candidate(1)], { enhance: null, viaBase: null }).route.route).toBe('held-base');
    });

    test('a candidate that serves nothing is not a candidate', () => {
        expect(via([candidate(0)]).route.route).toBe('refine-base');
    });

    test('unknown crafting XP on the fresh side leaves the blended XP unknown, not the held figure alone', () => {
        const built = via([candidate(0.5)], { craftXpPerUnit: null });
        expect(built.target.craftXpPerHour).toBeNull();
    });
});

describe('crafted protection copies in the level and the blend', () => {
    const copies = { cost: 40, seconds: 36, xp: 30, xpKnown: true, extraCraftSeconds: 72, extraCraftXp: 40 };
    const level = (enhance) =>
        evaluateLevel({
            level: 5,
            craftCostPerUnit: 60,
            unpricedInputs: [],
            secondsPerUnit: 36,
            otherNetPerUnit: 0,
            craftXpPerUnit: 20,
            enhance,
            saleAfterTax: 300,
        });

    test('the copies crafted add their seconds to the cycle and their XP to the craft XP, not the enhancing XP', () => {
        const rated = level(copies);
        // 36 craft + 36 enhance + 72 for the copies
        expect(rated.unitsPerHour).toBeCloseTo(3600 / 144, 6);
        expect(rated.craftXpPerHour).toBeCloseTo(60 * (3600 / 144), 6);
        expect(rated.enhanceXpPerHour).toBeCloseTo(30 * (3600 / 144), 6);
        // The cost is the run's; the copies' price is already inside it
        expect(rated.profitPerUnit).toBe(300 - 60 - 40);
    });

    test('a quote with no such fields is rated as before', () => {
        const rated = level({ cost: 40, seconds: 36, xp: 30 });
        expect(rated.unitsPerHour).toBeCloseTo(50, 6);
        expect(rated.craftXpPerHour).toBeCloseTo(1000, 6);
    });

    test('copies whose crafting XP is unknown leave the craft XP null, and the profit alone', () => {
        const rated = level({ ...copies, extraCraftXp: null });
        expect(rated.craftXpPerHour).toBeNull();
        expect(rated.profitPerHour).toBeGreaterThan(0);
    });

    test('a held base blends the copies of its part and of the fresh part, and unknown XP stays unknown', () => {
        const heldRun = {
            cost: 100,
            seconds: 10,
            xp: 10,
            xpKnown: true,
            selfCopyCrafts: 1,
            extraCraftSeconds: 10,
            extraCraftXp: 4,
        };
        const candidate = (over = {}) => ({
            level: 3,
            count: 1,
            coverage: 0.5,
            unitValue: 50,
            via: 'sale',
            enhance: heldRun,
            craftCostPerUnit: 40,
            secondsPerUnit: 30,
            otherNetPerUnit: 0,
            craftXpPerUnit: 15,
            ...over,
        });
        const fresh = {
            cost: 500,
            seconds: 20,
            xp: 10,
            xpKnown: true,
            selfCopyCrafts: 3,
            extraCraftSeconds: 30,
            extraCraftXp: 12,
        };
        const build = (heldBase, freshRun = fresh) =>
            row('ring', {
                over: { enhance: freshRun, viaBase: freshRun, baseHrid: '/items/ring', heldBases: [heldBase] },
            });
        const built = build(candidate());
        expect(built.route.route).toBe('held-base');
        expect(built.route.enhance.selfCopyCrafts).toBeCloseTo(2, 9);
        expect(built.route.enhance.extraCraftSeconds).toBeCloseTo(20, 9);
        expect(built.route.enhance.extraCraftXp).toBeCloseTo(8, 9);
        const unknownHeld = build(candidate({ enhance: { ...heldRun, extraCraftXp: null } }));
        expect(unknownHeld.target.craftXpPerHour).toBeNull();
        expect(build(candidate(), { ...fresh, extraCraftXp: null }).target.craftXpPerHour).toBeNull();
        // Full coverage has no fresh part to be unknown
        const whole = build(candidate({ coverage: 1 }), { ...fresh, extraCraftXp: null });
        expect(whole.target.craftXpPerHour).not.toBeNull();
    });
});

describe('capProfitByVolume', () => {
    const lvl = (over = {}) => ({
        status: 'ok',
        profitPerUnit: 200,
        unitsPerHour: 50,
        profitPerHour: 10000,
        ...over,
    });

    test('a measured volume under the hourly output holds the hour to what the market takes', () => {
        const capped = capProfitByVolume(lvl(), { known: true, unitsPerDay: 240 });
        // 10 an hour at 200 each
        expect(capped).toEqual({ capped: true, profitPerHour: 2000, uncappedPerHour: 10000, unitsPerHourCap: 10 });
    });

    test('a volume at or above the hourly output changes nothing', () => {
        expect(capProfitByVolume(lvl(), { known: true, unitsPerDay: 1200 }).capped).toBe(false);
        expect(capProfitByVolume(lvl(), { known: true, unitsPerDay: 5000 }).profitPerHour).toBe(10000);
    });

    test('a measured 0 caps to 0, but unknown, missing and malformed volumes are not 0', () => {
        expect(capProfitByVolume(lvl(), { known: true, unitsPerDay: 0 }).profitPerHour).toBe(0);
        for (const volume of [null, undefined, { known: false, unitsPerDay: 0 }, { unitsPerDay: 0 }, { known: true }]) {
            const none = capProfitByVolume(lvl(), volume);
            expect(none.capped).toBe(false);
            expect(none.profitPerHour).toBe(10000);
        }
        expect(capProfitByVolume(lvl(), { known: true, unitsPerDay: -5 }).capped).toBe(false);
    });

    test('a losing level and a level without a full figure are not capped', () => {
        const volume = { known: true, unitsPerDay: 0 };
        const losing = capProfitByVolume(lvl({ profitPerUnit: -10, profitPerHour: -500 }), volume);
        expect(losing).toEqual(expect.objectContaining({ capped: false, profitPerHour: -500 }));
        const unpriced = capProfitByVolume(
            lvl({ status: 'unpriced', profitPerUnit: null, profitPerHour: null }),
            volume
        );
        expect(unpriced).toEqual(expect.objectContaining({ capped: false, profitPerHour: null }));
        expect(capProfitByVolume(null, volume).profitPerHour).toBeNull();
    });
});

describe('the sweep from +0 to the target and its best level', () => {
    const run = (cost, seconds = 0) => ({ cost, seconds, xp: 10, xpKnown: true });
    // 100 units an hour at +0: 36 s a craft, 60 coins each. A level's hour is (sale - 60 - run cost) x 3600 / (36 + seconds)
    const spec = (level, saleAfterTax, enhance, over = {}) => ({
        level,
        saleAfterTax,
        enhance,
        viaBase: null,
        ...over,
    });
    const swept = (levels, over = {}) => row('ring', { saleN: 400, enhance: run(100), over: { levels, ...over } });
    const hours = (built) => built.sweep.map((entry) => [entry.level, entry.status, entry.profitPerHour]);

    test('+0 and the target are the row own figures: one function rates every level', () => {
        const built = swept([spec(1, 260, run(20)), spec(2, 300, run(50, 36))]);
        expect(built.sweep.map((entry) => entry.level)).toEqual([0, 1, 2, 5]);
        expect(built.sweep[0]).toEqual(expect.objectContaining({ ...built.base, route: null }));
        expect(built.sweep[3]).toEqual(expect.objectContaining({ ...built.target, route: built.route.route }));
        expect(built.sweep[1].profitPerHour).toBeCloseTo((260 - 60 - 20) * 100, 6);
        expect(built.sweep[2].profitPerHour).toBeCloseTo((300 - 60 - 50) * 50, 6);
    });

    test('the best level is the highest profit per hour, target included', () => {
        const built = swept([spec(1, 260, run(20)), spec(2, 300, run(50, 36))]);
        // +1: 18000, +2: 9500, +5: 24000, +0: 14000
        expect(built.best).toEqual(expect.objectContaining({ level: 5, profitPerHour: 24000 }));
        const lowerTarget = row('ring', { saleN: 200, enhance: run(100), over: { levels: [spec(1, 260, run(20))] } });
        expect(lowerTarget.best.level).toBe(1);
    });

    test('a level with no sale quote or an enhancement that cannot be priced is skipped, not counted as 0', () => {
        const built = swept([spec(1, null, run(20)), spec(2, 900, null), spec(3, 260, run(20))]);
        expect(built.sweep[1]).toEqual(expect.objectContaining({ status: 'unpriced', profitPerHour: null }));
        expect(built.sweep[1].reasons).toEqual(['sale']);
        expect(built.sweep[2].reasons).toEqual(['enhance']);
        // The skipped levels would have won (900) or been 0: neither
        expect(built.best.level).toBe(5);
        expect(hours(built).filter(([, status]) => status === 'unpriced')).toHaveLength(2);
    });

    test('a negative best is still the best, and nothing priced at all has no best', () => {
        const losing = row('ring', {
            sale0: 10,
            saleN: 20,
            enhance: run(400),
            over: { levels: [spec(1, 15, run(100))] },
        });
        expect(losing.best.level).toBe(0);
        expect(losing.best.profitPerHour).toBeLessThan(0);
        const none = row('ring', { sale0: null, saleN: null, over: { levels: [spec(1, null, run(20))] } });
        expect(none.best).toBeNull();
    });

    test('a tie goes to the lower level', () => {
        // +1 and +2 both 18000 an hour (90 units at 200, 100 units at 180)
        const built = swept([spec(1, 260, run(20)), spec(2, 280, run(20, 4))], { enhance: run(100) });
        expect(built.sweep[1].profitPerHour).toBeCloseTo(18000, 6);
        expect(built.sweep[2].profitPerHour).toBeCloseTo(18000, 6);
        const tied = row('ring', {
            saleN: 9,
            enhance: run(100),
            over: { levels: [spec(1, 260, run(20)), spec(2, 280, run(20, 4))] },
        });
        expect(tied.best.level).toBe(1);
        expect(
            bestLevelOf([
                { level: 0, status: 'ok', profitPerHour: 5 },
                { level: 1, status: 'ok', profitPerHour: 5 },
            ]).level
        ).toBe(0);
    });

    test('a held base serves the levels at or above its own, on the same rules as the target', () => {
        const held = {
            level: 3,
            count: 100,
            coverage: 1,
            unitValue: 50,
            via: 'sale',
            enhance: run(10),
            craftCostPerUnit: 20,
            secondsPerUnit: 36,
            otherNetPerUnit: 0,
            craftXpPerUnit: 20,
        };
        const built = row('ring', {
            saleN: 400,
            enhance: run(300),
            over: {
                viaBase: run(300),
                baseHrid: '/items/base',
                levels: [spec(1, 260, run(200)), spec(3, 260, run(200), { heldBases: [{ ...held, enhance: run(0) }] })],
                heldBases: [{ ...held, enhance: run(10) }],
            },
        });
        // Below the held level there is no held base; at and above it the cheaper held route is taken
        expect(built.sweep[1].route).not.toBe('held-base');
        expect(built.sweep[2].level).toBe(3);
        expect(built.sweep[2].route).toBe('held-base');
        expect(built.sweep[3].route).toBe('held-base');
        expect(built.route.route).toBe('held-base');
    });

    test('a row with no levels given holds +0 and the target only', () => {
        const built = row('ring', {});
        expect(built.sweep.map((entry) => entry.level)).toEqual([0, 5]);
    });

    test('levels at or above the target, or below 1, are ignored: the target is rated once', () => {
        const built = swept([spec(0, 999, run(1)), spec(5, 999, run(1)), spec(7, 999, run(1)), spec(2, 260, run(20))]);
        expect(built.sweep.map((entry) => entry.level)).toEqual([0, 2, 5]);
    });
});

describe('a level keeps the better hour of crafted-copy and market-only protection', () => {
    const plain = (cost, seconds = 0) => ({ cost, seconds, xp: 10, xpKnown: true });
    const withCopies = (cost, extraCraftSeconds, marketOnly) => ({
        ...plain(cost),
        selfCopyCrafts: 2,
        extraCraftSeconds,
        extraCraftXp: 0,
        marketOnly,
    });
    const rate = (enhance, over = {}) => row('ring', { saleN: 400, enhance, over });

    test('crafted copies win when cheaper and fast enough, and lose when their crafts cost more hour than they save', () => {
        // Market-only: 400 - 60 - 150 = 190 an item in 36 s. Crafted: 100 an item cheaper in run cost
        const wins = rate(withCopies(50, 10, plain(150)));
        expect(wins.target.enhanceCost).toBe(50);
        const loses = rate(withCopies(50, 200, plain(150)));
        expect(loses.target.enhanceCost).toBe(150);
        expect(loses.route.enhance.selfCopyCrafts ?? 0).toBe(0);
    });

    test('a tie keeps the market-only quote', () => {
        const tie = rate(withCopies(150, 0, plain(150)));
        expect(tie.route.enhance.selfCopyCrafts ?? 0).toBe(0);
    });

    test('a crafted quote is used when the market-only one cannot be priced, and vice versa', () => {
        expect(rate(withCopies(50, 10, null)).target.enhanceCost).toBe(50);
        expect(rate(withCopies(50, 10, null)).target.status).toBe('ok');
    });

    test('the pick is made at swept levels too', () => {
        const built = row('ring', {
            saleN: 400,
            enhance: plain(100),
            over: {
                levels: [{ level: 2, saleAfterTax: 300, enhance: withCopies(50, 500, plain(60)), viaBase: null }],
            },
        });
        expect(built.sweep[1].enhanceCost).toBe(60);
    });

    test('a held base blend picks per level the same way', () => {
        const held = (enhance) => ({
            level: 3,
            count: 100,
            coverage: 1,
            unitValue: 50,
            via: 'sale',
            enhance,
            craftCostPerUnit: 20,
            secondsPerUnit: 36,
            otherNetPerUnit: 0,
            craftXpPerUnit: 20,
        });
        const built = row('ring', {
            saleN: 400,
            enhance: plain(300),
            over: {
                viaBase: plain(300),
                baseHrid: '/items/base',
                heldBases: [held(withCopies(10, 5000, plain(40)))],
            },
        });
        expect(built.route.route).toBe('held-base');
        expect(built.target.enhanceCost).toBe(40);
    });
});
