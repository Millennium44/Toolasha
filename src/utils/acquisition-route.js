/**
 * Pure acquisition accounting shared by Equipment Watch and advisor comparisons.
 * Callers own recipe/enhancement/Mirror generation. This module never reads a
 * character, inventory, settings, or a panel, and never reserves live inventory.
 */

/**
 * Price a route against an explicit set of physical copies. Sale values are
 * after tax. `consumed` contains { id, share } (an expected share for Blessed Tea).
 * Unknown owned sales stay unknown; a consumed trade-in cancels its own sale.
 * @param {Object} route - id, gross cash outlay, consumed copies and optional bill
 * @param {Object} context - copies ({id, sale}), sellIds and optional keep flag
 * @returns {Object} Route with cash, real, forgone, credit and priced fields
 */
export function priceAcquisitionRoute(route, { copies = [], sellIds = [], keep = false } = {}) {
    const stock = new Map(copies.map((copy) => [copy.id, copy]));
    const sold = new Set(keep ? [] : sellIds);
    const consumed = new Map();
    let valid = stock.size === copies.length;
    for (const use of route.consumed || []) {
        const share = use.share ?? 1;
        const total = (consumed.get(use.id) || 0) + share;
        if (!stock.has(use.id) || !Number.isFinite(share) || share < 0 || total > 1 + 1e-9) valid = false;
        consumed.set(use.id, total);
    }
    if ([...sold].some((id) => !stock.has(id))) valid = false;
    let credit = 0;
    let forgone = 0;
    let realKnown = true;
    const warnings = [];
    for (const [id, copy] of stock) {
        const share = consumed.get(id) || 0;
        const saleKnown = Number.isFinite(copy.sale) && copy.sale >= 0;
        // Only a known quote can fund a purchase. An absent sale remains a warning,
        // never an invented zero-price sale or a credit from another character.
        if (sold.has(id)) {
            if (saleKnown) credit += (1 - share) * copy.sale;
            else if (share < 1) warnings.push('A replaced copy has no sale quote; no credit was applied.');
        } else if (share > 0) {
            if (saleKnown) forgone += share * copy.sale;
            else realKnown = false;
        }
    }
    const gross = Number.isFinite(route.gross) && route.gross >= 0 ? route.gross : null;
    const cash = valid && gross !== null ? Math.max(0, gross - credit) : null;
    const real = valid && gross !== null && realKnown ? gross + forgone - credit : null;
    return {
        ...route,
        cash,
        real,
        credit,
        forgone: realKnown ? forgone : null,
        priced: cash !== null && real !== null,
        warnings,
    };
}

/**
 * Select a route without throwing away its cash, real cost, copy IDs or bill.
 * A pin may show a known cash bill with unknown real cost or blocked eligibility.
 * Auto/Prefer cannot. Equal real costs retain caller order (Buy before Craft).
 * @param {Array<Object>} routes - Priced route records
 * @param {Object} options - pin, preference, eligible route IDs and allowMirror
 * @returns {{chosen: Object|null, pin: string|null, pinUnavailable: boolean}}
 */
export function selectAcquisitionRoute(
    routes,
    { pin = null, preference = 'auto', eligible = ['buy', 'craft', 'mirror'], allowMirror = true } = {}
) {
    const allowed = (route) => allowMirror || route.id !== 'mirror';
    const usable = (route) =>
        allowed(route) &&
        Number.isFinite(route.cash) &&
        Number.isFinite(route.real) &&
        route.eligibility?.status !== 'blocked';
    const standing = pin && routes.find((route) => route.id === pin && allowed(route) && Number.isFinite(route.cash));
    let chosen = standing || null;
    if (!chosen && !pin && preference !== 'auto') {
        chosen =
            routes.find((route) => route.id === preference && eligible.includes(route.id) && usable(route)) || null;
    }
    if (!chosen) {
        for (const id of eligible) {
            for (const route of routes) {
                if (route.id === id && usable(route) && (!chosen || route.real < chosen.real)) chosen = route;
            }
        }
    }
    return { chosen, pin, pinUnavailable: Boolean(pin && !standing) };
}

/**
 * Choose one recipe's base alternative before competing against Buy and Mirror.
 * Keep a blocked hypothetical bill only when there is no executable alternative.
 * @param {Array<Object>} options - Alternatives with cash, real and eligibility
 * @param {boolean} requireAvailable - Alternatives require proven startability
 * @returns {Object|null} The original option, including its shopping level/bill
 */
export function chooseCraftAcquisition(options, requireAvailable = false) {
    const startable = options.filter((option) =>
        requireAvailable ? option.eligibility?.status === 'available' : option.eligibility?.status !== 'blocked'
    );
    const candidates = startable.length ? startable : requireAvailable ? [] : options;
    if (!candidates.length) return null;
    const priced = candidates.filter((option) => Number.isFinite(option.real));
    const cashKnown = candidates.filter((option) => Number.isFinite(option.cash));
    return priced.length
        ? priced.reduce((best, option) => (option.real < best.real ? option : best))
        : cashKnown.length
          ? cashKnown.reduce((best, option) => (option.cash < best.cash ? option : best))
          : candidates[0];
}

/**
 * Watch's book-side quote, shared with comparisons. Estimates are not ticked.
 * @param {Object|null} prices - Existing market snapshot
 * @param {Object} context - itemHrid, level, transaction and side
 * @param {Function} tick - Existing patient-tick service
 * @returns {number} Positive quote or 0 for no quote
 */
export function acquisitionBookPrice(prices, { itemHrid, level = 0, transaction, side }, tick) {
    const value = Number(prices?.[side]) || 0;
    if (!(value > 0) || prices.source || prices[`${side}Estimated`]) return value;
    return (
        tick(value, transaction, side, {
            ask: prices.ask,
            bid: prices.bid,
            askEstimated: prices.askEstimated,
            bidEstimated: prices.bidEstimated,
            itemHrid,
            enhancementLevel: level,
        }) || value
    );
}
