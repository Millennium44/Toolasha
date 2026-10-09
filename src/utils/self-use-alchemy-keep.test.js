/**
 * Self-use alchemy with a keep list: an output the player marked "Keep for
 * self-use" is valued at the ask (untaxed buy side); every other output at what
 * selling it realizes (bid after tax). The report this answers: transmuting an
 * ability book valued every book it can roll at the ask, as if the player wanted
 * all of them, when they want one and sell the rest.
 *
 * Item shapes are the game's (`alchemyDetail.decomposeItems`,
 * `transmuteDropTable`); calculator results carry only the fields
 * `calculateDecomposeProfit` / `calculateTransmuteProfit` return.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../core/data-manager.js', () => ({
    default: { getCurrentCharacterGameMode: () => 'standard' },
}));
vi.mock('../core/config.js', () => ({
    default: { getSettingValue: (key, fallback) => fallback },
}));
vi.mock('./market-data.js', () => ({
    getItemPriceInfo: () => ({ price: null, source: null, estimated: false }),
    getPricingMode: () => 'ask',
}));
vi.mock('../features/settings/custom-price-overrides.js', () => ({ getCustomPrice: () => null }));
vi.mock('./game-lookups.js', () => ({ getShopCoinOnlyCost: () => 0, getShopCoinCost: () => 0 }));
vi.mock('../features/enhancement/tooltip-enhancement.js', () => ({ getProductionCost: () => 0 }));

const { outputPricing, selfUseDecompose, selfUseDecomposeChain, selfUseTransmuteHeld, untaxedContainerValue } =
    await import('./self-use-alchemy.js');

/** The market tax every after-tax figure here takes */
const TAX = 0.96;

const ITEMS = {
    '/items/umbral_hood': {
        equipmentDetail: {},
        alchemyDetail: {
            decomposeItems: [
                { itemHrid: '/items/umbral_leather', count: 90 },
                { itemHrid: '/items/beast_hood', count: 1 },
            ],
        },
    },
    '/items/beast_hood': {
        equipmentDetail: {},
        alchemyDetail: {
            decomposeItems: [
                { itemHrid: '/items/beast_leather', count: 60 },
                { itemHrid: '/items/gobo_hood', count: 1 },
            ],
        },
    },
    '/items/gobo_hood': {
        equipmentDetail: {},
        alchemyDetail: { decomposeItems: [{ itemHrid: '/items/gobo_leather', count: 30 }] },
    },
    '/items/cheese_sword': {
        equipmentDetail: {},
        alchemyDetail: { decomposeItems: [{ itemHrid: '/items/cheese', count: 18 }] },
    },
    // Vampirism transmutes into three other books, or comes back as itself
    '/items/vampirism': {
        abilityBookDetail: {},
        alchemyDetail: {
            decomposeItems: null,
            transmuteDropTable: [
                { itemHrid: '/items/frenzy', dropRate: 0.25, minCount: 1, maxCount: 1 },
                { itemHrid: '/items/puncture', dropRate: 0.25, minCount: 1, maxCount: 1 },
                { itemHrid: '/items/fierce_aura', dropRate: 0.25, minCount: 1, maxCount: 1 },
                { itemHrid: '/items/vampirism', dropRate: 0.25, minCount: 1, maxCount: 1 },
            ],
        },
    },
};
const getItemDetails = (hrid) => ITEMS[hrid] || null;
const isChainable = (hrid) => Boolean(ITEMS[hrid]?.equipmentDetail && ITEMS[hrid]?.alchemyDetail?.decomposeItems);

/** The ask: what a kept output saves */
const ASK = {
    '/items/frenzy': 1000,
    '/items/puncture': 500,
    '/items/fierce_aura': 350,
    '/items/umbral_leather': 1000,
    '/items/beast_leather': 300,
    '/items/gobo_leather': 50,
    '/items/cheese': 10,
    '/items/beast_hood': 1_000_000,
    '/items/gobo_hood': 500_000,
    '/items/alchemy_essence': 350,
};
/** The bid after tax: what a sold output realizes */
const SOLD = {
    '/items/frenzy': 900 * TAX,
    '/items/puncture': 400 * TAX,
    '/items/fierce_aura': 300 * TAX,
    '/items/umbral_leather': 800 * TAX,
    '/items/beast_leather': 250 * TAX,
    '/items/gobo_leather': 40 * TAX,
    '/items/cheese': 8 * TAX,
    '/items/beast_hood': 900_000 * TAX,
    '/items/alchemy_essence': 300 * TAX,
};
const priceOf = (hrid) => (hrid in ASK ? ASK[hrid] : null);
const sellOf = (hrid) => (hrid in SOLD ? SOLD[hrid] : null);
const keep =
    (...hrids) =>
    (hrid) =>
        hrids.includes(hrid);

/**
 * A calculator result with only the fields the helpers read.
 * @returns {Object}
 */
function result({ itemHrid, actionsPerHour = 1, successRate = 1, bonus = [] }) {
    return {
        itemHrid,
        actionsPerHour,
        successRate,
        requirementCosts: [{ itemHrid, count: 1, price: 0 }],
        catalystCostPerHour: 0,
        totalTeaCostPerHour: 0,
        dropRevenues: bonus,
    };
}

describe('transmuting a held book', () => {
    const transmute = (isWanted) =>
        selfUseTransmuteHeld(result({ itemHrid: '/items/vampirism' }), ITEMS['/items/vampirism'], {
            sellPrice: 600,
            priceOf,
            isWanted,
            sellOf,
        });
    const input = 600 * TAX;

    test('one wanted book of three is valued at the ask, the other two at the bid after tax', () => {
        const held = transmute(keep('/items/frenzy'));
        expect(held.outputValuePerHour).toBeCloseTo(
            0.25 * 1000 + 0.25 * 400 * TAX + 0.25 * 300 * TAX + 0.25 * input,
            6
        );
        expect(held.netPerAction).toBeCloseTo(held.outputValuePerHour - input, 6);
        expect(held.kept).toEqual(['/items/frenzy']);
    });

    test('nothing wanted sells every output after tax; the self-return keeps the input value', () => {
        const held = transmute(keep());
        expect(held.outputValuePerHour).toBeCloseTo(
            0.25 * 900 * TAX + 0.25 * 400 * TAX + 0.25 * 300 * TAX + 0.25 * input,
            6
        );
        expect(held.kept).toEqual([]);
    });

    test('marking the held item itself changes nothing: its self-return is always the input value', () => {
        const marked = transmute(keep('/items/vampirism'));
        expect(marked.netPerHour).toBeCloseTo(transmute(keep()).netPerHour, 6);
        expect(marked.kept).toEqual([]);
    });

    test('without a keep list every output is kept, as before (the collection optimizer path)', () => {
        const held = transmute(undefined);
        expect(held.outputValuePerHour).toBeCloseTo(0.25 * (1000 + 500 + 350 + input), 6);
        expect(held.kept).toEqual([]);
        expect(outputPricing('/items/frenzy', { priceOf })).toMatchObject({ kept: true, marked: false });
    });
});

describe('decompose once', () => {
    test('a wanted output at the ask; the unwanted gear piece sold after tax', () => {
        const step = selfUseDecompose(result({ itemHrid: '/items/umbral_hood' }), ITEMS['/items/umbral_hood'], {
            ownUseCost: 0,
            priceOf,
            isWanted: keep('/items/umbral_leather'),
            sellOf,
        });
        expect(step.outputValuePerHour).toBeCloseTo(90 * 1000 + 900_000 * TAX, 6);
        expect(step.kept).toEqual(['/items/umbral_leather']);
    });

    test('an unwanted output with no bid is unpriced, never borrowed from the ask', () => {
        const step = selfUseDecompose(result({ itemHrid: '/items/cheese_sword' }), ITEMS['/items/cheese_sword'], {
            ownUseCost: 0,
            priceOf,
            isWanted: keep(),
            sellOf: () => null,
        });
        expect(step.unpriced).toEqual(['/items/cheese']);
        expect(step.partlyUnpriced).toBe(true);
    });
});

describe('the decompose chain', () => {
    const chain = (isWanted) =>
        selfUseDecomposeChain('/items/umbral_hood', {
            getDecompose: (hrid) => result({ itemHrid: hrid, actionsPerHour: 100 }),
            getItemDetails,
            isChainable,
            ownUseCost: 0,
            priceOf,
            isWanted,
            sellOf,
        });

    test('wanted terminals at the ask, the rest at the bid after tax', () => {
        const walked = chain(keep('/items/beast_leather'));
        // 90 umbral leather sold, 60 beast leather kept, 30 gobo leather sold
        expect(walked.terminalValue).toBeCloseTo(90 * 800 * TAX + 60 * 300 + 30 * 40 * TAX, 6);
        expect(walked.kept).toEqual(['/items/beast_leather']);
    });

    test('the gear in between is consumed and never valued, marked or not', () => {
        const plain = chain(keep('/items/beast_leather'));
        const markedGear = chain(keep('/items/beast_leather', '/items/beast_hood'));
        expect(markedGear.terminalValue).toBeCloseTo(plain.terminalValue, 6);
    });
});

describe('the crate bonus', () => {
    const bonus = [
        { itemHrid: '/items/alchemy_essence', isEssence: true, dropsPerHour: 2, price: 1 },
        { itemHrid: '/items/small_artisans_crate', isRare: true, dropsPerHour: 0.5, price: 1 },
    ];
    const decompose = (isWanted) =>
        selfUseDecompose(
            result({ itemHrid: '/items/cheese_sword', actionsPerHour: 100, bonus }),
            ITEMS['/items/cheese_sword'],
            {
                ownUseCost: 0,
                priceOf,
                containerValue: (hrid) => (hrid === '/items/small_artisans_crate' ? 10_000 : null),
                isWanted,
                sellOf,
                sellContainerValue: (hrid) =>
                    hrid === '/items/small_artisans_crate' ? { value: 8_000 * TAX, partlyUnpriced: false } : null,
            }
        );

    test('a wanted crate is its contents opened untaxed at the buy side', () => {
        const step = decompose(keep('/items/small_artisans_crate', '/items/cheese', '/items/alchemy_essence'));
        expect(step.outputValuePerHour).toBeCloseTo(18 * 10 * 100 + 2 * 350 + 0.5 * 10_000, 6);
        expect(step.kept).toContain('/items/small_artisans_crate');
    });

    test('an unwanted crate is its contents sold after tax', () => {
        const step = decompose(keep('/items/cheese', '/items/alchemy_essence'));
        expect(step.outputValuePerHour).toBeCloseTo(18 * 10 * 100 + 2 * 350 + 0.5 * 8_000 * TAX, 6);
        expect(step.kept).not.toContain('/items/small_artisans_crate');
    });

    test('the container walk prices a sold crate when handed after-tax contents', () => {
        const drops = {
            '/items/small_artisans_crate': [{ itemHrid: '/items/cheese', dropRate: 1, minCount: 10, maxCount: 10 }],
        };
        const sold = untaxedContainerValue('/items/small_artisans_crate', {
            containerDrops: (hrid) => drops[hrid] ?? null,
            priceOf: sellOf,
        });
        expect(sold.value).toBeCloseTo(10 * 8 * TAX, 6);
    });
});
