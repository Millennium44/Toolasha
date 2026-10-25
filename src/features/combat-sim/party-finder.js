/**
 * Party Finder: which party, from your saved teammates, does best for YOU?
 *
 * The arithmetic half of the Combat Sim's Party tab — kept free of the DOM so every rule
 * can be tested on its own. Given you, a roster and a set of zone/tiers, it plans every
 * party worth simming (you alone, then you plus every combination of teammates up to the
 * zone's party cap), builds each party's player DTOs, reads one finished sim into a row
 * for you alone, and ranks the rows against your solo baseline in the same zone/tier.
 *
 * The rules this follows are the All Zones sweep's (`_onSimulateAllZones` in
 * `combat-sim-ui.js`), checked off one by one in the module that runs it:
 *
 * - Figures are always yours (player1): your XP, deaths and your share of the drops,
 *   priced by `calculateSimRevenue` — never the party's sum.
 * - A party's level-gap penalties are recomputed for that party; alone, there is none.
 * - Ordinary zones take at most 3 players, dungeons 5.
 * - An unpriced drop, consumable or key is counted at zero by the pricing helper; such a
 *   row says so rather than passing its profit off as complete. A row whose pricing
 *   threw has no profit at all (null), never 0.
 * - Profit is bounded by market volume where the cache already knows the answer, display
 *   only, the same cache-only cap All Zones applies.
 */

import { calculateSimRevenue, recomputeLevelGapDebuffs } from './combat-sim-adapter.js';
import { capProfitRateCached } from '../../utils/liquidity-cap.js';
import { buildFingerprint } from './party-roster.js';

/** Largest party the game lets into an ordinary combat zone */
export const ZONE_MAX_PARTY = 3;

/** Largest party the game lets into a dungeon */
export const DUNGEON_MAX_PARTY = 5;

/** Above this many sims in all, the tab asks before starting */
export const CONFIRM_RUNS_ABOVE = 60;

/** More quick sims than this is refused outright: narrow the roster, zones or party size */
export const MAX_QUICK_RUNS = 1500;

/** Default sim hours for the quick first pass */
export const DEFAULT_QUICK_HOURS = 2;

/** Default number of best rows re-run at full hours */
export const DEFAULT_TOP_K = 5;

/** What the table can rank by */
export const RANK_METRICS = Object.freeze([
    { key: 'xp', label: 'EXP/hr' },
    { key: 'profit', label: 'Profit/hr' },
    { key: 'xpVsSolo', label: 'EXP vs solo' },
    { key: 'profitVsSolo', label: 'Profit vs solo' },
]);

const ONE_HOUR_NS = 3600 * 1e9;

/**
 * Party cap for a zone.
 * @param {{isDungeon?: boolean}} zone
 * @returns {number}
 */
export function zoneMaxParty(zone) {
    return zone?.isDungeon ? DUNGEON_MAX_PARTY : ZONE_MAX_PARTY;
}

/**
 * A zone/tier's key in the plan and the results.
 * @param {{zoneHrid: string, difficultyTier: number}} zone
 * @returns {string}
 */
export function zoneTierKey(zone) {
    return `${zone.zoneHrid}#${Number(zone.difficultyTier) || 0}`;
}

/**
 * n choose k.
 * @param {number} n
 * @param {number} k
 * @returns {number}
 */
function choose(n, k) {
    if (k < 0 || k > n) return 0;
    let result = 1;
    for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
    return Math.round(result);
}

/**
 * The roster narrowed by the include/exclude choices, each teammate with the build
 * fingerprint the plan dedupes by.
 * @param {Array<{id: string, name: string, dto: Object}>} roster
 * @param {Object<string, 'try'|'always'|'never'>} [choices] - By teammate id; missing means 'try'
 * @returns {{pool: Array<Object>, mustInclude: Array<Object>}} `pool` holds every teammate that may be picked
 *   (the must-includes among them)
 */
export function narrowRoster(roster, choices = {}) {
    const pool = [];
    const mustInclude = [];
    for (const entry of Array.isArray(roster) ? roster : []) {
        const choice = choices?.[entry.id] || 'try';
        if (choice === 'never') continue;
        const member = { id: entry.id, name: entry.name, dto: entry.dto, fingerprint: buildFingerprint(entry.dto) };
        pool.push(member);
        if (choice === 'always') mustInclude.push(member);
    }
    return { pool, mustInclude };
}

/**
 * An upper bound on how many parties a zone would try, before any duplicate builds fold together — cheap
 * enough to check before enumerating anything.
 * @param {number} poolSize - Teammates that may be picked
 * @param {number} mustCount - Of those, how many every party must hold
 * @param {number} maxMembers - Most teammates beside you
 * @returns {number} Including the solo baseline
 */
export function countCompositionsUpperBound(poolSize, mustCount, maxMembers) {
    if (mustCount > maxMembers) return 0;
    let total = mustCount > 0 ? 1 : 0; // the solo baseline is run even when every party must hold someone
    for (let k = mustCount; k <= Math.min(maxMembers, poolSize); k++)
        total += choose(poolSize - mustCount, k - mustCount);
    return total;
}

/**
 * Every party to try beside you: solo first, then by size. Two parties whose builds are the same multiset — the
 * same build saved under two names — are one party; the names it also goes by ride along as `aliases`.
 * @param {Array<Object>} pool - From {@link narrowRoster}
 * @param {Array<Object>} mustInclude - From {@link narrowRoster}
 * @param {number} maxMembers - Most teammates beside you
 * @returns {Array<{key: string, members: Array<Object>, aliases: Array<Array<string>>, isBaseline: boolean}>}
 */
export function enumerateCompositions(pool, mustInclude, maxMembers) {
    const result = [{ key: 'solo', members: [], aliases: [], isBaseline: true }];
    const mustIds = new Set(mustInclude.map((m) => m.id));
    if (mustIds.size > maxMembers) return result;

    // Same build, same index, so a party's key is its multiset of builds
    const buildIndex = new Map();
    for (const member of pool) {
        if (!buildIndex.has(member.fingerprint)) buildIndex.set(member.fingerprint, buildIndex.size);
    }
    const optional = pool.filter((m) => !mustIds.has(m.id));
    const must = pool.filter((m) => mustIds.has(m.id));
    const byKey = new Map();

    const visit = (start, picked) => {
        const members = [...must, ...picked];
        if (members.length > 0 && members.length <= maxMembers) {
            const key = members
                .map((m) => buildIndex.get(m.fingerprint))
                .sort((a, b) => a - b)
                .join('+');
            const existing = byKey.get(key);
            if (existing) existing.aliases.push(members.map((m) => m.name));
            else byKey.set(key, { key, members, aliases: [], isBaseline: false });
        }
        if (members.length >= maxMembers) return;
        for (let i = start; i < optional.length; i++) visit(i + 1, [...picked, optional[i]]);
    };
    visit(0, []);

    const parties = [...byKey.values()].sort((a, b) => a.members.length - b.members.length);
    return [...result, ...parties];
}

/**
 * The whole sweep: every (zone/tier × party) to sim, solo baselines first so a stop still leaves them.
 * @param {Object} options
 * @param {Array<{zoneHrid: string, difficultyTier: number, isDungeon: boolean, name: string}>} options.zones
 * @param {Array<Object>} options.roster - Saved teammates
 * @param {Object} [options.choices] - Include/exclude by teammate id
 * @param {number} [options.maxPartySize] - Largest party to try, you included; capped by each zone's own
 * @returns {{tasks: Array<{zone: Object, zoneKey: string, comp: Object}>, perZone: Array<{zone: Object,
 *   zoneKey: string, count: number, note: string|null}>, total: number, refused: string|null}}
 *   `refused` explains a sweep too large to plan
 */
export function planSweep({ zones, roster, choices = {}, maxPartySize = DUNGEON_MAX_PARTY }) {
    const { pool, mustInclude } = narrowRoster(roster, choices);
    const seen = new Set();
    const uniqueZones = [];
    for (const zone of Array.isArray(zones) ? zones : []) {
        const key = zoneTierKey(zone);
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueZones.push(zone);
    }

    const perZone = [];
    let bound = 0;
    for (const zone of uniqueZones) {
        const maxMembers = Math.max(0, Math.min(Number(maxPartySize) || DUNGEON_MAX_PARTY, zoneMaxParty(zone)) - 1);
        bound += countCompositionsUpperBound(pool.length, mustInclude.length, maxMembers);
        perZone.push({ zone, zoneKey: zoneTierKey(zone), maxMembers, count: 0, note: null });
    }
    if (bound > MAX_QUICK_RUNS * 20) {
        return { tasks: [], perZone, total: bound, refused: tooManyText(bound) };
    }

    const baselines = [];
    const parties = [];
    const compsByCap = new Map();
    for (const entry of perZone) {
        if (mustInclude.length > entry.maxMembers) {
            entry.note =
                `${mustInclude.map((m) => m.name).join(', ')} cannot all fit in a ` +
                `${entry.maxMembers + 1}-player party here`;
            continue;
        }
        if (!compsByCap.has(entry.maxMembers)) {
            compsByCap.set(entry.maxMembers, enumerateCompositions(pool, mustInclude, entry.maxMembers));
        }
        const comps = compsByCap.get(entry.maxMembers);
        // With no teammate that may join, the baseline alone answers nothing
        if (comps.length === 1) {
            entry.note = pool.length ? 'no party fits the size limit' : 'no teammates to try';
            continue;
        }
        entry.count = comps.length;
        for (const comp of comps) {
            const task = { zone: entry.zone, zoneKey: entry.zoneKey, comp };
            (comp.isBaseline ? baselines : parties).push(task);
        }
    }
    const tasks = [...baselines, ...parties];
    return {
        tasks,
        perZone,
        total: tasks.length,
        refused: tasks.length > MAX_QUICK_RUNS ? tooManyText(tasks.length) : null,
    };
}

/**
 * Why a sweep was refused.
 * @param {number} count
 * @returns {string}
 */
function tooManyText(count) {
    return (
        `That is ${count.toLocaleString('en-US')} sims, over the ${MAX_QUICK_RUNS.toLocaleString('en-US')} limit. ` +
        'Lower the max party size, exclude some teammates, or pick fewer zones.'
    );
}

/**
 * The player DTOs for one party: you as player1, teammates as player2.., each a copy, with the party's level-gap
 * penalties worked out for this party (none alone).
 * @param {Object} selfDTO
 * @param {Array<{dto: Object}>} members
 * @returns {Array<Object>}
 */
export function buildCompositionParty(selfDTO, members) {
    const party = [selfDTO, ...members.map((m) => m.dto)].map((dto, index) => ({
        ...structuredClone(dto),
        hrid: `player${index + 1}`,
        debuffOnLevelGap: 0,
    }));
    if (party.length > 1) recomputeLevelGapDebuffs(party);
    return party;
}

/**
 * One finished sim read for you (player1).
 * @param {Object|null} simResult
 * @param {Object} gameData
 * @param {number} hours - Hours the sim was asked for
 * @param {Object} [options]
 * @param {Map} [options.priceCache] - Shared by every row of a pass, so a price change midway cannot read as a
 *   difference between parties
 * @returns {{failed: true}|{failed: false, hours: number, xpPerHour: number, deathsPerHour: number,
 *   profitPerHour: number|null, uncappedProfit: number|null, liquidityLimit: Object|null,
 *   unpriced: Array<string>, simResult: Object}}
 */
export function readResult(simResult, gameData, hours, { priceCache } = {}) {
    if (!simResult) return { failed: true };
    const playerHrid = 'player1';
    const simHours = (simResult.simulatedTime || 0) / ONE_HOUR_NS || hours;
    const xp = simResult.experienceGained?.[playerHrid] || {};
    const xpPerHour = Object.values(xp).reduce((sum, value) => sum + (Number(value) || 0), 0) / simHours;
    const deathsPerHour = (simResult.deaths?.[playerHrid] || 0) / simHours;
    const priced = priceRow(simResult, gameData, simHours, priceCache);
    return { failed: false, hours, xpPerHour, deathsPerHour, ...priced, simResult };
}

/**
 * Your profit for one result.
 * @param {Object} simResult
 * @param {Object} gameData
 * @param {number} simHours
 * @param {Map} [priceCache]
 * @returns {{profitPerHour: number|null, uncappedProfit: number|null, liquidityLimit: Object|null,
 *   unpriced: Array<string>}}
 */
function priceRow(simResult, gameData, simHours, priceCache) {
    let revenue = null;
    try {
        revenue = calculateSimRevenue(simResult, gameData, 'player1', simHours, priceCache ? { priceCache } : {});
    } catch (error) {
        console.error('[PartyFinder] Pricing a result failed:', error);
    }
    if (!revenue || !Number.isFinite(revenue.netPerHour)) {
        return { profitPerHour: null, uncappedProfit: null, liquidityLimit: null, unpriced: [] };
    }
    const unpriced = [
        ...(revenue.unpricedDrops || []),
        ...(revenue.unpricedConsumables || []),
        ...(revenue.unpricedKeys || []),
    ];
    let profitPerHour = revenue.netPerHour;
    let uncappedProfit = null;
    let liquidityLimit = null;
    try {
        const sells = (revenue.dropEntries || [])
            .filter((entry) => entry?.itemHrid && Number(entry.countPerHour) > 0)
            .map((entry) => ({ itemHrid: entry.itemHrid, name: entry.name || null, unitsPerHour: entry.countPerHour }));
        const capped = capProfitRateCached({ goldPerHour: profitPerHour, sells });
        if (capped?.capped) {
            uncappedProfit = profitPerHour;
            profitPerHour = capped.goldPerHour;
            liquidityLimit = capped.limit;
        }
    } catch (error) {
        console.error('[PartyFinder] Bounding a row by market volume failed:', error);
    }
    return { profitPerHour, uncappedProfit, liquidityLimit, unpriced };
}

/**
 * Price an already-read result again (a pricing setting changed), keeping its sim.
 * @param {Object} metrics - From {@link readResult}
 * @param {Object} gameData
 * @param {Map} [priceCache]
 * @returns {Object} New metrics
 */
export function repriceMetrics(metrics, gameData, priceCache) {
    if (!metrics || metrics.failed || !metrics.simResult) return metrics;
    const simHours = (metrics.simResult.simulatedTime || 0) / ONE_HOUR_NS || metrics.hours;
    return { ...metrics, ...priceRow(metrics.simResult, gameData, simHours, priceCache) };
}

/**
 * The figures a row shows: the full-hours re-run when there is one, else the quick pass.
 * @param {Object} row
 * @returns {Object|null}
 */
export function shownMetrics(row) {
    if (row?.full && !row.full.failed) return row.full;
    if (row?.quick && !row.quick.failed) return row.quick;
    return null;
}

/**
 * A row's standing against your solo baseline in the same zone/tier, like against like: the full re-runs when
 * both have one, the quick passes otherwise.
 * @param {Object} row
 * @param {Object|null} baseline - The solo row of the same zone/tier
 * @returns {{xpPct: number|null, profitDelta: number|null, stage: 'full'|'quick'|null}}
 */
export function soloDelta(row, baseline) {
    const none = { xpPct: null, profitDelta: null, stage: null };
    if (!row || !baseline) return none;
    let mine = null;
    let theirs = null;
    let stage = null;
    if (row.full && !row.full.failed && baseline.full && !baseline.full.failed) {
        [mine, theirs, stage] = [row.full, baseline.full, 'full'];
    } else if (row.quick && !row.quick.failed && baseline.quick && !baseline.quick.failed) {
        [mine, theirs, stage] = [row.quick, baseline.quick, 'quick'];
    }
    if (!mine) return none;
    const xpPct = theirs.xpPerHour > 0 ? ((mine.xpPerHour - theirs.xpPerHour) / theirs.xpPerHour) * 100 : null;
    const profitDelta =
        mine.profitPerHour != null && theirs.profitPerHour != null ? mine.profitPerHour - theirs.profitPerHour : null;
    return { xpPct, profitDelta, stage };
}

/**
 * The value a row ranks by.
 * @param {Object} row
 * @param {Object|null} baseline
 * @param {string} metric - A {@link RANK_METRICS} key, or 'deaths'
 * @returns {number|null} null when the row has no such figure (failed, unpriced, no baseline)
 */
export function metricValue(row, baseline, metric) {
    const shown = shownMetrics(row);
    if (!shown) return null;
    switch (metric) {
        case 'xp':
            return shown.xpPerHour;
        case 'profit':
            return shown.profitPerHour;
        case 'deaths':
            return shown.deathsPerHour;
        case 'xpVsSolo':
            return soloDelta(row, baseline).xpPct;
        case 'profitVsSolo':
            return soloDelta(row, baseline).profitDelta;
        default:
            return null;
    }
}

/**
 * Rows ranked by a metric; a row without the figure sinks to the bottom whichever way the sort runs.
 * @param {Array<Object>} rows
 * @param {Map<string, Object>} baselines - zoneKey → solo row
 * @param {string} metric
 * @param {boolean} [ascending=false]
 * @returns {Array<Object>} A new array
 */
export function sortRows(rows, baselines, metric, ascending = false) {
    const keyed = rows.map((row, index) => ({
        row,
        index,
        value: metricValue(row, baselines.get(row.zoneKey) || null, metric),
    }));
    keyed.sort((a, b) => {
        const aMissing = a.value == null || !Number.isFinite(a.value);
        const bMissing = b.value == null || !Number.isFinite(b.value);
        if (aMissing !== bMissing) return aMissing ? 1 : -1;
        if (!aMissing && a.value !== b.value) return ascending ? a.value - b.value : b.value - a.value;
        return a.index - b.index;
    });
    return keyed.map((entry) => entry.row);
}

/**
 * The parties worth a full-hours re-run: the best K by the metric, never a baseline, never a failed row, plus the
 * solo baselines of their zone/tiers (first, so a stop still leaves the comparison).
 * @param {Array<Object>} rows
 * @param {Map<string, Object>} baselines
 * @param {string} metric
 * @param {number} k
 * @returns {Array<Object>} Rows to re-run, baselines first
 */
export function pickRerunRows(rows, baselines, metric, k) {
    const count = Math.max(0, Math.floor(Number(k) || 0));
    if (!count) return [];
    const candidates = rows.filter((row) => !row.isBaseline && shownMetrics(row));
    const ranked = sortRows(candidates, baselines, metric).filter(
        (row) => metricValue(row, baselines.get(row.zoneKey) || null, metric) != null
    );
    const top = ranked.slice(0, count);
    const baselineRows = [];
    const seen = new Set();
    for (const row of top) {
        const baseline = baselines.get(row.zoneKey);
        if (baseline && shownMetrics(baseline) && !seen.has(row.zoneKey)) {
            seen.add(row.zoneKey);
            baselineRows.push(baseline);
        }
    }
    return [...baselineRows, ...top];
}

/**
 * The names a party shows: you alone, or the teammates beside you.
 * @param {Object} comp
 * @returns {string}
 */
export function partyLabel(comp) {
    if (!comp || comp.isBaseline || !comp.members?.length) return 'Solo';
    return comp.members.map((m) => m.name).join(' + ');
}

/**
 * "stopped early — 12 of 40 sims"
 * @param {number} done
 * @param {number} total
 * @returns {string}
 */
export function stoppedSweepText(done, total) {
    return `stopped early — ${done} of ${total} sim${total === 1 ? '' : 's'}`;
}

/** CSV columns for the results table */
export const CSV_COLUMNS = Object.freeze([
    { key: 'zone', label: 'Zone' },
    { key: 'tier', label: 'Tier' },
    { key: 'party', label: 'Party' },
    { key: 'size', label: 'Players' },
    { key: 'hours', label: 'Sim hours' },
    { key: 'xpPerHour', label: 'Your EXP/hr' },
    { key: 'profitPerHour', label: 'Your profit/hr' },
    { key: 'deathsPerHour', label: 'Your deaths/hr' },
    { key: 'xpVsSoloPct', label: 'EXP vs solo %' },
    { key: 'profitVsSolo', label: 'Profit vs solo' },
    { key: 'comparedAt', label: 'Compared at' },
    { key: 'unpriced', label: 'Unpriced items' },
    { key: 'note', label: 'Note' },
]);

/**
 * One results row as CSV fields.
 * @param {Object} row
 * @param {Object|null} baseline
 * @returns {Object}
 */
export function csvRow(row, baseline) {
    const shown = shownMetrics(row);
    const delta = soloDelta(row, baseline);
    const round = (value, places) => (value == null || !Number.isFinite(value) ? '' : Number(value.toFixed(places)));
    return {
        zone: row.zone?.name || row.zone?.zoneHrid || '',
        tier: Number(row.zone?.difficultyTier) || 0,
        party: partyLabel(row.comp),
        size: (row.comp?.members?.length || 0) + 1,
        hours: shown ? shown.hours : '',
        xpPerHour: shown ? round(shown.xpPerHour, 0) : '',
        profitPerHour: shown ? round(shown.profitPerHour, 0) : '',
        deathsPerHour: shown ? round(shown.deathsPerHour, 3) : '',
        xpVsSoloPct: round(delta.xpPct, 1),
        profitVsSolo: round(delta.profitDelta, 0),
        comparedAt: delta.stage === 'full' ? 'full hours' : delta.stage === 'quick' ? 'quick pass' : '',
        unpriced: shown?.unpriced?.length ? shown.unpriced.join(' ') : '',
        note: !shown ? 'sim failed' : shown.profitPerHour == null ? 'profit could not be priced' : '',
    };
}
