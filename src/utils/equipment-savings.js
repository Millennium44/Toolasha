/**
 * Equipment savings
 *
 * How far you are from affording the piece you want, and when you will be.
 *
 * ## The cost is not the price
 *
 * An upgrade costs the asking price of the thing you want **minus what the piece
 * it replaces is worth**, because you sell the old one. Reading the ask alone
 * overstates every upgrade by the value of the gear you are already wearing,
 * which for a late-game slot is most of the price.
 *
 * That is only true if you actually sell it. Somebody keeping the old piece for
 * a second loadout is paying the full ask, so the trade-in is a mode rather than
 * an assumption — `noSell` turns it off.
 *
 * ## Unpriced is not free
 *
 * A target nobody is selling has no cost, not a cost of nothing. Treating it as
 * zero would report it as already affordable, which is the most misleading thing
 * this could possibly say. Those come back null and are counted separately in a
 * total, so a total is never quietly a lower bound.
 *
 * ## Levels are bought too
 *
 * An ability level is a purchase like any other: so many books at what the
 * market wants for them. It is a savings goal in every way that matters here,
 * so it lives on the same list — and, because a sim run refines its own estimate
 * every time it is asked, adding a goal for an ability that already has one
 * replaces it rather than stacking a second guess beside the first.
 *
 * The one thing a level has that a sword does not is a way of being *finished*
 * without being bought: you can read the books over a week of drops and arrive
 * anyway. So a goal is checked against the level the character is actually at,
 * and says so, rather than sitting on the list forever.
 *
 * The goals live in the same stored record as the gear, under `abilities`, which
 * is why the loading and saving of that record is here rather than in the panel:
 * two writers of one key lose each other's edits. A record written before this
 * existed simply has no `abilities` key and loads exactly as it did.
 *
 * The model is EWatch's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import storage from '../core/storage.js';
import { readScoped, writeScoped } from './character-key.js';

/** The one record the whole feature is stored in, per character */
const STORAGE_KEY = 'equipmentSavings';

/**
 * What one upgrade actually costs.
 *
 * @param {Object} input - What it needs
 * @param {number|null} input.targetAsk - The asking price of the piece you want
 * @param {number} [input.equippedBid] - What the piece it replaces would fetch
 * @param {boolean} [input.noSell] - Keeping the old piece, so no trade-in
 * @returns {number|null} Coins needed, or null when the target has no price
 */
export function upgradeCost({ targetAsk, equippedBid = 0, noSell = false }) {
    if (!(targetAsk > 0)) return null;
    if (noSell) return targetAsk;

    // Never negative: an upgrade cheaper than what you are wearing costs
    // nothing, and a negative cost would make a progress bar meaningless
    return Math.max(0, targetAsk - (Number(equippedBid) || 0));
}

/**
 * What the materials for one craft come to.
 *
 * An upgrade recipe has two halves the game keeps apart: the **inputs**, which
 * are consumed, and the **upgrade item**, which is the piece being upgraded. For
 * somebody who already owns the base piece — the usual reason to craft rather
 * than buy — only the inputs are a purchase, and the finished item's ask is
 * irrelevant. A Furious Spear you already hold becomes a Refined one for the
 * price of the shards.
 *
 * Any unpriced input makes the whole thing unpriced. A recipe totalled from the
 * ingredients it could price is a lower bound wearing a total's clothes, and
 * here it would report a cheaper craft than is possible.
 *
 * @param {Object} input - What it needs
 * @param {Array<{itemHrid: string, count: number}>} input.inputItems - The recipe
 * @param {Function} input.priceOf - `(itemHrid) => number|null`
 * @param {number} [input.outputCount] - How many one action makes
 * @param {boolean} [input.haveBase] - Whether the piece being upgraded is already owned
 * @param {number} [input.upgradeAsk] - What the piece being upgraded costs, if not
 * @returns {number|null} Coins for one finished item, or null when it cannot be priced
 */
export function craftCost({ inputItems, priceOf, outputCount = 1, haveBase = true, upgradeAsk = 0 }) {
    if (!inputItems?.length) return null;

    let total = 0;
    for (const input of inputItems) {
        const price = priceOf(input.itemHrid);
        if (!(price > 0)) return null;
        total += price * (input.count || 0);
    }

    // The base piece is only a cost if it has to be bought
    if (!haveBase) {
        if (!(upgradeAsk > 0)) return null;
        total += upgradeAsk;
    }

    const made = outputCount > 0 ? outputCount : 1;
    return total / made;
}

/**
 * How far along the saving is.
 *
 * @param {number|null} cost - From `upgradeCost`
 * @param {number} coins - What you have
 * @returns {{fraction: number|null, affordable: boolean, needed: number|null}}
 *   `fraction` is capped at 1 — a bar cannot say more than full — while `needed`
 *   is what is actually left, which is the figure worth reading
 */
export function savingsProgress(cost, coins) {
    if (cost === null) return { fraction: null, affordable: false, needed: null };

    const held = Number(coins) || 0;
    // Nothing to save for is already there, rather than a division by zero
    if (cost <= 0) return { fraction: 1, affordable: true, needed: 0 };

    return {
        fraction: Math.min(1, held / cost),
        affordable: held >= cost,
        needed: Math.max(0, cost - held),
    };
}

/**
 * How long the rest of it takes at what you are earning.
 *
 * @param {number|null} needed - Coins still to find
 * @param {number} perDay - Income per day
 * @returns {number|null} Seconds, or null when it cannot be said
 */
export function timeToAffordSeconds(needed, perDay) {
    if (needed === null || !(needed > 0)) return 0;
    // Not infinity: no income is not "never", it is nothing to divide by. A
    // figure would be a claim about the future that this cannot make.
    if (!(perDay > 0)) return null;

    return (needed / perDay) * 86400;
}

/**
 * The whole shopping list at once.
 *
 * @param {Array<{cost: number|null}>} watches - Priced watches
 * @returns {{cost: number, unpriced: number}} `unpriced` is how many targets it
 *   could not include, which is the difference between a total and a lower bound
 *   presented as one
 */
export function totalSavings(watches) {
    let cost = 0;
    let unpriced = 0;

    for (const watch of watches || []) {
        if (!watch) continue;
        if (watch.cost === null) unpriced++;
        else cost += watch.cost;
    }
    return { cost, unpriced };
}

/**
 * The order a savings list reads best in.
 *
 * Nearest to done first, because that is the next thing that happens and the
 * only entry you might act on today. Insertion order says nothing at all, and
 * cost order buries the piece you are two days from behind one you are two
 * months from.
 *
 * Affordable ones lead — they are done, and a list that hides its finished
 * entries at the bottom makes you hunt for good news. Unpriced ones go last:
 * they have no progress to sort by, and putting them anywhere else implies one.
 *
 * @param {Array<Object>} targets - Costed targets
 * @returns {Array<Object>} A new array
 */
export function orderTargets(targets) {
    const rank = (target) => (target.cost === null ? 2 : target.affordable ? 0 : 1);

    return [...(targets || [])].filter(Boolean).sort((a, b) => {
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        if (rank(a) === 2) return (a.name || '').localeCompare(b.name || '');
        // Within a band, the one furthest along leads
        return (b.fraction || 0) - (a.fraction || 0);
    });
}

/**
 * The item that levels an ability, which is the thing the market has a price for.
 *
 * @param {string} abilityHrid - e.g. `/abilities/fierce_aura`
 * @returns {string} e.g. `/items/fierce_aura`
 */
export function abilityBookHrid(abilityHrid) {
    return String(abilityHrid || '').replace('/abilities/', '/items/');
}

/** An ability's name out of its hrid, for when nothing better was supplied */
const prettyAbility = (abilityHrid) =>
    String(abilityHrid || '')
        .split('/')
        .pop()
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());

/**
 * How an ability goal reads: the ability and the level, e.g. `Fierce Aura Lv46`.
 *
 * Exported so a caller with a better name for the ability than its hrid still
 * produces the same shape of label, rather than each one inventing its own.
 *
 * @param {string} abilityHrid - The ability
 * @param {number} targetLevel - The level being saved for
 * @param {string} [name] - A nicer name for the ability, if one is known
 * @returns {string}
 */
export function abilityGoalLabel(abilityHrid, targetLevel, name = '') {
    return `${name || prettyAbility(abilityHrid)} Lv${Math.max(0, Math.floor(Number(targetLevel) || 0))}`;
}

/**
 * Whether a goal has already happened.
 *
 * A goal the character has read their way past is done, not pending: leaving it
 * on the list at full price is the same lie as pricing an unlisted item at zero,
 * pointed the other way.
 *
 * @param {{targetLevel: number}} goal - The goal
 * @param {number} currentLevel - Where the ability is now
 * @returns {boolean}
 */
export function abilityGoalReached(goal, currentLevel) {
    const target = Math.max(0, Math.floor(Number(goal?.targetLevel) || 0));
    if (!(target > 0)) return false;

    return (Number(currentLevel) || 0) >= target;
}

/**
 * The ability goals, keyed by ability hrid.
 *
 * One goal per ability rather than a list: "get Fierce Aura to 46" and "get
 * Fierce Aura to 51" are the same intention measured twice, and a list would
 * show both and total both.
 */
let goals = {};

/** The rest of the stored record — the gear side, which this module only carries */
let record = {};

/** Whether the stored record has been read since the last character change */
let loaded = false;

/**
 * One stored goal, with everything it must have and nothing it must not.
 *
 * @param {string} abilityHrid - The ability
 * @param {Object} goal - What was handed over or read back
 * @returns {Object}
 */
function normalizeGoal(abilityHrid, goal) {
    const targetLevel = Math.max(0, Math.floor(Number(goal?.targetLevel) || 0));
    // Explicitly, because `Number(null)` is 0 and an unpriced goal recorded as
    // costing nothing reports itself as already affordable
    const raw = goal?.cost === null || goal?.cost === undefined || goal?.cost === '' ? null : Number(goal.cost);
    const cost = Number.isFinite(raw) && raw >= 0 ? raw : null;

    return {
        targetLevel,
        cost,
        label: String(goal?.label || abilityGoalLabel(abilityHrid, targetLevel)),
        updatedAt: Number(goal?.updatedAt) || 0,
    };
}

/**
 * Write the record back: the gear side as the panel last left it, the goals as
 * they are now. One writer, so neither side can drop the other's edits.
 *
 * @returns {Promise<boolean>} Whether it was written
 */
async function write() {
    try {
        return await writeScoped(STORAGE_KEY, { ...record, abilities: { ...goals } }, 'settings');
    } catch (error) {
        console.error('[EquipmentSavings] Saving the savings record failed:', error);
        return false;
    }
}

/**
 * Read the whole savings record, keeping the ability goals and handing back the
 * rest.
 *
 * The goals are absorbed rather than returned because this module owns them from
 * here on; the caller gets the gear side it owns, and a record written before
 * ability goals existed simply has no `abilities` key and comes back untouched.
 *
 * @returns {Promise<Object|null>} The record without the goals, or null when
 *   nothing has been stored for this character
 */
export async function loadSavingsRecord() {
    try {
        await storage.ready;
        const saved = await readScoped(STORAGE_KEY, 'settings', null, { migrate: 'adopt' });

        const rest = { ...(saved || {}) };
        goals = {};
        for (const [abilityHrid, goal] of Object.entries(rest.abilities || {})) {
            if (!abilityHrid || !goal || typeof goal !== 'object') continue;
            goals[abilityHrid] = normalizeGoal(abilityHrid, goal);
        }
        delete rest.abilities;

        record = rest;
        loaded = true;
        return saved ? rest : null;
    } catch (error) {
        console.error('[EquipmentSavings] Reading the savings record failed:', error);
        loaded = true;
        return null;
    }
}

/**
 * Store the gear side of the record.
 *
 * @param {Object} gear - The panel's own state
 * @returns {Promise<boolean>} Whether it was written
 */
export async function saveSavingsRecord(gear) {
    record = { ...(gear || {}) };
    // Never from the caller: the goals below are the only copy that is current
    delete record.abilities;
    return write();
}

/** Read the record once, for a caller that arrived before the panel did */
async function ensureLoaded() {
    if (!loaded) await loadSavingsRecord();
}

/**
 * Save towards a level of an ability.
 *
 * Idempotent per ability: a second call for an ability already on the list
 * replaces its target and its cost, because the caller is usually a sim run that
 * has just costed the same intention more accurately than the last one did.
 *
 * @param {Object} goal - The goal
 * @param {string} goal.abilityHrid - e.g. `/abilities/fierce_aura`
 * @param {number} goal.targetLevel - The level being saved for
 * @param {number|null} goal.cost - Coins for the books, or null when unpriced
 * @param {string} [goal.label] - How it should read, e.g. `Fierce Aura Lv46`
 * @returns {Promise<void>}
 */
export async function addAbilityGoal({ abilityHrid, targetLevel, cost, label } = {}) {
    if (!abilityHrid) return;
    await ensureLoaded();

    goals[abilityHrid] = normalizeGoal(abilityHrid, { targetLevel, cost, label, updatedAt: Date.now() });
    await write();
}

/**
 * Stop saving for a level.
 * @param {string} abilityHrid - The ability
 * @returns {Promise<void>}
 */
export async function removeAbilityGoal(abilityHrid) {
    await ensureLoaded();
    if (!goals[abilityHrid]) return;

    delete goals[abilityHrid];
    await write();
}

/**
 * Every ability goal, as a list.
 * @returns {Array<{abilityHrid: string, targetLevel: number, cost: number|null, label: string}>}
 */
export function abilityGoals() {
    return Object.entries(goals).map(([abilityHrid, goal]) => ({ abilityHrid, ...goal }));
}

/**
 * One ability's goal.
 * @param {string} abilityHrid - The ability
 * @returns {Object|null}
 */
export function abilityGoalFor(abilityHrid) {
    const goal = goals[abilityHrid];
    return goal ? { abilityHrid, ...goal } : null;
}

/** @param {string} abilityHrid - Whether a level of this is being saved for */
export function hasAbilityGoal(abilityHrid) {
    return Boolean(goals[abilityHrid]);
}

/**
 * Forget every goal, for a test that must not inherit the last one.
 *
 * @param {{loaded?: boolean}} [options] - `loaded: false` also forgets that the
 *   record was ever read, which is the state a caller arriving before the panel
 *   finds — the only way to exercise the read-on-demand path
 */
export function resetAbilityGoals({ loaded: hasLoaded = true } = {}) {
    goals = {};
    record = {};
    loaded = hasLoaded;
}
