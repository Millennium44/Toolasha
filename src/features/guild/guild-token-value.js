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
 * Three sources, in order, and each one that answers stops the search.
 *
 * **The client's own data**, if it publishes the exchange anywhere. Four shapes
 * are probed, because which one the game uses — if it uses any — has not been
 * verified against a live client: the token item carrying `guildCreditConversions`
 * of its own, exactly as every tradeable item that converts into credits does; a
 * shop map selling a credit for a token cost; a credit item naming what it costs
 * in tokens; and a guild-shaped map of `{creditItemHrid, guildTokenCount,
 * creditCount}` rules. All four are matched by shape rather than by hrid, so a
 * renamed map or a new credit colour costs nothing. `source: 'client'` says so.
 *
 * **The Guild Shop dialog**, read off the screen by
 * `guild-token-exchange-capture.js` when the player opens it. This is where the
 * rate demonstrably is — the dialog says "1 → 10" for green credits — and a
 * reading taken from it is a fact about this game, so `source: 'captured'` is
 * not marked assumed. It is second only because client data, if it ever
 * materialises, needs no dialog to be opened first.
 *
 * **The `guildTokenCreditRate` setting**, a credits-per-token number the player
 * types in. Its default is an assumption, not a reading, so a valuation built on
 * it is marked `source: 'setting'` and every caption that shows it says
 * "assumed" out loud. Setting it to 0 turns token valuation off entirely, and
 * callers fall back to showing a bare token count the way they did before.
 *
 * ## Which credit a token is valued against
 *
 * The rate is per credit colour — a token buys ten green credits or a sixtieth
 * of a gold one — and a credit's gold value is per colour too, since it is the
 * cheapest item that converts into *that* colour. So every colour is priced
 * separately and the best one wins:
 *
 *     gold per token = max over colours of (credits per token × gold per credit)
 *
 * A colour with a generous rate and a worthless credit loses to a stingy rate on
 * an expensive one, which is the whole reason the maximum is taken over the
 * product rather than over either half. A token is worth the best thing it can
 * be turned into, which makes the figure an upper bound rather than an average
 * of exchanges nobody would take. When the rate comes from the setting it names
 * no colour at all, so it is valued against the most valuable credit on offer.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { capturedTokenExchanges } from './guild-token-exchange-capture.js';
import { buildGoldPerCredit } from '../../utils/guild-credit-pricing.js';
import { formatKMB } from '../../utils/formatters.js';

/** How an hrid spells a guild token */
const TOKEN_PATTERN = /guild_token/;

/** How an hrid spells a guild credit */
const CREDIT_PATTERN = /guild_credit/;

/** Client-data maps that might carry the guild shop's exchange, most likely first */
const SHOP_MAP_KEYS = ['guildShopItemDetailMap', 'guildStoreItemDetailMap', 'shopItemDetailMap'];

/** Fields a credit item might name its token price in */
const TOKEN_COST_FIELDS = ['guildTokenCost', 'guildTokenCount', 'tokenCost', 'tokenCount'];

/** Fields an exchange rule might name its credit yield in */
const CREDIT_YIELD_FIELDS = ['creditCount', 'guildCreditCount', 'count'];

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
 * The first of a set of fields carrying a positive number.
 * @param {Object} source - Object to read
 * @param {Array<string>} fields - Field names, most likely first
 * @returns {number} The number, or 0 when none of them carry one
 */
function firstPositive(source, fields) {
    for (const field of fields) {
        const value = Number(source?.[field]);
        if (value > 0) return value;
    }
    return 0;
}

/**
 * One exchange, as the shared shape the rest of this module reads.
 * @param {string} creditItemHrid - Credit the token buys
 * @param {number} tokens - Tokens handed over
 * @param {number} credits - Credits received
 * @param {string} via - Which shape it was read from
 * @returns {Object|null} The exchange, or null when the two halves do not make a rate
 */
function makeExchange(creditItemHrid, tokens, credits, via) {
    if (!isGuildCreditHrid(creditItemHrid) || !(tokens > 0) || !(credits > 0)) return null;
    return {
        creditItemHrid,
        creditsPerToken: credits / tokens,
        tokensPerExchange: tokens,
        creditsPerExchange: credits,
        via,
    };
}

/**
 * An exchange rule stated the way one would be: which credit, how many tokens,
 * how many credits.
 *
 * @param {Object} rule - Candidate rule
 * @param {string} via - Label for where it was found
 * @returns {Object|null} The exchange, or null when the object is not one
 */
function exchangeFromRule(rule, via) {
    if (!rule || typeof rule !== 'object') return null;
    return makeExchange(
        rule.creditItemHrid,
        firstPositive(rule, TOKEN_COST_FIELDS),
        firstPositive(rule, CREDIT_YIELD_FIELDS),
        via
    );
}

/**
 * Token→credit exchanges the client's own data describes.
 *
 * Four shapes, because the game has not been observed publishing this and any of
 * them would be a reasonable way to say it:
 *
 * - the token item carrying `guildCreditConversions`, exactly as every tradeable
 *   item that converts into credits does;
 * - a shop entry selling a credit whose `costs` are paid in tokens;
 * - a credit item naming what it costs in tokens;
 * - a guild-shaped map of `{creditItemHrid, guildTokenCount, creditCount}` rules.
 *
 * All are read by shape rather than by a hard-coded hrid, so a renamed map or a
 * new credit colour costs nothing.
 *
 * @param {Object} clientData - Init client data
 * @returns {Array<{creditItemHrid: string, creditsPerToken: number, tokensPerExchange: number,
 *   creditsPerExchange: number, via: string}>} Exchanges found
 */
export function exchangesFromClientData(clientData) {
    const found = [];
    const push = (exchange) => {
        if (exchange) found.push(exchange);
    };

    for (const [hrid, item] of Object.entries(clientData?.itemDetailMap || {})) {
        if (isGuildTokenHrid(hrid)) {
            for (const conversion of item?.guildCreditConversions || []) {
                push(
                    makeExchange(
                        conversion?.creditItemHrid,
                        Number(conversion?.itemCount) || 0,
                        Number(conversion?.creditCount) || 0,
                        'conversion'
                    )
                );
            }
            continue;
        }

        // A credit that names its own token price. Its yield defaults to one:
        // an item that says "costs 60 tokens" and nothing else is one item.
        if (!isGuildCreditHrid(hrid)) continue;
        const tokenCost = firstPositive(item, TOKEN_COST_FIELDS);
        if (tokenCost > 0) push(makeExchange(hrid, tokenCost, firstPositive(item, CREDIT_YIELD_FIELDS) || 1, 'credit'));
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
            push(makeExchange(soldHrid, tokens, credits, 'shop'));
        }
        // The first map that answers is the answer — falling through to a second
        // one would mix two shops' rates into one list
        if (found.some((exchange) => exchange.via === 'shop')) break;
    }

    for (const [key, value] of Object.entries(clientData || {})) {
        // Only guild-shaped keys, and never the item map — that one was read
        // above, by a rule that knows what its entries mean
        if (!/guild/i.test(key) || key === 'itemDetailMap' || SHOP_MAP_KEYS.includes(key)) continue;
        if (!value || typeof value !== 'object') continue;

        for (const entry of Object.values(value)) {
            if (Array.isArray(entry)) entry.forEach((rule) => push(exchangeFromRule(rule, 'rule')));
            else push(exchangeFromRule(entry, 'rule'));
        }
    }

    return found;
}

/**
 * The token→credit exchange rate: from the client when it publishes one, from
 * the Guild Shop dialog when it has been opened, and from the player's setting
 * when neither has anything to say.
 *
 * @param {Object} [options] - Overrides, for tests
 * @param {Object} [options.clientData] - Init client data; read from the data manager when omitted
 * @param {Array<Object>} [options.capturedExchanges] - Readings taken off the Guild Shop dialog
 * @param {Function} [options.getSetting] - Settings reader
 * @returns {{exchanges: Array<Object>, source: string}} Exchanges and where they came from
 *   (`'client'`, `'captured'`, `'setting'`, or `'unknown'` when nothing is priceable)
 */
export function readTokenCreditExchange({ clientData, capturedExchanges, getSetting } = {}) {
    const data = clientData || dataManager.getInitClientData?.() || {};
    const fromClient = exchangesFromClientData(data);
    if (fromClient.length > 0) return { exchanges: fromClient, source: 'client' };

    const fromDialog = (capturedExchanges || capturedTokenExchanges()).filter(
        (exchange) => isGuildCreditHrid(exchange?.creditItemHrid) && Number(exchange?.creditsPerToken) > 0
    );
    if (fromDialog.length > 0) {
        return { exchanges: fromDialog.map((exchange) => ({ ...exchange, via: 'captured' })), source: 'captured' };
    }

    const read = getSetting || ((key, fallback) => config.getSettingValue?.(key, fallback) ?? fallback);
    const rate = Number(read(TOKEN_CREDIT_RATE_SETTING, DEFAULT_TOKEN_CREDIT_RATE));
    // Zero is the off switch, not a rate: it puts callers back on a bare count
    if (!Number.isFinite(rate) || rate <= 0) return { exchanges: [], source: 'unknown' };

    return { exchanges: [{ creditItemHrid: null, creditsPerToken: rate, via: 'setting' }], source: 'setting' };
}

/**
 * Every credit colour a token could be turned into, priced.
 *
 * The list the valuation chooses from, and the list the dump command prints. One
 * row per exchange, each carrying the two halves that make its gold figure —
 * the rate and that colour's gold-per-credit — so a surprising answer can be
 * read rather than guessed at. Rows the credit half cannot price are kept with
 * `gold: null` rather than dropped, because "this colour has no priced
 * conversion" is the explanation for half the surprises.
 *
 * Sorted best first, so the head of the list is the pick.
 *
 * @param {string} [pricingMode='ask'] - Pricing side for the credit half
 * @param {Object} [options] - Overrides, as {@link readTokenCreditExchange} takes them
 * @param {Object} [options.goldPerCredit] - Prebuilt credit→gold map, to avoid rebuilding it per call
 * @returns {{options: Array<Object>, best: Object|null, source: string, pricingMode: string}} The comparison
 */
export function tokenExchangeOptions(pricingMode = 'ask', { goldPerCredit, ...sources } = {}) {
    const mode = normalisePricingMode(pricingMode);
    const { exchanges, source } = readTokenCreditExchange(sources);

    const rates = goldPerCredit || buildGoldPerCredit(mode);
    const values = Object.values(rates)
        .map(Number)
        .filter((value) => value > 0);
    const bestCredit = values.length > 0 ? Math.max(...values) : 0;

    const options = exchanges.map((exchange) => {
        // An exchange that names its credit is priced at that credit; one that
        // does not (the setting) is priced at the best credit on offer
        const perCredit = exchange.creditItemHrid ? Number(rates[exchange.creditItemHrid]) || 0 : bestCredit;
        const gold = perCredit > 0 ? exchange.creditsPerToken * perCredit : null;

        return {
            creditItemHrid: exchange.creditItemHrid || null,
            creditsPerToken: exchange.creditsPerToken,
            tokensPerExchange: exchange.tokensPerExchange ?? null,
            creditsPerExchange: exchange.creditsPerExchange ?? null,
            goldPerCredit: perCredit > 0 ? perCredit : null,
            gold,
            via: exchange.via,
        };
    });

    // Best gold per token, not best rate: ten of a worthless credit loses to one
    // of an expensive one
    options.sort((a, b) => (b.gold ?? -1) - (a.gold ?? -1));
    const best = options.find((option) => option.gold > 0) || null;

    return { options, best, source, pricingMode: mode };
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
 * @param {Array<Object>} [options.capturedExchanges] - Readings taken off the Guild Shop dialog
 * @param {Object} [options.goldPerCredit] - Prebuilt credit→gold map, to avoid rebuilding it per call
 * @param {Function} [options.getSetting] - Settings reader
 * @returns {{gold: number|null, creditsPerToken: number|null, creditItemHrid: string|null,
 *   goldPerCredit: number|null, source: string, assumed: boolean, note: string|null}} The valuation
 */
export function explainGuildTokenValue(pricingMode = 'ask', options = {}) {
    const { best, source } = tokenExchangeOptions(pricingMode, options);

    if (!best) {
        return {
            gold: null,
            creditsPerToken: null,
            creditItemHrid: null,
            goldPerCredit: null,
            source: source === 'unknown' ? 'unknown' : source,
            assumed: false,
            note: null,
        };
    }

    const assumed = source === 'setting';
    const rateText = `${formatRate(best.creditsPerToken)} credit${best.creditsPerToken === 1 ? '' : 's'}/token`;

    return {
        gold: best.gold,
        creditsPerToken: best.creditsPerToken,
        creditItemHrid: best.creditItemHrid,
        goldPerCredit: best.goldPerCredit,
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
    if (Number.isInteger(rate)) return String(rate);
    // A gold credit costs sixty tokens, so the rate is 0.0167 and rounding it to
    // two places would print 0.02 and overstate the token by a fifth
    return rate < 1 ? String(Number(rate.toPrecision(3))) : rate.toFixed(2);
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
                : valuation.source === 'captured'
                  ? 'The rate was read off the Guild Shop exchange dialog itself.'
                  : "The rate is the game's own guild shop exchange."),
        valuation,
    };
}

/**
 * What a source of exchange rates is, in words a report can print.
 * @param {string} source - As {@link readTokenCreditExchange} reports it
 * @returns {string} One line of provenance
 */
function describeSource(source) {
    switch (source) {
        case 'client':
            return "the game's own client data";
        case 'captured':
            return 'the Guild Shop dialog, read off the screen';
        case 'setting':
            return 'the guildTokenCreditRate setting — an assumption, not a reading';
        default:
            return 'nowhere: no rate is known and tokens go unpriced';
    }
}

/**
 * A credit's name, for a report that a person reads.
 * @param {string|null} creditItemHrid - Credit hrid, or null for the setting's nameless rate
 * @param {Object} [itemDetailMap] - Item details; read from the data manager when omitted
 * @returns {string} Display name
 */
function creditName(creditItemHrid, itemDetailMap) {
    if (!creditItemHrid) return 'best credit on offer';
    const map = itemDetailMap || dataManager.getInitClientData?.()?.itemDetailMap || {};
    return map[creditItemHrid]?.name || creditItemHrid.split('/').pop().replace(/_/g, ' ');
}

/**
 * Every exchange the token could take, priced, with the one the valuation picked
 * marked — the object behind `Toolasha.debug.tokenExchange()`.
 *
 * The point of it is the arithmetic being checkable by hand: each row carries
 * the rate, that colour's gold-per-credit and their product, so "why is a token
 * worth that" has an answer with two numbers in it rather than a shrug.
 *
 * @param {string} [pricingMode='ask'] - Pricing side for the credit half
 * @param {Object} [options] - Overrides, as {@link tokenExchangeOptions} takes them
 * @returns {{source: string, sourceText: string, pricingMode: string, rows: Array<Object>,
 *   best: Object|null, goldPerToken: number|null, captured: Array<Object>}} The report
 */
export function collectTokenExchangeDebug(pricingMode = 'ask', options = {}) {
    const { options: found, best, source, pricingMode: mode } = tokenExchangeOptions(pricingMode, options);
    const itemDetailMap = options.clientData?.itemDetailMap || undefined;

    const rows = found.map((option) => ({
        ...option,
        name: creditName(option.creditItemHrid, itemDetailMap),
        picked: best !== null && option === best,
    }));

    return {
        source,
        sourceText: describeSource(source),
        pricingMode: mode,
        rows,
        best: best ? { ...best, name: creditName(best.creditItemHrid, itemDetailMap) } : null,
        goldPerToken: best?.gold ?? null,
        captured: options.capturedExchanges || capturedTokenExchanges(),
    };
}

/**
 * The exchange report as the lines a chat message or a console log shows.
 * @param {Object} report - From {@link collectTokenExchangeDebug}
 * @returns {string} Printable report
 */
export function formatTokenExchangeReport(report) {
    const lines = ['Toolasha token exchange'];
    lines.push(`Rates from: ${report?.sourceText || describeSource('unknown')}`);
    lines.push(`Credit prices: ${report?.pricingMode || 'ask'} side`);

    if (!report?.rows?.length) {
        lines.push('No exchange rates are known, so guild tokens are shown as a bare count.');
        lines.push('Open a Guild Shop exchange dialog with a Guild Token selected, or set guildTokenCreditRate.');
        return lines.join('\n');
    }

    for (const row of report.rows) {
        const rate =
            row.tokensPerExchange && row.creditsPerExchange
                ? `${row.tokensPerExchange} token${row.tokensPerExchange === 1 ? '' : 's'} → ${row.creditsPerExchange}`
                : `${formatRate(row.creditsPerToken)}/token`;
        const perCredit = row.goldPerCredit === null ? 'no priced conversion' : `${formatKMB(row.goldPerCredit)}g each`;
        const gold = row.gold === null ? 'unpriced' : `${formatKMB(row.gold)}g per token`;
        lines.push(`${row.picked ? '→' : ' '} ${row.name}: ${rate}, ${perCredit} ⇒ ${gold} [${row.via}]`);
    }

    lines.push(
        report.best
            ? `Picked ${report.best.name}: a guild token is worth ${formatKMB(report.goldPerToken)} gold.`
            : 'Nothing priceable: every credit on offer has no conversion with a market price.'
    );

    return lines.join('\n');
}

/**
 * The one line the shrine report carries, so the token figure is visible without
 * asking for it.
 * @param {Object} [report] - From {@link collectTokenExchangeDebug}; built when omitted
 * @returns {string} A single line
 */
export function tokenExchangeSummaryLine(report) {
    const built = report || collectTokenExchangeDebug();
    if (!built.best) return 'Guild token ≈ unpriced — no exchange rate known (Toolasha.debug.tokenExchange())';

    const assumed = built.source === 'setting' ? ' (assumed rate)' : '';
    return `Guild token ≈ ${formatKMB(built.goldPerToken)}g via ${built.best.name}${assumed} — ${built.rows.length} exchange${built.rows.length === 1 ? '' : 's'} known`;
}
