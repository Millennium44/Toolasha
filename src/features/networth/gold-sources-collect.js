/**
 * Everything the gold attribution reads, gathered from where it lives.
 *
 * The arithmetic is in `gold-sources.js` and knows nothing about storage; this
 * is the half that does. Keeping the two apart is what lets a week of play be
 * costed in a test with no IndexedDB, no market and no game.
 *
 * Every source is read defensively and independently: a store that will not
 * answer contributes nothing and leaves its line at zero rather than taking the
 * whole panel down with it. A missing source shows up honestly in the residual,
 * which is the behaviour the panel is built around.
 */

import dataManager from '../../core/data-manager.js';
import tradeLedgerStore from '../market/trade-ledger-store.js';
import { loadSessions as loadCombatSessions, MAX_SESSIONS } from '../combat-stats/combat-session-history.js';
import { loadSessions as loadEnhancementSessions } from '../enhancement/enhancement-storage.js';
import { createAlchemySessionStore, NO_CHARACTER } from '../alchemy/alchemy-session-store.js';
import lootLogHistory from '../actions/loot-log-history.js';
import networthHistory from './networth-history.js';
import productionIncomeRecorder from './production-income-recorder.js';
import { getItemPrice } from '../../utils/market-data.js';
import { MARKET_TAX } from '../../utils/profit-constants.js';

/** The three alchemy trackers, and the tag the attribution reads them under */
const ALCHEMY_STORES = [
    { kind: 'transmute', baseKey: 'transmuteSessions' },
    { kind: 'decompose', baseKey: 'decomposeSessions' },
    { kind: 'coinify', baseKey: 'coinifySessions' },
];

/**
 * A memoised pricer at the user's net worth pricing mode.
 *
 * The same handful of items are priced hundreds of times over a month of loot
 * entries, and `getItemPrice` goes through the override table and the market
 * reconciliation on every call.
 *
 * @returns {Function} `(itemHrid, enhancementLevel) => number|null`
 */
export function createPricer() {
    const cache = new Map();
    return (itemHrid, enhancementLevel = 0) => {
        if (!itemHrid) return null;
        const key = `${itemHrid}:${enhancementLevel || 0}`;
        if (cache.has(key)) return cache.get(key);
        let price = null;
        try {
            price = getItemPrice(itemHrid, { enhancementLevel: enhancementLevel || 0, context: 'networth' });
        } catch {
            price = null;
        }
        cache.set(key, price);
        return price;
    };
}

/**
 * Run a read that is allowed to fail.
 * @param {string} what - What was being read, for the log line
 * @param {Function} read - `() => Promise<*>`
 * @param {*} fallback - What to return when it fails
 * @returns {Promise<*>} The value or the fallback
 */
async function attempt(what, read, fallback) {
    try {
        const value = await read();
        return value ?? fallback;
    } catch (error) {
        console.error(`[GoldSources] Reading ${what} failed:`, error);
        return fallback;
    }
}

/**
 * Every alchemy session this character has, from all three trackers.
 * @returns {Promise<Array<Object>>} Sessions, each tagged with its `kind`
 */
async function collectAlchemySessions() {
    const charId = dataManager.getCurrentCharacterId?.() || NO_CHARACTER;
    const sessions = [];

    for (const { kind, baseKey } of ALCHEMY_STORES) {
        const store = createAlchemySessionStore(baseKey, 'GoldSources');
        const rows = await attempt(`${kind} sessions`, () => store.load(charId), []);
        for (const session of rows) if (session) sessions.push({ ...session, kind });
    }

    return sessions;
}

/**
 * Gather every recording the attribution needs.
 *
 * @param {Object} [options] - Overrides
 * @param {Function} [options.price] - A pricer, for tests
 * @returns {Promise<Object>} The `attributeGoldSources` input, minus the window
 */
export async function collectGoldSourceInputs({ price = createPricer() } = {}) {
    const [lootEntries, productionDays, alchemySessions, enhancementSessions, combatSessions] = await Promise.all([
        attempt('the loot log', () => lootLogHistory.getHistoricalEntries(new Set()), []),
        attempt('the production recorder', () => productionIncomeRecorder.load(), []),
        collectAlchemySessions(),
        attempt('the enhancement sessions', () => loadEnhancementSessions(), {}),
        attempt('the combat session history', () => loadCombatSessions(), []),
    ]);

    const tradeFills = await attempt(
        'the trade ledger',
        async () => (tradeLedgerStore.isReady?.() ? tradeLedgerStore.getRecords() : []),
        []
    );

    return {
        series: networthHistory.getHistory?.() || [],
        lootEntries,
        actionType: (actionHrid) => dataManager.getActionDetails?.(actionHrid)?.type || null,
        productionDays,
        alchemySessions,
        enhancementSessions: Object.values(enhancementSessions || {}),
        tradeFills,
        combatSessions,
        // The bound the archived runs are kept under, carried through so the
        // panel can say how far the combat fallback actually reaches back
        sessionCap: MAX_SESSIONS,
        price,
        marketTax: MARKET_TAX,
    };
}
