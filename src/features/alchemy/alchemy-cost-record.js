/**
 * The pure half of the saved-cost record: coverage arithmetic, merging and
 * validation, with no market or game imports so the session store, the merge
 * and the import can use it freely. See `alchemy-session-cost.js` for what the
 * record is and why it exists.
 */

/** Distinct input bases kept per session; further ones fold into {@link MIXED_BASIS} */
const MAX_BASES = 6;

/** The bucket a session's basis labels overflow into */
export const MIXED_BASIS = 'mixed';

/**
 * @param {*} value
 * @returns {number} The value, or 0 when it is not a finite number
 */
export function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * @param {Object} bases - `{ basis: units }`, mutated
 * @param {string} basis - The label to add
 * @param {number} units - Units costed under it
 * @returns {void}
 */
export function addBasis(bases, basis, units) {
    const key = Object.hasOwn(bases, basis) || Object.keys(bases).length < MAX_BASES ? basis : MIXED_BASIS;
    bases[key] = num(bases[key]) + units;
}

/**
 * How a session's saved input cost relates to what it consumed.
 *
 * @param {Object} session
 * @param {number} netConsumed - Units the session consumed, as the reader counts them
 * @param {Function} priceToday - `() => {price, basis, unpriced}`, called only when something is uncovered
 * @returns {{cost: number, basis: string|null, unpriced: boolean, savedUnits: number, todayUnits: number,
 *   hasSaved: boolean, pricedToday: boolean, mode: string|null}} `cost` covers every priced unit; `basis` names what the
 *   cost was computed under, or null when nothing could be priced
 */
export function resolveInputCost(session, netConsumed, priceToday) {
    const saved = session?.costs?.input;
    const needed = Math.max(0, num(netConsumed));

    if (!saved) {
        // Nothing was saved: the whole of it is read at today's market
        const today = priceToday();
        return {
            cost: needed * today.price,
            basis: today.basis,
            unpriced: today.basis === null && needed > 0,
            savedUnits: 0,
            todayUnits: needed,
            hasSaved: false,
            pricedToday: needed > 0 && today.basis !== null,
            mode: null,
        };
    }

    // Only units that were priced when they ran are covered. A message that could not be priced then (the
    // first tick after a reload, before market data loads) saves nothing, so the reader prices it at today's
    // market and marks it, and only shows it unpriced if today has no price either
    const covered = Math.max(0, num(saved.units));

    // A saved record covering more than the session now says it consumed (a hand-corrected import) is
    // scaled down to it, so a lowered count lowers the cost with it
    const scale = covered > needed && covered > 0 ? needed / covered : 1;
    let cost = num(saved.cost) * scale;
    const savedUnits = covered * scale;

    const bases = Object.keys(saved.bases || {});
    let basis = bases.length === 1 ? bases[0] : bases.length > 1 ? MIXED_BASIS : null;

    const remainder = Math.max(0, needed - covered);
    let unpriced = false;
    let remainderUnpriced = false;
    if (remainder > 0) {
        const today = priceToday();
        if (today.basis === null) {
            unpriced = true;
            remainderUnpriced = true;
        } else {
            cost += remainder * today.price;
            basis = basis === null || basis === today.basis ? today.basis : MIXED_BASIS;
        }
    }

    return {
        cost,
        basis,
        unpriced,
        savedUnits,
        todayUnits: remainder,
        hasSaved: true,
        pricedToday: remainder > 0 && !remainderUnpriced,
        mode: typeof saved.mode === 'string' ? saved.mode : null,
    };
}

/**
 * How a session's saved cost for one catalyst relates to what it consumed.
 *
 * @param {Object} session
 * @param {string} catalystHrid
 * @param {number} count - How many the session consumed
 * @param {Function} priceToday - `(hrid) => number|null`, called only when something is uncovered
 * @returns {{cost: number, unpriced: boolean, pricedToday: boolean}} `cost` covers every priced unit
 */
export function resolveCatalystCost(session, catalystHrid, count, priceToday) {
    const saved = session?.costs?.catalysts?.[catalystHrid];
    const needed = Math.max(0, num(count));
    if (!saved) {
        const price = priceToday(catalystHrid);
        return price === null
            ? { cost: 0, unpriced: needed > 0, pricedToday: false }
            : { cost: needed * price, unpriced: false, pricedToday: needed > 0 };
    }

    const covered = Math.max(0, num(saved.count));
    const scale = covered > needed && covered > 0 ? needed / covered : 1;

    let cost = num(saved.cost) * scale;
    let unpriced = false;
    let pricedToday = false;
    const remainder = Math.max(0, needed - covered);
    if (remainder > 0) {
        const price = priceToday(catalystHrid);
        if (price === null) {
            unpriced = true;
        } else {
            cost += remainder * price;
            pricedToday = true;
        }
    }
    return { cost, unpriced, pricedToday };
}

/**
 * Combine two sessions' saved costs into the record of the session they make together.
 * Sums everything, so coverage adds exactly as the counts it describes do.
 *
 * @param {Object|undefined} a
 * @param {Object|undefined} b
 * @returns {Object|undefined} The combined record, or undefined when neither had one
 */
export function mergeCosts(a, b) {
    if (!a && !b) return undefined;
    const out = {};

    if (a?.input || b?.input) {
        const bases = {};
        for (const source of [a?.input, b?.input]) {
            for (const [basis, units] of Object.entries(source?.bases || {})) addBasis(bases, basis, num(units));
        }
        out.input = {
            cost: num(a?.input?.cost) + num(b?.input?.cost),
            units: num(a?.input?.units) + num(b?.input?.units),
            bases,
        };
        const modes = [a?.input?.mode, b?.input?.mode].filter(Boolean);
        if (modes.length > 0) out.input.mode = modes.every((m) => m === modes[0]) ? modes[0] : MIXED_BASIS;
    }

    if (a?.catalysts || b?.catalysts) {
        out.catalysts = {};
        for (const source of [a?.catalysts, b?.catalysts]) {
            for (const [hrid, entry] of Object.entries(source || {})) {
                const current = (out.catalysts[hrid] ||= { cost: 0, count: 0 });
                current.cost += num(entry?.cost);
                current.count += num(entry?.count);
            }
        }
    }

    return out;
}

/**
 * @param {Object|undefined} costs
 * @returns {number} Input units the record covers
 */
function inputCoverage(costs) {
    return num(costs?.input?.units);
}

/**
 * @param {Object|undefined} costs
 * @returns {number} Catalyst units the record covers
 */
function catalystCoverage(costs) {
    let total = 0;
    for (const entry of Object.values(costs?.catalysts || {})) total += num(entry?.count);
    return total;
}

/**
 * The saved costs to keep when two copies of one session meet (a sync).
 *
 * The copies are an older and a newer version of the same run, so the one
 * covering more is the one that has seen more of it. The copy kept whole may be
 * the one that lacks them (recorded on a build that does not save costs), and
 * dropping the other's would turn a recorded cost back into today's price.
 *
 * Input coverage decides first, so catalysts cannot outvote it; catalyst
 * coverage breaks a tie; a full tie is broken by the records' own text, so the
 * answer does not depend on which copy is passed first.
 *
 * @param {Object|undefined} a
 * @param {Object|undefined} b
 * @returns {Object|undefined} The record covering more, or undefined when neither has one
 */
export function pickCosts(a, b) {
    if (!a) return b;
    if (!b) return a;
    for (const measure of [inputCoverage, catalystCoverage]) {
        const diff = measure(a) - measure(b);
        if (diff !== 0) return diff > 0 ? a : b;
    }
    return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

/**
 * The bulk size a session's units are counted with: its own recorded one, else the item's, else 1.
 * The trackers (units saved per message) and the viewers (units consumed) share this so the two cannot
 * count a different number of items.
 * @param {Object} session
 * @param {Object|null|undefined} itemDetails - The input item's game data
 * @returns {number}
 */
export function resolveBulk(session, itemDetails) {
    return session?.bulkMultiplier ?? itemDetails?.alchemyDetail?.bulkMultiplier ?? 1;
}

/**
 * The per-catalyst counters coinify and decompose sessions keep beside `catalystsUsed`, and read from.
 * Repeats the trackers' `LEGACY_CATALYST_FIELDS` (this module is the pure half and imports no tracker).
 */
const LEGACY_CATALYST_FIELD = {
    '/items/catalyst_of_coinification': 'catalystOfCoinificationUsed',
    '/items/catalyst_of_decomposition': 'catalystOfDecompositionUsed',
    '/items/prime_catalyst': 'primeCatalystUsed',
};

/**
 * Scale a session's saved costs down to what its counts now say it consumed.
 *
 * Done when a hand-corrected count is imported, so the record is right from then on and the ticks recorded
 * afterwards are added to a record that already describes the edited part, instead of being diluted by a
 * read-time scale over the whole.
 *
 * @param {Object} session - A session with `costs`, `totalAttempts`, `bulkMultiplier`, `results`, `catalystsUsed`
 * @returns {Object|undefined} The costs to keep (equal to the input when nothing needs scaling)
 */
export function rescaleCosts(session) {
    const costs = session?.costs;
    if (!costs) return costs;
    const out = { ...costs };

    if (costs.input && Number(session.bulkMultiplier) > 0) {
        let selfReturned = 0;
        for (const result of Object.values(session.results || {})) {
            if (result?.isSelfReturn) selfReturned += num(result.count);
        }
        const needed = Math.max(0, num(session.totalAttempts) * session.bulkMultiplier - selfReturned);
        const covered = num(costs.input.units);
        if (covered > needed && covered > 0) {
            const f = needed / covered;
            out.input = { ...costs.input, cost: num(costs.input.cost) * f, units: covered * f };
            out.input.bases = Object.fromEntries(
                Object.entries(costs.input.bases || {}).map(([basis, units]) => [basis, num(units) * f])
            );
        }
    }

    if (costs.catalysts && session.catalystsUsed && typeof session.catalystsUsed === 'object') {
        out.catalysts = { ...costs.catalysts };
        for (const [hrid, entry] of Object.entries(costs.catalysts)) {
            // A map that is there and does not name a catalyst says none was consumed. Keeping its coverage
            // would add the ticks of a resumed run to a saved cost for catalysts the session no longer has. The
            // coinify and decompose readers count from their legacy fields, so one of those still answers.
            const listed = Object.hasOwn(session.catalystsUsed, hrid);
            const needed = Math.max(
                0,
                num(listed ? session.catalystsUsed[hrid] : session[LEGACY_CATALYST_FIELD[hrid]])
            );
            if (!listed && needed === 0) {
                delete out.catalysts[hrid];
                continue;
            }
            const covered = num(entry?.count);
            if (covered > needed && covered > 0) {
                const f = needed / covered;
                out.catalysts[hrid] = { cost: num(entry.cost) * f, count: covered * f };
            }
        }
    }
    return out;
}

/**
 * Check a `costs` record from a file, in the lenient style of the rest of the import.
 * @param {*} costs
 * @returns {string|null} What is wrong with it, or null
 */
export function validateCosts(costs) {
    const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
    const bad = (v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0;
    if (!isObject(costs)) return 'has a non-object costs';
    if (costs.input !== undefined) {
        const input = costs.input;
        if (!isObject(input)) return 'has a non-object costs.input';
        for (const field of ['cost', 'units']) {
            if (bad(input[field])) return `has a bad costs.input.${field}`;
        }
        if (input.mode !== undefined && typeof input.mode !== 'string') return 'has a non-text costs.input.mode';
        if (input.bases !== undefined) {
            if (!isObject(input.bases)) return 'has a non-object costs.input.bases';
            for (const [basis, units] of Object.entries(input.bases)) {
                if (bad(units)) return `has a bad costs.input.bases count for "${basis}"`;
            }
        }
    }
    if (costs.catalysts !== undefined) {
        if (!isObject(costs.catalysts)) return 'has a non-object costs.catalysts';
        for (const [hrid, entry] of Object.entries(costs.catalysts)) {
            if (!isObject(entry)) return `has a non-object costs.catalysts entry for "${hrid}"`;
            for (const field of ['cost', 'count']) {
                if (bad(entry[field])) return `has a bad costs.catalysts.${field} for "${hrid}"`;
            }
        }
    }
    return null;
}

/** Marks a figure that was priced at today's market because no price was saved with it */
export const TODAYS_PRICE_MARK = '≈';

/**
 * The hover line for a group or total holding sessions priced at today's market.
 * @param {number} sessions - How many of its sessions were
 * @returns {string|undefined} The sentence, or undefined when none were
 */
export function todaysPriceNote(sessions) {
    if (!(sessions > 0)) return undefined;
    return (
        `${sessions} session(s) were priced at today's market, not at the price when they ran — no price was ` +
        'saved for (all of) their input. This total moves with the market.'
    );
}

/**
 * @param {...(string|undefined)} parts
 * @returns {string|undefined} The parts joined, or undefined when there are none
 */
export function joinTitles(...parts) {
    return parts.filter(Boolean).join(' ') || undefined;
}

export default {
    resolveBulk,
    rescaleCosts,
    TODAYS_PRICE_MARK,
    todaysPriceNote,
    joinTitles,
    resolveInputCost,
    resolveCatalystCost,
    mergeCosts,
    pickCosts,
    validateCosts,
    addBasis,
    MIXED_BASIS,
};
