/**
 * Labyrinth Supplies
 *
 * What you are actually carrying, so the planners stop answering as though the
 * shop were free. A labyrinth run spends three consumables — a torch per room
 * entered, a shroud to skip a room you cannot beat, a beacon to reveal a patch
 * of the floor — and each comes in three tiers.
 *
 * Everything here is pure: counts are read out of an inventory array that is
 * passed in, never off a singleton, so the clamping and shortfall logic can be
 * tested against fixture inventories without a game attached.
 */

/**
 * The supply items, best tier last.
 *
 * Hrids follow the game's own convention (lowercased name, underscores), the
 * same shape as `/items/expert_tea_crate` elsewhere in this codebase. They are
 * only a fallback: `resolveSupplyHrids` prefers whatever the live item map
 * calls these things, so a rename or a fourth tier does not silently zero
 * every count.
 */
export const SUPPLY_HRIDS = {
    torch: ['/items/basic_torch', '/items/advanced_torch', '/items/expert_torch'],
    shroud: ['/items/basic_shroud', '/items/advanced_shroud', '/items/expert_shroud'],
    beacon: ['/items/basic_beacon', '/items/advanced_beacon', '/items/expert_beacon'],
};

/** Tier order, worst first — the index a tier sorts at */
export const SUPPLY_TIERS = ['basic', 'advanced', 'expert'];

/** Only what is in the bag counts; equipped and listed items are not supplies */
const INVENTORY_LOCATION = '/item_locations/inventory';

/**
 * Which items the game currently calls torches, shrouds and beacons.
 *
 * Read off the item map by hrid shape rather than by display name: a name is
 * localised and a category is shared with half the game, but the hrid of a
 * tiered supply is `/items/<tier>_<kind>` and has been since the labyrinth
 * shipped. Anything the map does not have falls back to the canonical list, so
 * a caller with no game data still gets a usable set of keys rather than none.
 *
 * @param {Object|null} itemDetailMap - initClientData.itemDetailMap
 * @returns {{torch: string[], shroud: string[], beacon: string[]}} Hrids per
 *   kind, worst tier first
 */
export function resolveSupplyHrids(itemDetailMap) {
    const resolved = { torch: [], shroud: [], beacon: [] };
    const known = itemDetailMap && typeof itemDetailMap === 'object' ? Object.keys(itemDetailMap) : [];

    for (const hrid of known) {
        const match = /^\/items\/([a-z]+)_(torch|shroud|beacon)$/.exec(hrid);
        if (!match) continue;
        const [, tier, kind] = match;
        resolved[kind].push({ hrid, order: SUPPLY_TIERS.indexOf(tier) });
    }

    const out = {};
    for (const kind of Object.keys(resolved)) {
        if (!resolved[kind].length) {
            out[kind] = [...SUPPLY_HRIDS[kind]];
            continue;
        }
        // An unrecognised tier sorts last rather than to the front, where it
        // would claim to be the weakest thing you own
        out[kind] = resolved[kind]
            .sort((a, b) => (a.order < 0 ? 99 : a.order) - (b.order < 0 ? 99 : b.order))
            .map((entry) => entry.hrid);
    }
    return out;
}

/**
 * Count the supplies an inventory holds.
 *
 * Tiers are summed rather than reported separately for the totals, because the
 * planners spend "a shroud" without caring which one — but the per-tier
 * breakdown comes back too, since the tiers are not interchangeable in what
 * they can do (a basic shroud is capped at level 50, a basic beacon reveals a
 * third of what an expert one does).
 *
 * @param {Array<Object>|null} inventory - dataManager.getInventory() shape
 * @param {Object} [hrids] - As returned by resolveSupplyHrids
 * @returns {{torch: number, shroud: number, beacon: number, byTier: Object, known: boolean}}
 *   `known` is false when there is no inventory to read, which is not the same
 *   as owning nothing
 */
export function readSupplyCounts(inventory, hrids = SUPPLY_HRIDS) {
    const counts = { torch: 0, shroud: 0, beacon: 0, byTier: { torch: {}, shroud: {}, beacon: {} }, known: false };
    if (!Array.isArray(inventory)) return counts;
    counts.known = true;

    const kindOf = new Map();
    for (const kind of Object.keys(counts.byTier)) {
        for (const hrid of hrids[kind] || []) {
            kindOf.set(hrid, kind);
            counts.byTier[kind][hrid] = 0;
        }
    }

    for (const item of inventory) {
        if (!item || item.itemLocationHrid !== INVENTORY_LOCATION) continue;
        const kind = kindOf.get(item.itemHrid);
        if (!kind) continue;
        const n = Math.max(0, Math.floor(Number(item.count) || 0));
        counts[kind] += n;
        counts.byTier[kind][item.itemHrid] += n;
    }
    return counts;
}

/**
 * The best tier of a kind actually held, or null when none is.
 * @param {Object} counts - As returned by readSupplyCounts
 * @param {string} kind - 'torch' | 'shroud' | 'beacon'
 * @param {Object} [hrids] - As returned by resolveSupplyHrids
 * @returns {string|null} Item hrid
 */
export function bestOwnedTier(counts, kind, hrids = SUPPLY_HRIDS) {
    const order = hrids[kind] || [];
    for (let i = order.length - 1; i >= 0; i--) {
        if (counts?.byTier?.[kind]?.[order[i]] > 0) return order[i];
    }
    return null;
}

/**
 * Clamp a requested count to what is held.
 *
 * Returns the shortfall rather than swallowing it: a plan quietly made smaller
 * is a plan that stopped answering the question that was asked, so the caller
 * always has enough to say "4 set / 3 owned" instead of drawing three beacons
 * and leaving the user to notice.
 *
 * @param {number} requested - What the input asks for
 * @param {number} owned - What is held
 * @param {boolean} [known=true] - False when the inventory could not be read,
 *   in which case the request passes through untouched
 * @returns {{effective: number, requested: number, owned: number, short: number, clamped: boolean}}
 */
export function clampToOwned(requested, owned, known = true) {
    const want = Math.max(0, Math.floor(Number(requested) || 0));
    const have = Math.max(0, Math.floor(Number(owned) || 0));
    if (!known) return { effective: want, requested: want, owned: have, short: 0, clamped: false };
    const effective = Math.min(want, have);
    return { effective, requested: want, owned: have, short: Math.max(0, want - effective), clamped: effective < want };
}

/**
 * How a needed-versus-owned pair should read in a status line.
 *
 * The plain case says nothing at all — a plan you can afford should not be
 * cluttered with a reassurance — and only a shortfall gets words.
 *
 * @param {number} needed - What the plan calls for
 * @param {number} owned - What is held
 * @param {string} noun - Singular noun, e.g. 'shroud'
 * @param {boolean} [known=true] - False when the inventory could not be read
 * @returns {{text: string, short: number, over: boolean}}
 */
export function describeSupplyNeed(needed, owned, noun, known = true) {
    const need = Math.max(0, Math.floor(Number(needed) || 0));
    const have = Math.max(0, Math.floor(Number(owned) || 0));
    const plural = (n) => `${n} ${noun}${n === 1 ? '' : 's'}`;
    if (!known) return { text: plural(need), short: 0, over: false };
    if (need <= have) return { text: plural(need), short: 0, over: false };
    return { text: `${plural(need)} needed · ${have} owned`, short: need - have, over: true };
}

/**
 * What the missing supplies would cost at market, as information only.
 *
 * Deliberately quotes the ask price of the cheapest tier that can do the job:
 * this is a "you are this far off" note, not a purchase plan, and pricing the
 * expert tier would overstate the gap for someone who only needs to skip a
 * couple of low-level rooms.
 *
 * @param {number} short - How many are missing
 * @param {string[]} hrids - Candidate item hrids, worst tier first
 * @param {Object} market - marketAPI-shaped { isLoaded(), getPrice(hrid) }
 * @returns {{total: number, unit: number, itemHrid: string}|null} null when
 *   nothing is missing or no price is known
 */
export function estimateRestockCost(short, hrids, market) {
    if (!(short > 0) || !Array.isArray(hrids) || !market?.isLoaded?.()) return null;
    for (const hrid of hrids) {
        const price = market.getPrice?.(hrid);
        const ask = Number(price?.ask);
        if (Number.isFinite(ask) && ask > 0) return { total: ask * short, unit: ask, itemHrid: hrid };
    }
    return null;
}
