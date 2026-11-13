/**
 * The tooltip's craft profit follows the action tiles' simulated scrolls: for one fixture action, a tile
 * (calculateProductionProfit inside runWithTileScrolls, exactly as max-produceable does) and the tooltip
 * (calculateTooltipCraftProfit) must give the same figures, with a scroll that adds output (Gourmet) and one
 * that adds efficiency, and the simulation must be put back afterwards.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

const GOURMET = '/buff_types/gourmet';
const EFFICIENCY = '/buff_types/efficiency';
const ACTION = '/actions/cooking/crate';
const TYPE = '/action_types/cooking';

const mocks = vi.hoisted(() => ({
    settings: {},
    chosen: new Set(),
    simulation: {},
    armedDuringCalc: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => mocks.settings[key],
        getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback,
        onSettingChange: () => () => {},
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get scrollSimulationByActionType() {
            return mocks.simulation;
        },
        setScrollSimulation: (type, set) => {
            if (set && set.size > 0) mocks.simulation[type] = set;
            else delete mocks.simulation[type];
        },
        clearScrollSimulation: (type) => {
            delete mocks.simulation[type];
        },
        isBuffBeingSimulated: (type, buff) => Boolean(mocks.simulation[type]?.has(buff)),
        getInitClientData: () => ({
            actionDetailMap: { [ACTION]: actionDetail() },
            communityBuffTypeDetailMap: {},
        }),
        getActionDetails: (hrid) => (hrid === ACTION ? actionDetail() : null),
        getItemDetails: (hrid) => ({ name: hrid.split('/').pop() }),
        getSkills: () => [{ skillHrid: '/skills/cooking', level: 50 }],
        getCommunityBuffLevel: () => 0,
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null } }));
vi.mock('../../utils/bundle-bridge.js', () => ({
    scrollSimulator: () => ({ getScrollSetForActionType: () => mocks.chosen }),
    loadoutSnapshot: () => null,
    guildMemberSkills: () => null,
    marketUndercutAlerts: () => null,
}));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../combat/scroll-simulator.js', () => ({ default: { getScrollSetForActionType: () => mocks.chosen } }));
vi.mock('../../utils/scroll-buff-values.js', () => ({ SELECTION_CHANGED_EVENT: 'x' }));
vi.mock('../actions/scroll-chips.js', () => ({
    SIMULATED_ACTION_TYPES: ['/action_types/cooking'],
    getApplicableScrollBuffs: () => [GOURMET, EFFICIENCY],
    getOwnedScrolls: () => 0,
    getSimulatedScrollNames: (type) =>
        [GOURMET, EFFICIENCY].filter((b) => mocks.simulation[type]?.has(b)).map((b) => b.split('/').pop()),
    scrollItemHrid: () => null,
    shortScrollName: (b) => b.split('/').pop(),
}));
// The efficiency context is where scrolls act: read the armed simulation the way the real one does
vi.mock('../../utils/efficiency.js', () => ({
    getActionEfficiencyContext: () => {
        const armed = mocks.simulation[TYPE];
        mocks.armedDuringCalc.push(armed ? [...armed] : []);
        const eff = armed?.has(EFFICIENCY) ? 20 : 0;
        return {
            equipment: [],
            drinkSlots: [],
            drinkConcentration: 0,
            itemDetailMap: {},
            actionTime: 10,
            artisanBonus: 0,
            gourmetBonus: armed?.has(GOURMET) ? 0.25 : 0,
            processingBonus: 0,
            equipmentEfficiency: 0,
            equipmentEfficiencyItems: [],
            houseEfficiency: 0,
            teaEfficiency: 0,
            achievementEfficiency: 0,
            personalEfficiency: eff,
            actionLevelBonus: 0,
            teaSkillLevelBonus: 0,
            baseRequirement: 1,
            speedBonus: 0,
            personalSpeedBonus: 0,
            efficiencyBreakdown: { totalEfficiency: eff, levelEfficiency: 0, effectiveRequirement: 1 },
            efficiencyMultiplier: 1 + eff / 100,
        };
    },
}));
vi.mock('../../utils/bonus-revenue-calculator.js', () => ({ calculateBonusRevenue: () => null }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    getProductionCost: () => 0,
    getProductionChainTime: () => 0,
}));
vi.mock('../../utils/enhancement-pricing.js', async (importOriginal) => ({
    ...(await importOriginal()),
    getProductionCostDetailed: () => ({ cost: 0, partial: false }),
    getProductionCost: () => 0,
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => ({ '/items/crate': 5000, '/items/flour': 100 })[hrid] ?? null,
    getItemPrices: (hrid) => (hrid === '/items/crate' ? { ask: 5000, bid: 4900 } : null),
    getPricingMode: () => 'ask',
}));
vi.mock('../../utils/profit-constants.js', () => ({ MARKET_TAX: 0.02 }));
vi.mock('../../utils/profit-helpers.js', () => ({
    calculateActionsPerHour: (t) => (t > 0 ? 3600 / Math.max(3, t) : 0),
    calculatePriceAfterTax: (price, tax = 0.02) => price * (1 - tax),
    outputTaxRate: (tax = 0.02) => tax,
    calculateProfitPerAction: (perHour, perHourActions) => (perHourActions > 0 ? perHour / perHourActions : 0),
    calculateProfitPerDay: (perHour) => perHour * 24,
    calculateTeaCostsPerHour: () => ({ costs: [], totalCostPerHour: 0, hasMissingPrices: false }),
    createPriceCache: (fn) => fn,
    resolveItemPrice: (hrid) => ({
        price: { '/items/crate': 5000, '/items/flour': 100 }[hrid] ?? null,
        custom: false,
        missing: false,
    }),
}));

function actionDetail() {
    return {
        type: TYPE,
        inputItems: [{ itemHrid: '/items/flour', count: 40 }],
        outputItems: [{ itemHrid: '/items/crate', count: 1 }],
    };
}

const { calculateProductionProfit } = await import('../actions/production-profit.js');
const { runWithTileScrolls, TILE_SCROLLS_SETTING } = await import('../actions/tile-scrolls.js');
const { calculateTooltipCraftProfit, tooltipScrollSignature } = await import('./tooltip-tile-scrolls.js');
const { default: profitCalculator } = await import('./profit-calculator.js');

/** What the tile computes for the action (max-produceable's call), untaxed toggle off */
async function tileFigures() {
    const { result, simulated } = runWithTileScrolls(TYPE, () => calculateProductionProfit(ACTION));
    return { data: await result, simulated };
}

beforeEach(() => {
    mocks.settings = { simulateScrollEffects: true, [TILE_SCROLLS_SETTING]: true };
    mocks.chosen = new Set();
    mocks.simulation = {};
    mocks.armedDuringCalc = [];
    profitCalculator._itemDetailMap = null;
    profitCalculator._actionDetailMap = null;
});

describe('tooltip craft profit follows the tiles', () => {
    for (const [label, scrolls] of [
        ['an output scroll (Gourmet)', [GOURMET]],
        ['an efficiency scroll', [EFFICIENCY]],
        ['both', [GOURMET, EFFICIENCY]],
    ]) {
        test(`${label}: tile and tooltip agree, and differ from the real figure`, async () => {
            mocks.chosen = new Set(scrolls);
            const tile = await tileFigures();
            const tip = await calculateTooltipCraftProfit('/items/crate');

            expect(tile.simulated.length).toBe(scrolls.length);
            expect(tip.simulated).toEqual(tile.simulated);
            expect(tip.profitData.profitPerHour).toBeCloseTo(tile.data.profitPerHour, 6);
            expect(tip.profitData.profitPerAction).toBeCloseTo(tile.data.profitPerAction, 6);
            expect(tip.profitData.profitPerDay).toBeCloseTo(tile.data.profitPerDay, 6);
            expect(tip.profitData.actionHrid).toBe(ACTION);

            // The real bench figure is still available, and is not the simulated one
            mocks.chosen = new Set();
            const real = await calculateTooltipCraftProfit('/items/crate');
            expect(real.simulated).toEqual([]);
            expect(tip.realProfitData.profitPerHour).toBeCloseTo(real.profitData.profitPerHour, 6);
            expect(tip.profitData.profitPerHour).not.toBeCloseTo(real.profitData.profitPerHour, 2);
        });
    }

    test.each([[[]], [[GOURMET]]])(
        'the personal-use sell-tax toggle moves tile and tooltip together, with scrolls %j',
        async (scrolls) => {
            mocks.chosen = new Set(scrolls);
            mocks.settings.profitCalc_excludeSellTax = false;
            const taxedTile = await tileFigures();
            const taxedTip = await calculateTooltipCraftProfit('/items/crate');
            mocks.settings.profitCalc_excludeSellTax = true;
            const untaxedTile = await tileFigures();
            const untaxedTip = await calculateTooltipCraftProfit('/items/crate');

            expect(taxedTip.profitData.profitPerHour).toBeCloseTo(taxedTile.data.profitPerHour, 6);
            expect(untaxedTip.profitData.profitPerHour).toBeCloseTo(untaxedTile.data.profitPerHour, 6);
            expect(untaxedTip.profitData.excludeSellTax).toBe(true);
            expect(taxedTip.profitData.excludeSellTax).toBe(false);
            // The exclusion really changes the figure, so the agreement above is not two equal constants
            expect(untaxedTip.profitData.profitPerHour).toBeGreaterThan(taxedTip.profitData.profitPerHour);
        }
    );

    test('toggle off or simulation switch off: exactly the real figures, nothing armed', async () => {
        mocks.chosen = new Set([GOURMET, EFFICIENCY]);
        const baseline = (await calculateTooltipCraftProfit('/items/crate')).profitData.profitPerHour;
        for (const off of [TILE_SCROLLS_SETTING, 'simulateScrollEffects']) {
            mocks.settings[off] = false;
            mocks.armedDuringCalc = [];
            const tip = await calculateTooltipCraftProfit('/items/crate');
            expect(tip.simulated).toEqual([]);
            expect(tip.realProfitData).toBe(tip.profitData);
            expect(tip.profitData.profitPerHour).not.toBeCloseTo(baseline, 2);
            expect(mocks.armedDuringCalc.every((a) => a.length === 0)).toBe(true);
            mocks.settings[off] = true;
        }
    });

    test('the simulation is restored afterwards, including a simulation someone else had armed', async () => {
        mocks.chosen = new Set([GOURMET]);
        const mine = new Set([EFFICIENCY]);
        mocks.simulation[TYPE] = mine;
        await calculateTooltipCraftProfit('/items/crate');
        expect(mocks.simulation[TYPE]).toBe(mine);
        delete mocks.simulation[TYPE];
        await calculateTooltipCraftProfit('/items/crate');
        expect(mocks.simulation[TYPE]).toBeUndefined();
    });

    test('an item nothing makes is costed as before', async () => {
        mocks.chosen = new Set([GOURMET]);
        const tip = await calculateTooltipCraftProfit('/items/nothing');
        expect(tip.profitData).toBeNull();
        expect(tip.simulated).toEqual([]);
    });

    test('the signature changes with the toggle and the chosen scrolls (the "already drawn" key)', () => {
        expect(tooltipScrollSignature('/items/crate')).toBe('');
        mocks.chosen = new Set([GOURMET]);
        const one = tooltipScrollSignature('/items/crate');
        mocks.chosen = new Set([EFFICIENCY, GOURMET]);
        const two = tooltipScrollSignature('/items/crate');
        expect(new Set(['', one, two]).size).toBe(3);
        mocks.settings[TILE_SCROLLS_SETTING] = false;
        expect(tooltipScrollSignature('/items/crate')).toBe('');
        expect(tooltipScrollSignature(undefined)).toBe('');
    });
});
