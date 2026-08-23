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
 * ## Days are UTC
 *
 * Every recorder this reads buckets on UTC day boundaries (see
 * `utils/chunked-history.js`), and a per-day table that disagreed with the
 * records it is built from would be worse than one that says which midnight it
 * means. The panel says so.
 *
 * ## Purity
 *
 * Nothing here reads storage, the DOM or the market. Prices arrive as a
 * `price(itemHrid, enhancementLevel)` callback and the recordings arrive as
 * plain arrays, so the arithmetic that decides what a week of play was worth is
 * testable without a game running behind it.
 */

/** Milliseconds in a day */
const DAY_MS = 24 * 60 * 60 * 1000;

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
        source: 'Loot log history',
        note: 'Every drop the loot log recorded for a combat action, priced at today’s market.',
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
 * The UTC day a timestamp falls in.
 * @param {number} t - Milliseconds since the epoch
 * @returns {string} `YYYY-MM-DD`
 */
export function utcDayId(t) {
    const date = new Date(Number.isFinite(t) ? t : 0);
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${date.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Midnight UTC at the start of a day id.
 * @param {string} dayId - `YYYY-MM-DD`
 * @returns {number} Milliseconds since the epoch
 */
export function dayStart(dayId) {
    return Date.parse(`${dayId}T00:00:00.000Z`);
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
    for (let t = dayStart(utcDayId(from)); t <= to; t += DAY_MS) days.push(utcDayId(t));
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
        total += num(price(itemHrid, enhancementLevel)) * num(count);
    }
    return total;
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
 * Realised marketplace profit and tax paid, per UTC day.
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
        const id = utcDayId(t);
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
        const id = utcDayId(point.t);
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
 * Split a window's net worth delta across the activity that is recorded for it.
 *
 * @param {Object} input - Everything the attribution reads
 * @param {number} input.from - Window start, milliseconds
 * @param {number} input.to - Window end, milliseconds
 * @param {Array<Object>} [input.series] - Net worth snapshots `{t, total}`
 * @param {Array<Object>} [input.lootEntries] - Loot log entries
 * @param {Function} [input.actionType] - `(actionHrid) => string|null`
 * @param {Array<Object>} [input.productionDays] - Recorder rows `{d, outputValue, inputValue, offlineProfit}`
 * @param {Array<Object>} [input.alchemySessions] - Stored alchemy sessions
 * @param {Array<Object>} [input.enhancementSessions] - Stored enhancement sessions
 * @param {Array<Object>} [input.tradeFills] - Trade ledger fill records
 * @param {Array<Object>} [input.combatSessions] - Archived combat runs
 * @param {Function} input.price - `(itemHrid, enhancementLevel) => number|null`
 * @param {number} [input.marketTax] - Sell tax rate
 * @returns {{
 *   from: number, to: number,
 *   days: Array<{day: string, sources: Object, explained: number, delta: number|null, residual: number|null}>,
 *   totals: {sources: Object, explained: number, delta: number|null, residual: number|null},
 *   coverage: Object<string, number|null>,
 *   unpricedEnhancementSessions: number
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
    // consumed, and the production recorder below has both halves
    for (const entry of lootEntries || []) {
        const t = Date.parse(entry?.startTime);
        if (!Number.isFinite(t)) continue;
        const type = actionType(entry.actionHrid);
        const key =
            type === '/action_types/combat' ? 'combat' : GATHERING_ACTION_TYPES.includes(type) ? 'gathering' : null;
        if (!key) continue;
        add(utcDayId(t), key, lootEntryValue(entry, price));
    }

    // Production recorder: already per UTC day, already valued
    for (const row of productionDays || []) {
        if (!row?.d) continue;
        add(row.d, 'production', num(row.outputValue) - num(row.inputValue));
        add(row.d, 'offline', num(row.offlineProfit));
    }

    for (const session of alchemySessions || []) {
        const t = num(session?.startTime);
        if (!t) continue;
        add(utcDayId(t), 'alchemy', alchemySessionNet(session, price));
    }

    let unpricedEnhancementSessions = 0;
    for (const session of enhancementSessions || []) {
        const t = num(session?.startTime);
        if (!t) continue;
        const net = enhancementSessionNet(session, price);
        if (net === null) {
            if (inWindow.has(utcDayId(t))) unpricedEnhancementSessions += 1;
            continue;
        }
        add(utcDayId(t), 'enhancement', net);
    }

    const market = marketplaceByDay(tradeFills, marketTax);
    for (const [day, figures] of Object.entries(market)) {
        add(day, 'marketplace', figures.realisedGross);
        add(day, 'marketTax', -figures.tax);
    }

    for (const session of combatSessions || []) {
        const t = Date.parse(session?.combatStartTime);
        if (!Number.isFinite(t)) continue;
        const me = (session.players || []).find((player) => player?.isCurrentPlayer) || session.players?.[0];
        let cost = 0;
        for (const consumable of me?.consumables || []) {
            const consumed = num(consumable?.consumed);
            if (consumed <= 0) continue;
            cost += consumed * num(price(consumable.itemHrid, 0));
        }
        add(utcDayId(t), 'consumables', -cost);
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
            combat: earliest(lootEntries, (entry) => Date.parse(entry?.startTime)),
            gathering: earliest(lootEntries, (entry) => Date.parse(entry?.startTime)),
            production: earliest(productionDays, (row) => dayStart(row?.d)),
            offline: earliest(productionDays, (row) => (row?.offlineProfit ? dayStart(row?.d) : NaN)),
            alchemy: earliest(alchemySessions, (session) => num(session?.startTime) || NaN),
            enhancement: earliest(enhancementSessions, (session) => num(session?.startTime) || NaN),
            marketplace: earliest(tradeFills, (fill) => num(fill?.t) || NaN),
            marketTax: earliest(tradeFills, (fill) => num(fill?.t) || NaN),
            consumables: earliest(combatSessions, (session) => Date.parse(session?.combatStartTime)),
        },
        unpricedEnhancementSessions,
    };
}
