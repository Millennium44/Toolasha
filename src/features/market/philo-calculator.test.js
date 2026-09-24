import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MARKET_TAX } from '../../utils/profit-constants.js';

const PHILO_HRID = '/items/philosophers_stone';
const WIDGET_HRID = '/items/test_widget';
const OTHER_HRID = '/items/test_shard';
const REFINED_HRID = '/items/test_cape_refined';
const TEA_HRID = '/items/catalytic_tea';
const ARTISAN_TEA_HRID = '/items/artisan_tea';

// The market, as a table. Every price the calculator can reach comes from here.
const mocks = vi.hoisted(() => ({
    prices: {},
    skills: [{ skillHrid: '/skills/alchemy', level: 100 }],
    actionStats: { actionTime: 8, totalEfficiency: 50 },
    bonusDrops: [],
    globalPricingMode: 'hybrid',
    patientTickBuy: false,
    patientTickSell: false,
    characterId: 'char1',
    // Refine actions, keyed by HRID, merged into actionDetailMap so a test
    // can give getRefinementCraftCost something to find.
    refineActions: {},
    // Iron Cow valuation: only read while characterGameMode includes 'ironcow'
    // (see utils/ironcow-valuation.js).
    characterGameMode: 'standard',
    ironCowValuation: 'market',
    // Vendor (sellPrice) for every item the Iron Cow tests price — kept apart
    // from `widget()`'s own sellPrice, which is what calculateRow is handed
    // directly rather than what dataManager.getItemDetails would answer.
    vendorPrices: {},
    // Inventory rows, read by `resolveActionContext` (via `calculateArtisanBonus`)
    // to decide whether a slotted drink is actually in stock.
    inventory: [],
    // Raw drink slots for the refine action type, read the same way.
    drinkSlots: [],
}));

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            storageMock.unavailable = false;
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
});

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
        getCurrentCharacterId: () => mocks.characterId,
        getCurrentCharacterGameMode: () => mocks.characterGameMode,
        getInitClientData: () => ({
            itemDetailMap: {
                [TEA_HRID]: { name: 'Catalytic Tea', consumableDetail: { buffs: [] } },
                [WIDGET_HRID]: { name: 'Test Widget' },
                [ARTISAN_TEA_HRID]: {
                    name: 'Artisan Tea',
                    consumableDetail: { buffs: [{ typeHrid: '/buff_types/artisan', flatBoost: 0.1 }] },
                },
            },
            actionDetailMap: {
                '/actions/alchemy/transmute': { baseTimeCost: 20e9, type: '/action_types/alchemy' },
                ...mocks.refineActions,
            },
        }),
        // ironcow-valuation.js's own item read — separate from getInitClientData
        // above, which the calculator reads itself. Only sellPrice matters here.
        getItemDetails: (itemHrid) =>
            itemHrid in mocks.vendorPrices ? { sellPrice: mocks.vendorPrices[itemHrid] } : null,
        getSkills: () => mocks.skills,
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => mocks.drinkSlots,
        getInventory: () => mocks.inventory,
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (key, fallback) => {
            if (key === 'profitCalc_pricingMode') return mocks.globalPricingMode;
            if (key === 'profitCalc_patientTickBuy') return mocks.patientTickBuy;
            if (key === 'profitCalc_patientTickSell') return mocks.patientTickSell;
            if (key === 'profitCalc_ironCowValuation') return mocks.ironCowValuation;
            return fallback;
        },
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
        COLOR_WARNING: '#fa0',
    },
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

vi.mock('./alchemy-profit-calculator.js', () => ({
    default: {
        calculateTransmuteProfit: () => ({ dropRevenues: mocks.bonusDrops }),
        // Mirrors the real getUnderLevelPenalty's formula against mocks.skills, so this
        // suite still drives the under-level scenarios without pulling in the full calculator.
        getUnderLevelPenalty: (itemLevel) => {
            const level = itemLevel || 1;
            const alchemyLevel = mocks.skills?.find((s) => s.skillHrid === '/skills/alchemy')?.level || 1;
            return alchemyLevel < level ? (0.9 / level) * (alchemyLevel - level) : 0;
        },
    },
}));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => mocks.actionStats,
}));

const { PhiloCalculator, formatRowValue, rowsToTsv } = await import('./philo-calculator.js');
const { nextPriceUp, nextPriceDown } = await import('../../utils/market-values.js');

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
    mocks.patientTickBuy = false;
    mocks.patientTickSell = false;
    mocks.refineActions = {};
    mocks.characterGameMode = 'standard';
    mocks.ironCowValuation = 'market';
    mocks.vendorPrices = {};
    mocks.inventory = [];
    mocks.drinkSlots = [];

    calc = new PhiloCalculator();
    calc.useCatalyst = false;
    calc.useCatalyticTea = false;
    calc.drinkConcentrationLevel = 0;
    calc.loadDefaultPrices();
});

describe('revenue', () => {
    test('every sold drop pays market tax; the self-return does not', () => {
        const row = calc.calculateRow(WIDGET_HRID, widget());

        // Stones and shards are sold (market tax); the returned widget goes straight
        // back into the transmuter, so it is credited at its full cost basis.
        const stones = 0.5 * 0.01 * 1 * (4_000_000 * (1 - MARKET_TAX));
        const shards = 0.5 * 0.25 * 2 * (100 * (1 - MARKET_TAX));
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
        expect(calc.calculateRow(WIDGET_HRID, widget()).ev).toBeCloseTo(without + 150 * (1 - MARKET_TAX), 6);
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
        const stones = 0.5 * 0.01 * 1 * (4_000_000 * (1 - MARKET_TAX));
        const shards = 0.5 * 0.25 * 2 * (100 * (1 - MARKET_TAX));
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

    describe('refinement craft cost follows the table own buy side', () => {
        beforeEach(() => {
            // 10 test_shard per craft; the shard's ask/bid come from the
            // default price table (200/100). No drink is slotted (mocks.drinkSlots
            // defaults to []), so the artisan bonus is genuinely 0 here and these
            // tests price the raw recipe — see the dedicated test below for the
            // reduced-count path.
            mocks.refineActions['/actions/refine_test'] = {
                outputItems: [{ itemHrid: REFINED_HRID }],
                inputItems: [{ itemHrid: OTHER_HRID, count: 10 }],
            };
        });

        test('conservative buys the materials at ask', () => {
            calc.pricingMode = 'conservative';
            expect(calc.getRefinementCraftCost(REFINED_HRID)).toBeCloseTo(10 * 200, 6);
        });

        test('optimistic buys the materials at bid, not ask', () => {
            calc.pricingMode = 'optimistic';
            expect(calc.getRefinementCraftCost(REFINED_HRID)).toBeCloseTo(10 * 100, 6);
        });

        test('falls back to the other side when the mode own side is unlisted', () => {
            mocks.prices[`${OTHER_HRID}+0`] = { ask: 200, bid: 0 };
            calc.pricingMode = 'optimistic'; // buy: bid, but bid is unlisted
            expect(calc.getRefinementCraftCost(REFINED_HRID)).toBeCloseTo(10 * 200, 6);
        });

        test('an active artisan tea reduces the priced material count, not just the raw recipe', () => {
            // Without the tea slotted, the craft prices the full 10-shard recipe.
            calc.pricingMode = 'conservative';
            expect(calc.getRefinementCraftCost(REFINED_HRID)).toBeCloseTo(10 * 200, 6);

            // Slot a 10% artisan tea and hold it in stock — resolveActionContext
            // only counts a drink as active when it is actually held.
            mocks.drinkSlots = [{ itemHrid: ARTISAN_TEA_HRID }];
            mocks.inventory = [{ itemHrid: ARTISAN_TEA_HRID, count: 5 }];

            // 10 shards at a 10% reduction is 9, not 10 — this is the arithmetic
            // that turns a 100-shard recipe into the 88.9 shards the game charges.
            expect(calc.getRefinementCraftCost(REFINED_HRID)).toBeCloseTo(9 * 200, 6);
        });

        test('global mode ticks the materials patiently, like every other buy read', () => {
            // Optimistic buys at the bid — the patient side a buy tick moves.
            mocks.globalPricingMode = 'optimistic';
            mocks.patientTickBuy = true;
            calc.pricingMode = 'global';
            expect(calc.getRefinementCraftCost(REFINED_HRID)).toBeCloseTo(10 * nextPriceUp(100), 6);
        });

        // The craft arithmetic lives in utils/refined-item-cost.js now, shared
        // with the alchemy history viewers. These pin what this table shows.
        test('the cheaper of the +0 listing and the craft is the cost basis', () => {
            calc.pricingMode = 'conservative'; // craft = 10 × 200 = 2000
            mocks.prices[`${REFINED_HRID}+0`] = { ask: 5000, bid: 4500 };
            expect(calc.resolveItemCost(REFINED_HRID)).toMatchObject({ itemCost: 2000, source: 'craft' });

            mocks.prices[`${REFINED_HRID}+0`] = { ask: 1500, bid: 1400 };
            expect(calc.resolveItemCost(REFINED_HRID)).toMatchObject({ itemCost: 1500, source: 'market' });
        });

        test('the tooltip breakdown and base note are recorded even when the market wins', () => {
            calc.pricingMode = 'conservative';
            mocks.prices[`${REFINED_HRID}+0`] = { ask: 1500, bid: 1400 };
            mocks.refineActions['/actions/refine_test'].upgradeItemHrid = WIDGET_HRID;

            calc.resolveItemCost(REFINED_HRID);

            expect(calc._craftBreakdowns[REFINED_HRID]).toHaveLength(1);
            expect(calc._craftBreakdowns[REFINED_HRID][0]).toContain('10 × test shard @ 200');
            // The widget is not marked tradable in the item map
            expect(calc._craftBaseNotes[REFINED_HRID]).toBe('untradable');
        });
    });

    describe('the enhanced self-return follows the table own sell side', () => {
        test('an explicit mode reads the +0 quote straight, no tick', () => {
            // No +0 ask (nobody selling), so the +0 quote fails and the level
            // loop borrows the +2 listing as the cost basis.
            mocks.prices[`${REFINED_HRID}+0`] = { ask: 0, bid: 900 };
            mocks.prices[`${REFINED_HRID}+2`] = { ask: 5000, bid: 4500 };
            calc.pricingMode = 'conservative'; // sell: bid
            expect(calc.resolveItemCost(REFINED_HRID).selfReturnUnitValue).toBe(900);
        });

        test('global mode ticks the self-return patiently, like every other sell read', () => {
            // Optimistic sells at the ask — the patient side a sell tick moves.
            // No +0 bid (nobody bidding), so the buy-side +0 quote fails too
            // and the level loop borrows the +2 listing (bid-priced under optimistic).
            mocks.prices[`${REFINED_HRID}+0`] = { ask: 900, bid: 0 };
            mocks.prices[`${REFINED_HRID}+2`] = { ask: 5000, bid: 4500 };
            mocks.globalPricingMode = 'optimistic';
            mocks.patientTickSell = true;
            calc.pricingMode = 'global';
            expect(calc.resolveItemCost(REFINED_HRID).selfReturnUnitValue).toBe(nextPriceDown(900));
        });
    });

    describe('Iron Cow valuation', () => {
        test('an Iron Cow character under vendor prices an item off the vendor value, no tick', () => {
            mocks.characterGameMode = 'ironcow';
            mocks.ironCowValuation = 'vendor';
            mocks.vendorPrices[WIDGET_HRID] = 300;
            // Optimistic + a buy tick would move a real market quote; the
            // vendor value has no book to tick.
            mocks.globalPricingMode = 'optimistic';
            mocks.patientTickBuy = true;
            calc.pricingMode = 'global';

            const cost = calc.resolveItemCost(WIDGET_HRID);
            expect(cost.itemCost).toBe(300);
            expect(cost.selfReturnUnitValue).toBe(300);
        });

        test('a standard character ignores the option and prices off the market as before', () => {
            mocks.ironCowValuation = 'vendor';
            mocks.vendorPrices[WIDGET_HRID] = 300;

            expect(calc.resolveItemCost(WIDGET_HRID).itemCost).toBe(1000);
        });

        test('loadDefaultPrices takes Philo and Prime Catalyst from the vendor value', () => {
            mocks.characterGameMode = 'ironcow';
            mocks.ironCowValuation = 'vendor';
            mocks.vendorPrices[PHILO_HRID] = 3_000_000;
            mocks.vendorPrices['/items/prime_catalyst'] = 900;

            calc.loadDefaultPrices();

            expect(calc.philoBid).toBe(3_000_000);
            expect(calc.philoAsk).toBe(3_000_000);
            expect(calc.catalystPrice).toBe(900);
        });

        test('a manually typed price still overrides the Iron Cow vendor value', () => {
            mocks.characterGameMode = 'ironcow';
            mocks.ironCowValuation = 'vendor';
            mocks.vendorPrices[PHILO_HRID] = 3_000_000;
            calc._manualPhiloPrice = true;
            calc.philoPrice = 9_999_999;

            calc.loadDefaultPrices();

            expect(calc.philoPrice).toBe(9_999_999);
        });
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
            0.5 * 0.01 * (5_000_000 - 4_000_000) * (1 - MARKET_TAX) + 0.5 * 0.25 * 2 * (200 - 100) * (1 - MARKET_TAX),
            6
        );
    });

    test('a pinned philo price wins over both sides of the book', () => {
        calc.philoPrice = 1_000_000;
        calc._manualPhiloPrice = true;

        const row = calc.calculateRow(WIDGET_HRID, widget());
        expect(row.evInstant).toBeCloseTo(row.evPatient - 0.5 * 0.25 * 2 * (200 - 100) * (1 - MARKET_TAX), 6);
        expect(row.pricingMode).toBe('conservative');
    });
});

describe('patient +1 tick', () => {
    const TAX = 1 - MARKET_TAX;

    test('following the global mode, patient buys step up and patient sells step down', () => {
        mocks.globalPricingMode = 'optimistic';
        mocks.patientTickBuy = true;
        mocks.patientTickSell = true;
        calc.pricingMode = 'global';
        calc.loadDefaultPrices();

        const row = calc.calculateRow(WIDGET_HRID, widget());
        expect(row.cost).toBe(nextPriceUp(800));
        expect(calc.philoPrice).toBe(nextPriceDown(5_000_000));
        // The instant column sells at the bid and is not moved; only the patient one is
        expect(row.evPatient - row.evInstant).toBeCloseTo(
            0.5 * 0.01 * (nextPriceDown(5_000_000) - 4_000_000) * TAX +
                0.5 * 0.25 * 2 * (nextPriceDown(200) - 100) * TAX,
            6
        );
    });

    test('each side ticks under its own setting', () => {
        mocks.globalPricingMode = 'optimistic';
        calc.pricingMode = 'global';

        mocks.patientTickBuy = true;
        calc.loadDefaultPrices();
        expect(calc.calculateRow(WIDGET_HRID, widget()).cost).toBe(nextPriceUp(800));
        expect(calc.philoPrice).toBe(5_000_000);

        mocks.patientTickBuy = false;
        mocks.patientTickSell = true;
        calc.loadDefaultPrices();
        expect(calc.calculateRow(WIDGET_HRID, widget()).cost).toBe(800);
        expect(calc.philoPrice).toBe(nextPriceDown(5_000_000));
    });

    test('the catalyst bought patiently in global mode steps up too', () => {
        mocks.globalPricingMode = 'optimistic';
        mocks.patientTickBuy = true;
        mocks.prices['/items/prime_catalyst+0'] = { ask: 3000, bid: 2000 };
        calc.pricingMode = 'global';
        calc.loadDefaultPrices();
        expect(calc.catalystPrice).toBe(nextPriceUp(2000));
    });

    test('catalytic tea bought patiently in global mode steps up too, and not in an explicit mode', () => {
        mocks.globalPricingMode = 'optimistic';
        mocks.patientTickBuy = true;
        calc.useCatalyticTea = true;

        calc.pricingMode = 'global';
        calc.loadDefaultPrices();
        // 12 drinks an hour at the ticked 400 bid, spread over 675 actions
        expect(calc.calculateRow(WIDGET_HRID, widget()).teaCostPerAction).toBeCloseTo((nextPriceUp(400) * 12) / 675, 6);

        calc.pricingMode = 'optimistic';
        calc.loadDefaultPrices();
        expect(calc.calculateRow(WIDGET_HRID, widget()).teaCostPerAction).toBeCloseTo((400 * 12) / 675, 6);
    });

    test('a listed essence is quoted on the table own sell side, not the global mode', () => {
        const ESSENCE = '/items/alchemy_essence';
        mocks.prices[`${ESSENCE}+0`] = { ask: 300, bid: 200 };
        // What the canonical calculator hands back under global hybrid with the sell tick
        mocks.bonusDrops = [
            { itemHrid: ESSENCE, isEssence: true, dropRate: 0.1, revenuePerAttempt: 0.1 * nextPriceDown(300) },
        ];
        mocks.globalPricingMode = 'hybrid';
        mocks.patientTickSell = true;

        calc.pricingMode = 'conservative';
        calc._bonusRevenueCache.clear();
        expect(calc.getBonusRevenuePerAction(WIDGET_HRID)).toBeCloseTo(0.1 * 200 * TAX, 6);

        calc.pricingMode = 'global';
        calc._bonusRevenueCache.clear();
        expect(calc.getBonusRevenuePerAction(WIDGET_HRID)).toBeCloseTo(0.1 * nextPriceDown(300) * TAX, 6);
    });

    test('an explicitly chosen mode prices at its exact sides', () => {
        mocks.patientTickBuy = true;
        mocks.patientTickSell = true;
        calc.pricingMode = 'optimistic';
        calc.loadDefaultPrices();

        const row = calc.calculateRow(WIDGET_HRID, widget());
        expect(row.cost).toBe(800);
        expect(calc.philoPrice).toBe(5_000_000);
        expect(row.evPatient - row.evInstant).toBeCloseTo(
            0.5 * 0.01 * (5_000_000 - 4_000_000) * TAX + 0.5 * 0.25 * 2 * (200 - 100) * TAX,
            6
        );
    });

    test('with the tick off global mode is exact', () => {
        mocks.globalPricingMode = 'optimistic';
        calc.pricingMode = 'global';
        calc.loadDefaultPrices();

        expect(calc.calculateRow(WIDGET_HRID, widget()).cost).toBe(800);
        expect(calc.philoPrice).toBe(5_000_000);
    });
});

describe('the stored settings', () => {
    const KEY = 'philoCalculatorSettings_char1';
    const stored = () => storageMock.storeFor('settings').get(KEY);
    const seed = (value) => storageMock.storeFor('settings').set(KEY, value);

    beforeEach(() => {
        storageMock.reset();
        mocks.characterId = 'char1';
    });

    test('reads back what was written, cost overrides included', async () => {
        calc.itemCostOverrides = { [WIDGET_HRID]: 900 };
        calc.filterText = 'widget';
        await calc.saveSettings();
        expect(stored().itemCostOverrides).toEqual({ [WIDGET_HRID]: 900 });

        const fresh = new PhiloCalculator();
        await fresh.loadSettings();
        expect(fresh.itemCostOverrides).toEqual({ [WIDGET_HRID]: 900 });
        expect(fresh.filterText).toBe('widget');
    });

    test('a load that cannot be made keeps the values in hand rather than blanking them', async () => {
        seed({ itemCostOverrides: { [WIDGET_HRID]: 900 }, filterText: 'widget' });
        await calc.loadSettings();
        storageMock.unavailable = true;
        await calc.loadSettings();
        expect(calc.itemCostOverrides).toEqual({ [WIDGET_HRID]: 900 });
        expect(calc.filterText).toBe('widget');
    });

    test('a save over a store that cannot be read is skipped, and what is stored stays', async () => {
        seed({ itemCostOverrides: { [WIDGET_HRID]: 900 } });
        storageMock.unavailable = true;
        const fresh = new PhiloCalculator();
        await fresh.loadSettings();
        fresh.itemCostOverrides = { [OTHER_HRID]: 50 };
        await fresh.saveSettings();
        storageMock.unavailable = false;
        expect(stored()).toEqual({ itemCostOverrides: { [WIDGET_HRID]: 900 } });
    });

    test('a save before the settings were read back loses no stored override', async () => {
        seed({ itemCostOverrides: { [WIDGET_HRID]: 900 } });
        storageMock.unavailable = true;
        const fresh = new PhiloCalculator();
        await fresh.loadSettings();
        storageMock.unavailable = false;

        fresh.itemCostOverrides = { [OTHER_HRID]: 50 };
        await fresh.saveSettings();
        expect(stored().itemCostOverrides).toEqual({ [WIDGET_HRID]: 900, [OTHER_HRID]: 50 });
    });

    test('after a readable load a cleared override stays cleared', async () => {
        seed({ itemCostOverrides: { [WIDGET_HRID]: 900, [OTHER_HRID]: 50 } });
        const fresh = new PhiloCalculator();
        await fresh.loadSettings();
        delete fresh.itemCostOverrides[WIDGET_HRID];
        await fresh.saveSettings();
        expect(stored().itemCostOverrides).toEqual({ [OTHER_HRID]: 50 });
    });

    test('once storage is back, the next save lands', async () => {
        storageMock.unavailable = true;
        const fresh = new PhiloCalculator();
        await fresh.loadSettings();
        fresh.itemCostOverrides = { [OTHER_HRID]: 50 };
        await fresh.saveSettings();
        expect(stored()).toBeUndefined();

        storageMock.unavailable = false;
        await fresh.saveSettings();
        expect(stored().itemCostOverrides).toEqual({ [OTHER_HRID]: 50 });
    });

    test("another character's settings are not shown to, or folded into, this one", async () => {
        seed({ itemCostOverrides: { [WIDGET_HRID]: 900 } });
        const fresh = new PhiloCalculator();
        await fresh.loadSettings();
        mocks.characterId = 'char2';
        await fresh.loadSettings();
        fresh.itemCostOverrides = { [OTHER_HRID]: 50 };
        await fresh.saveSettings();
        expect(storageMock.storeFor('settings').get('philoCalculatorSettings_char2').itemCostOverrides).toEqual({
            [OTHER_HRID]: 50,
        });
        expect(stored().itemCostOverrides).toEqual({ [WIDGET_HRID]: 900 });
    });
});

describe('copy table as text', () => {
    const columns = [
        { key: 'name', label: 'Item' },
        { key: 'philoChance', label: 'Philo %' },
        { key: 'profitPerPhiloInstant', label: 'Profit/Philo (instant | patient)' },
        { key: 'itemsPerAction', label: 'Items/Act' },
    ];
    const row = {
        name: 'Test Widget',
        philoChance: 0.012345,
        profitPerPhiloInstant: 1234.6,
        profitPerPhiloPatient: 2345.4,
        itemsPerAction: 1.5,
    };

    test('name passes through untouched', () => {
        expect(formatRowValue('name', row)).toBe('Test Widget');
    });

    test('a percentage column reads as a percentage', () => {
        expect(formatRowValue('philoChance', row)).toBe('1.23%');
    });

    test('the paired instant/patient profit column keeps both halves', () => {
        expect(formatRowValue('profitPerPhiloInstant', row)).toBe('1.24K | 2.35K');
    });

    test('a plain numeric column falls back to the shared large-number format', () => {
        expect(formatRowValue('itemsPerAction', row)).toBe('1.50');
    });

    test('rowsToTsv builds one header line and one line per row, tab-separated', () => {
        const text = rowsToTsv(columns, [row]);
        const lines = text.split('\n');
        expect(lines[0]).toBe('Item\tPhilo %\tProfit/Philo (instant | patient)\tItems/Act');
        expect(lines[1]).toBe('Test Widget\t1.23%\t1.24K | 2.35K\t1.50');
    });

    test('an empty row set is just the header', () => {
        expect(rowsToTsv(columns, [])).toBe('Item\tPhilo %\tProfit/Philo (instant | patient)\tItems/Act');
    });
});

describe('the table opens on the column it is read for', () => {
    test('the default sort is profit per hour, descending', async () => {
        const { PhiloCalculator } = await import('./philo-calculator.js');
        const calc = new PhiloCalculator();

        // Cost was a stable default, not a useful one: the table exists to rank
        // what earns most per hour, and the Profit/Hr column is the last one.
        expect(calc.sortColumn).toBe('profitPerHour');
        expect(calc.sortDirection).toBe('desc');
    });
});
