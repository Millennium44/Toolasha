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
    craftUnitFigures,
    dungeonInputKind,
    evaluateLevel,
    hasDungeonInput,
    normalizeOwnedMode,
    normalizeTargetLevel,
    priceCraftMaterials,
} from './craft-enhance-rank.js';

/** A small slice of the game's data, in the shapes it emits */
const gameData = {
    actionDetailMap: {
        '/actions/combat/chimerical_den': {
            name: 'Chimerical Den',
            combatZoneInfo: {
                isDungeon: true,
                dungeonInfo: {
                    rewardDropTable: [
                        { itemHrid: '/items/chimerical_chest' },
                        { itemHrid: '/items/griffin_leather' },
                        { itemHrid: '/items/coin' },
                    ],
                },
            },
        },
        '/actions/combat/fly': { name: 'Fly', combatZoneInfo: { isDungeon: false, fightInfo: {} } },
    },
    itemDetailMap: {},
    openableLootDropMap: {
        '/items/chimerical_chest': [{ itemHrid: '/items/chimerical_essence' }, { itemHrid: '/items/coin' }],
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
    test('a dungeon reward, a chest and the chest contents are drops; coins and ordinary zones are not', () => {
        expect([...index.drops.keys()].sort()).toEqual([
            '/items/chimerical_chest',
            '/items/chimerical_essence',
            '/items/griffin_leather',
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

describe('priceCraftMaterials', () => {
    const valueDrop = (hrid) => ({ '/items/griffin_leather': 960 })[hrid] ?? null;
    const valueToken = (hrid) => ({ '/items/shop_cloth': 480 })[hrid] ?? null;

    test('market mode: a non-dungeon input keeps its buy price, a drop is valued at its after-tax sale', () => {
        const priced = priceCraftMaterials({
            materials: [mat('/items/cheese', 10, 5), mat('/items/griffin_leather', 2, 1000)],
            index,
            ownedMode: OWNED_MODES.MARKET,
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
