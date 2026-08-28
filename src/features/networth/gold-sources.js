/**
 * Gold source attribution.
 *
 * ## The question
 *
 * The net worth history says the account is worth eight hundred million more
 * than it was a week ago. It does not say where that came from, and the honest
 * answer is that nothing in this script knows for certain: net worth is a
 * valuation of everything owned, and it moves when the market moves as readily
 * as when the player earns anything.
 *
 * What the script *does* have is several independent recordings of activity —
 * the loot log, the alchemy session stores, the enhancement sessions, the trade
 * ledger, and (new, alongside this) a per-day production recorder. Each of them
 * can be turned into a number of coins. Adding them up gives a figure that
 * explains *some* of the net worth delta.
 *
 * ## The residual is the point
 *
 * The difference between the measured net worth delta and the sum of the
 * attributed sources is reported as a residual and never distributed across the
 * sources to make the table balance. A residual is real information:
 *
 * - market movement — everything owned repriced, which no activity caused;
 * - activity older than a recorder's coverage window (the loot log keeps five
 *   hundred entries, the combat session history twenty runs);
 * - activity nothing records at all (quests, task rewards, chest opens,
 *   guild contributions, gifts);
 * - valuation drift, because every source here is priced at *today's* market,
 *   not at the price on the day it happened.
 *
 * A balancing plug hides all four. The residual names them.
 *
 * ## Combat has two recordings, and they must not be added together
 *
 * The loot log is the game's own record of what an action produced, but the
 * game only *sends* it while the Loot & XP Log panel is open. A character that
 * fights all week and never opens that panel records nothing at all, and the
 * combat row reported a confident measured zero while the consumables row —
 * fed from the archived combat runs — proved the fighting happened.
 *
 * So the row reads both. Per local day: if the loot log has any combat entry that
 * day, that day is the loot log's, because it includes runs this client never
 * watched. Otherwise the day falls back to the archived runs' own loot maps.
 * Never both for one day — the same drop is in both recordings, and summing
 * them would double it.
 *
 * The fallback is bounded in a way the loot log is not: only the twenty most
 * recent runs are kept, so a busy week reaches back further than they do. Days
 * that neither recording covers are counted and reported rather than left to
 * look like days of no combat, and what they were worth stays in the residual.
 *
 * ## Days are local
 *
 * A day here means the day the user experienced, midnight to midnight in
 * their own timezone — the same keying the net worth calendar uses. Storage
 * still CHUNKS some histories by UTC day (`utils/chunked-history.js`), but a
 * chunk id is where a record lives, not what day its own timestamp belongs
 * to; every entry is re-bucketed here from its timestamp.
 *
 * ## Purity
 *
 * Nothing here reads storage, the DOM or the market. Prices arrive as a
 * `price(itemHrid, enhancementLevel)` callback and the recordings arrive as
 * plain arrays, so the arithmetic that decides what a week of play was worth is
 * testable without a game running behind it.
 */

/** Milliseconds in a day */
import { localDayKey, localDayStart } from './networth-calendar.js';

/**
 * How many archived combat runs the history keeps, when the caller does not
 * say. The real bound is `MAX_SESSIONS` in `combat-session-history.js`; it is
 * passed in rather than imported so this module stays free of storage, and
 * mirrored here so a caller that forgets still reports an honest limit.
 */
export const DEFAULT_SESSION_CAP = 20;

/** Gathering action types, whose loot log entries are gathered output */
export const GATHERING_ACTION_TYPES = ['/action_types/foraging', '/action_types/woodcutting', '/action_types/milking'];

/** The attributed sources, in the order the panel stacks and lists them */
export const SOURCE_KEYS = [
    'combat',
    'gathering',
    'production',
    'alchemy',
    'enhancement',
    'marketplace',
    'offline',
    'consumables',
    'marketTax',
];

/** Display names, and what each one is actually measuring */
export const SOURCE_META = {
    combat: {
        label: 'Combat drops',
        measured: true,
        source: 'Loot log history, and the battle feed where it is silent',
        note:
            'Every drop the loot log recorded for a combat action, priced at today’s market. The game only sends ' +
            'the loot log while its panel is open, so on a day it recorded nothing the archived combat runs are ' +
            'read instead — your own share of their loot, from the twenty most recent runs. Never both for one day.',
    },
    gathering: {
        label: 'Gathering',
        measured: true,
        source: 'Loot log history',
        note: 'Milking, foraging and woodcutting drops from the loot log, priced at today’s market.',
    },
    production: {
        label: 'Production',
        measured: false,
        source: 'Production income recorder',
        note:
            'Outputs minus inputs for cooking, brewing, crafting, tailoring and cheesesmithing, ' +
            'estimated from the recipe and the number of actions completed — rare extras are not counted.',
    },
    alchemy: {
        label: 'Alchemy',
        measured: true,
        source: 'Alchemy session stores',
        note: 'Recorded transmute, decompose and coinify results, less the items and catalysts consumed.',
    },
    enhancement: {
        label: 'Enhancement',
        measured: true,
        source: 'Enhancement sessions',
        note: 'What each item gained in value by being enhanced, less the materials, coins and protections spent.',
    },
    marketplace: {
        label: 'Marketplace',
        measured: true,
        source: 'Trade ledger',
        note: 'Realised profit on your own filled listings, before tax — average-cost matched against recorded buys.',
    },
    offline: {
        label: 'Offline progress',
        measured: true,
        source: 'Production income recorder',
        note: 'The Welcome Back summary, recorded as it arrives. Nothing before the recorder existed can be recovered.',
    },
    consumables: {
        label: 'Consumables',
        measured: true,
        source: 'Combat session history',
        note: 'Food and drinks consumed in recorded combat runs. Only the twenty most recent runs are kept.',
    },
    marketTax: {
        label: 'Market tax',
        measured: true,
        source: 'Trade ledger',
        note: 'Tax paid on every filled sell listing, shown apart from the marketplace profit it is deducted from.',
    },
};

/**
 * The LOCAL calendar day a timestamp falls in — the day the user experienced.
 * Delegates to the net worth calendar's keying so the two can never disagree.
 * @param {number} t - Milliseconds since the epoch
 * @returns {string} `YYYY-MM-DD`
 */
export function localDayId(t) {
    return localDayKey(Number.isFinite(t) ? t : 0);
}

/**
 * Local midnight at the start of a day id.
 * @param {string} dayId - `YYYY-MM-DD`
 * @returns {number} Milliseconds since the epoch
 */
export function dayStart(dayId) {
    return localDayStart(dayId);
}

/**
 * How much of a time span falls in each local day it touches.
 *
 * A zero-length span (a session with no recorded duration) is its start day,
 * whole. Days step by calendar date, so DST days weigh their real length.
 *
 * @param {number} from - Span start, epoch ms
 * @param {number} to - Span end, epoch ms
 * @returns {Array<{day: string, share: number}>} Shares summing to 1
 */
export function daySharesOfSpan(from, to) {
    if (!Number.isFinite(from)) return [];
    if (!Number.isFinite(to) || to <= from) return [{ day: localDayId(from), share: 1 }];

    const total = to - from;
    const shares = [];
    const cursor = new Date(dayStart(localDayId(from)));
    while (cursor.getTime() < to) {
        const start = cursor.getTime();
        cursor.setDate(cursor.getDate() + 1);
        const overlap = Math.min(to, cursor.getTime()) - Math.max(from, start);
        if (overlap > 0) shares.push({ day: localDayId(start), share: overlap / total });
    }
    return shares;
}

/**
 * The day ids a window covers, oldest first.
 * @param {number} from - Window start
 * @param {number} to - Window end
 * @returns {Array<string>} Day ids
 */
export function daysBetween(from, to) {
    const days = [];
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return days;
    // Stepped by calendar date rather than 24h, so a DST day (23 or 25 hours)
    // neither repeats nor skips an id
    const cursor = new Date(dayStart(localDayId(from)));
    while (cursor.getTime() <= to) {
        days.push(localDayId(cursor.getTime()));
        cursor.setDate(cursor.getDate() + 1);
    }
    return days;
}

/**
 * Split a loot log drop key into its item and enhancement level.
 * @param {string} key - `/items/foo` or `/items/foo::3`
 * @returns {{itemHrid: string, enhancementLevel: number}} The pair
 */
export function splitDropKey(key) {
    const match = /^(.*)::(\d+)$/.exec(String(key || ''));
    if (!match) return { itemHrid: String(key || ''), enhancementLevel: 0 };
    return { itemHrid: match[1], enhancementLevel: Number(match[2]) || 0 };
}

/** @returns {number} `value` when it is a usable number, else 0 */
function num(value) {
    return Number.isFinite(value) ? value : 0;
}

/**
 * A blank per-source tally.
 * @returns {Object} Every source key at zero
 */
function emptyTally() {
    const tally = {};
    for (const key of SOURCE_KEYS) tally[key] = 0;
    return tally;
}

/** Coin dropped as loot is coins - face value, no market lookup */
const COIN_HRID = '/items/coin';

/**
 * One drop's unit worth: coin at face value, everything else at market.
 *
 * The pricer knows no price for coin (it has no order book), which silently
 * valued every combat coin drop at nothing and left it in the residual.
 * Face value here rather than in the shared pricer, because the alchemy and
 * enhancement paths already carry their coins through `totalCoinsEarned` and
 * a pricer-level coin would count those twice.
 * @param {Function} price - `(itemHrid, enhancementLevel) => number|null`
 * @param {string} itemHrid
 * @param {number} enhancementLevel
 * @returns {number}
 */
function dropUnitValue(price, itemHrid, enhancementLevel) {
    if (itemHrid === COIN_HRID) return 1;
    return num(price(itemHrid, enhancementLevel));
}

/**
 * What a loot log entry's drops are worth.
 * @param {Object} entry - A loot log entry
 * @param {Function} price - `(itemHrid, enhancementLevel) => number|null`
 * @returns {number} Coins
 */
export function lootEntryValue(entry, price) {
    let total = 0;
    for (const [key, count] of Object.entries(entry?.drops || {})) {
        const { itemHrid, enhancementLevel } = splitDropKey(key);
        total += dropUnitValue(price, itemHrid, enhancementLevel) * num(count);
    }
    return total;
}

/**
 * The archived run's own player.
 *
 * A run is a party's run and its `players` array holds everybody in it, but the
 * gold attribution is one character's ledger: counting the party's loot would
 * credit this account with four people's drops. The current player is flagged,
 * and a solo run recorded before the flag existed falls back to the only player
 * there is — which is exactly how the consumables row scopes itself, and the
 * two rows must not disagree about whose run it was.
 *
 * @param {Object} session - An archived combat run
 * @returns {Object|null} The player entry, or null
 */
export function ownCombatPlayer(session) {
    const players = session?.players || [];
    return players.find((player) => player?.isCurrentPlayer) || players[0] || null;
}

/**
 * What one archived combat run's loot was worth to this character.
 *
 * The run's loot map is keyed by the game's own slot key with the item inside,
 * so two slots of one item are two entries; every entry is priced the way
 * {@link lootEntryValue} prices a loot log drop — at today's market, with no
 * tax deducted, because the loot log side does not deduct one either and a row
 * fed from both sources must not change character with its source.
 *
 * `items` is how many priced-or-not loot entries the run held, which is what
 * separates "this run dropped nothing worth anything" from "this run recorded
 * no loot at all" — the second is a gap and gets said out loud.
 *
 * @param {Object} session - An archived combat run
 * @param {Function} price - `(itemHrid, enhancementLevel) => number|null`
 * @returns {{value: number, items: number}} Coins, and how many loot entries there were
 */
export function combatSessionLootValue(session, price) {
    const me = ownCombatPlayer(session);
    let value = 0;
    let items = 0;
    for (const entry of Object.values(me?.loot || {})) {
        if (!entry?.itemHrid) continue;
        items += 1;
        value += dropUnitValue(price, entry.itemHrid, num(entry.enhancementLevel)) * num(entry.count);
    }
    return { value, items };
}

/**
 * What one alchemy session added to the account.
 *
 * Outputs less the inputs consumed and the catalysts spent. Transmute and
 * decompose record their outputs item by item; coinify records the coins it
 * produced. Every session records attempts, and an attempt consumes one input
 * whether or not it succeeded — which is exactly why alchemy can lose money and
 * why counting only the outputs would be a lie.
 *
 * @param {Object} session - A stored alchemy session, tagged with `kind`
 * @param {Function} price - `(itemHrid, enhancementLevel) => number|null`
 * @returns {number} Coins, which may be negative
 */
export function alchemySessionNet(session, price) {
    if (!session) return 0;

    let outputs = num(session.totalCoinsEarned);
    for (const [itemHrid, result] of Object.entries(session.results || {})) {
        const count = num(result?.count);
        if (count <= 0) continue;
        const unit = price(itemHrid, 0);
        outputs += Number.isFinite(unit) ? unit * count : num(result?.totalValue);
    }

    const attempts = num(session.totalAttempts);
    const inputs = attempts * num(price(session.inputItemHrid, num(session.enhancementLevel)));

    const catalysts =
        num(session.catalystOfCoinificationUsed) * num(price('/items/catalyst_of_coinification', 0)) +
        num(session.catalystOfDecompositionUsed) * num(price('/items/catalyst_of_decomposition', 0)) +
        num(session.catalystOfTransmutationUsed) * num(price('/items/catalyst_of_transmutation', 0)) +
        num(session.primeCatalystUsed) * num(price('/items/prime_catalyst', 0));

    return outputs - inputs - catalysts;
}

/**
 * What one enhancement session added to the account.
 *
 * The item is worth more at a higher level, and the run cost materials, coins
 * and protections to get there. Both halves are needed: a session that spent
 * two hundred million to add a hundred and fifty million of item value made the
 * account poorer, and reporting only the level gained would show it as income.
 *
 * A session whose item cannot be priced at one of its two levels — high
 * enhancement levels frequently have no market at all — returns null rather
 * than a number built on a missing half.
 *
 * @param {Object} session - A stored enhancement session
 * @param {Function} price - `(itemHrid, enhancementLevel) => number|null`
 * @returns {number|null} Coins, which may be negative, or null when unpriceable
 */
export function enhancementSessionNet(session, price) {
    if (!session?.itemHrid) return null;

    const from = price(session.itemHrid, num(session.startLevel));
    const to = price(session.itemHrid, num(session.currentLevel ?? session.startLevel));
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;

    return to - from - num(session.totalCost);
}

/**
 * Realised marketplace profit and tax paid, per local day.
 *
 * Average-cost matched per item and enhancement level, chronologically over the
 * *whole* ledger rather than the window — a sell inside the window was very
 * often bought before it, and starting the pool at the window edge would call
 * that whole sale profit.
 *
 * The profit reported is before tax, and the tax is reported beside it, so the
 * two lines sum to what actually landed. Sells with no recorded buy behind them
 * realise nothing: calling untracked cost zero would fake a total margin.
 *
 * @param {Array<Object>} fills - Trade ledger fill records, any order
 * @param {number} marketTax - Sell tax rate, e.g. 0.05
 * @returns {Object<string, {realisedGross: number, tax: number}>} Keyed by day id
 */
export function marketplaceByDay(fills, marketTax) {
    const sorted = (Array.isArray(fills) ? fills.filter((fill) => fill && fill.itemHrid) : []).slice();
    sorted.sort((a, b) => num(a.t) - num(b.t));

    const pools = new Map();
    const byDay = {};

    const dayFor = (t) => {
        const id = localDayId(t);
        if (!byDay[id]) byDay[id] = { realisedGross: 0, tax: 0 };
        return byDay[id];
    };

    for (const fill of sorted) {
        const key = `${fill.itemHrid}:${num(fill.enhancementLevel)}`;
        let pool = pools.get(key);
        if (!pool) {
            pool = { qty: 0, cost: 0 };
            pools.set(key, pool);
        }

        const quantity = num(fill.quantity);
        if (quantity <= 0) continue;

        if (fill.side === 'buy') {
            pool.qty += quantity;
            pool.cost += num(fill.coins);
            continue;
        }
        if (fill.side !== 'sell') continue;

        // `coins` on a sell is already net of tax; the gross is what the
        // listing was worth before the market took its cut
        const net = num(fill.coins);
        const gross = num(fill.price) * quantity;
        const tax = Math.max(0, gross - net) || gross * num(marketTax);

        const day = dayFor(fill.t);
        day.tax += tax;

        const matched = Math.min(quantity, pool.qty);
        if (matched > 0) {
            const avgCost = pool.cost / pool.qty;
            const costOut = avgCost * matched;
            pool.qty -= matched;
            pool.cost -= costOut;
            day.realisedGross += gross * (matched / quantity) - costOut;
        }
    }

    return byDay;
}

/**
 * The net worth measured at the end of each day in a window.
 *
 * The last snapshot of a day is that day's closing figure, and a day's delta is
 * its close against the previous day's. A day with no snapshot at all — the
 * player did not log in — has no close, and the next day that does have one
 * carries the whole gap rather than the gap being invented for the silent day.
 *
 * @param {Array<Object>} series - Net worth snapshots `{t, total}`, any order
 * @returns {Object<string, number>} day id → closing total
 */
export function dailyCloses(series) {
    const closes = {};
    const seen = {};
    for (const point of Array.isArray(series) ? series : []) {
        if (!point || !Number.isFinite(point.t) || !Number.isFinite(point.total)) continue;
        const id = localDayId(point.t);
        if (seen[id] !== undefined && seen[id] > point.t) continue;
        seen[id] = point.t;
        closes[id] = point.total;
    }
    return closes;
}

/**
 * The earliest timestamp in a list, or null when there is none.
 * @param {Array<*>} items - Anything
 * @param {Function} timeOf - `(item) => number|NaN`
 * @returns {number|null} Milliseconds since the epoch
 */
function earliest(items, timeOf) {
    let best = null;
    for (const item of Array.isArray(items) ? items : []) {
        const t = timeOf(item);
        if (!Number.isFinite(t)) continue;
        if (best === null || t < best) best = t;
    }
    return best;
}

/**
 * The earlier of two timestamps, either of which may be missing.
 * @param {number|null} a - Milliseconds, or null
 * @param {number|null} b - Milliseconds, or null
 * @returns {number|null} The earlier one, or whichever exists
 */
function earlierOf(a, b) {
    if (!Number.isFinite(a)) return Number.isFinite(b) ? b : null;
    if (!Number.isFinite(b)) return a;
    return Math.min(a, b);
}

/**
 * Split a window's net worth delta across the activity that is recorded for it.
 *
 * @param {Object} input - Everything the attribution reads
 * @param {number} input.from - Window start, milliseconds
 * @param {number} input.to - Window end, milliseconds
 * @param {Array<Object>} [input.series] - Net worth snapshots `{t, total}`
 * @param {Array<Object>} [input.lootEntries] - Loot log entries
 * @param {Function} [input.actionType] - `(actionHrid) => string|null`
 * @param {Array<Object>} [input.productionDays] - Recorder rows
 *   `{d, outputValue, inputValue, offlineProfit, unpricedActions}`
 * @param {Array<Object>} [input.alchemySessions] - Stored alchemy sessions
 * @param {Array<Object>} [input.enhancementSessions] - Stored enhancement sessions
 * @param {Array<Object>} [input.tradeFills] - Trade ledger fill records
 * @param {Array<Object>} [input.combatSessions] - Archived combat runs
 * @param {number} [input.sessionCap] - How many runs the history keeps
 * @param {Function} input.price - `(itemHrid, enhancementLevel) => number|null`
 * @param {number} [input.marketTax] - Sell tax rate
 * @returns {{
 *   from: number, to: number,
 *   days: Array<{day: string, sources: Object, explained: number, delta: number|null, residual: number|null}>,
 *   totals: {sources: Object, explained: number, delta: number|null, residual: number|null},
 *   coverage: Object<string, number|null>,
 *   unpricedEnhancementSessions: number,
 *   unpricedProductionActions: number,
 *   combatBasis: {lootLogDays: number, sessionDays: number, uncoveredDays: number, sessions: number,
 *     emptySessions: number, sessionsHeld: number, sessionCap: number, lastLootLog: number|null,
 *     combatRan: boolean}
 * }} The attribution
 */
export function attributeGoldSources(input) {
    const {
        from,
        to,
        series = [],
        lootEntries = [],
        actionType = () => null,
        productionDays = [],
        alchemySessions = [],
        enhancementSessions = [],
        tradeFills = [],
        combatSessions = [],
        sessionCap = DEFAULT_SESSION_CAP,
        price = () => null,
        marketTax = 0.05,
    } = input || {};

    const days = daysBetween(from, to);
    const inWindow = new Set(days);
    const tallies = new Map(days.map((day) => [day, emptyTally()]));

    /**
     * @param {string} day - Day id
     * @param {string} key - Source key
     * @param {number} value - Coins to add
     */
    const add = (day, key, value) => {
        if (!inWindow.has(day) || !Number.isFinite(value) || value === 0) return;
        tallies.get(day)[key] += value;
    };

    // Loot log: combat and gathering. Production actions are deliberately not
    // read from here — the log records what an action produced but not what it
    // consumed, and the production recorder below has both halves.
    //
    // Gathering is added straight away; combat is held aside, because the day
    // it lands on may instead be served by the archived runs and the two must
    // never be summed. A day is *the loot log's* as soon as it has one combat
    // entry, worth anything or not: the log recorded that day, and what it
    // recorded is the answer for it
    const combatLootDays = new Map();
    let lastCombatLootLog = null;
    for (const entry of lootEntries || []) {
        const t = Date.parse(entry?.startTime);
        if (!Number.isFinite(t)) continue;
        const type = actionType(entry.actionHrid);
        if (type === '/action_types/combat') {
            if (lastCombatLootLog === null || t > lastCombatLootLog) lastCombatLootLog = t;
            const day = localDayId(t);
            combatLootDays.set(day, (combatLootDays.get(day) || 0) + lootEntryValue(entry, price));
            continue;
        }
        if (!GATHERING_ACTION_TYPES.includes(type)) continue;
        add(localDayId(t), 'gathering', lootEntryValue(entry, price));
    }

    // Production recorder: already per day, already valued
    let unpricedProductionActions = 0;
    for (const row of productionDays || []) {
        if (!row?.d) continue;
        add(row.d, 'production', num(row.outputValue) - num(row.inputValue));
        add(row.d, 'offline', num(row.offlineProfit));
        // Actions the recorder could not value at all, because one of their
        // items has no market price. They are in the residual, not the
        // production row, and the panel says so rather than letting the
        // production figure look complete
        if (inWindow.has(row.d)) unpricedProductionActions += num(row.unpricedActions);
    }

    for (const session of alchemySessions || []) {
        const t = num(session?.startTime);
        if (!t) continue;
        add(localDayId(t), 'alchemy', alchemySessionNet(session, price));
    }

    let unpricedEnhancementSessions = 0;
    for (const session of enhancementSessions || []) {
        const t = num(session?.startTime);
        if (!t) continue;
        const net = enhancementSessionNet(session, price);
        if (net === null) {
            if (inWindow.has(localDayId(t))) unpricedEnhancementSessions += 1;
            continue;
        }
        add(localDayId(t), 'enhancement', net);
    }

    const market = marketplaceByDay(tradeFills, marketTax);
    for (const [day, figures] of Object.entries(market)) {
        add(day, 'marketplace', figures.realisedGross);
        add(day, 'marketTax', -figures.tax);
    }

    // The combat runs, which pay for two rows: the consumables burned in them,
    // and — where the loot log was closed and so recorded nothing — the drops.
    //
    // A session's totals are SPREAD across the days it actually ran, by time.
    // Booking everything to the start day put a twelve-day AFK grind — the
    // normal way this game is played — entirely on a day outside every window,
    // and the combat row read 0 while the loot was accruing right now. Which
    // day each drop really fell on is unknowable from a session total, so the
    // uniform-by-time share is the honest estimate, and it is exact for the
    // common one-day session.
    const combatSessionDays = new Map();
    let sessionsInWindow = 0;
    let emptyLootSessions = 0;
    let consumablesAttributed = false;
    let earliestSession = null;
    for (const session of combatSessions || []) {
        const t = Date.parse(session?.combatStartTime);
        if (!Number.isFinite(t)) continue;
        if (earliestSession === null || t < earliestSession) earliestSession = t;

        const me = ownCombatPlayer(session);
        let cost = 0;
        for (const consumable of me?.consumables || []) {
            const consumed = num(consumable?.consumed);
            if (consumed <= 0) continue;
            cost += consumed * num(price(consumable.itemHrid, 0));
        }

        const loot = combatSessionLootValue(session, price);
        const spanEnd = t + Math.max(0, num(session?.durationSeconds)) * 1000;
        const shares = daySharesOfSpan(t, spanEnd);

        let touchedWindow = false;
        for (const { day, share } of shares) {
            add(day, 'consumables', -cost * share);
            if (!inWindow.has(day)) continue;
            touchedWindow = true;
            const held = combatSessionDays.get(day) || { value: 0, items: 0 };
            held.value += loot.value * share;
            held.items += loot.items;
            combatSessionDays.set(day, held);
        }

        if (!touchedWindow) continue;
        sessionsInWindow += 1;
        if (cost > 0) consumablesAttributed = true;
        if (loot.items === 0) emptyLootSessions += 1;
    }

    // The precedence rule, one day at a time: the loot log where it spoke, the
    // archived runs where it did not, and a counted gap where neither did
    let lootLogCombatDays = 0;
    let sessionCombatDays = 0;
    let uncoveredCombatDays = 0;
    const combatRan = sessionsInWindow > 0 || consumablesAttributed;
    for (const day of days) {
        if (combatLootDays.has(day)) {
            add(day, 'combat', combatLootDays.get(day));
            lootLogCombatDays += 1;
            continue;
        }
        const session = combatSessionDays.get(day);
        if (session && session.items > 0) {
            add(day, 'combat', session.value);
            sessionCombatDays += 1;
            continue;
        }
        // Only a gap when something proves combat happened this window at all;
        // a character who does not fight has no gap, it has no combat
        if (combatRan) uncoveredCombatDays += 1;
    }

    // The net worth each day closed at, and what the day before closed at, so a
    // day's delta is a measurement rather than a difference of interpolations
    const closes = dailyCloses(series);
    const closeBefore = (day) => {
        let best = null;
        const start = dayStart(day);
        for (const [id, total] of Object.entries(closes)) {
            const t = dayStart(id);
            if (t >= start) continue;
            if (best === null || t > best.t) best = { t, total };
        }
        return best?.total ?? null;
    };

    const rows = [];
    const totalsSources = emptyTally();
    let totalExplained = 0;

    for (const day of days) {
        const sources = tallies.get(day);
        let explained = 0;
        for (const key of SOURCE_KEYS) {
            explained += sources[key];
            totalsSources[key] += sources[key];
        }
        totalExplained += explained;

        const close = closes[day];
        const previous = closeBefore(day);
        const delta = Number.isFinite(close) && Number.isFinite(previous) ? close - previous : null;

        rows.push({
            day,
            sources,
            explained,
            delta,
            residual: delta === null ? null : delta - explained,
        });
    }

    // The window's delta is measured end to end, not summed from the days: a
    // day with no snapshot has no delta of its own, and summing would silently
    // drop whatever happened across it.
    //
    // The baseline is the last close before the window, and failing that the
    // first close inside it — a window that reaches back further than the
    // history does still has a measurable change, just a shorter one than it
    // was asked for.
    const firstDay = days[0];
    const closedDays = days.filter((day) => Number.isFinite(closes[day]));
    let openingClose = firstDay ? closeBefore(firstDay) : null;
    let firstClosed = 0;
    if (openingClose === null && closedDays.length > 0) {
        openingClose = closes[closedDays[0]];
        firstClosed = 1;
    }
    const lastClose = closedDays.length > firstClosed ? closes[closedDays[closedDays.length - 1]] : null;
    const windowDelta = Number.isFinite(lastClose) && Number.isFinite(openingClose) ? lastClose - openingClose : null;

    return {
        from,
        to,
        days: rows,
        totals: {
            sources: totalsSources,
            explained: totalExplained,
            delta: windowDelta,
            residual: windowDelta === null ? null : windowDelta - totalExplained,
        },
        coverage: {
            // Split the same way the attribution loop above splits them: the
            // loot log holds both, and answering "combat has been recorded
            // since" with the date of a foraging entry claims coverage for a
            // source that has never been seen.
            //
            // Combat now has two recordings, so its coverage is the earlier of
            // them: a character who never opened the loot log is covered from
            // its oldest archived run, and saying "nothing recorded" there
            // would be as wrong as the zero this replaced
            combat: earlierOf(
                earliest(lootEntries, (entry) =>
                    actionType(entry?.actionHrid) === '/action_types/combat' ? Date.parse(entry?.startTime) : NaN
                ),
                earliestSession
            ),
            gathering: earliest(lootEntries, (entry) =>
                GATHERING_ACTION_TYPES.includes(actionType(entry?.actionHrid)) ? Date.parse(entry?.startTime) : NaN
            ),
            production: earliest(productionDays, (row) => dayStart(row?.d)),
            offline: earliest(productionDays, (row) => (row?.offlineProfit ? dayStart(row?.d) : NaN)),
            alchemy: earliest(alchemySessions, (session) => num(session?.startTime) || NaN),
            enhancement: earliest(enhancementSessions, (session) => num(session?.startTime) || NaN),
            marketplace: earliest(tradeFills, (fill) => num(fill?.t) || NaN),
            marketTax: earliest(tradeFills, (fill) => num(fill?.t) || NaN),
            consumables: earliest(combatSessions, (session) => Date.parse(session?.combatStartTime)),
        },
        unpricedEnhancementSessions,
        unpricedProductionActions,
        // What actually fed the combat row, so the panel can say so rather than
        // calling a fallback and a gap alike "Measured"
        combatBasis: {
            lootLogDays: lootLogCombatDays,
            sessionDays: sessionCombatDays,
            uncoveredDays: uncoveredCombatDays,
            sessions: sessionsInWindow,
            emptySessions: emptyLootSessions,
            sessionsHeld: (combatSessions || []).length,
            sessionCap,
            lastLootLog: lastCombatLootLog,
            combatRan,
        },
    };
}
