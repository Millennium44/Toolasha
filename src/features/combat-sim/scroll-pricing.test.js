import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ shop: {}, prices: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            labyrinthShopItemDetailMap: game.shop,
            itemDetailMap: {
                '/items/pathseeker_lodestone': { name: 'Pathseeker Lodestone' },
                '/items/labyrinth_essence': { name: 'Labyrinth Essence' },
            },
        }),
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSettingValue: (_key, fallback) => fallback },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => game.prices[hrid]?.ask ?? null,
    getItemPriceInfo: (hrid) => ({ price: game.prices[hrid]?.ask ?? null, source: 'book', estimated: false }),
    getItemPrices: (hrid) => game.prices[hrid] ?? null,
}));

const { scrollTokenRate, priceScrollRow } = await import('./scroll-pricing.js');
const { priceScrollByTokens } = await import('../../utils/token-worth.js');

/** A scroll result row as the advisor produces it. */
function scrollRow(profitGainPerHour, { measuresLoss = false } = {}) {
    return {
        candidate: { type: 'scroll', measuresLoss, description: 'Add Scroll of Combat Drop (+15%)' },
        economics: { profitGainPerHour },
    };
}

beforeEach(() => {
    // Real shop shape: Pathseeker Lodestone costs 1,000 tokens and sells for 6.8M, so 6.8K/token
    game.shop = {
        lodestone: {
            itemHrid: '/items/pathseeker_lodestone',
            cost: { itemHrid: '/items/labyrinth_token', count: 1000 },
        },
        essence: {
            itemHrid: '/items/labyrinth_essence',
            cost: { itemHrid: '/items/labyrinth_token', count: 1 },
            outputCount: 10,
        },
    };
    game.prices = { '/items/pathseeker_lodestone': { ask: 6_800_000 }, '/items/labyrinth_essence': { ask: 100 } };
});

describe('scrollTokenRate', () => {
    test('is the best gold/token from the Labyrinth Shop, with the item behind it', () => {
        expect(scrollTokenRate()).toEqual({
            value: 6800,
            itemHrid: '/items/pathseeker_lodestone',
            itemName: 'Pathseeker Lodestone',
        });
    });

    test('is null when nothing in the shop is priced', () => {
        game.prices = {};
        expect(scrollTokenRate()).toBeNull();
    });
});

describe('priceScrollRow', () => {
    test('prices a scroll at 30 tokens x the best gold/token, per scroll and per hour', () => {
        const priced = priceScrollRow(scrollRow(1_200_000), scrollTokenRate());
        expect(priced.basis).toBe('30 tokens × 6.8K/token (Pathseeker Lodestone) = 204.0K per scroll');
        expect(priced.costPerScroll).toBe(204_000);
        // A 30-minute buff kept up all hour is bought twice
        expect(priced.costPerHour).toBe(408_000);
        expect(priced.gainPerScroll).toBe(600_000);
        expect(priced.netPerHour).toBe(792_000);
        expect(priced.worthIt).toBe(true);
    });

    test('a scroll whose gain is below its token cost is a net loss', () => {
        // 300K/hr is 150K per scroll against 204K of tokens
        const priced = priceScrollRow(scrollRow(300_000), scrollTokenRate());
        expect(priced.netPerHour).toBe(-108_000);
        expect(priced.worthIt).toBe(false);
        expect(priced.verdict).toBe('Net loss −108.0K/hr: the same tokens buy more as Pathseeker Lodestone');
        expect(priced.netText).toBe('−54.0K per scroll');
    });

    test('a scroll already carried is read as what dropping it loses', () => {
        // Turning it off drops Profit/hr by 1.2M, so carrying it adds 1.2M
        const priced = priceScrollRow(scrollRow(-1_200_000, { measuresLoss: true }), scrollTokenRate());
        expect(priced.gainPerHour).toBe(1_200_000);
        expect(priced.worthIt).toBe(true);
    });

    test('falls back to the baseline when the row has no economics', () => {
        const row = { candidate: { type: 'scroll' }, metrics: { profitPerHour: 1_500_000 } };
        const priced = priceScrollRow(row, scrollTokenRate(), { profitPerHour: 300_000 });
        expect(priced.gainPerHour).toBe(1_200_000);
    });

    test('is null without a token value', () => {
        expect(priceScrollRow(scrollRow(1_000_000), null)).toBeNull();
    });
});

describe('priceScrollByTokens', () => {
    test('a free gain of exactly the cost is not worth it', () => {
        expect(priceScrollByTokens({ tokenValue: 100, profitGainPerHour: 6000 }).worthIt).toBe(false);
    });
});
