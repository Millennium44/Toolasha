import { describe, test, expect, vi, beforeEach } from 'vitest';

const PHILO_HRID = '/items/philosophers_stone';
const WIDGET_HRID = '/items/test_widget';
const OTHER_HRID = '/items/test_shard';
const REFINED_HRID = '/items/test_cape_refined';
const TEA_HRID = '/items/catalytic_tea';

// The market, as a table. Every price the calculator can reach comes from here.
const mocks = vi.hoisted(() => ({
    prices: {},
    skills: [{ skillHrid: '/skills/alchemy', level: 100 }],
    actionStats: { actionTime: 8, totalEfficiency: 50 },
    bonusDrops: [],
    globalPricingMode: 'hybrid',
}));

vi.mock('../../api/marketplace.js', () => ({
    default: {
        getPrice: (itemHrid, level = 0) => mocks.prices[`${itemHrid}+${level}`] || null,
        fetch: vi.fn(),
        on: () => () => {},
        off: () => {},
        getDataAge: () => 0,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            itemDetailMap: {
                [TEA_HRID]: { name: 'Catalytic Tea', consumableDetail: { buffs: [] } },
                [WIDGET_HRID]: { name: 'Test Widget' },
            },
            actionDetailMap: {
                '/actions/alchemy/transmute': { baseTimeCost: 20e9, type: '/action_types/alchemy' },
            },
        }),
        getSkills: () => mocks.skills,
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (key, fallback) => (key === 'profitCalc_pricingMode' ? mocks.globalPricingMode : fallback),
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
        COLOR_WARNING: '#fa0',
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: { getJSON: async () => null, setJSON: async () => {} },
}));

vi.mock('./alchemy-profit-calculator.js', () => ({
    default: {
        calculateTransmuteProfit: () => ({ dropRevenues: mocks.bonusDrops }),
    },
}));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => mocks.actionStats,
}));

const { PhiloCalculator } = await import('./philo-calculator.js');

/**
 * A transmutable item: half its attempts succeed, 1% of those pay a stone,
 * half return the input, a quarter pay two shards.
 */
function widget(overrides = {}) {
    return {
        name: 'Test Widget',
        itemLevel: 50,
        sellPrice: 100,
        alchemyDetail: {
            transmuteSuccessRate: 0.5,
            bulkMultiplier: 1,
            transmuteDropTable: [
                { itemHrid: PHILO_HRID, dropRate: 0.01, minCount: 1, maxCount: 1 },
                { itemHrid: WIDGET_HRID, dropRate: 0.5, minCount: 1, maxCount: 1 },
                { itemHrid: OTHER_HRID, dropRate: 0.25, minCount: 2, maxCount: 2 },
            ],
            ...overrides,
        },
    };
}

let calc;

beforeEach(() => {
    mocks.prices = {
        [`${PHILO_HRID}+0`]: { ask: 5_000_000, bid: 4_000_000 },
        [`${WIDGET_HRID}+0`]: { ask: 1000, bid: 800 },
        [`${OTHER_HRID}+0`]: { ask: 200, bid: 100 },
        [`${TEA_HRID}+0`]: { ask: 500, bid: 400 },
    };
    mocks.skills = [{ skillHrid: '/skills/alchemy', level: 100 }];
    mocks.actionStats = { actionTime: 8, totalEfficiency: 50 };
    mocks.bonusDrops = [];
    mocks.globalPricingMode = 'hybrid';

    calc = new PhiloCalculator();
    calc.useCatalyst = false;
    calc.useCatalyticTea = false;
    calc.drinkConcentrationLevel = 0;
    calc.loadDefaultPrices();
});

describe('revenue', () => {
    test('every sold drop pays market tax; the self-return does not', () => {
        const row = calc.calculateRow(WIDGET_HRID, widget());

        // Stones and shards are sold (2% tax); the returned widget goes straight
        // back into the transmuter, so it is credited at its full cost basis.
        const stones = 0.5 * 0.01 * 1 * (4_000_000 * 0.98);
        const shards = 0.5 * 0.25 * 2 * (100 * 0.98);
        const selfReturn = 0.5 * 0.5 * 1 * 1000;

        expect(row.ev).toBeCloseTo(stones + shards + selfReturn, 6);
    });

    test('essence and rare bonus drops land in revenue', () => {
        const without = calc.calculateRow(WIDGET_HRID, widget()).ev;

        mocks.bonusDrops = [
            { itemHrid: '/items/alchemy_essence', isEssence: true, revenuePerAttempt: 100 },
            { itemHrid: '/items/large_artisans_crate', isRare: true, revenuePerAttempt: 50 },
            { itemHrid: PHILO_HRID, isEssence: false, isRare: false, revenuePerAttempt: 999_999 },
        ];
        calc._bonusRevenueCache.clear();

        // Bonus drops are taxed like the rest; the ordinary drop rows the
        // alchemy calculator also reports are already counted here and must
        // not be added twice.
        expect(calc.calculateRow(WIDGET_HRID, widget()).ev).toBeCloseTo(without + 150 * 0.98, 6);
    });
});

describe('success rate', () => {
    test('transmuting above your level carries no penalty', () => {
        expect(calc.calculateRow(WIDGET_HRID, widget()).effectiveTransmuteChance).toBeCloseTo(0.5, 10);
    });

    test('being under-levelled cuts the success rate by 0.9/itemLevel per level short', () => {
        mocks.skills = [{ skillHrid: '/skills/alchemy', level: 25 }];
        const row = calc.calculateRow(WIDGET_HRID, widget());

        expect(row.levelPenalty).toBeCloseTo((0.9 / 50) * (25 - 50), 10);
        expect(row.effectiveTransmuteChance).toBeCloseTo(0.5 * (1 - 0.45), 10);
    });

    test('the catalyst bonus and the level penalty share one additive sum', () => {
        mocks.skills = [{ skillHrid: '/skills/alchemy', level: 25 }];
        calc.useCatalyst = true;
        calc.catalystPrice = 0;

        expect(calc.calculateRow(WIDGET_HRID, widget()).effectiveTransmuteChance).toBeCloseTo(
            0.5 * (1 + 0.25 - 0.45),
            10
        );
    });
});

describe('action time', () => {
    test('comes from the action, not a hardcoded 20 seconds', () => {
        const row = calc.calculateRow(WIDGET_HRID, widget());

        // 8s actions at +50% efficiency = 675 attempts an hour
        expect(row.actionTime).toBe(8);
        expect(row.actionsPerHour).toBeCloseTo(675, 6);
        expect(row.timePerPhiloSeconds).toBeCloseTo((row.actionsPerPhilo / 675) * 3600, 6);
        expect(row.profitPerHour).toBeCloseTo((row.ev - row.transmuteCost) * 675, 6);
    });

    test('falls back to an estimate when the game data is not loaded', () => {
        mocks.actionStats = null;
        calc._actionStatsCache.clear();

        const row = calc.calculateRow(WIDGET_HRID, widget());
        expect(row.actionTimeEstimated).toBe(true);
        expect(row.actionTime).toBe(20);
    });
});

describe('costs', () => {
    test('catalytic tea is charged per action only when it is switched on', () => {
        expect(calc.calculateRow(WIDGET_HRID, widget()).teaCostPerAction).toBe(0);

        calc.useCatalyticTea = true;
        const row = calc.calculateRow(WIDGET_HRID, widget());

        // 12 drinks an hour at the 500 ask, spread over 675 actions
        expect(row.teaCostPerAction).toBeCloseTo((500 * 12) / 675, 6);
        expect(row.transmuteCost).toBeCloseTo(1000 + 50 + row.teaCostPerAction, 6);
    });

    test('the catalyst is only paid for on success', () => {
        calc.useCatalyst = true;
        calc.catalystPrice = 400;

        // A catalyst also lifts the success rate to 0.625, and it is that
        // raised rate that decides how often one is burnt
        const row = calc.calculateRow(WIDGET_HRID, widget());
        expect(row.effectiveTransmuteChance).toBeCloseTo(0.625, 10);
        expect(row.transmuteCost).toBeCloseTo(1000 + 50 + 0.625 * 400, 6);
    });
});

describe('bulk transmutes', () => {
    test('scale cost, revenue and item consumption by the same multiplier', () => {
        const single = calc.calculateRow(WIDGET_HRID, widget());
        const bulk = calc.calculateRow(WIDGET_HRID, widget({ bulkMultiplier: 10 }));

        // Cost: 10 inputs plus 10× the coin fee. Revenue and net consumption
        // must move with it or a bulk row reads as free money.
        expect(bulk.transmuteCost).toBeCloseTo(10 * 1000 + 10 * 50, 6);
        expect(bulk.ev).toBeCloseTo(single.ev * 10, 6);
        expect(bulk.itemsPerAction).toBeCloseTo(single.itemsPerAction * 10, 6);
        expect(bulk.actionsPerPhilo).toBeCloseTo(single.actionsPerPhilo / 10, 6);
        expect(bulk.profitPerPhilo).toBeCloseTo(single.profitPerPhilo, 6);
    });
});

describe('cost basis', () => {
    test('an ordinary row is priced off its own listing', () => {
        const row = calc.calculateRow(WIDGET_HRID, widget());
        expect(row.costSource).toBe('market');
        expect(row.cost).toBe(1000);
    });

    test('a row that had to borrow an enhanced listing is flagged', () => {
        mocks.prices[`${REFINED_HRID}+0`] = { ask: 0, bid: 900 };
        mocks.prices[`${REFINED_HRID}+2`] = { ask: 5000, bid: 4500 };

        const details = widget();
        details.alchemyDetail.transmuteDropTable[1] = {
            itemHrid: REFINED_HRID,
            dropRate: 0.5,
            minCount: 1,
            maxCount: 1,
        };
        const row = calc.calculateRow(REFINED_HRID, details);

        expect(row.costSource).toBe('enhanced');
        expect(row.costFallbackLevel).toBe(2);
        expect(row.cost).toBe(5000);

        // A +2 listing is not what the transmuter hands back — the return is
        // credited at the base item's own price, not the enhanced ask
        const stones = 0.5 * 0.01 * 1 * (4_000_000 * 0.98);
        const shards = 0.5 * 0.25 * 2 * (100 * 0.98);
        expect(row.ev).toBeCloseTo(stones + shards + 0.5 * 0.5 * 900, 6);
    });

    test('a manual override replaces the resolved cost on both sides', () => {
        calc.itemCostOverrides[WIDGET_HRID] = 200;
        const row = calc.calculateRow(WIDGET_HRID, widget());

        expect(row.costSource).toBe('override');
        expect(row.cost).toBe(200);
        expect(row.transmuteCost).toBeCloseTo(200 + 50, 6);
    });

    test('an item with no reachable price is dropped rather than guessed at', () => {
        delete mocks.prices[`${WIDGET_HRID}+0`];
        expect(calc.calculateRow(WIDGET_HRID, widget())).toBeNull();
    });
});

describe('pricing mode', () => {
    test('defaults to conservative even when the global setting is not', () => {
        mocks.globalPricingMode = 'optimistic';

        expect(calc.resolvePricingMode()).toBe('conservative');
        expect(calc.getPriceType('buy')).toBe('ask');
        expect(calc.getPriceType('sell')).toBe('bid');
    });

    test('following the global setting is opt-in', () => {
        mocks.globalPricingMode = 'optimistic';
        calc.pricingMode = 'global';
        calc.loadDefaultPrices();

        expect(calc.resolvePricingMode()).toBe('optimistic');
        // Patient buy, patient sell: buys at the bid, sells at the ask
        expect(calc.calculateRow(WIDGET_HRID, widget()).cost).toBe(800);
        expect(calc.philoPrice).toBe(5_000_000);
    });

    test('an unrecognised stored mode falls back to conservative', () => {
        calc.pricingMode = 'nonsense';
        expect(calc.resolvePricingMode()).toBe('conservative');
    });

    test('the paired column prices the same row at both liquidation speeds', () => {
        const row = calc.calculateRow(WIDGET_HRID, widget());

        expect(row.profitPerPhiloInstant).toBeLessThan(row.profitPerPhiloPatient);
        // Conservative mode sells into bids, so the headline figure is instant
        expect(row.profitPerPhilo).toBeCloseTo(row.profitPerPhiloInstant, 6);
        expect(row.evPatient - row.evInstant).toBeCloseTo(
            0.5 * 0.01 * (5_000_000 - 4_000_000) * 0.98 + 0.5 * 0.25 * 2 * (200 - 100) * 0.98,
            6
        );
    });

    test('a pinned philo price wins over both sides of the book', () => {
        calc.philoPrice = 1_000_000;
        calc._manualPhiloPrice = true;

        const row = calc.calculateRow(WIDGET_HRID, widget());
        expect(row.evInstant).toBeCloseTo(row.evPatient - 0.5 * 0.25 * 2 * (200 - 100) * 0.98, 6);
        expect(row.pricingMode).toBe('conservative');
    });
});
