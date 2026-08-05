/**
 * Labyrinth Supplies
 *
 * What you are actually carrying, so the planners stop answering as though the
 * shop were free. A labyrinth run spends three consumables — a torch per room
 * entered, a shroud to skip a room you cannot beat, a beacon to reveal a patch
 * of the floor — and each comes in three tiers.
 *
 * There are two places a supply count can live, and which one is right depends
 * on whether a run is going:
 *
 *  - **Out of a run**, the inventory is the answer. It is what the next entry
 *    will be able to take in, which is the question a plan drawn between runs is
 *    asking.
 *  - **In a run**, the inventory is the wrong number and confidently so. The
 *    game moves supplies out of the bag and into the run the moment you press
 *    start, and what the bag still holds is the remainder it did not take. A
 *    toolbar reading 260 torches beside a game that says 40 is not a counting
 *    bug — it is a reading of the wrong pile. The run's own stock is what the
 *    Supplies row at the bottom of the labyrinth screen shows, and it is the
 *    only number a mid-run plan may be measured against.
 *
 * So the run's stock is looked for first, in the labyrinth payload and then on
 * the Supplies row itself, and the inventory is the out-of-run answer and the
 * last resort. Every reading carries the `source` it came from so the readout
 * can say which pile it is showing rather than leaving the user to work out why
 * two numbers on one screen disagree.
 *
 * Everything here is pure: counts are read out of an inventory array, a payload
 * object or a DOM subtree that is passed in, never off a singleton, so the
 * clamping and shortfall logic can be tested without a game attached.
 */

import { parseItemCount } from '../../utils/number-parser.js';

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

/** The three kinds, in the order a readout lists them */
export const SUPPLY_KINDS = ['torch', 'shroud', 'beacon'];

/**
 * Which pile a reading came from.
 *
 * `run` is the stock the current run is carrying — the Supplies row's numbers.
 * `inventory` is the bag, which is what the next entry can take in.
 */
export const SUPPLY_SOURCE = { run: 'run', inventory: 'inventory' };

/** Only what is in the bag counts; equipped and listed items are not supplies */
const INVENTORY_LOCATION = '/item_locations/inventory';

/**
 * A zero reading, ready to be filled in.
 * @param {string} source - A value of `SUPPLY_SOURCE`
 * @param {Object} [hrids] - Tiers to seed at zero, so a caller can tell "none of
 *   this tier" from "this tier is not a thing"
 * @returns {Object} readSupplyCounts shape
 */
function emptyCounts(source, hrids) {
    const counts = {
        torch: 0,
        shroud: 0,
        beacon: 0,
        byTier: { torch: {}, shroud: {}, beacon: {} },
        known: false,
        source,
    };
    for (const kind of SUPPLY_KINDS) {
        for (const hrid of hrids?.[kind] || []) counts.byTier[kind][hrid] = 0;
    }
    return counts;
}

/**
 * hrid -> kind, for looking an item up without caring which tier it is.
 * @param {Object} hrids - As returned by resolveSupplyHrids
 * @returns {Map<string, string>}
 */
function kindByHrid(hrids) {
    const kindOf = new Map();
    for (const kind of SUPPLY_KINDS) {
        for (const hrid of hrids?.[kind] || []) kindOf.set(hrid, kind);
    }
    return kindOf;
}

/**
 * Fold per-hrid tallies into a counts object.
 *
 * Takes the largest figure seen for an hrid rather than the sum, because a
 * payload may carry the same stock twice — once as a list and once as a map —
 * and a run holding forty torches must not read as eighty because the server
 * said so in two places. Different tiers of one kind still add up; they are
 * different items.
 *
 * @param {Object} counts - Reading to fill in, mutated
 * @param {Map<string, number>} tally - hrid -> count
 * @param {Map<string, string>} kindOf - As returned by kindByHrid
 */
function applyTally(counts, tally, kindOf) {
    for (const [hrid, value] of tally) {
        const kind = kindOf.get(hrid);
        if (!kind) continue;
        const n = Math.max(0, Math.floor(Number(value) || 0));
        counts.byTier[kind][hrid] = n;
        counts[kind] += n;
    }
}

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
    const counts = emptyCounts(SUPPLY_SOURCE.inventory, hrids);
    if (!Array.isArray(inventory)) return counts;
    counts.known = true;

    const kindOf = kindByHrid(hrids);
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

/** Keys whose contents are the floor, not a supply — skipped, and they are large */
const NOT_SUPPLY_KEYS = new Set(['roomData', 'pathData', 'monsters', 'battleMonsters']);
/** How deep into a payload the search goes before giving up */
const MAX_SCAN_DEPTH = 6;
/** How many objects it will look at, so a malformed payload cannot hang a frame */
const MAX_SCAN_NODES = 4000;

/**
 * Whether a labyrinth run is currently going.
 *
 * A run is the thing that owns its own supplies, so this is what decides which
 * pile the planners are allowed to read.
 *
 * `isActive` is the server's own answer and wins outright when the payload
 * carries it — including when it says no. A run that has just ended leaves the
 * grid and the queued path in hand for a while afterwards, and reading those as
 * a live run sends the planners to the run's leftover stock at exactly the
 * moment the bag has become the right pile again.
 *
 * Without the flag the grid and the path stand in: both exist only while a run
 * does, which is the same test `labyrinthRunState` falls back to in the
 * notifications feature. Neither the flag nor either of them is not a run.
 *
 * @param {Object|null} labyrinth - A `labyrinth_updated` payload's `labyrinth`,
 *   or `characterData.characterLabyrinth`
 * @returns {boolean}
 */
export function isLabyrinthRunActive(labyrinth) {
    if (!labyrinth || typeof labyrinth !== 'object') return false;
    if (typeof labyrinth.isActive === 'boolean') return labyrinth.isActive;
    if (Array.isArray(labyrinth.roomData) && labyrinth.roomData.length > 0) return true;
    if (typeof labyrinth.roomData === 'string' && labyrinth.roomData.length > 2) return true;
    if (Array.isArray(labyrinth.pathData) && labyrinth.pathData.length > 0) return true;
    if (typeof labyrinth.pathData === 'string' && labyrinth.pathData.length > 2) return true;
    return false;
}

/**
 * The supplies the current run is carrying, read out of the labyrinth payload.
 *
 * Found by shape rather than by name. The field the server keeps the run's stock
 * under is not something this code can know — it is not documented and it has
 * changed once already — but whatever holds it has to name the items, and an
 * item is named the same way everywhere in this game: `/items/expert_torch`. So
 * the payload is walked for anything that pairs a supply hrid with a number,
 * whether that is a map keyed by hrid or a list of `{ itemHrid, count }`, and
 * nothing else is guessed at. A key called `torches` is not matched, because a
 * key called `torches` could as easily be the plan's cost as the run's stock,
 * and reading the wrong one is the bug this function exists to end.
 *
 * `known` stays false when the payload names no supply at all — which is the
 * signal to fall back to the Supplies row rather than to report a run that owns
 * nothing.
 *
 * @param {Object|null} labyrinth - A `labyrinth_updated` payload's `labyrinth`,
 *   or `characterData.characterLabyrinth`
 * @param {Object} [hrids] - As returned by resolveSupplyHrids
 * @returns {Object} readSupplyCounts shape, with `source: 'run'`
 */
export function readRunSupplyCounts(labyrinth, hrids = SUPPLY_HRIDS) {
    const counts = emptyCounts(SUPPLY_SOURCE.run, hrids);
    if (!labyrinth || typeof labyrinth !== 'object') return counts;

    const kindOf = kindByHrid(hrids);
    const tally = new Map();
    const record = (hrid, value) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return;
        tally.set(hrid, Math.max(tally.get(hrid) ?? 0, n));
    };

    let nodes = 0;
    const visit = (value, depth) => {
        if (!value || typeof value !== 'object' || depth > MAX_SCAN_DEPTH || nodes >= MAX_SCAN_NODES) return;
        nodes++;

        if (Array.isArray(value)) {
            for (const entry of value) visit(entry, depth + 1);
            return;
        }

        // { itemHrid: '/items/expert_torch', count: 40 }
        if (kindOf.has(value.itemHrid)) {
            record(value.itemHrid, value.count ?? value.quantity ?? value.amount);
        }

        for (const [key, entry] of Object.entries(value)) {
            // { '/items/expert_torch': 40 }
            if (kindOf.has(key)) {
                record(key, entry);
                continue;
            }
            if (NOT_SUPPLY_KEYS.has(key)) continue;
            visit(entry, depth + 1);
        }
    };
    visit(labyrinth, 0);

    if (!tally.size) return counts;
    counts.known = true;
    applyTally(counts, tally, kindOf);
    return counts;
}

/**
 * The part of the labyrinth screen the Supplies row lives in.
 *
 * Narrowed rather than searching the whole panel, because the panel also holds
 * the labyrinth shop, which sells the very same three items and puts a number
 * beside each of them. Counting the shop's stock as the run's would be a
 * plausible-looking, entirely wrong reading.
 *
 * @param {Document|HTMLElement} root - Where to look
 * @param {Map<string, string>} kindOf - As returned by kindByHrid
 * @returns {HTMLElement|Document|null}
 */
function supplyRowScope(root, kindOf) {
    const panel = root.querySelector?.('[class*="LabyrinthPanel"]') || root;

    for (const node of panel.querySelectorAll?.('div, span, h1, h2, h3') || []) {
        let ownText = '';
        for (const child of node.childNodes) {
            if (child.nodeType === 3) ownText += child.textContent;
        }
        if (!/^supplies\b/i.test(ownText.trim())) continue;

        // The heading itself holds no icons; its row does, and how far up that
        // is depends on how the game nests the label
        let current = node;
        for (let depth = 0; depth < 4 && current; depth++) {
            if (hasSupplyIcon(current, kindOf)) return current;
            current = current.parentElement;
        }
    }
    return panel;
}

/**
 * Whether an element contains at least one supply icon we are allowed to read.
 * @param {Element} element - Candidate container
 * @param {Map<string, string>} kindOf - As returned by kindByHrid
 * @returns {boolean}
 */
function hasSupplyIcon(element, kindOf) {
    for (const use of element.querySelectorAll?.('use') || []) {
        if (!readableSupplyIcon(use)) continue;
        const fragment = (use.getAttribute('href') || use.getAttribute('xlink:href') || '').split('#')[1];
        if (fragment && kindOf.has(`/items/${fragment}`)) return true;
    }
    return false;
}

/**
 * Whether an icon on the labyrinth screen is the run's stock rather than
 * something that merely draws the same item: the shop's buyable grid prices
 * torches, and this script's own toolbar now draws them too.
 * @param {Element} use - An SVG `<use>`
 * @returns {boolean}
 */
function readableSupplyIcon(use) {
    return !use.closest?.('[class*="buyableGrid"], [class*="mwi-labyrinth"], [class*="toolasha"]');
}

/**
 * The supplies the current run is carrying, read off the game's Supplies row.
 *
 * The fallback for when the payload does not carry the stock in any shape this
 * can recognise. Slower and more fragile than a message — it depends on the
 * game's markup — but it reads exactly the numbers the user is looking at, which
 * is the whole complaint this answers.
 *
 * @param {Document|HTMLElement|null} [root] - Where to look, `document` by default
 * @param {Object} [hrids] - As returned by resolveSupplyHrids
 * @returns {Object} readSupplyCounts shape, with `source: 'run'`
 */
export function readSupplyRowCounts(root = typeof document === 'undefined' ? null : document, hrids = SUPPLY_HRIDS) {
    const counts = emptyCounts(SUPPLY_SOURCE.run, hrids);
    if (!root?.querySelectorAll) return counts;

    const kindOf = kindByHrid(hrids);
    const scope = supplyRowScope(root, kindOf);
    if (!scope?.querySelectorAll) return counts;

    const tally = new Map();

    for (const use of scope.querySelectorAll('use')) {
        if (!readableSupplyIcon(use)) continue;
        const fragment = (use.getAttribute('href') || use.getAttribute('xlink:href') || '').split('#')[1];
        if (!fragment) continue;
        const hrid = `/items/${fragment}`;
        if (!kindOf.has(hrid)) continue;

        const count = countBeside(use);
        if (count === null) continue;
        tally.set(hrid, Math.max(tally.get(hrid) ?? 0, count));
    }

    if (!tally.size) return counts;
    counts.known = true;
    applyTally(counts, tally, kindOf);
    return counts;
}

/**
 * The number printed with an item's icon, or null when there is none.
 *
 * The game's own count element is preferred; the walk outward is for a Supplies
 * row that writes the figure as plain text beside the icon instead. A tier with
 * no number at all is a tier the row is not claiming a count for, and returning
 * zero for it would be an assertion this cannot make.
 *
 * @param {Element} use - An SVG `<use>` drawing the item
 * @returns {number|null}
 */
function countBeside(use) {
    const tile = use.closest?.('[class*="Item_itemContainer"]') || use.closest?.('[class*="Item_item"]');
    const own = tile?.querySelector('[class*="Item_count"]')?.textContent?.trim();
    if (own && /\d/.test(own)) return Math.max(0, Math.floor(parseItemCount(own, 0)));

    let current = use.parentElement;
    for (let depth = 0; depth < 4 && current; depth++) {
        const text = (current.textContent || '').trim();
        // Short, because a whole panel's text also contains digits and none of
        // them are this item's count
        if (text.length <= 12 && /\d/.test(text)) return Math.max(0, Math.floor(parseItemCount(text, 0)));
        current = current.parentElement;
    }
    return null;
}

/**
 * Which reading the planners should use, and what to call it.
 *
 * The order is not a preference, it is a correctness rule: in a run the bag is
 * stale by definition, so it is used only when neither the payload nor the
 * screen would say, and it is flagged when that happens rather than passed off
 * as the run's stock.
 *
 * @param {Object} sources - The readings available
 * @param {boolean} sources.runActive - Whether a run is going
 * @param {Object|null} [sources.run] - readRunSupplyCounts result
 * @param {Object|null} [sources.dom] - readSupplyRowCounts result
 * @param {Object|null} [sources.inventory] - readSupplyCounts result
 * @returns {Object} The chosen reading, plus `label` for the readout and
 *   `stale` when a run is going but only the bag could be read
 */
export function chooseSupplyCounts({ runActive, run = null, dom = null, inventory = null }) {
    const bag = inventory || emptyCounts(SUPPLY_SOURCE.inventory, SUPPLY_HRIDS);

    if (runActive) {
        const inRun = (run?.known && run) || (dom?.known && dom) || null;
        if (inRun) return { ...inRun, label: 'this run', stale: false };
        return { ...bag, label: 'in bag', stale: true };
    }
    return { ...bag, label: 'held', stale: false };
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
 * The word for "how many of the pile remain" — which depends on which pile a
 * reading is showing.
 *
 * Between runs it is "owned": the bag, and you can walk it up by buying more.
 * Mid-run it is "left this run": the run's own stock (or, failing that, the
 * bag standing in for it), and nothing bought now can add to it — the game
 * only tops a run up from the bag at the moment it starts. Calling a mid-run
 * zero "0 owned" is not wrong about the number, only about what it invites
 * you to do next.
 *
 * @param {boolean} runActive
 * @returns {string}
 */
export function remainingWord(runActive) {
    return runActive ? 'left this run' : 'owned';
}

/**
 * How a needed-versus-owned pair should read in a status line.
 *
 * The plain case says nothing at all — a plan you can afford should not be
 * cluttered with a reassurance — and only a shortfall gets words. The word
 * for what is held follows `remainingWord`: "owned" out of a run, "left this
 * run" mid-run, where it is not a number a purchase can move.
 *
 * @param {number} needed - What the plan calls for
 * @param {number} owned - What is held
 * @param {string} noun - Singular noun, e.g. 'shroud'
 * @param {boolean} [known=true] - False when the inventory could not be read
 * @param {boolean} [runActive=false] - Whether the pile being measured is a
 *   run's own stock (or standing in for one), for the word used to name it
 * @returns {{text: string, short: number, over: boolean}}
 */
export function describeSupplyNeed(needed, owned, noun, known = true, runActive = false) {
    const need = Math.max(0, Math.floor(Number(needed) || 0));
    const have = Math.max(0, Math.floor(Number(owned) || 0));
    const plural = (n) => `${n} ${noun}${n === 1 ? '' : 's'}`;
    if (!known) return { text: plural(need), short: 0, over: false };
    if (need <= have) return { text: plural(need), short: 0, over: false };
    return { text: `${plural(need)} needed · ${have} ${remainingWord(runActive)}`, short: need - have, over: true };
}

/**
 * What the missing supplies would cost at market, as information only.
 *
 * Walks the given tiers in order and quotes the first with a price — the
 * caller decides what order that is. Handed the full worst-first list with
 * nothing else to go on, that is the cheapest tier that has a price, which is
 * the right default when nothing says which tier the plan should quote:
 * pricing the expert tier would overstate the gap for someone who only needs
 * to skip a couple of low-level rooms. Handed a single preferred tier by
 * `restockCandidates`, it is that tier or nothing — see there for why.
 *
 * @param {number} short - How many are missing
 * @param {string[]} hrids - Candidate item hrids, in the order to try them
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

/**
 * Which tier(s) a restock estimate should be priced against.
 *
 * Preference beats price. The three tiers of a labyrinth supply are not
 * interchangeable — a basic shroud is capped at level 50 and starts failing
 * above it, a beacon's reveal grows with its tier, a torch's chance to be
 * preserved on use does too — so a hint that quotes whichever tier happens to
 * be cheapest can recommend an item that will not do the job the user is
 * actually using it for, or that plainly is not the one they buy. When a
 * preferred tier is known — from what is held, or from the run's own stock —
 * it is priced on its own rather than blended in with cheaper ones a shortage
 * would otherwise reach for. Only when nothing indicates a preference does
 * this fall back to the full list, cheapest-per-use, exactly as before.
 *
 * @param {string[]} hrids - Candidate item hrids, worst tier first
 * @param {string|null} [preferredHrid] - A tier known to be in use, or null
 * @returns {string[]} What to hand `estimateRestockCost`
 */
export function restockCandidates(hrids, preferredHrid = null) {
    const list = Array.isArray(hrids) ? hrids : [];
    if (preferredHrid && list.includes(preferredHrid)) return [preferredHrid];
    return list;
}
