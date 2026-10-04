/** @vitest-environment happy-dom */
/**
 * Tooltip prices — the routing of a popper by the shared tooltip observer's
 * classification (item / collection / ability / other) and the per-item
 * dedupe on top of it. The price, profit and enhancement maths live in their
 * own modules and are mocked away here.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

const observerState = vi.hoisted(() => ({ handler: null }));
const settings = vi.hoisted(() => ({
    hideInEnhanceSelector: false,
    loadoutMarksEnabled: true,
    selfUseAlchemy: false,
    patientTickBuy: false,
    patientTickSell: false,
}));
const characterState = vi.hoisted(() => ({ data: null }));
const alchemyState = vi.hoisted(() => ({ profits: {}, candidates: {}, decompose: {} }));
const openableState = vi.hoisted(() => ({ drops: {} }));
const gatheringState = vi.hoisted(() => ({ actionDetailMap: {}, profitData: null }));
/** Items the market cannot price, and the shop-conversion value (if any) for each */
const priceState = vi.hoisted(() => ({ unpriced: new Set(), shop: {}, shopSides: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (id) => {
            if (id === 'itemTooltip_hideInEnhanceSelector') return settings.hideInEnhanceSelector;
            if (id === 'itemTooltip_loadoutMarks') return settings.loadoutMarksEnabled;
            if (id === 'itemTooltip_selfUseAlchemy') return settings.selfUseAlchemy;
            return true;
        },
        getSettingValue: (id, fallback) => {
            if (id === 'profitCalc_patientTickBuy') return settings.patientTickBuy;
            if (id === 'profitCalc_patientTickSell') return settings.patientTickSell;
            return fallback;
        },
        COLOR_TOOLTIP_INFO: '#abc',
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_TOOLTIP_PROFIT: '#0f0',
        COLOR_TOOLTIP_LOSS: '#f00',
        COLOR_BORDER: '#444',
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            observerState.handler = callback;
            return () => {};
        },
    },
}));
vi.mock('../../core/data-manager.js', () => {
    const itemDetailMap = {
        '/items/apple': { name: 'Apple' },
        '/items/cheese': { name: 'Cheese' },
        '/items/labyrinth_token': { name: 'Labyrinth Token' },
        // A scroll decomposes into untradeable Labyrinth Tokens, which only a shop conversion prices
        '/items/seal_of_gathering': {
            name: 'Seal of Gathering',
            alchemyDetail: { decomposeItems: [{ itemHrid: '/items/labyrinth_token', count: 20 }] },
        },
        '/items/griffin_bulwark': { name: 'Griffin Bulwark', equipmentDetail: {} },
        '/items/wisdom_tea': { name: 'Wisdom Tea', consumableDetail: {} },
        '/items/cheese_sword': {
            name: 'Cheese Sword',
            equipmentDetail: {},
            alchemyDetail: { decomposeItems: [{ itemHrid: '/items/cheese', count: 18 }] },
        },
        // Gear that decomposes into more gear, for the chain
        '/items/twin_sword': {
            name: 'Twin Sword',
            equipmentDetail: {},
            alchemyDetail: {
                decomposeItems: [
                    { itemHrid: '/items/cheese', count: 5 },
                    { itemHrid: '/items/cheese_sword', count: 1 },
                ],
            },
        },
    };
    return {
        default: {
            getInitClientData: () => ({
                itemDetailMap,
                actionDetailMap: gatheringState.actionDetailMap,
                openableLootDropMap: openableState.drops,
                abilityDetailMap: { '/abilities/berserk': { name: 'Berserk' } },
            }),
            getItemDetails: (hrid) => itemDetailMap[hrid] || null,
            get characterData() {
                return characterState.data;
            },
            get characterItems() {
                return characterState.data?.characterItems;
            },
        },
    };
});
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: async () => {}, getPrice: () => null },
}));
vi.mock('./profit-calculator.js', () => ({
    default: { calculateProfit: async () => null, findProductionAction: () => null },
}));
vi.mock('./alchemy-profit-calculator.js', () => ({
    default: {
        calculateAllProfits: () => alchemyState.profits,
        calculateDecomposeProfit: (hrid) => alchemyState.decompose[hrid] ?? null,
        calculateCandidateResults: (type, hrid) => alchemyState.candidates[`${type}|${hrid}`] ?? [],
    },
}));
vi.mock('./expected-value-calculator.js', () => ({
    default: {
        calculateExpectedValue: () => null,
        resolveBuySideValue: (hrid) =>
            hrid === '/items/small_artisans_crate' || hrid === '/items/missing_material' ? null : { value: 10 },
    },
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    calculateEnhancementPath: () => null,
    buildEnhancementTooltipHTML: () => '',
    buildEnhancementMilestonesHTML: () => '',
    getProductionCost: () => 0,
    installEnhancementSourceToggle: () => {},
    uninstallEnhancementSourceToggle: () => {},
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({ enhancementParamsFor: () => null }));
vi.mock('../actions/gathering-profit.js', () => ({ calculateGatheringProfit: async () => gatheringState.profitData }));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: () => ({ ask: 10, bid: 9 }),
    getItemPrice: (hrid) =>
        hrid === '/items/small_artisans_crate' || hrid === '/items/missing_material' || priceState.unpriced.has(hrid)
            ? null
            : 10,
}));
vi.mock('../../utils/alchemy-shop-value.js', () => ({
    getAlchemyOutputShopValue: (hrid, options) => {
        priceState.shopSides.push(options?.side ?? 'sell');
        return hrid in priceState.shop
            ? { valuePerUnit: priceState.shop[hrid], sourceItemHrid: '/items/foo', sourceItemName: 'Shop Thing' }
            : null;
    },
}));
vi.mock('../../utils/ability-cost-calculator.js', () => ({
    explainAbilityCost: () => ({ total: 1234, books: 3 }),
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    resolveItemPrice: () => 0,
    calculatePriceAfterTax: (price) => price,
}));
vi.mock('../../utils/material-calculator.js', () => ({ calculateArtisanBonus: () => 0 }));
vi.mock('../../utils/game-lookups.js', () => ({
    getShopCoinOnlyCost: () => 0,
    getActionHridFromName: () => null,
    getActionHridFromFiber: () => null,
}));
vi.mock('../../utils/production-index.js', () => ({ findProducingAction: () => null }));
vi.mock('../../utils/dom.js', () => ({
    default: {
        addStyles: vi.fn(),
        fixTooltipOverflow: vi.fn(),
        createStyledDiv: (_style, text, className) => {
            const div = document.createElement('div');
            div.className = className;
            div.textContent = text;
            return div;
        },
    },
}));

const {
    default: tooltipPrices,
    ownUseCompare,
    ownUseLine,
    loadoutSlotsItem,
    loadoutsContainingItem,
} = await import('./tooltip-prices.js');
const { default: tooltipObserver } = await import('../../core/tooltip-observer.js');

/**
 * @param {string} innerHTML
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function popper(innerHTML, className = 'MuiTooltip-popper') {
    const el = document.createElement('div');
    el.className = className;
    el.innerHTML = `<div class="MuiTooltip-tooltip">${innerHTML}</div>`;
    document.body.appendChild(el);
    return el;
}

const itemTooltip = (name) =>
    popper(`<div class="ItemTooltipText_itemTooltipText__x">
        <div class="ItemTooltipText_name__2JAHA"><span>${name}</span></div></div>`);

const abilityTooltip = () =>
    popper(
        `<div class="Ability_abilityTooltip__1"><div class="Ability_name__2">Berserk</div><div>Level: 42</div></div>`
    );

/** Let the async handler run past its awaits */
const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(async () => {
    document.body.innerHTML = '';
    settings.hideInEnhanceSelector = false;
    settings.loadoutMarksEnabled = true;
    settings.selfUseAlchemy = false;
    alchemyState.profits = {};
    alchemyState.candidates = {};
    alchemyState.decompose = {};
    openableState.drops = {};
    gatheringState.actionDetailMap = {};
    gatheringState.profitData = null;
    priceState.unpriced = new Set();
    priceState.shop = {};
    priceState.shopSides = [];
    characterState.data = null;
    await tooltipPrices.initialize();
});

afterEach(() => {
    tooltipPrices.disable();
    tooltipObserver.disable();
});

describe('routing by classification', () => {
    test('subscribes to the shared observer', () => {
        expect(tooltipObserver.subscribers.has('TooltipPrices')).toBe(true);
    });

    test('an item tooltip gets its price section, keyed on the item name', async () => {
        const el = itemTooltip('Cheese');
        observerState.handler(el);
        await settle();
        expect(el.dataset.pricesProcessedItem).toBe('Cheese');
        expect(el.querySelector('.market-price-injected')).not.toBeNull();
    });

    test('the same popper handed over twice is processed once', async () => {
        const el = itemTooltip('Cheese');
        observerState.handler(el);
        observerState.handler(el);
        await settle();
        expect(el.querySelectorAll('.market-price-injected')).toHaveLength(1);
    });

    test('an enhanced item is priced at its enhancement level, not as the base item', async () => {
        const el = itemTooltip('Griffin Bulwark +7');
        observerState.handler(el);
        await settle();
        expect(el.dataset.pricesProcessedItem).toBe('Griffin Bulwark +7');
        // Enhanced items skip the craft-profit path; the price section still lands
        expect(el.querySelector('.market-price-injected')).not.toBeNull();
    });

    test('an ability tooltip gets its fresh-cost line and nothing else', async () => {
        const el = abilityTooltip();
        observerState.handler(el);
        await settle();
        expect(el.querySelector('.mwi-ability-fresh')?.textContent).toContain('Fresh to Lv 42');
        expect(el.dataset.pricesProcessedItem).toBeUndefined();
    });

    describe('_abilityTooltipLevel — locale-grouped level', () => {
        afterEach(() => {
            localStorage.removeItem('i18nextLng');
            _resetGameNumberSeparators();
        });

        const tooltipWithLevel = (levelText) =>
            popper(
                `<div class="Ability_abilityTooltip__1"><div class="Ability_name__2">Berserk</div>` +
                    `<div>Level: ${levelText}</div></div>`
            );

        test('en-US comma grouping', () => {
            localStorage.setItem('i18nextLng', 'en-US');
            _resetGameNumberSeparators();
            expect(tooltipPrices._abilityTooltipLevel(tooltipWithLevel('1,042'))).toBe(1042);
        });

        test('de-DE period grouping — the bug this replaces', () => {
            // A hardcoded `[\d,]+` reads "Level: 1.042" as "Level: 1": the
            // period isn't in the class, so the match stops at the first group
            // boundary.
            localStorage.setItem('i18nextLng', 'de-DE');
            _resetGameNumberSeparators();
            expect(tooltipPrices._abilityTooltipLevel(tooltipWithLevel('1.042'))).toBe(1042);
        });
    });

    test('a tooltip that is neither is left alone', async () => {
        const el = popper('<div class="QueuedActions_queuedActionsTooltip__1">3 queued</div>');
        observerState.handler(el);
        await settle();
        expect(el.dataset.pricesProcessedItem).toBeUndefined();
        expect(el.querySelector('.market-price-injected')).toBeNull();
    });

    test('a popper that is not a tooltip is not touched', async () => {
        const el = popper('<div class="ItemTooltipText_name__2JAHA"><span>Cheese</span></div>', 'MuiPopper-root');
        observerState.handler(el);
        await settle();
        expect(el.dataset.pricesProcessedItem).toBeUndefined();
    });

    test('handleTooltip classifies for itself when called without a classification', async () => {
        const el = itemTooltip('Cheese');
        await tooltipPrices.handleTooltip(el);
        expect(el.querySelector('.market-price-injected')).not.toBeNull();
    });

    test('disable unsubscribes', () => {
        tooltipPrices.disable();
        expect(tooltipObserver.subscribers.has('TooltipPrices')).toBe(false);
    });
});

describe('gathering tooltip prices', () => {
    test('marks the solo net rate incomplete when any drop quote is missing', async () => {
        gatheringState.actionDetailMap = {
            '/actions/foraging/apple': {
                hrid: '/actions/foraging/apple',
                name: 'Apple',
                type: '/action_types/foraging',
                category: '/action_categories/foraging/shimmering_lake',
                baseTimeCost: 8_000_000_000,
                experienceGain: { skillHrid: '/skills/foraging', value: 7.5 },
                dropTable: [{ itemHrid: '/items/apple', dropRate: 1, minCount: 1, maxCount: 4 }],
                essenceDropTable: [
                    { itemHrid: '/items/foraging_essence', dropRate: 0.024444444444444446, minCount: 1, maxCount: 1 },
                ],
                rareDropTable: [
                    {
                        itemHrid: '/items/small_meteorite_cache',
                        dropRate: 0.00020370370370370372,
                        minCount: 1,
                        maxCount: 1,
                    },
                ],
                inputItems: null,
                outputItems: null,
            },
        };
        gatheringState.profitData = {
            profitPerHour: 800,
            hasMissingPrices: true,
            baseOutputs: [{ itemHrid: '/items/apple', itemsPerHour: 1125 }],
        };
        const el = itemTooltip('Apple');
        const sources = await tooltipPrices.findGatheringSources('/items/apple');

        tooltipPrices.injectGatheringDisplay(el, sources);

        expect(el.textContent).toContain('-- ⚠/hr');
        expect(el.textContent).toContain('-- ⚠/day');
        expect(el.textContent).not.toContain('800/hr');
    });
});

describe('own-use make vs buy', () => {
    /** Per-hour figures for a bench making 100 items from 4M of spend */
    const data = (overrides = {}) => ({
        totalItemsPerHour: 100,
        materialCostPerHour: 3_500_000,
        totalTeaCostPerHour: 500_000,
        itemPrice: { ask: 50_000, bid: 45_000 },
        pricingMode: 'hybrid',
        ...overrides,
    });

    test('the make side is the whole hourly spend over the whole hourly output', () => {
        const compared = ownUseCompare(data());
        // (3.5M + 500K) / 100 — teas amortized over efficiency's extra items
        expect(compared.make).toBe(40_000);
        expect(compared.buy).toBe(50_000);
        expect(compared.cheaper).toBe('make');
        expect(compared.saves).toBe(10_000);
    });

    test('neither side carries a sales tax', () => {
        // Buying costs exactly the ask; making costs exactly the bench spend.
        // A consumed item is never sold, so no side is taxed.
        const compared = ownUseCompare(data({ itemPrice: { ask: 40_000, bid: 1 } }));
        expect(compared.cheaper).toBe('even');
    });

    test('within a percent of the buy price no winner is called', () => {
        const compared = ownUseCompare(data({ itemPrice: { ask: 40_300, bid: 0 } }));
        expect(compared.cheaper).toBe('even');
        // The band is a percent of the buy side whichever book it came from, so
        // on a bid basis it narrows with the number it qualifies: 40.3K is
        // within a percent of itself, 40.5K is not once the reference is 40.0K
        const bidBand = ownUseCompare(data({ pricingMode: 'patientBuy', itemPrice: { ask: 99_999, bid: 40_300 } }));
        expect(bidBand.cheaper).toBe('even');
        const outsideBidBand = ownUseCompare(
            data({ pricingMode: 'patientBuy', itemPrice: { ask: 99_999, bid: 40_500 } })
        );
        expect(outsideBidBand.cheaper).toBe('make');
    });

    test('an item with no asks still prices the making of it', () => {
        const compared = ownUseCompare(data({ itemPrice: { ask: 0, bid: 9_999 } }));
        expect(compared.make).toBe(40_000);
        expect(compared.buy).toBeNull();
        expect(ownUseLine(compared).text).toBe('Own use: make ≈40.0K (no asks)');
    });

    test('each pricing mode buys on the side that mode would actually pay', () => {
        // getPricingMode's buy column: conservative/hybrid insta-buy at ask,
        // optimistic/patientBuy wait at bid
        for (const mode of ['conservative', 'hybrid']) {
            const compared = ownUseCompare(data({ pricingMode: mode }));
            expect(compared.priceBasis).toBe('ask');
            expect(compared.buy).toBe(50_000);
        }
        for (const mode of ['optimistic', 'patientBuy']) {
            const compared = ownUseCompare(data({ pricingMode: mode }));
            expect(compared.priceBasis).toBe('bid');
            expect(compared.buy).toBe(45_000);
        }
    });

    test('a mode nobody recognises, or none at all, lands on ask like the make side did', () => {
        // config's mock answers getSettingValue with the caller's fallback,
        // which for profitCalc_pricingMode is 'hybrid'
        expect(ownUseCompare(data({ pricingMode: undefined })).priceBasis).toBe('ask');
        expect(ownUseCompare(data({ pricingMode: 'sideways' })).priceBasis).toBe('ask');
    });

    test('the sell tick alone leaves a bid buy exact', () => {
        settings.patientTickSell = true;
        try {
            expect(ownUseCompare(data({ pricingMode: 'optimistic' })).buy).toBe(45_000);
        } finally {
            settings.patientTickSell = false;
        }
    });

    test('with the buy tick on, a bid buy is one tick up and an ask buy is unchanged', () => {
        settings.patientTickBuy = true;
        try {
            // 45,000 sits in the 45,000-47,999 bin tier, where one tick is 160
            expect(ownUseCompare(data({ pricingMode: 'optimistic' })).buy).toBe(45_120);
            expect(ownUseCompare(data({ pricingMode: 'hybrid' })).buy).toBe(50_000);
            // An estimated bid has no queue to jump
            const estimated = data({
                pricingMode: 'optimistic',
                itemPrice: { ask: 50_000, bid: 45_000, bidEstimated: true },
            });
            expect(ownUseCompare(estimated).buy).toBe(45_000);
        } finally {
            settings.patientTickBuy = false;
        }
    });

    test('the line names the book the buy figure came from', () => {
        expect(ownUseLine(ownUseCompare(data({ pricingMode: 'hybrid' }))).text).toContain('buy 50.0K (ask)');
        expect(ownUseLine(ownUseCompare(data({ pricingMode: 'optimistic' }))).text).toContain('buy 45.0K (bid)');
        // The even line declares it too — it is still a claim about two prices
        const even = ownUseCompare(data({ pricingMode: 'optimistic', itemPrice: { ask: 50_000, bid: 40_000 } }));
        expect(ownUseLine(even).text).toBe('Own use: make ≈40.0K vs buy 40.0K (bid) — even');
    });

    test('a missing price under a bid mode says the bids are missing, not that buying is free', () => {
        // An ask sitting right there is no substitute: nobody is bidding, and
        // reading the other book would quote a price this mode never pays
        const compared = ownUseCompare(data({ pricingMode: 'optimistic', itemPrice: { ask: 50_000, bid: 0 } }));
        expect(compared.buy).toBeNull();
        expect(compared.saves).toBeNull();
        expect(compared.cheaper).toBeNull();
        expect(ownUseLine(compared).text).toBe('Own use: make ≈40.0K (no bids)');
        // And the mirror: an ask mode ignores a healthy bid
        const askSide = ownUseCompare(data({ pricingMode: 'conservative', itemPrice: { ask: 0, bid: 45_000 } }));
        expect(askSide.buy).toBeNull();
        expect(ownUseLine(askSide).text).toBe('Own use: make ≈40.0K (no asks)');
    });

    test('a bid mode does not tilt the verdict toward making by costing the alternative at ask', () => {
        // Materials came in at bid upstream, so the bench is cheap; quoting the
        // alternative at ask would have called this 'make' on the spread alone
        const compared = ownUseCompare(
            data({ pricingMode: 'patientBuy', materialCostPerHour: 3_800_000, itemPrice: { ask: 50_000, bid: 41_000 } })
        );
        expect(compared.buy).toBe(41_000);
        expect(compared.cheaper).toBe('buy');
        expect(compared.saves).toBe(2_000);
    });

    test('a make side that cannot be priced says nothing at all', () => {
        expect(ownUseCompare(data({ totalItemsPerHour: 0 }))).toBeNull();
        expect(ownUseCompare(null)).toBeNull();
        expect(ownUseLine(null)).toBeNull();
    });

    test('an unpriceable material or tea silences the line rather than riding as free', () => {
        // The calculator costs a missing price at zero, so the per-hour spend
        // still parses — only the missingPrice flags say the figure is fiction
        const missingMaterial = data({ materialCosts: [{ itemHrid: '/items/coal', missingPrice: true }] });
        expect(ownUseCompare(missingMaterial)).toBeNull();
        const missingTea = data({ teaCosts: [{ itemHrid: '/items/artisan_tea', missingPrice: true }] });
        expect(ownUseCompare(missingTea)).toBeNull();
        // Priced entries keep the line
        const priced = data({
            materialCosts: [{ itemHrid: '/items/coal', missingPrice: false }],
            teaCosts: [{ itemHrid: '/items/artisan_tea', missingPrice: false }],
        });
        expect(ownUseCompare(priced)).not.toBeNull();
    });

    test('a recipe with several outputs is not costed as if one output paid for all of them', () => {
        const multiOutput = {
            outputItems: [{ itemHrid: '/items/cheese' }, { itemHrid: '/items/whey' }],
        };
        expect(ownUseCompare(data(), multiOutput)).toBeNull();
        // One output — or no action detail to check — leaves the line alone
        expect(ownUseCompare(data(), { outputItems: [{ itemHrid: '/items/cheese' }] })).not.toBeNull();
        expect(ownUseCompare(data(), null)).not.toBeNull();
    });

    test('the line carries the saving and the percent of the price avoided', () => {
        expect(ownUseLine(ownUseCompare(data())).text).toBe(
            'Own use: make ≈40.0K vs buy 50.0K (ask) — make saves 10.0K (20%)'
        );
        // Buying at 50K instead of making at 80K avoids the 80K — the saving
        // is measured against what the cheaper choice spares you
        const buyingWins = ownUseCompare(data({ materialCostPerHour: 7_500_000 }));
        expect(ownUseLine(buyingWins).text).toContain('saves 30.0K (38%)');
    });

    test('a line where the bench wins names making and takes the profit color', () => {
        const line = ownUseLine(ownUseCompare(data()));
        expect(line.text).toContain('— make saves 10.0K (20%)');
        expect(line.color).toBe('#0f0');
    });

    test('a line where buying wins names buying and takes the loss color', () => {
        // The line sits on a crafting tooltip, so an unsubjected "save" in the
        // bench's own color read as an endorsement of crafting even when the
        // figures said buy. The word and the color both have to turn over.
        const line = ownUseLine(ownUseCompare(data({ materialCostPerHour: 7_500_000 })));
        expect(line.text).toBe('Own use: make ≈80.0K vs buy 50.0K (ask) — buy saves 30.0K (38%)');
        expect(line.text).not.toContain('make saves');
        expect(line.color).toBe('#f00');
    });

    test('an even line still names no winner and stays informational', () => {
        const line = ownUseLine(ownUseCompare(data({ itemPrice: { ask: 40_000, bid: 1 } })));
        expect(line.text).toBe('Own use: make ≈40.0K vs buy 40.0K (ask) — even');
        expect(line.color).toBe('#abc');
    });

    test('an unbuyable item is untouched by the direction wording', () => {
        const line = ownUseLine(ownUseCompare(data({ itemPrice: { ask: 0, bid: 9_999 } })));
        expect(line.text).toBe('Own use: make ≈40.0K (no asks)');
        expect(line.color).toBe('#abc');
    });

    test('the bid basis still qualifies the buy figure on a directed line', () => {
        const line = ownUseLine(ownUseCompare(data({ pricingMode: 'optimistic' })));
        expect(line.text).toBe('Own use: make ≈40.0K vs buy 45.0K (bid) — make saves 5.0K (11%)');
        expect(line.color).toBe('#0f0');
        const buyWins = ownUseLine(ownUseCompare(data({ pricingMode: 'optimistic', materialCostPerHour: 7_500_000 })));
        expect(buyWins.text).toBe('Own use: make ≈80.0K vs buy 45.0K (bid) — buy saves 35.0K (44%)');
        expect(buyWins.color).toBe('#f00');
    });
});

describe('loadout marks — matching a stack to a loadout', () => {
    test('a loadout pinned to an exact enhancement only matches that level', () => {
        const pinned = {
            name: 'Boss Gear',
            useExactEnhancement: true,
            wearableMap: { '/item_locations/body': 'c::/item_locations/body::/items/griffin_bulwark::5' },
        };
        // The +5 stack matches...
        expect(loadoutSlotsItem(pinned, '/items/griffin_bulwark', 5, new Map())).toBe(true);
        // ...but the +0 stack of the same item does not, even with a +12 owned —
        // a pinned loadout is frozen at what it says, not at what is highest.
        const owned = new Map([['/items/griffin_bulwark', 12]]);
        expect(loadoutSlotsItem(pinned, '/items/griffin_bulwark', 0, owned)).toBe(false);
        expect(loadoutSlotsItem(pinned, '/items/griffin_bulwark', 12, owned)).toBe(false);
        // And the mirror image: a loadout pinned to +0 does not match a +5 stack.
        const pinnedToZero = {
            name: 'Fresh Gear',
            useExactEnhancement: true,
            wearableMap: { '/item_locations/body': 'c::/item_locations/body::/items/griffin_bulwark::0' },
        };
        expect(loadoutSlotsItem(pinnedToZero, '/items/griffin_bulwark', 5, owned)).toBe(false);
    });

    test('a loadout not pinned wears the HIGHEST level owned, not any level and not the stale stored one', () => {
        // useExactEnhancement:false does NOT mean "any level of this item" —
        // the game equips whichever copy is highest-owned, so only that
        // level's stack is the one genuinely in this loadout.
        const flexible = {
            name: 'Everyday',
            useExactEnhancement: false,
            // wearableMap still says +0, stale from whenever this was last saved
            wearableMap: { '/item_locations/body': 'c::/item_locations/body::/items/griffin_bulwark::0' },
        };
        const owned = new Map([['/items/griffin_bulwark', 12]]);
        // The +12 stack — the level actually worn — matches...
        expect(loadoutSlotsItem(flexible, '/items/griffin_bulwark', 12, owned)).toBe(true);
        // ...but a lower stack of the very same item does not, stale
        // wearableMap level included
        expect(loadoutSlotsItem(flexible, '/items/griffin_bulwark', 0, owned)).toBe(false);
        expect(loadoutSlotsItem(flexible, '/items/griffin_bulwark', 5, owned)).toBe(false);
        expect(loadoutSlotsItem(flexible, '/items/some_other_sword', 0, owned)).toBe(false);
    });

    test('with nothing owned yet, a non-pinned loadout falls back to the stored level', () => {
        // An inventory read that has not arrived yet is an empty map, not a
        // signal to drop a known level to 0
        const flexible = {
            name: 'Everyday',
            useExactEnhancement: false,
            wearableMap: { '/item_locations/body': 'c::/item_locations/body::/items/griffin_bulwark::7' },
        };
        expect(loadoutSlotsItem(flexible, '/items/griffin_bulwark', 7, new Map())).toBe(true);
        expect(loadoutSlotsItem(flexible, '/items/griffin_bulwark', 0, new Map())).toBe(false);
    });

    test('the mark follows a loadout when a higher-level copy is acquired', () => {
        const flexible = {
            name: 'Everyday',
            useExactEnhancement: false,
            wearableMap: { '/item_locations/body': 'c::/item_locations/body::/items/griffin_bulwark::0' },
        };
        // Before the upgrade, the +0 stack is the one worn...
        const before = new Map([['/items/griffin_bulwark', 0]]);
        expect(loadoutSlotsItem(flexible, '/items/griffin_bulwark', 0, before)).toBe(true);
        // ...owning a +8 moves the mark to the +8 stack and off the +0 one —
        // the same thing loadout-snapshot.js's updateEnhancementLevel keeps in
        // sync for its own snapshot store.
        const afterUpgrade = new Map([['/items/griffin_bulwark', 8]]);
        expect(loadoutSlotsItem(flexible, '/items/griffin_bulwark', 0, afterUpgrade)).toBe(false);
        expect(loadoutSlotsItem(flexible, '/items/griffin_bulwark', 8, afterUpgrade)).toBe(true);
    });

    test('food and drinks match on hrid alone — consumables carry no enhancement level', () => {
        const loadout = {
            name: 'Milking Loadout',
            foodItemHrids: ['/items/blueberry_cake', '', ''],
            drinkItemHrids: ['', '/items/wisdom_tea', ''],
        };
        expect(loadoutSlotsItem(loadout, '/items/blueberry_cake', 0, new Map())).toBe(true);
        expect(loadoutSlotsItem(loadout, '/items/wisdom_tea', 7, new Map())).toBe(true);
        expect(loadoutSlotsItem(loadout, '/items/coffee', 0, new Map())).toBe(false);
    });

    test('an empty-string slot in food/drink arrays never matches', () => {
        const loadout = { name: 'Sparse', foodItemHrids: ['', ''], drinkItemHrids: ['', ''] };
        expect(loadoutSlotsItem(loadout, '', 0, new Map())).toBe(false);
    });
});

describe('loadout marks — the three readings across every loadout', () => {
    test('an item in two loadouts names both', () => {
        const owned = new Map([['/items/sword', 12]]);
        const map = {
            a: { name: 'Alpha', useExactEnhancement: false, wearableMap: { x: 'c::x::/items/sword::0' } },
            b: { name: 'Beta', useExactEnhancement: false, wearableMap: { y: 'c::y::/items/sword::0' } },
            c: { name: 'Gamma', wearableMap: { z: 'c::z::/items/shield::0' } },
        };
        // Queried at the level actually owned/worn — both are non-exact, so
        // resolveEnhancementLevel resolves both to +12 and both match.
        const marks = loadoutsContainingItem(map, '/items/sword', 12, owned);
        expect(marks.hasLoadouts).toBe(true);
        expect([...marks.loadouts].sort()).toEqual(['Alpha', 'Beta']);
    });

    test('an item in no loadout still says the character has saved loadouts', () => {
        const map = { a: { name: 'Alpha', wearableMap: { z: 'c::z::/items/shield::0' } } };
        expect(loadoutsContainingItem(map, '/items/sword', 0, new Map())).toEqual({
            hasLoadouts: true,
            loadouts: [],
        });
    });

    test('no saved loadouts at all reads apart from "in no loadout"', () => {
        expect(loadoutsContainingItem({}, '/items/sword', 0, new Map())).toEqual({ hasLoadouts: false, loadouts: [] });
        expect(loadoutsContainingItem(undefined, '/items/sword', 0, new Map())).toEqual({
            hasLoadouts: false,
            loadouts: [],
        });
        expect(loadoutsContainingItem(null, '/items/sword', 0, new Map())).toEqual({
            hasLoadouts: false,
            loadouts: [],
        });
        // An unnamed entry (a loadout mid-delete, or a malformed map) is not a
        // saved loadout either
        expect(loadoutsContainingItem({ a: {} }, '/items/sword', 0, new Map())).toEqual({
            hasLoadouts: false,
            loadouts: [],
        });
    });
});

describe('loadout marks — on the tooltip itself', () => {
    test('names the loadouts an equipped item is slotted in, at its exact enhancement level', async () => {
        characterState.data = {
            characterLoadoutMap: {
                a: {
                    name: 'Boss Gear',
                    useExactEnhancement: true,
                    wearableMap: { '/item_locations/body': 'c::/item_locations/body::/items/griffin_bulwark::5' },
                },
            },
        };
        const el = itemTooltip('Griffin Bulwark +5');
        observerState.handler(el);
        await settle();
        expect(el.querySelector('.mwi-loadout-marks')?.textContent).toBe('In loadouts: Boss Gear');
    });

    test('a different enhancement level of the same pinned item is not marked as in that loadout', async () => {
        characterState.data = {
            characterLoadoutMap: {
                a: {
                    name: 'Boss Gear',
                    useExactEnhancement: true,
                    wearableMap: { '/item_locations/body': 'c::/item_locations/body::/items/griffin_bulwark::5' },
                },
            },
        };
        const el = itemTooltip('Griffin Bulwark');
        observerState.handler(el);
        await settle();
        expect(el.querySelector('.mwi-loadout-marks')?.textContent).toBe('Not in any saved loadout');
    });

    test('a non-pinned loadout marks only the highest-owned stack, not the stale stored level', async () => {
        characterState.data = {
            characterLoadoutMap: {
                a: {
                    name: 'Everyday',
                    useExactEnhancement: false,
                    wearableMap: { '/item_locations/body': 'c::/item_locations/body::/items/griffin_bulwark::0' },
                },
            },
            // The highest owned copy is +8, even though wearableMap still says +0
            characterItems: [{ itemHrid: '/items/griffin_bulwark', enhancementLevel: 8, count: 1 }],
        };
        const zeroStack = itemTooltip('Griffin Bulwark');
        observerState.handler(zeroStack);
        await settle();
        expect(zeroStack.querySelector('.mwi-loadout-marks')?.textContent).toBe('Not in any saved loadout');

        const eightStack = itemTooltip('Griffin Bulwark +8');
        observerState.handler(eightStack);
        await settle();
        expect(eightStack.querySelector('.mwi-loadout-marks')?.textContent).toBe('In loadouts: Everyday');
    });

    test('an item in no saved loadout says so, distinct from having none saved', async () => {
        characterState.data = {
            characterLoadoutMap: { a: { name: 'Boss Gear', wearableMap: {} } },
        };
        const el = itemTooltip('Griffin Bulwark');
        observerState.handler(el);
        await settle();
        expect(el.querySelector('.mwi-loadout-marks')?.textContent).toBe('Not in any saved loadout');
    });

    test('no saved loadouts at all reads as unknown, never as "not in any loadout"', async () => {
        characterState.data = { characterLoadoutMap: {} };
        const el = itemTooltip('Griffin Bulwark');
        observerState.handler(el);
        await settle();
        expect(el.querySelector('.mwi-loadout-marks')?.textContent).toBe('No loadouts saved');
    });

    test('covers food and drinks as well as equipment', async () => {
        characterState.data = {
            characterLoadoutMap: {
                a: { name: 'Milking', drinkItemHrids: ['/items/wisdom_tea'] },
            },
        };
        const el = itemTooltip('Wisdom Tea');
        observerState.handler(el);
        await settle();
        expect(el.querySelector('.mwi-loadout-marks')?.textContent).toBe('In loadouts: Milking');
    });

    test('a plain material is never checked — a loadout has nowhere to put it', async () => {
        // Cheese carries neither equipmentDetail nor consumableDetail in the
        // mocked item map, so even a (contrived) matching loadout is not read.
        characterState.data = {
            characterLoadoutMap: { a: { name: 'Somehow', foodItemHrids: ['/items/cheese'] } },
        };
        const el = itemTooltip('Cheese');
        observerState.handler(el);
        await settle();
        expect(el.querySelector('.mwi-loadout-marks')).toBeNull();
    });

    test('the setting off adds nothing at all', async () => {
        settings.loadoutMarksEnabled = false;
        characterState.data = {
            characterLoadoutMap: {
                a: { name: 'Boss Gear', wearableMap: { x: 'c::x::/items/griffin_bulwark::0' } },
            },
        };
        const el = itemTooltip('Griffin Bulwark');
        observerState.handler(el);
        await settle();
        expect(el.querySelector('.mwi-loadout-marks')).toBeNull();
    });

    test('no character data loaded yet leaves the tooltip untouched rather than guessing', async () => {
        characterState.data = null;
        const el = itemTooltip('Griffin Bulwark');
        observerState.handler(el);
        await settle();
        expect(el.querySelector('.mwi-loadout-marks')).toBeNull();
    });
});

describe('self-use alchemy lines', () => {
    // The calculator's decompose result for a Cheese Sword, cut to what is read
    const cheeseSwordDecompose = () => ({
        actionType: 'decompose',
        itemHrid: '/items/cheese_sword',
        profitPerHour: -500,
        profitPerAction: -5,
        actionsPerHour: 100,
        successRate: 0.6,
        requirementCosts: [{ itemHrid: '/items/cheese_sword', count: 1, price: 50 }],
        catalystCostPerHour: 0,
        totalTeaCostPerHour: 0,
        dropRevenues: [],
    });

    const blockFor = async (hrid) => {
        const el = itemTooltip('Cheese Sword');
        await tooltipPrices.injectMultiActionProfitDisplay(el, hrid, 0);
        return el.querySelector('.market-multi-action-injected');
    };

    test('the setting off leaves the alternative actions exactly as they were', async () => {
        alchemyState.profits = { decompose: cheeseSwordDecompose() };
        const block = await blockFor('/items/cheese_sword');
        expect(block.textContent).toContain('Decompose: ');
        expect(block.textContent).not.toMatch(/self-use/i);
        expect(block.innerHTML).toBe(
            '<div style="border-top: 1px solid rgba(255,255,255,0.2); padding-top: 8px;">' +
                '<div style="font-weight: bold; margin-bottom: 4px;">Profits:</div>' +
                '<div style="font-size: 0.9em; margin-left: 8px;">' +
                '<div style="color: #f00;">• Decompose: -500/hr ' +
                '<span style="opacity: 0.7; color: #f00;">(-5/action)</span></div></div></div>'
        );
    });

    test('the setting on adds the labelled self-use line and its footnote', async () => {
        settings.selfUseAlchemy = true;
        alchemyState.profits = { decompose: cheeseSwordDecompose() };
        const block = await blockFor('/items/cheese_sword');
        // 18 cheese x 10 x 0.6 x 100/hr = 10,800 kept, against 100 swords x 50 (not craftable
        // here, so the own-use cost is the buy side) = 5,000
        expect(block.textContent).toContain('Decompose (self-use): 5.8K/hr');
        expect(block.textContent).toContain('(58/action)');
        expect(block.textContent).toContain('Self-use: untaxed');
        // The ordinary taxed line is still there, unchanged
        expect(block.textContent).toContain('Decompose: -500/hr');
        // No gear comes out of a cheese sword, so no chain line repeats the step
        expect(block.textContent).not.toContain('Full decompose chain');
    });

    test('a crate with unresolved contents keeps its lower bound but marks the line partly unpriced', async () => {
        settings.selfUseAlchemy = true;
        openableState.drops = {
            '/items/small_artisans_crate': [
                { itemHrid: '/items/cheese', dropRate: 0.5, minCount: 100, maxCount: 100 },
                { itemHrid: '/items/missing_material', dropRate: 1, minCount: 100, maxCount: 100 },
            ],
        };
        alchemyState.profits = {
            decompose: {
                ...cheeseSwordDecompose(),
                dropRevenues: [{ itemHrid: '/items/small_artisans_crate', dropsPerHour: 1, isRare: true }],
            },
        };
        const block = await blockFor('/items/cheese_sword');
        // 18 cheese x 10 x 0.6 x 100 = 10,800; crate's known cheese subtotal adds 500,
        // less 5,000 of input cost. The unresolved drop must not erase that lower bound.
        expect(block.textContent).toContain('Decompose (self-use): ≥6.3K/hr');
        expect(block.textContent).toContain('partly unpriced');
        expect(block.textContent).toContain('setup not optimized');
        expect(block.textContent).toContain('Self-use: untaxed');
    });

    // The same decompose on a prime catalyst: the seller passed it over (at a taxed bid
    // it does not pay), but at the buy side its extra 15 points of success do
    const cheeseSwordPrime = () => ({
        ...cheeseSwordDecompose(),
        profitPerHour: -900,
        successRate: 0.75,
        catalystCostPerHour: 2000,
    });

    test('the self-use line takes the catalyst that is best for self-use, not the seller pick', async () => {
        settings.selfUseAlchemy = true;
        alchemyState.profits = { decompose: cheeseSwordDecompose() };
        alchemyState.candidates = {
            'decompose|/items/cheese_sword': [cheeseSwordDecompose(), cheeseSwordPrime()],
        };
        const block = await blockFor('/items/cheese_sword');
        // 18 x 10 x 0.75 x 100 = 13,500 kept, less 5,000 of swords and 2,000 of catalyst
        expect(block.textContent).toContain('Decompose (self-use): 6.5K/hr');
        expect(block.textContent).toContain('(65/action)');
        // The seller's line keeps the seller's pick
        expect(block.textContent).toContain('Decompose: -500/hr');
    });

    test('each chain step takes its own best candidate for self-use', async () => {
        settings.selfUseAlchemy = true;
        const twin = {
            ...cheeseSwordDecompose(),
            itemHrid: '/items/twin_sword',
            successRate: 1,
            requirementCosts: [{ itemHrid: '/items/twin_sword', count: 1, price: 100 }],
        };
        alchemyState.profits = { decompose: twin };
        // What the seller's search hands back for the sword step
        alchemyState.decompose = { '/items/cheese_sword': cheeseSwordDecompose() };
        alchemyState.candidates = {
            'decompose|/items/cheese_sword': [cheeseSwordDecompose(), cheeseSwordPrime()],
        };
        const block = await blockFor('/items/twin_sword');
        // Per twin sword: 5 cheese (50) + one sword decomposed on prime: 18 x 0.75 cheese (135)
        // less 2,000/100 = 20 of catalyst; cost 100. The seller's sword setup would give 58.
        expect(block.textContent).toContain('Full decompose chain (self-use): 65/item');
    });

    test('a chain step is scored by what its gear yields further down, not its market price', async () => {
        settings.selfUseAlchemy = true;
        const twin = (successRate, catalystCostPerHour) => ({
            ...cheeseSwordDecompose(),
            itemHrid: '/items/twin_sword',
            successRate,
            catalystCostPerHour,
            requirementCosts: [{ itemHrid: '/items/twin_sword', count: 1, price: 100 }],
        });
        alchemyState.profits = { decompose: twin(0.5, 0) };
        alchemyState.decompose = { '/items/cheese_sword': cheeseSwordDecompose() };
        alchemyState.candidates = { 'decompose|/items/twin_sword': [twin(0.5, 0), twin(1, 5000)] };
        const block = await blockFor('/items/twin_sword');
        // Valued as it comes out (the sword at its price of 10) the plain setup wins, 30 to 10 per
        // twin. But the sword is decomposed again for 18 x 0.6 x 10 = 108, so per twin the
        // catalyst gives 50 + 108 - 50 = 108 against 0.5 x 158 = 79; less the twin's 100
        expect(block.textContent).toContain('Full decompose chain (self-use): 8/item');
    });

    // Decomposing a seal yields Labyrinth Tokens: untradeable, so the market has no price for
    // them, but the ordinary calculator values them through a shop conversion
    const sealDecompose = () => ({
        ...cheeseSwordDecompose(),
        itemHrid: '/items/seal_of_gathering',
        successRate: 1,
        requirementCosts: [{ itemHrid: '/items/seal_of_gathering', count: 1, price: 50 }],
    });

    test('a shop-only output is priced through its shop conversion, untaxed, not left unpriced', async () => {
        settings.selfUseAlchemy = true;
        priceState.unpriced.add('/items/labyrinth_token');
        priceState.shop['/items/labyrinth_token'] = 30;
        alchemyState.profits = { decompose: sealDecompose() };
        const el = itemTooltip('Seal of Gathering');
        await tooltipPrices.injectMultiActionProfitDisplay(el, '/items/seal_of_gathering', 0);
        const text = el.querySelector('.market-multi-action-injected').textContent;
        // 20 tokens x 30 x 100/hr = 60,000 kept, against 100 seals x 50 = 5,000
        expect(text).toContain('Decompose (self-use): 55.0K/hr');
        // Valued at what keeping them saves: the shop items on the buy side, like every other output
        expect(priceState.shopSides).toContain('buy');
        expect(priceState.shopSides).not.toContain('sell');
        // The figure is named as a shop conversion, not passed off as a market price
        expect(text).toMatch(/Labyrinth Token valued at its Labyrinth Shop conversion \(.+\), not a market price\./);
        expect(text).toContain('(550/action)');
        expect(text).not.toContain('partly unpriced');
    });

    test('with no shop conversion either, the output stays unpriced and the line says so', async () => {
        settings.selfUseAlchemy = true;
        priceState.unpriced.add('/items/labyrinth_token');
        alchemyState.profits = { decompose: sealDecompose() };
        const el = itemTooltip('Seal of Gathering');
        await tooltipPrices.injectMultiActionProfitDisplay(el, '/items/seal_of_gathering', 0);
        expect(el.querySelector('.market-multi-action-injected').textContent).toContain('partly unpriced');
    });

    test('nothing to say about an item no alchemy applies to', async () => {
        settings.selfUseAlchemy = true;
        expect(await blockFor('/items/cheese_sword')).toBeNull();
    });
});
