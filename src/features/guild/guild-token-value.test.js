/**
 * Pricing a guild token through the credit exchange.
 *
 * Two conversions deep and both of them fallible, so what is worth asserting is
 * mostly the failures: an exchange rate the client does not publish, a credit
 * with no item converting into it, a setting turned off. Each of those must come
 * back as "no value" rather than as a zero, because a zero would rank a shrine
 * level's tokens as free — which is the bug this file exists to fix.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ clientData: {}, prices: {}, settings: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => (key in game.settings ? game.settings[key] : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => game.clientData },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (itemHrid, { mode } = {}) => game.prices[itemHrid]?.[mode] ?? 0,
}));

const {
    DEFAULT_TOKEN_CREDIT_RATE,
    describeGuildTokenGold,
    exchangesFromClientData,
    explainGuildTokenValue,
    goldPerGuildToken,
    readTokenCreditExchange,
} = await import('./guild-token-value.js');

/** A credit obtainable for 10 bronze bars, which cost 100 (ask) / 90 (bid) each */
function creditsFromBronze() {
    return {
        '/items/bronze_bar': {
            name: 'Bronze Bar',
            guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 }],
        },
    };
}

beforeEach(() => {
    game.clientData = {};
    game.settings = {};
    game.prices = { '/items/bronze_bar': { ask: 100, bid: 90 } };
});

describe('finding the exchange in client data', () => {
    test('the token item carrying its own conversions is read as a rate', () => {
        game.clientData = {
            itemDetailMap: {
                '/items/guild_token': {
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 2, creditCount: 3 }],
                },
            },
        };

        expect(exchangesFromClientData(game.clientData)).toEqual([
            { creditItemHrid: '/items/guild_credit_1', creditsPerToken: 1.5, via: 'conversion' },
        ]);
    });

    test('a shop line selling credits for tokens is read as a rate, bundle size and all', () => {
        game.clientData = {
            guildShopItemDetailMap: {
                a: {
                    itemHrid: '/items/guild_credit_1',
                    count: 10,
                    costs: [{ itemHrid: '/items/guild_token', count: 5 }],
                },
                // Not a credit, so not an exchange
                b: { itemHrid: '/items/coin', count: 1000, costs: [{ itemHrid: '/items/guild_token', count: 1 }] },
            },
        };

        expect(exchangesFromClientData(game.clientData)).toEqual([
            { creditItemHrid: '/items/guild_credit_1', creditsPerToken: 2, via: 'shop' },
        ]);
    });

    test('client data wins over the setting', () => {
        game.settings = { guildTokenCreditRate: 99 };
        game.clientData = {
            itemDetailMap: {
                '/items/guild_token': {
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 4 }],
                },
            },
        };

        const { exchanges, source } = readTokenCreditExchange();
        expect(source).toBe('client');
        expect(exchanges[0].creditsPerToken).toBe(4);
    });

    test('with no client exchange, the setting stands in and says so', () => {
        game.settings = { guildTokenCreditRate: 3 };

        expect(readTokenCreditExchange()).toEqual({
            exchanges: [{ creditItemHrid: null, creditsPerToken: 3, via: 'setting' }],
            source: 'setting',
        });
    });

    test('the default rate is used when the player has set nothing', () => {
        expect(readTokenCreditExchange().exchanges[0].creditsPerToken).toBe(DEFAULT_TOKEN_CREDIT_RATE);
    });

    test('a rate of zero is the off switch, not a rate', () => {
        game.settings = { guildTokenCreditRate: 0 };

        expect(readTokenCreditExchange()).toEqual({ exchanges: [], source: 'unknown' });
    });
});

describe('goldPerGuildToken', () => {
    test('chains the two conversions: credits per token × gold per credit', () => {
        game.clientData = {
            itemDetailMap: {
                ...creditsFromBronze(),
                '/items/guild_token': {
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 2 }],
                },
            },
        };

        // A credit costs 10 × 100 = 1,000 gold; a token buys two of them
        expect(goldPerGuildToken('ask')).toBe(2000);
    });

    test('the pricing side reaches the credit half', () => {
        game.clientData = {
            itemDetailMap: {
                ...creditsFromBronze(),
                '/items/guild_token': {
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 2 }],
                },
            },
        };

        expect(goldPerGuildToken('bid')).toBe(1800);
    });

    test('the setting rate is valued against the most valuable credit on offer', () => {
        game.settings = { guildTokenCreditRate: 2 };
        game.prices = { '/items/bronze_bar': { ask: 100 }, '/items/gold_bar': { ask: 500 } };
        game.clientData = {
            itemDetailMap: {
                ...creditsFromBronze(),
                '/items/gold_bar': {
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_2', itemCount: 10, creditCount: 1 },
                    ],
                },
            },
        };

        // credit_1 is worth 1,000 and credit_2 5,000 — a token buys two of the
        // better one
        expect(goldPerGuildToken('ask')).toBe(10_000);
    });

    test('the best exchange wins when the client publishes several', () => {
        game.clientData = {
            itemDetailMap: {
                ...creditsFromBronze(),
                '/items/guild_token': {
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 2 },
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 5 },
                    ],
                },
            },
        };

        expect(goldPerGuildToken('ask')).toBe(5000);
    });

    test('a credit nothing converts into leaves the token unpriced rather than free', () => {
        game.clientData = {
            itemDetailMap: {
                '/items/guild_token': {
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_9', itemCount: 1, creditCount: 2 }],
                },
            },
        };

        expect(goldPerGuildToken('ask')).toBeNull();
    });

    test('no market prices at all leaves the token unpriced', () => {
        game.prices = {};
        game.clientData = { itemDetailMap: creditsFromBronze() };

        expect(goldPerGuildToken('ask')).toBeNull();
    });

    test('an unknown pricing mode falls back to the ask side rather than throwing', () => {
        game.clientData = { itemDetailMap: creditsFromBronze() };

        expect(goldPerGuildToken('nonsense')).toBe(1000);
    });
});

describe('how the valuation describes itself', () => {
    beforeEach(() => {
        game.clientData = { itemDetailMap: creditsFromBronze() };
    });

    test('a client rate is labelled via the exchange, without an assumption', () => {
        game.clientData.itemDetailMap['/items/guild_token'] = {
            guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 2 }],
        };

        const valuation = explainGuildTokenValue('ask');
        expect(valuation).toMatchObject({ source: 'client', assumed: false, creditsPerToken: 2 });
        expect(valuation.note).toContain('via credit exchange');
        expect(valuation.note).not.toContain('assumed');
    });

    test('a setting rate says out loud that it is assumed', () => {
        const described = describeGuildTokenGold(1000, 'ask');

        expect(described.gold).toBe(1_000_000);
        expect(described.text).toContain('via credit exchange');
        expect(described.text).toContain('assumed rate');
        expect(described.title).toContain('guildTokenCreditRate');
    });

    test('nothing to price against describes nothing, so a caller can fall back to a count', () => {
        game.prices = {};

        expect(describeGuildTokenGold(1000, 'ask')).toBeNull();
    });

    test('zero tokens describe nothing', () => {
        expect(describeGuildTokenGold(0, 'ask')).toBeNull();
    });

    test('a prebuilt valuation is reused rather than rebuilt', () => {
        const valuation = explainGuildTokenValue('ask');
        const described = describeGuildTokenGold(2, 'ask', { valuation });

        expect(described.gold).toBe(2 * valuation.gold);
    });
});
