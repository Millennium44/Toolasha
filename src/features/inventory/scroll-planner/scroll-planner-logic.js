/**
 * Scroll Planner logic
 * Pure helpers: which items count as scrolls, plan normalization, and run construction.
 *
 * A run is a list of steps, one per scroll type. Each step carries `remaining`, the planned
 * scrolls still to open, and `lastOwned`, the inventory count last seen. Only a drop in the count
 * while the step is current is counted as opened ({@link observeInventory}); a gain moves
 * `lastOwned` up and leaves `remaining` alone, so picking up more of a scroll mid-run never raises
 * what the player planned, and a step marked `done` stays done. Steps are saved with both fields,
 * so a reload resumes from them; records from before this shape (`targetCount` only) are read by
 * {@link normalizeSteps}.
 */

const SCROLL_CATEGORY_HRID = '/item_categories/scroll';
const INVENTORY_LOCATION_HRID = '/item_locations/inventory';

/**
 * Scroll item HRIDs in the game's own sort order.
 * @param {Object} itemDetailMap - init_client_data itemDetailMap
 * @returns {string[]}
 */
export function getScrollHrids(itemDetailMap) {
    if (!itemDetailMap) {
        return [];
    }
    return Object.entries(itemDetailMap)
        .filter(([, item]) => item?.categoryHrid === SCROLL_CATEGORY_HRID && item.isOpenable)
        .sort(([, a], [, b]) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
        .map(([hrid]) => hrid);
}

/**
 * @param {Array} characterItems
 * @param {string} itemHrid
 * @returns {number} Unenhanced inventory count of the item
 */
export function getOwnedCount(characterItems, itemHrid) {
    if (!Array.isArray(characterItems)) {
        return 0;
    }
    let total = 0;
    for (const item of characterItems) {
        if (
            item?.itemHrid === itemHrid &&
            item.itemLocationHrid === INVENTORY_LOCATION_HRID &&
            !(item.enhancementLevel > 0)
        ) {
            total += item.count || 0;
        }
    }
    return total;
}

/**
 * Keep only positive, finite whole-number quantities for known scrolls.
 * @param {*} rawPlan - Possibly stale or malformed stored plan
 * @param {string[]} scrollHrids - Valid scroll HRIDs
 * @returns {Object<string, number>}
 */
export function normalizePlan(rawPlan, scrollHrids) {
    const valid = new Set(scrollHrids);
    const plan = {};
    if (!rawPlan || typeof rawPlan !== 'object') {
        return plan;
    }
    for (const [hrid, quantity] of Object.entries(rawPlan)) {
        const whole = Math.floor(Number(quantity));
        if (valid.has(hrid) && Number.isFinite(whole) && whole > 0) {
            plan[hrid] = whole;
        }
    }
    return plan;
}

/**
 * Build a run from a plan against what this character owns.
 * @param {Object<string, number>} plan
 * @param {string[]} scrollHrids - Ordering of steps
 * @param {Array} characterItems
 * @returns {{steps: Array<{itemHrid: string, quantity: number, planned: number, remaining: number,
 *   lastOwned: number, done: boolean, skipped: boolean}>,
 *   shortfalls: Array<{itemHrid: string, planned: number, owned: number}>}}
 */
export function buildRun(plan, scrollHrids, characterItems) {
    const steps = [];
    const shortfalls = [];
    for (const itemHrid of scrollHrids) {
        const planned = plan[itemHrid];
        if (!(planned > 0)) {
            continue;
        }
        const owned = getOwnedCount(characterItems, itemHrid);
        const quantity = Math.min(planned, owned);
        if (quantity < planned) {
            shortfalls.push({ itemHrid, planned, owned });
        }
        if (quantity > 0) {
            steps.push({
                itemHrid,
                quantity,
                planned,
                remaining: quantity,
                lastOwned: owned,
                done: false,
                skipped: false,
            });
        }
    }
    return { steps, shortfalls };
}

/**
 * Saved steps in the current shape, whatever build wrote them.
 *
 * A record from before `remaining` existed holds `targetCount` (owned at start minus planned): its
 * remaining is what that formula gave, owned now minus the target, but never more than the step's
 * planned quantity — so scrolls gained before the resume are not added to it.
 * @param {*} steps - Stored steps
 * @param {Array} characterItems
 * @returns {Array|null} Steps, or null when the record is unreadable
 */
export function normalizeSteps(steps, characterItems) {
    if (!Array.isArray(steps)) {
        return null;
    }
    const out = [];
    for (const step of steps) {
        if (!step || typeof step.itemHrid !== 'string') {
            return null;
        }
        const owned = getOwnedCount(characterItems, step.itemHrid);
        const quantity = Math.max(0, Math.floor(Number(step.quantity)) || 0);
        let remaining = Number(step.remaining);
        let lastOwned = Number(step.lastOwned);
        if (!Number.isFinite(remaining)) {
            const target = Number(step.targetCount);
            remaining = Number.isFinite(target) ? Math.min(quantity, Math.max(0, owned - target)) : 0;
            lastOwned = owned;
        }
        if (!Number.isFinite(lastOwned)) {
            lastOwned = owned;
        }
        out.push({
            itemHrid: step.itemHrid,
            quantity,
            planned: Number(step.planned) || quantity,
            remaining: Math.max(0, Math.min(quantity, remaining)),
            lastOwned,
            done: Boolean(step.done) || remaining <= 0,
            skipped: Boolean(step.skipped),
        });
    }
    return out;
}

/**
 * Fold the inventory now into the steps: a drop in the current step's scroll is that many opened,
 * a gain only moves the baseline. Returns new step objects; the input is not changed.
 * @param {Array} steps
 * @param {Array} characterItems
 * @returns {{steps: Array, changed: boolean}}
 */
export function observeInventory(steps, characterItems) {
    // The step that was current before this change, judged by the counts last seen: judged by the
    // new counts, a step whose last scrolls were just opened would already look finished
    const currentIndex = steps.findIndex(
        (step) => !step.skipped && !step.done && step.remaining > 0 && step.lastOwned > 0
    );
    let changed = false;
    const next = steps.map((step, index) => {
        const owned = getOwnedCount(characterItems, step.itemHrid);
        if (owned === step.lastOwned) {
            return step;
        }
        changed = true;
        const updated = { ...step, lastOwned: owned };
        if (index === currentIndex) {
            const opened = Math.max(0, step.lastOwned - owned);
            updated.remaining = Math.max(0, step.remaining - opened);
            // Nothing left to open: done, and a later gain does not bring it back
            if (updated.remaining <= 0 || owned === 0) {
                updated.done = true;
            }
        }
        return updated;
    });
    return { steps: changed ? next : steps, changed };
}

/**
 * @param {{itemHrid: string, remaining: number, done: boolean, skipped: boolean}} step
 * @param {Array} characterItems
 * @returns {boolean}
 */
export function isStepFinished(step, characterItems) {
    return step.skipped || step.done || !(step.remaining > 0) || getOwnedCount(characterItems, step.itemHrid) === 0;
}

/**
 * First unfinished step, or null when the run is complete.
 * @param {Array} steps
 * @param {Array} characterItems
 * @returns {{step: Object, index: number}|null}
 */
export function getCurrentStep(steps, characterItems) {
    for (let index = 0; index < steps.length; index++) {
        if (!isStepFinished(steps[index], characterItems)) {
            return { step: steps[index], index };
        }
    }
    return null;
}

/**
 * Scrolls still to open for a step: what is left of the plan, and never more than is owned.
 * @param {{itemHrid: string, remaining: number}} step
 * @param {Array} characterItems
 * @returns {number}
 */
export function getRemainingQuantity(step, characterItems) {
    return Math.max(0, Math.min(step.remaining, getOwnedCount(characterItems, step.itemHrid)));
}

/**
 * Which action types (skills) each scroll's buff can be used in, from game data: an item's
 * `scrollDetail.personalBuffTypeHrid`, then that buff type's `usableInActionTypeMap`.
 * @param {string[]} scrollHrids
 * @param {Object} gameData - init_client_data (itemDetailMap, personalBuffTypeDetailMap, actionTypeDetailMap)
 * @returns {Map<string, string[]>} Scroll HRID -> action type HRIDs in the game's order; empty when
 *   the buff data is missing
 */
export function getScrollSkills(scrollHrids, gameData) {
    const result = new Map();
    const buffMap = gameData?.personalBuffTypeDetailMap;
    if (!buffMap || typeof buffMap !== 'object') {
        return result;
    }
    const order = (hrid) => gameData?.actionTypeDetailMap?.[hrid]?.sortIndex ?? Number.MAX_SAFE_INTEGER;
    for (const scrollHrid of scrollHrids) {
        const buffHrid = gameData?.itemDetailMap?.[scrollHrid]?.scrollDetail?.personalBuffTypeHrid;
        const usable = buffHrid ? buffMap[buffHrid]?.usableInActionTypeMap : null;
        if (!usable || typeof usable !== 'object') {
            continue;
        }
        const types = Object.keys(usable)
            .filter((type) => usable[type])
            .sort((a, b) => order(a) - order(b) || a.localeCompare(b));
        if (types.length > 0) {
            result.set(scrollHrid, types);
        }
    }
    return result;
}

/**
 * Every action type at least one scroll covers, in the game's order.
 * @param {Map<string, string[]>} scrollSkills - From {@link getScrollSkills}
 * @param {Object} [actionTypeDetailMap]
 * @returns {string[]}
 */
export function getCoveredSkills(scrollSkills, actionTypeDetailMap) {
    const all = new Set();
    for (const types of scrollSkills.values()) {
        types.forEach((type) => all.add(type));
    }
    const order = (hrid) => actionTypeDetailMap?.[hrid]?.sortIndex ?? Number.MAX_SAFE_INTEGER;
    return [...all].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
}

/** At this many non-combat skills a row says so in words rather than drawing every icon */
const NON_COMBAT_LABEL_MIN = 8;
export const COMBAT_ACTION_TYPE = '/action_types/combat';

/**
 * How a scroll row shows its skills: a word label for the broad scrolls, icons otherwise.
 * @param {string[]} types - The scroll's action types
 * @param {string[]} coveredSkills - Every skill any scroll covers ({@link getCoveredSkills})
 * @returns {{label: string|null, missing: string[]}} `label` when words replace the icons, with
 *   the non-combat skills the scroll does not cover in `missing`
 */
export function describeScrollSkills(types, coveredSkills) {
    const own = new Set(types);
    if (coveredSkills.length > 0 && coveredSkills.every((type) => own.has(type))) {
        return { label: 'All skills', missing: [] };
    }
    if (!own.has(COMBAT_ACTION_TYPE) && own.size >= NON_COMBAT_LABEL_MIN) {
        const missing = coveredSkills.filter((type) => type !== COMBAT_ACTION_TYPE && !own.has(type));
        return { label: 'All non-combat', missing };
    }
    return { label: null, missing: [] };
}
