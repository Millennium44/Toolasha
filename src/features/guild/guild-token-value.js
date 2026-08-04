/**
 * What a guild token is worth, in gold.
 *
 * Guild tokens have no marketplace listing and nothing is crafted into them, so
 * every part of this script that met one so far reported a count and stopped
 * there: the build score left them out, the upgrade advisor ranked shrine levels
 * on their credit half alone, and a trial payout of 40,000 tokens was a number
 * with no scale attached to it.
 *
 * There is one honest way to price them, and it is the same reasoning
 * `guild-credit-pricing.js` already uses for credits. Tokens buy guild credits at
 * the guild shop's published exchange rate; credits are obtained by handing in
 * tradeable items at published conversion rates, and so have a gold value. Chain
 * the two and a token has one too:
 *
 *     gold per token = credits per token × gold per credit
 *
 * Everything derived this way is labelled **via credit exchange**, because it is
 * a chain of two conversions and not a price anybody quoted.
 *
 * ## Where the exchange rate comes from
 *
 * Preferred: the client's own data. Two shapes are probed, because which one the
 * game publishes has not been verified against a live client — the token item
 * carrying `guildCreditConversions` of its own, and a shop map selling a credit
 * for a token cost. Whichever answers is used, and `source: 'client'` says so.
 *
 * Failing that: the `guildTokenCreditRate` setting, a credits-per-token number
 * the player can read off the Guild Shop themselves. Its default is an
 * assumption, not a reading, so a valuation built on it is marked
 * `source: 'setting'` and every caption that shows it says "assumed" out loud.
 * Setting it to 0 turns token valuation off entirely, and callers fall back to
 * showing a bare token count the way they did before.
 *
 * ## Which credit a token is valued against
 *
 * When the exchange names a credit type, that one. When the rate comes from the
 * setting it names none, so the token is valued against the most valuable credit
 * on offer — a token is worth what the best thing you can spend it on is worth,
 * and that makes the figure an upper bound rather than an average of exchanges
 * nobody would take.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { buildGoldPerCredit } from '../../utils/guild-credit-pricing.js';
import { formatKMB } from '../../utils/formatters.js';

/** How an hrid spells a guild token */
const TOKEN_PATTERN = /guild_token/;

/** How an hrid spells a guild credit */
const CREDIT_PATTERN = /guild_credit/;

/** Client-data maps that might carry the guild shop's exchange, most likely first */
const SHOP_MAP_KEYS = ['guildShopItemDetailMap', 'guildStoreItemDetailMap', 'shopItemDetailMap'];

/** Pricing sides `buildGoldPerCredit` understands */
const PRICING_MODES = new Set(['ask', 'bid', 'average']);

/** The setting that stands in for an exchange rate the client does not publish */
export const TOKEN_CREDIT_RATE_SETTING = 'guildTokenCreditRate';

/** Credits per token assumed when neither the client nor the player says otherwise */
export const DEFAULT_TOKEN_CREDIT_RATE = 1;

/** The phrase every derived figure is labelled with */
export const VIA_EXCHANGE = 'via credit exchange';

/**
 * Whether an hrid names a guild token.
 * @param {string} hrid - Item hrid
 * @returns {boolean} True for a guild token
 */
export function isGuildTokenHrid(hrid) {
    return TOKEN_PATTERN.test(String(hrid || ''));
}

/**
 * Whether an hrid names a guild credit.
 * @param {string} hrid - Item hrid
 * @returns {boolean} True for a guild credit
 */
export function isGuildCreditHrid(hrid) {
    return CREDIT_PATTERN.test(String(hrid || ''));
}

/**
 * A pricing side `buildGoldPerCredit` can use.
 * @param {string} pricingMode - Requested side
 * @returns {string} One of ask/bid/average
 */
function normalisePricingMode(pricingMode) {
    return PRICING_MODES.has(pricingMode) ? pricingMode : 'ask';
}

/**
 * Token→credit exchanges the client's own data describes.
 *
 * Two shapes, because the game has not been observed publishing this and either
 * would be a reasonable way to say it:
 *
 * - the token item carrying `guildCreditConversions`, exactly as every tradeable
 *   item that converts into credits does;
 * - a shop entry selling a credit whose `costs` are paid in tokens.
 *
 * Both are read by shape rather than by a hard-coded hrid, so a renamed map or a
 * second credit tier costs nothing.
 *
 * @param {Object} clientData - Init client data
 * @returns {Array<{creditItemHrid: string, creditsPerToken: number, via: string}>} Exchanges found
 */
export function exchangesFromClientData(clientData) {
    const found = [];

    for (const [hrid, item] of Object.entries(clientData?.itemDetailMap || {})) {
        if (!isGuildTokenHrid(hrid)) continue;
        for (const conversion of item?.guildCreditConversions || []) {
            const tokens = Number(conversion?.itemCount) || 0;
            const credits = Number(conversion?.creditCount) || 0;
            if (tokens <= 0 || credits <= 0 || !conversion?.creditItemHrid) continue;
            found.push({
                creditItemHrid: conversion.creditItemHrid,
                creditsPerToken: credits / tokens,
                via: 'conversion',
            });
        }
    }

    for (const key of SHOP_MAP_KEYS) {
        const shop = clientData?.[key];
        if (!shop || typeof shop !== 'object') continue;

        for (const entry of Object.values(shop)) {
            const soldHrid = entry?.itemHrid;
            if (!isGuildCreditHrid(soldHrid)) continue;

            const tokenCost = (entry?.costs || []).find((cost) => isGuildTokenHrid(cost?.itemHrid));
            const tokens = Number(tokenCost?.count) || 0;
            // A shop line that sells a bundle says how big it is; one that does
            // not is selling exactly one
            const credits = Number(entry?.count ?? entry?.itemCount ?? 1) || 0;
            if (tokens <= 0 || credits <= 0) continue;

            found.push({ creditItemHrid: soldHrid, creditsPerToken: credits / tokens, via: 'shop' });
        }
        // The first map that answers is the answer — falling through to a second
        // one would mix two shops' rates into one list
        if (found.some((exchange) => exchange.via === 'shop')) break;
    }

    return found;
}

/**
 * The token→credit exchange rate, from the client when it publishes one and from
 * the player's setting when it does not.
 *
 * @param {Object} [options] - Overrides, for tests
 * @param {Object} [options.clientData] - Init client data; read from the data manager when omitted
 * @param {Function} [options.getSetting] - Settings reader
 * @returns {{exchanges: Array<Object>, source: string}} Exchanges and where they came from
 *   (`'client'`, `'setting'`, or `'unknown'` when nothing is priceable)
 */
export function readTokenCreditExchange({ clientData, getSetting } = {}) {
    const data = clientData || dataManager.getInitClientData?.() || {};
    const fromClient = exchangesFromClientData(data);
    if (fromClient.length > 0) return { exchanges: fromClient, source: 'client' };

    const read = getSetting || ((key, fallback) => config.getSettingValue?.(key, fallback) ?? fallback);
    const rate = Number(read(TOKEN_CREDIT_RATE_SETTING, DEFAULT_TOKEN_CREDIT_RATE));
    // Zero is the off switch, not a rate: it puts callers back on a bare count
    if (!Number.isFinite(rate) || rate <= 0) return { exchanges: [], source: 'unknown' };

    return { exchanges: [{ creditItemHrid: null, creditsPerToken: rate, via: 'setting' }], source: 'setting' };
}

/**
 * What one guild token is worth, and how that was arrived at.
 *
 * The best exchange wins: a token is worth the most valuable thing it can be
 * turned into, not the average of every counter it could be handed to.
 *
 * @param {string} [pricingMode='ask'] - Pricing side for the credit half ('ask', 'bid' or 'average')
 * @param {Object} [options] - Overrides, for tests
 * @param {Object} [options.clientData] - Init client data
 * @param {Object} [options.goldPerCredit] - Prebuilt credit→gold map, to avoid rebuilding it per call
 * @param {Function} [options.getSetting] - Settings reader
 * @returns {{gold: number|null, creditsPerToken: number|null, creditItemHrid: string|null,
 *   goldPerCredit: number|null, source: string, assumed: boolean, note: string|null}} The valuation
 */
export function explainGuildTokenValue(pricingMode = 'ask', { clientData, goldPerCredit, getSetting } = {}) {
    const mode = normalisePricingMode(pricingMode);
    const unknown = {
        gold: null,
        creditsPerToken: null,
        creditItemHrid: null,
        goldPerCredit: null,
        source: 'unknown',
        assumed: false,
        note: null,
    };

    const { exchanges, source } = readTokenCreditExchange({ clientData, getSetting });
    if (exchanges.length === 0) return unknown;

    const rates = goldPerCredit || buildGoldPerCredit(mode);
    const values = Object.values(rates).filter((value) => Number(value) > 0);

    let best = null;
    for (const exchange of exchanges) {
        // An exchange that names its credit is priced at that credit; one that
        // does not (the setting) is priced at the best credit on offer
        const perCredit = exchange.creditItemHrid
            ? Number(rates[exchange.creditItemHrid]) || 0
            : values.length > 0
              ? Math.max(...values)
              : 0;
        if (!(perCredit > 0)) continue;

        const gold = exchange.creditsPerToken * perCredit;
        if (!best || gold > best.gold) {
            best = {
                gold,
                creditsPerToken: exchange.creditsPerToken,
                creditItemHrid: exchange.creditItemHrid || null,
                goldPerCredit: perCredit,
            };
        }
    }

    if (!best) return { ...unknown, source };

    const assumed = source === 'setting';
    const rateText = `${formatRate(best.creditsPerToken)} credit${best.creditsPerToken === 1 ? '' : 's'}/token`;

    return {
        ...best,
        source,
        assumed,
        note: assumed ? `${VIA_EXCHANGE}, assumed ${rateText}` : `${VIA_EXCHANGE} at ${rateText}`,
    };
}

/**
 * Gold value of one guild token.
 * @param {string} [pricingMode='ask'] - Pricing side for the credit half
 * @param {Object} [options] - Overrides, as {@link explainGuildTokenValue} takes them
 * @returns {number|null} Gold per token, or null when no rate or no credit price is known
 */
export function goldPerGuildToken(pricingMode = 'ask', options = {}) {
    return explainGuildTokenValue(pricingMode, options).gold;
}

/**
 * A rate written the way a caption wants it: whole when it is whole.
 * @param {number} rate - Credits per token
 * @returns {string} Formatted rate
 */
function formatRate(rate) {
    return Number.isInteger(rate) ? String(rate) : rate.toFixed(2);
}

/**
 * Gold value of a pile of tokens, and the caption that must travel with it.
 *
 * Returns null rather than a zero when nothing can be priced, so a caller can
 * fall back to the bare token count it showed before instead of printing "≈ 0".
 *
 * @param {number} tokenCount - Tokens
 * @param {string} [pricingMode='ask'] - Pricing side for the credit half
 * @param {Object} [options] - Overrides, as {@link explainGuildTokenValue} takes them
 * @returns {{gold: number, text: string, title: string, valuation: Object}|null} Value and captions
 */
export function describeGuildTokenGold(tokenCount, pricingMode = 'ask', options = {}) {
    const tokens = Number(tokenCount);
    if (!Number.isFinite(tokens) || tokens <= 0) return null;

    const valuation = options.valuation || explainGuildTokenValue(pricingMode, options);
    if (!Number.isFinite(valuation.gold) || valuation.gold <= 0) return null;

    const gold = tokens * valuation.gold;
    const rateText = `${formatRate(valuation.creditsPerToken)} credit${valuation.creditsPerToken === 1 ? '' : 's'} per token`;

    return {
        gold,
        text: `≈${formatKMB(gold)}g ${VIA_EXCHANGE}${valuation.assumed ? ' (assumed rate)' : ''}`,
        title:
            `${formatKMB(gold)} gold: ${formatKMB(tokens)} tokens at ${rateText}, ` +
            `each credit worth ${formatKMB(valuation.goldPerCredit)} gold. ` +
            (valuation.assumed
                ? 'The rate is the guildTokenCreditRate setting, not a figure the game published — ' +
                  'check the Guild Shop and correct it there.'
                : "The rate is the game's own guild shop exchange."),
        valuation,
    };
}
