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

const game = vi.hoisted(() => ({ clientData: {}, prices: {}, settings: {}, captured: [] }));

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
vi.mock('./guild-token-exchange-capture.js', () => ({
    capturedTokenExchanges: () => game.captured,
}));

const {
    DEFAULT_TOKEN_CREDIT_RATE,
    collectTokenExchangeDebug,
    describeGuildTokenGold,
    exchangesFromClientData,
    explainGuildTokenValue,
    formatTokenExchangeReport,
    goldPerGuildToken,
    readTokenCreditExchange,
    tokenExchangeOptions,
    tokenExchangeSummaryLine,
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
    game.captured = [];
    game.prices = { '/items/bronze_bar': { ask: 100, bid: 90 } };
});

/**
 * Two credit colours: green, cheap at 100g each, and gold, dear at 5,000g each.
 * @returns {Object} An itemDetailMap
 */
function twoCreditColours() {
    return {
        '/items/bronze_bar': {
            name: 'Bronze Bar',
            guildCreditConversions: [{ creditItemHrid: '/items/green_guild_credit', itemCount: 1, creditCount: 1 }],
        },
        '/items/gold_bar': {
            name: 'Gold Bar',
            guildCreditConversions: [{ creditItemHrid: '/items/gold_guild_credit', itemCount: 1, creditCount: 1 }],
        },
        '/items/green_guild_credit': { name: 'Green Guild Credit' },
        '/items/gold_guild_credit': { name: 'Gold Guild Credit' },
    };
}

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
            {
                creditItemHrid: '/items/guild_credit_1',
                creditsPerToken: 1.5,
                tokensPerExchange: 2,
                creditsPerExchange: 3,
                via: 'conversion',
            },
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
            {
                creditItemHrid: '/items/guild_credit_1',
                creditsPerToken: 2,
                tokensPerExchange: 5,
                creditsPerExchange: 10,
                via: 'shop',
            },
        ]);
    });

    test('a credit item naming its own token price is read as a rate', () => {
        game.clientData = {
            itemDetailMap: {
                '/items/gold_guild_credit': { name: 'Gold Guild Credit', guildTokenCost: 60 },
            },
        };

        expect(exchangesFromClientData(game.clientData)).toEqual([
            {
                creditItemHrid: '/items/gold_guild_credit',
                creditsPerToken: 1 / 60,
                tokensPerExchange: 60,
                creditsPerExchange: 1,
                via: 'credit',
            },
        ]);
    });

    test('a guild-shaped map of exchange rules is read, one row per credit colour', () => {
        game.clientData = {
            guildTokenExchangeDetailMap: {
                green: { creditItemHrid: '/items/green_guild_credit', guildTokenCount: 1, creditCount: 10 },
                gold: { creditItemHrid: '/items/gold_guild_credit', guildTokenCount: 60, creditCount: 1 },
                // Not an exchange: no credit named
                junk: { itemHrid: '/items/coin', count: 5 },
            },
        };

        expect(exchangesFromClientData(game.clientData).map((e) => [e.creditItemHrid, e.creditsPerToken])).toEqual([
            ['/items/green_guild_credit', 10],
            ['/items/gold_guild_credit', 1 / 60],
        ]);
    });

    test('a guild map of unrelated shapes is not mistaken for an exchange', () => {
        game.clientData = {
            guildBuffDetailMap: {
                '/guild_buffs/force': {
                    shrineHrid: '/guild_shrines/force',
                    levelCosts: [
                        { guildTokenCost: 400, creditCosts: [{ itemHrid: '/items/red_guild_credit', count: 2 }] },
                    ],
                },
            },
        };

        expect(exchangesFromClientData(game.clientData)).toEqual([]);
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

    test('client data wins over a reading taken off the dialog', () => {
        game.captured = [{ creditItemHrid: '/items/green_guild_credit', creditsPerToken: 10 }];
        game.clientData = {
            itemDetailMap: {
                '/items/guild_token': {
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 4 }],
                },
            },
        };

        expect(readTokenCreditExchange().source).toBe('client');
    });

    test('a reading taken off the dialog wins over the setting, and is not an assumption', () => {
        game.settings = { guildTokenCreditRate: 1 };
        game.captured = [
            {
                creditItemHrid: '/items/green_guild_credit',
                creditsPerToken: 10,
                tokensPerExchange: 1,
                creditsPerExchange: 10,
            },
        ];

        const { exchanges, source } = readTokenCreditExchange();
        expect(source).toBe('captured');
        expect(exchanges).toEqual([
            {
                creditItemHrid: '/items/green_guild_credit',
                creditsPerToken: 10,
                tokensPerExchange: 1,
                creditsPerExchange: 10,
                via: 'captured',
            },
        ]);
    });

    test('a captured reading with no rate in it is ignored rather than believed', () => {
        game.settings = { guildTokenCreditRate: 3 };
        game.captured = [{ creditItemHrid: '/items/green_guild_credit', creditsPerToken: 0 }];

        expect(readTokenCreditExchange().source).toBe('setting');
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

    test('a generous rate on a cheap credit loses to a stingy one on an expensive credit', () => {
        game.prices = { '/items/bronze_bar': { ask: 100 }, '/items/gold_bar': { ask: 5000 } };
        game.clientData = {
            itemDetailMap: {
                ...twoCreditColours(),
                '/items/guild_token': {
                    guildCreditConversions: [
                        // 10 × 100 = 1,000 gold
                        { creditItemHrid: '/items/green_guild_credit', itemCount: 1, creditCount: 10 },
                        // 4 × 5,000 = 20,000 gold
                        { creditItemHrid: '/items/gold_guild_credit', itemCount: 1, creditCount: 4 },
                    ],
                },
            },
        };

        const valuation = explainGuildTokenValue('ask');
        expect(valuation.gold).toBe(20_000);
        expect(valuation.creditItemHrid).toBe('/items/gold_guild_credit');
        // The loser is still on the list, so the choice can be checked
        expect(tokenExchangeOptions('ask').options.map((o) => o.gold)).toEqual([20_000, 1000]);
    });

    test('gold per credit is taken per colour, not from one colour for all of them', () => {
        game.prices = { '/items/bronze_bar': { ask: 100 }, '/items/gold_bar': { ask: 5000 } };
        game.clientData = {
            itemDetailMap: {
                ...twoCreditColours(),
                '/items/guild_token': {
                    guildCreditConversions: [
                        { creditItemHrid: '/items/green_guild_credit', itemCount: 1, creditCount: 1 },
                        { creditItemHrid: '/items/gold_guild_credit', itemCount: 1, creditCount: 1 },
                    ],
                },
            },
        };

        const byCredit = Object.fromEntries(
            tokenExchangeOptions('ask').options.map((o) => [o.creditItemHrid, o.goldPerCredit])
        );
        expect(byCredit).toEqual({ '/items/green_guild_credit': 100, '/items/gold_guild_credit': 5000 });
    });

    test('a colour with no priced conversion is kept on the list, unpriced, not silently dropped', () => {
        game.prices = { '/items/bronze_bar': { ask: 100 } };
        game.clientData = {
            itemDetailMap: {
                ...twoCreditColours(),
                '/items/guild_token': {
                    guildCreditConversions: [
                        { creditItemHrid: '/items/green_guild_credit', itemCount: 1, creditCount: 2 },
                        { creditItemHrid: '/items/gold_guild_credit', itemCount: 1, creditCount: 99 },
                    ],
                },
            },
        };

        const { options, best } = tokenExchangeOptions('ask');
        expect(options).toHaveLength(2);
        expect(best.creditItemHrid).toBe('/items/green_guild_credit');
        expect(options.find((o) => o.creditItemHrid === '/items/gold_guild_credit').gold).toBeNull();
    });

    test('a reading off the dialog prices the token the same way client data would', () => {
        game.settings = { guildTokenCreditRate: 1 };
        game.prices = { '/items/bronze_bar': { ask: 100 } };
        game.clientData = { itemDetailMap: twoCreditColours() };
        game.captured = [{ creditItemHrid: '/items/green_guild_credit', creditsPerToken: 10 }];

        const valuation = explainGuildTokenValue('ask');
        expect(valuation.gold).toBe(1000);
        expect(valuation).toMatchObject({ source: 'captured', assumed: false });
        expect(valuation.note).not.toContain('assumed');
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

describe('the dump command', () => {
    beforeEach(() => {
        game.prices = { '/items/bronze_bar': { ask: 100 }, '/items/gold_bar': { ask: 5000 } };
        game.clientData = {
            itemDetailMap: {
                ...twoCreditColours(),
                '/items/guild_token': {
                    guildCreditConversions: [
                        { creditItemHrid: '/items/green_guild_credit', itemCount: 1, creditCount: 10 },
                        { creditItemHrid: '/items/gold_guild_credit', itemCount: 60, creditCount: 1 },
                    ],
                },
            },
        };
    });

    test('every colour is listed, named, with its two halves and their product', () => {
        const report = collectTokenExchangeDebug('ask');

        expect(report.source).toBe('client');
        expect(report.rows).toHaveLength(2);

        const green = report.rows.find((row) => row.creditItemHrid === '/items/green_guild_credit');
        expect(green).toMatchObject({
            name: 'Green Guild Credit',
            creditsPerToken: 10,
            tokensPerExchange: 1,
            creditsPerExchange: 10,
            goldPerCredit: 100,
            gold: 1000,
            picked: true,
        });

        const gold = report.rows.find((row) => row.creditItemHrid === '/items/gold_guild_credit');
        expect(gold).toMatchObject({ goldPerCredit: 5000, picked: false });
        // 60 tokens for one 5,000g credit is 83.3g a token — worse than green
        expect(gold.gold).toBeCloseTo(5000 / 60);
    });

    test('the printed report shows the pick, the rates and where they came from', () => {
        const text = formatTokenExchangeReport(collectTokenExchangeDebug('ask'));

        expect(text).toContain("the game's own client data");
        expect(text).toContain('ask side');
        expect(text).toContain('→ Green Guild Credit: 1 token → 10');
        expect(text).toContain('Gold Guild Credit: 60 tokens → 1');
        expect(text).toContain('Picked Green Guild Credit');
    });

    test('with nothing known it says so, and says what to do about it', () => {
        game.clientData = {};
        game.settings = { guildTokenCreditRate: 0 };

        const report = collectTokenExchangeDebug('ask');
        expect(report.rows).toEqual([]);
        expect(report.goldPerToken).toBeNull();

        const text = formatTokenExchangeReport(report);
        expect(text).toContain('No exchange rates are known');
        expect(text).toContain('guildTokenCreditRate');
    });

    test('a reading off the dialog is reported as one rather than as client data', () => {
        game.clientData = { itemDetailMap: twoCreditColours() };
        game.captured = [
            {
                creditItemHrid: '/items/green_guild_credit',
                creditsPerToken: 10,
                tokensPerExchange: 1,
                creditsPerExchange: 10,
                via: 'arrow',
            },
        ];

        const text = formatTokenExchangeReport(collectTokenExchangeDebug('ask'));
        expect(text).toContain('read off the screen');
        expect(text).toContain('[captured]');
    });

    test('the summary line names the gold, the colour and how many exchanges were compared', () => {
        expect(tokenExchangeSummaryLine()).toBe('Guild token ≈ 1.0Kg via Green Guild Credit — 2 exchanges known');
    });

    test('the summary line owns up to an assumed rate', () => {
        game.clientData = { itemDetailMap: twoCreditColours() };
        game.settings = { guildTokenCreditRate: 2 };

        expect(tokenExchangeSummaryLine()).toContain('(assumed rate)');
    });

    test('the summary line says unpriced rather than zero when nothing is known', () => {
        game.clientData = {};
        game.settings = { guildTokenCreditRate: 0 };

        expect(tokenExchangeSummaryLine()).toContain('unpriced');
    });
});
