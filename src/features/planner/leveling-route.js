/**
 * Leveling route optimizer
 *
 * The Goal Planner's quick estimate picks the best action the character can
 * start today and keeps it for the whole climb. That is the right default — it
 * is instant and it is what most players do — but a long climb passes unlocks:
 * an action that opens at 50 can beat the one you started with, and a cheaper
 * one can carry you when coins are short. This module answers "which action,
 * from which level to which" for one noncombat skill, on request only.
 *
 * ## What it reuses
 *
 * Every number comes from the quick estimate's own helpers in `goal-planner.js`:
 * the start rule with tea bonuses (`rateStartsAt`), the climb walk with its
 * per-level efficiency and flat-rate (enhancing) special case (`climbWith`), the
 * coin side costed per completion with drinks by the clock and the market's
 * absorption cap by elapsed time (`climbGold`), and recurring teas netted
 * against what is held (`climbTeas`). A one-stage route is the quick estimate.
 *
 * ## How it searches
 *
 * The climb is cut at every level boundary, and at each one the search may keep
 * the action or switch to any action the level allows. A partial route reaching
 * a level is a *label* (hours so far, coins spent so far, experience carried),
 * and labels another one beats are dropped:
 *
 * - **Fastest** keeps the quickest label per level (any cost, unknown included);
 * - **Cheapest** keeps the cheapest fully priced label per level;
 * - **Within budget** keeps every label no other is both quicker and cheaper
 *   than, among the fully priced ones whose cash never went below zero — capped
 *   at {@link DEFAULT_FRONTIER_CAP} per level, which the result says when it bites.
 *
 * Experience carried past a level boundary (less than one action's worth) is
 * carried exactly but not compared, and an action's repeat capacity does not
 * carry over a level boundary in the search. Both are second-order — about one
 * action per level. The market's absorption cap (`max(0, proceeds − cap × hours)`)
 * is also applied level by level in the search, which can only charge more than
 * the same cap applied once per stage: the search is pessimistic about capped
 * sales (and so about whether a capped route fits the budget), never optimistic.
 * The chosen routes are re-costed exactly, stage by stage, before they are shown. The quick estimate's own choice is always a
 * candidate too, so the Fastest route is never slower than the quick estimate.
 *
 * ## Coins
 *
 * Inputs are bought at the price the rate was measured at; owned materials are
 * not credited (parity with the quick estimate), so nothing is counted twice and
 * the cash line is conservative. Held recurring teas (enhancing) are one pool
 * across the stages. A stage needs `upfront + max(0, -net)` in hand when it
 * starts (one completion's inputs as working capital, plus its loss) — the
 * planner's own `peakFunds` rule — so a profit made later never pays for a
 * shortfall earlier. A cost that could not be priced keeps a route out of
 * Cheapest and Within budget rather than reading as free.
 */

import { climbWith, climbGold, climbTeas, levelEfficiencyAt, rateStartsAt, startableRates } from './goal-planner.js';

/** The three things a player can ask a route to be */
export const ROUTE_OBJECTIVES = Object.freeze({
    fastest: 'Fastest',
    cheapest: 'Cheapest',
    budget: 'Within budget',
});

/** Labels kept per level by the within-budget search before it trims and says so */
export const DEFAULT_FRONTIER_CAP = 512;

/** How long one slice of search runs before it yields to the browser, in ms */
const DEFAULT_SLICE_MS = 12;

/**
 * @param {*} value - Anything
 * @param {number} [fallback] - Returned when not a finite number
 * @returns {number} A finite number
 */
function num(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The level an amount of experience has reached, from a known level, capped at the target.
 * @param {Array<number>} table - Level experience table
 * @param {number} level - A level the experience is known to have reached
 * @param {number} xp - Experience
 * @param {number} cap - Highest level to report
 * @returns {number} The level
 */
function levelFor(table, level, xp, cap) {
    let reached = level;
    while (reached < cap && table[reached + 1] !== undefined && xp >= table[reached + 1]) reached += 1;
    return reached;
}

/**
 * Whether a rate's coin side is fully priced before any held-tea credit.
 * @param {Object} rate - A measured rate
 * @returns {boolean} Priced
 */
function ratePriced(rate) {
    if (rate.goldKnown === false || !Number.isFinite(rate.goldPerHour)) return false;
    // An unpriced recurring tea is unknown unless the bag covers it. The search cannot see the shared pool,
    // so it counts a rate priced when the bag covers that rate's whole climb on its own (`teaCovered`, set
    // by prepareRouteInput); the exact re-cost draws from the pool and drops a route the pool cannot cover
    if (!rate.teaCovered && Array.isArray(rate.teaBill) && rate.teaBill.some((tea) => !(tea.unitPrice > 0))) {
        return false;
    }
    return true;
}

/**
 * Normalize what the optimizer works from, and say what it cannot use.
 *
 * Everything that changes an answer is in here, so {@link routeCacheKey} of it
 * is a complete cache key.
 *
 * @param {Object} spec - Inputs
 * @param {string} spec.skillHrid - The skill
 * @param {number} spec.targetLevel - Level to reach
 * @param {number} spec.level - Current level
 * @param {number} spec.experience - Current experience
 * @param {Array<Object>} spec.rates - Measured rates for every action of the skill, locked ones included
 * @param {Array<number>} spec.table - Level experience table
 * @param {number} spec.gold - Coins in hand (the budget)
 * @param {number} [spec.measuredAtLevel] - Level the rates were measured at, when a rate does not say
 * @param {(itemHrid: string) => number} [spec.heldOf] - Recurring teas available
 * @returns {Object} The route input
 */
export function prepareRouteInput({
    skillHrid,
    targetLevel,
    level,
    experience,
    rates,
    table,
    gold,
    measuredAtLevel,
    heldOf = () => 0,
}) {
    const startLevel = Math.max(1, Math.floor(num(level, 1)));
    const usable = [];
    const excluded = [];
    for (const rate of Array.isArray(rates) ? rates : []) {
        if (!rate) continue;
        const label = rate.label || rate.actionHrid || 'An action';
        const timed = rate.flatRate ? num(rate.xpPerHour) > 0 : num(rate.actionTime) > 0;
        if (!(num(rate.xpPerHour) > 0) || !(num(rate.xpPerAction) > 0) || !timed) {
            excluded.push({ label, reason: 'gives no experience per hour' });
            continue;
        }
        usable.push({
            ...rate,
            label,
            measuredAtLevel: num(rate.measuredAtLevel, num(measuredAtLevel, startLevel)),
        });
    }

    const heldTeas = {};
    for (const rate of usable) {
        for (const tea of Array.isArray(rate.teaBill) ? rate.teaBill : []) {
            if (tea?.itemHrid && !(tea.itemHrid in heldTeas)) {
                heldTeas[tea.itemHrid] = Math.max(0, num(heldOf(tea.itemHrid)));
            }
        }
    }

    const target = Math.floor(num(targetLevel));
    const climbXp = Array.isArray(table) ? Math.max(0, num(table[target]) - num(experience)) : 0;
    for (const rate of usable) {
        if (!rate.flatRate || !Array.isArray(rate.teaBill)) continue;
        // Enhancing's climb is the experience divided by its rate, so its whole-climb tea need is exact
        const hours = climbXp / num(rate.xpPerHour);
        rate.teaCovered = rate.teaBill.every(
            (tea) => tea.unitPrice > 0 || (heldTeas[tea.itemHrid] || 0) >= Math.ceil(num(tea.perHour) * hours - 1e-9)
        );
    }

    return {
        skillHrid,
        target,
        level: startLevel,
        experience: num(experience),
        gold: Math.max(0, num(gold)),
        table: Array.isArray(table) ? table : null,
        rates: usable,
        excluded,
        heldTeas,
    };
}

/**
 * A key that changes whenever anything the answer depends on does: the character's level and experience,
 * the coins in hand, held teas, the experience table, and every number on every rate (which carry gear,
 * buffs, drinks, prices and settings inside them).
 *
 * @param {Object} input - From {@link prepareRouteInput}
 * @returns {string} The key
 */
export function routeCacheKey(input) {
    const table = input.table || [];
    return JSON.stringify([
        input.skillHrid,
        input.target,
        input.level,
        input.experience,
        input.gold,
        input.heldTeas,
        table.length,
        table[input.target] ?? null,
        table[table.length - 1] ?? null,
        input.rates.map((rate) => [
            rate.actionHrid,
            rate.label,
            rate.requiredLevel,
            rate.teaSkillLevelBonus,
            rate.actionLevelBonus,
            rate.xpPerHour,
            rate.xpPerAction,
            rate.actionTime,
            rate.totalEfficiency,
            rate.actionsPerHour,
            rate.goldPerHour,
            rate.goldKnown,
            rate.drinkCostPerHour,
            rate.upfrontCost,
            rate.saleProceedsPerHour,
            rate.saleCapPerHour,
            rate.flatRate,
            rate.measuredAtLevel,
            rate.teaBill,
            rate.teaCovered,
        ]),
    ]);
}

/**
 * Experience per hour a rate gives at a level, for explaining a switch.
 * @param {Object} rate - A rate
 * @param {number} level - The level
 * @returns {number} XP per hour
 */
export function xpPerHourAt(rate, level) {
    if (rate.flatRate) return num(rate.xpPerHour);
    const measured = num(rate.measuredAtLevel, level);
    const efficiency = num(rate.totalEfficiency) - levelEfficiencyAt(rate, measured) + levelEfficiencyAt(rate, level);
    return (3600 / num(rate.actionTime)) * (1 + efficiency / 100) * num(rate.xpPerAction);
}

/**
 * Coins one experience point costs with a rate (negative when it pays), ignoring drinks' clock share.
 * @param {Object} rate - A rate
 * @returns {number|null} Coins per XP, or null when unknown
 */
function coinsPerXp(rate) {
    if (!ratePriced(rate)) return null;
    const perHour = num(rate.xpPerHour);
    return perHour > 0 ? -num(rate.goldPerHour) / perHour : null;
}

/**
 * Cost one level of the climb with one action, as the search sees it.
 * @param {Object} input - Route input
 * @param {Object} rate - The rate
 * @param {number} level - Level the segment starts at
 * @param {number} xp - Experience it starts with
 * @returns {Object|null} `{hours, goldDelta, known, endXp, endLevel, need}`, or null when unusable
 */
function segment(input, rate, level, xp) {
    const climb = climbWith(rate, level, xp, level + 1, input.table, rate.measuredAtLevel);
    if (!Number.isFinite(climb.timeHours) || !Number.isFinite(climb.actionsNeeded)) return null;
    const gold = climbGold(rate, climb.actionsNeeded, climb.timeHours);
    const known = gold.rateKnown && ratePriced(rate);
    const upfront = known ? Math.max(0, num(rate.upfrontCost)) : 0;
    return {
        hours: climb.timeHours,
        goldDelta: known ? gold.goldDelta : 0,
        known,
        endXp: climb.endXp,
        endLevel: levelFor(input.table, level + 1, climb.endXp, input.target),
        // The planner's per-step rule: working capital for one completion plus the loss
        need: upfront + Math.max(0, -gold.goldDelta),
    };
}

/**
 * Re-cost a route exactly: each stage as one climb, with repeat capacity carried through it, held teas as
 * one pool, and the cash walked in order.
 *
 * @param {Object} input - Route input
 * @param {Array<{rate: Object, fromLevel: number, toLevel: number}>} plan - Stages in order
 * @param {string} objective - Which objective chose it, for the explanations
 * @returns {Object} A route: `{objective, stages, totals}`
 */
export function costRoute(input, plan, objective = 'fastest') {
    const stages = [];
    const pool = { ...input.heldTeas };
    let xp = input.experience;
    let level = levelFor(input.table, input.level, input.experience, input.target);
    let cash = input.gold;
    let lowestCash = cash;

    for (let index = 0; index < plan.length; index += 1) {
        const { rate, toLevel } = plan[index];
        const fromLevel = level;
        const climb = climbWith(rate, fromLevel, xp, toLevel, input.table, rate.measuredAtLevel);
        const actions = num(climb.actionsNeeded);
        const timeHours = num(climb.timeHours);
        const gold = climbGold(rate, actions, timeHours);
        let goldDelta = gold.goldDelta;
        let costKnown = gold.rateKnown;

        let teas = [];
        if (costKnown && Array.isArray(rate.teaBill)) {
            const result = climbTeas(rate, timeHours, (itemHrid) => pool[itemHrid] || 0);
            teas = result.teaNeeds;
            goldDelta += result.teaHeldCredit;
            if (result.teaUnknown) costKnown = false;
            // What this stage drinks from the bag is gone for the next one: held tea counts once
            for (const tea of teas) pool[tea.itemHrid] = Math.max(0, (pool[tea.itemHrid] || 0) - tea.held);
        }
        if (!costKnown) goldDelta = 0;

        const upfront = costKnown ? Math.max(0, num(rate.upfrontCost)) : 0;
        let materialCost = 0;
        let proceeds = 0;
        if (costKnown) {
            if (rate.flatRate) {
                // Enhancing: the hourly figure is materials plus teas; nothing is sold
                materialCost = Math.max(0, -(gold.goldDelta + gold.drinkCost));
            } else {
                materialCost = upfront * actions;
                proceeds = gold.goldDelta + materialCost + gold.drinkCost;
            }
        }

        const cashStart = cash;
        const low = cashStart - upfront - Math.max(0, -goldDelta);
        cash += goldDelta;
        if (costKnown) lowestCash = Math.min(lowestCash, low);

        const reached = levelFor(input.table, toLevel, climb.endXp, input.target);
        stages.push({
            actionHrid: rate.actionHrid || null,
            label: rate.label,
            fromLevel,
            toLevel,
            actions,
            timeHours,
            goldDelta,
            costKnown,
            materialCost,
            drinkCost: costKnown ? gold.drinkCost : 0,
            proceeds,
            unsoldProceeds: gold.unsoldProceeds,
            upfront,
            teas,
            cashStart,
            cashLow: low,
            cashEnd: cash,
            xpPerHour: xpPerHourAt(rate, fromLevel),
            why: '',
            rate,
        });
        xp = climb.endXp;
        level = reached;
    }

    for (let index = 0; index < stages.length; index += 1) {
        stages[index].why = explainStage(input, stages, index, objective);
    }

    const totals = stages.reduce(
        (sum, stage) => ({
            timeHours: sum.timeHours + stage.timeHours,
            actions: sum.actions + stage.actions,
            goldDelta: sum.goldDelta + stage.goldDelta,
            materialCost: sum.materialCost + stage.materialCost,
            drinkCost: sum.drinkCost + stage.drinkCost,
            proceeds: sum.proceeds + stage.proceeds,
            costKnown: sum.costKnown && stage.costKnown,
        }),
        { timeHours: 0, actions: 0, goldDelta: 0, materialCost: 0, drinkCost: 0, proceeds: 0, costKnown: true }
    );
    totals.lowestCash = lowestCash;
    totals.budgetSafe = totals.costKnown && lowestCash >= 0;
    return { objective, stages, totals };
}

/**
 * The first level at or above the start where a rate can be started.
 * @param {Object} input - Route input
 * @param {Object} rate - A rate
 * @returns {number|null} The level, or null when it never opens before the target
 */
function unlockLevel(input, rate) {
    for (let level = input.level; level < input.target; level += 1) {
        if (rateStartsAt(rate, level)) return level;
    }
    return null;
}

/**
 * Why a stage uses the action it does.
 * @param {Object} input - Route input
 * @param {Array<Object>} stages - The route's stages
 * @param {number} index - Which stage
 * @param {string} objective - The objective
 * @returns {string} A short reason
 */
function explainStage(input, stages, index, objective) {
    const stage = stages[index];
    const xpHr = (value) => `${Math.round(value).toLocaleString('en-US')} XP/hr`;
    if (index === 0) {
        if (stages.length === 1) return 'one action the whole way';
        return objective === 'cheapest' ? 'cheapest per XP you can start now' : 'best you can start now';
    }
    const previous = stages[index - 1];
    const at = stage.fromLevel;
    const parts = [];
    if (unlockLevel(input, stage.rate) === at && at > input.level) parts.push(`unlocks at ${at}`);
    const before = xpPerHourAt(previous.rate, at);
    if (stage.xpPerHour > before) parts.push(`${xpHr(stage.xpPerHour)} vs ${xpHr(before)}`);
    else {
        const now = coinsPerXp(stage.rate);
        const then = coinsPerXp(previous.rate);
        if (now !== null && then !== null && now < then) {
            parts.push(objective === 'budget' ? 'cheaper per XP, keeps coins above zero' : 'cheaper per XP');
        } else parts.push(`${xpHr(stage.xpPerHour)} vs ${xpHr(before)}`);
    }
    return parts.join('; ');
}

/**
 * Turn a per-level choice list into stages, merging levels that keep the same action.
 * @param {Array<{rate: Object, toLevel: number}>} choices - One entry per search segment, in order
 * @returns {Array<{rate: Object, toLevel: number}>} Stages
 */
function mergeStages(choices) {
    const stages = [];
    for (const choice of choices) {
        const last = stages[stages.length - 1];
        if (last && last.rate === choice.rate) last.toLevel = choice.toLevel;
        else stages.push({ rate: choice.rate, toLevel: choice.toLevel });
    }
    return stages;
}

/**
 * Walk a label back to the per-level choices that made it.
 * @param {Object} label - A search label
 * @returns {Array<{rate: Object, toLevel: number}>} Choices in order
 */
function choicesOf(label) {
    const choices = [];
    for (let at = label; at && at.rate; at = at.prev) choices.push({ rate: at.rate, toLevel: at.level });
    return choices.reverse();
}

/**
 * One objective's search state.
 * @param {Object} input - Route input
 * @param {string} objective - fastest | cheapest | budget
 * @param {number} cap - Frontier cap for the budget search
 * @returns {Object} Search state
 */
function createObjectiveSearch(input, objective, cap) {
    const start = { level: input.level, xp: input.experience, hours: 0, spent: 0, known: true, prev: null };
    const startLevel = levelFor(input.table, input.level, input.experience, input.target);
    start.level = startLevel;
    const nodes = new Map([[startLevel, [start]]]);
    return { objective, cap, nodes, bounded: false, segments: 0 };
}

/**
 * Keep the labels worth extending at one level.
 * @param {Object} search - Search state
 * @param {Array<Object>} labels - Labels that reached the level
 * @returns {Array<Object>} Survivors
 */
function prune(search, labels) {
    if (labels.length <= 1) return labels;
    if (search.objective === 'fastest') {
        let best = labels[0];
        for (const label of labels) {
            if (label.hours < best.hours || (label.hours === best.hours && label.spent < best.spent)) best = label;
        }
        return [best];
    }
    if (search.objective === 'cheapest') {
        let best = labels[0];
        for (const label of labels) {
            if (label.spent < best.spent || (label.spent === best.spent && label.hours < best.hours)) best = label;
        }
        return [best];
    }
    // Within budget: the quicker-and-cheaper frontier
    const sorted = [...labels].sort((a, b) => a.hours - b.hours || a.spent - b.spent);
    const frontier = [];
    let cheapest = Infinity;
    for (const label of sorted) {
        if (label.spent < cheapest) {
            frontier.push(label);
            cheapest = label.spent;
        }
    }
    if (frontier.length <= search.cap) return frontier;
    // Evenly spaced along the frontier, both ends kept: the quickest and the cheapest survive any trim
    search.bounded = true;
    const kept = [];
    for (let i = 0; i < search.cap; i += 1) {
        kept.push(frontier[Math.round((i * (frontier.length - 1)) / (search.cap - 1))]);
    }
    return [...new Set(kept)];
}

/**
 * Extend every surviving label at one level by one level with every action the level allows.
 * @param {Object} input - Route input
 * @param {Object} search - Search state
 * @param {number} level - The level
 * @param {Array<Object>} eligible - Rates that can be started at this level
 */
function extendLevel(input, search, level, eligible) {
    const arrived = search.nodes.get(level);
    if (!arrived) return;
    search.nodes.delete(level);
    const labels = prune(search, arrived);
    const priced = search.objective !== 'fastest';
    for (const label of labels) {
        for (const rate of eligible) {
            const seg = segment(input, rate, level, label.xp);
            search.segments += 1;
            if (!seg) continue;
            if (priced && !seg.known) continue;
            if (search.objective === 'budget' && input.gold - label.spent < seg.need) continue;
            const next = {
                level: seg.endLevel,
                xp: seg.endXp,
                hours: label.hours + seg.hours,
                spent: label.spent - seg.goldDelta,
                known: label.known && seg.known,
                rate,
                prev: label,
            };
            const list = search.nodes.get(next.level);
            if (list) list.push(next);
            else search.nodes.set(next.level, [next]);
        }
    }
}

/**
 * The best finished label for an objective.
 * @param {Object} search - Search state
 * @param {number} target - Target level
 * @returns {Array<Object>} Finished labels, best first
 */
function finished(search, target) {
    const labels = search.nodes.get(target) || [];
    const key =
        search.objective === 'cheapest'
            ? (a, b) => a.spent - b.spent || a.hours - b.hours
            : (a, b) => a.hours - b.hours || a.spent - b.spent;
    return [...labels].sort(key);
}

/**
 * Whether route `a` is a better answer to an objective than `b`.
 * @param {string} objective - The objective
 * @param {Object} a - A costed route
 * @param {Object|null} b - Another, or null
 * @returns {boolean} Whether a wins
 */
function better(objective, a, b) {
    if (!b) return true;
    if (objective === 'cheapest') {
        const spentA = -a.totals.goldDelta;
        const spentB = -b.totals.goldDelta;
        return spentA < spentB - 1e-9 || (Math.abs(spentA - spentB) <= 1e-9 && a.totals.timeHours < b.totals.timeHours);
    }
    return a.totals.timeHours < b.totals.timeHours - 1e-12;
}

/**
 * A result that ends before any search.
 * @param {Object} input - Route input
 * @param {string} status - Why
 * @param {string} message - What to say
 * @returns {Object} The result
 */
function endedEarly(input, status, message) {
    return {
        status,
        message,
        skillHrid: input.skillHrid,
        fromLevel: input.level,
        target: input.target,
        gold: input.gold,
        routes: { fastest: null, cheapest: null, budget: null },
        unavailable: {},
        baseline: null,
        excluded: input.excluded,
        bounded: false,
        notes: [],
        stats: { segments: 0 },
    };
}

/**
 * Search for routes, yielding between slices.
 *
 * @param {Object} input - From {@link prepareRouteInput}
 * @param {Object} [options] - Options
 * @param {() => boolean} [options.shouldStop] - Asked between slices; true ends with status 'stopped'
 * @param {(progress: {done: number, total: number}) => void} [options.onProgress] - Called between slices
 * @param {() => Promise<void>} [options.yieldToBrowser] - Awaited between slices (none: runs straight through)
 * @param {number} [options.sliceMs] - Work per slice
 * @param {() => number} [options.now] - Clock, in ms
 * @param {number} [options.frontierCap] - Labels kept per level by the budget search
 * @returns {Promise<Object>} The result (see the module doc)
 */
export async function runRouteSearch(input, options = {}) {
    const {
        shouldStop = () => false,
        onProgress = null,
        yieldToBrowser = null,
        sliceMs = DEFAULT_SLICE_MS,
        now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
        frontierCap = DEFAULT_FRONTIER_CAP,
    } = options;

    if (!input.table || input.table[input.target] === undefined) {
        return endedEarly(input, 'no-table', 'The game has not sent the experience table, so no route can be timed.');
    }
    const startLevel = levelFor(input.table, input.level, input.experience, input.target);
    if (startLevel >= input.target) {
        return endedEarly(input, 'reached', `Already at level ${startLevel}; nothing to route.`);
    }
    if (!startableRates(input.rates, startLevel).length) {
        const why = input.rates.length
            ? `None of the actions can be started at level ${startLevel}.`
            : 'No action for this skill gives experience that can be timed.';
        return endedEarly(input, 'no-action', why);
    }

    const eligibleAt = new Map();
    for (let level = startLevel; level < input.target; level += 1) {
        eligibleAt.set(
            level,
            input.rates.filter((rate) => rateStartsAt(rate, level))
        );
    }

    const searches = ['fastest', 'cheapest', 'budget'].map((objective) =>
        createObjectiveSearch(input, objective, frontierCap)
    );
    const total = searches.length * (input.target - startLevel);
    let done = 0;
    let sliceStart = now();

    for (const search of searches) {
        for (let level = startLevel; level < input.target; level += 1) {
            extendLevel(input, search, level, eligibleAt.get(level));
            done += 1;
            if (yieldToBrowser && now() - sliceStart >= sliceMs) {
                onProgress?.({ done, total });
                await yieldToBrowser();
                if (shouldStop()) return endedEarly(input, 'stopped', 'Stopped.');
                sliceStart = now();
            }
        }
    }
    if (shouldStop()) return endedEarly(input, 'stopped', 'Stopped.');
    onProgress?.({ done: total, total });

    // The quick estimate's choice, kept the whole way: always a candidate, and the yardstick
    const quick = startableRates(input.rates, startLevel)[0];
    const baseline = costRoute(input, [{ rate: quick, toLevel: input.target }], 'fastest');

    const routes = {};
    const unavailable = {};
    for (const search of searches) {
        const { objective } = search;
        let chosen = null;
        for (const label of finished(search, input.target)) {
            const route = costRoute(input, mergeStages(choicesOf(label)), objective);
            if (objective !== 'fastest' && !route.totals.costKnown) continue;
            if (objective === 'budget' && !route.totals.budgetSafe) continue;
            chosen = route;
            break;
        }
        const quickRoute = { ...baseline, objective };
        const quickQualifies =
            objective === 'fastest' ||
            (objective === 'cheapest' && baseline.totals.costKnown) ||
            (objective === 'budget' && baseline.totals.budgetSafe);
        if (quickQualifies && better(objective, quickRoute, chosen)) {
            chosen = costRoute(input, [{ rate: quick, toLevel: input.target }], objective);
        }
        routes[objective] = chosen;
        if (!chosen) {
            unavailable[objective] =
                objective === 'cheapest'
                    ? 'No route could be fully priced: every way there uses an action whose cost has no market price.'
                    : `No priced route keeps your coins above zero all the way (budget ${Math.round(input.gold).toLocaleString('en-US')}).`;
        }
    }

    const budgetSearch = searches.find((search) => search.objective === 'budget');
    const notes = [];
    if (budgetSearch.bounded) {
        notes.push(
            `The within-budget search kept the ${frontierCap} best trade-offs per level and dropped the rest, ` +
                'so it may not be the fastest affordable route.'
        );
    }

    return {
        status: 'route',
        message: '',
        skillHrid: input.skillHrid,
        fromLevel: startLevel,
        target: input.target,
        gold: input.gold,
        routes,
        unavailable,
        baseline,
        excluded: input.excluded,
        bounded: budgetSearch.bounded,
        notes,
        stats: { segments: searches.reduce((sum, search) => sum + search.segments, 0) },
    };
}

/**
 * Every route an exhaustive search would try: each level's action chosen independently. For checking the
 * search on small cases only — it grows as actions^levels.
 *
 * @param {Object} input - Route input
 * @param {string} objective - fastest | cheapest | budget
 * @returns {{hours: number, spent: number}|null} The best search-model figures, or null when none qualifies
 */
export function exhaustiveBest(input, objective) {
    const startLevel = levelFor(input.table, input.level, input.experience, input.target);
    let best = null;
    const walk = (level, xp, hours, spent, known) => {
        if (level >= input.target) {
            if (objective !== 'fastest' && !known) return;
            const candidate = { hours, spent };
            const wins =
                !best ||
                (objective === 'cheapest'
                    ? spent < best.spent || (spent === best.spent && hours < best.hours)
                    : hours < best.hours || (hours === best.hours && spent < best.spent));
            if (wins) best = candidate;
            return;
        }
        for (const rate of input.rates) {
            if (!rateStartsAt(rate, level)) continue;
            const seg = segment(input, rate, level, xp);
            if (!seg) continue;
            if (objective !== 'fastest' && !seg.known) continue;
            if (objective === 'budget' && input.gold - spent < seg.need) continue;
            walk(seg.endLevel, seg.endXp, hours + seg.hours, spent - seg.goldDelta, known && seg.known);
        }
    };
    walk(startLevel, input.experience, 0, 0, true);
    return best;
}

/**
 * The search-model figures of a label path, for comparing against {@link exhaustiveBest}.
 * @param {Object} input - Route input
 * @param {Array<Object>} rates - One rate per level, in order
 * @returns {{hours: number, spent: number}} Figures
 */
export function searchModelCost(input, rates) {
    let level = levelFor(input.table, input.level, input.experience, input.target);
    let xp = input.experience;
    let hours = 0;
    let spent = 0;
    for (const rate of rates) {
        if (level >= input.target) break;
        const seg = segment(input, rate, level, xp);
        hours += seg.hours;
        spent -= seg.goldDelta;
        xp = seg.endXp;
        level = seg.endLevel;
    }
    return { hours, spent };
}

/**
 * The per-level choices of a finished route's best label, for tests.
 * @param {Object} input - Route input
 * @param {string} objective - The objective
 * @returns {Promise<{hours: number, spent: number}|null>} The search's best search-model figures
 */
export async function searchBest(input, objective) {
    const startLevel = levelFor(input.table, input.level, input.experience, input.target);
    const search = createObjectiveSearch(input, objective, Number.POSITIVE_INFINITY);
    for (let level = startLevel; level < input.target; level += 1) {
        extendLevel(
            input,
            search,
            level,
            input.rates.filter((rate) => rateStartsAt(rate, level))
        );
    }
    const best = finished(search, input.target)[0];
    return best ? { hours: best.hours, spent: best.spent } : null;
}

export default {
    ROUTE_OBJECTIVES,
    prepareRouteInput,
    routeCacheKey,
    runRouteSearch,
    costRoute,
};
