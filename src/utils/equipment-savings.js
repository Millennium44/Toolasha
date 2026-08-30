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
 * ## So are rooms
 *
 * A house room level is the same shape of purchase again — a pile of materials
 * at what the market wants for them, plus the coins the level asks for outright
 * — and it is finishable without being bought in exactly the same way, by
 * building it. So rooms sit beside abilities under `houses`, keyed by room and
 * capped at the level the game stops at, and a record written before they
 * existed has no `houses` key either.
 *
 * The model is EWatch's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import dataManager from '../core/data-manager.js';
import storage from '../core/storage.js';
import { createCuratedRecord, mergeMaps } from './persisted-record.js';

/** The one record the whole feature is stored in, per character */
const STORAGE_KEY = 'equipmentSavings';

/**
 * What tells one gear target from another.
 *
 * The list used to be keyed by item hrid alone, which made "save for the +5"
 * and "save for the +8" of one sword the same entry: the second silently
 * replaced the first, and the sword you were most of the way to affording
 * stopped being on the list at all. They are two purchases at two prices, so
 * they are two entries.
 *
 * A +0 keys as the bare hrid, deliberately: every entry written before this is
 * either a +0 (already keyed that way) or carries its level in the entry, and
 * suffixing the +0s too would have turned the common case into a migration for
 * no gain. See `migrateSavingsTargets` for the other half.
 *
 * @param {string} itemHrid - The piece
 * @param {number} [enhancementLevel] - Which enhancement of it
 * @returns {string} The entry's key in the list
 */
export function targetKey(itemHrid, enhancementLevel = 0) {
    const level = Number(enhancementLevel) || 0;
    return level > 0 ? `${itemHrid}::${level}` : String(itemHrid);
}

/**
 * Fold a stored list of targets into the (item, level) key shape.
 *
 * A list written before the key carried the level has its +5 filed under the
 * bare hrid, with the 5 sitting inside the entry. That entry is moved to the
 * key it should have had, keeping everything on it — `noSell`, `craft`, `mode`
 * — because a target that loses its mode is costed along a path its owner
 * already ruled out.
 *
 * Every entry comes out carrying its own `itemHrid`, so nothing downstream has
 * to parse a key back into an item. An entry already under the new key is left
 * alone, and where both shapes somehow exist for one target the one already
 * under the right key wins: it is the one written by the newer build.
 *
 * @param {Object} targets - The list as stored
 * @returns {Object} The list, re-keyed
 */
export function migrateSavingsTargets(targets) {
    const source = targets && typeof targets === 'object' ? targets : {};
    const out = {};

    for (const [key, target] of Object.entries(source)) {
        if (!key || !target || typeof target !== 'object') continue;

        // The key is the authority on the item when it carries one, since that
        // is what the entry was filed under
        const itemHrid = String(target.itemHrid || key.split('::')[0]);
        const level = Number(target.enhancementLevel) || 0;
        const wanted = targetKey(itemHrid, level);

        // Already correctly filed, or a newer entry is: never overwrite one
        if (out[wanted] && key !== wanted) continue;
        out[wanted] = { ...target, itemHrid, enhancementLevel: level };
    }
    return out;
}

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

/** The level the game stops a house room at, and so the highest a goal can ask for */
export const MAX_HOUSE_ROOM_LEVEL = 8;

/** A name out of an hrid, for when nothing better was supplied */
const prettyName = (hrid) =>
    String(hrid || '')
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
    return goalLabel(abilityHrid, targetLevel, name);
}

/**
 * How a house room goal reads: the room and the level, e.g. `Mystical Study Lv5`.
 *
 * @param {string} houseRoomHrid - The room
 * @param {number} targetLevel - The level being saved for
 * @param {string} [name] - A nicer name for the room, if one is known
 * @returns {string}
 */
export function houseGoalLabel(houseRoomHrid, targetLevel, name = '') {
    return goalLabel(houseRoomHrid, targetLevel, name);
}

/**
 * The shape both labels take: a name and the level it is going to.
 *
 * @param {string} hrid - The ability or the room
 * @param {number} targetLevel - The level being saved for
 * @param {string} name - A nicer name, if one is known
 * @returns {string}
 */
function goalLabel(hrid, targetLevel, name) {
    return `${name || prettyName(hrid)} Lv${Math.max(0, Math.floor(Number(targetLevel) || 0))}`;
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
    return goalReached(goal, currentLevel);
}

/**
 * Whether a room has already been built to the level being saved for.
 *
 * The same test as an ability's, for the same reason: a room you built out of
 * materials you already had was never bought, and a goal that cannot notice
 * that sits on the list at full price forever.
 *
 * @param {{targetLevel: number}} goal - The goal
 * @param {number} currentLevel - Where the room is now
 * @returns {boolean}
 */
export function houseGoalReached(goal, currentLevel) {
    return goalReached(goal, currentLevel);
}

/**
 * @param {{targetLevel: number}} goal - The goal
 * @param {number} currentLevel - Where it is now
 * @returns {boolean}
 */
function goalReached(goal, currentLevel) {
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

/**
 * The house room goals, keyed by room hrid, for the same reason: one goal per
 * room, because "get the Dojo to 6" and "get the Dojo to 8" are one intention.
 */
let rooms = {};

/** The rest of the stored record — the gear side, which this module only carries */
let record = {};

/** Whether the stored record has been read since the last character change */
let loaded = false;

/**
 * Fold a stored record under the one in memory — only consulted before this
 * character's record has been read back (see `createCuratedRecord`): the gear
 * side key by key, memory winning, and the two goal maps likewise entry by
 * entry, so a goal set before the read landed is kept and no stored goal is
 * dropped.
 * @param {Object} stored - The record as read back
 * @param {Object} memory - The record as held
 * @returns {Object} The merged record
 */
function mergeRecords(stored, memory) {
    const theirs = stored && typeof stored === 'object' ? stored : {};
    const ours = memory && typeof memory === 'object' ? memory : {};
    const maps = mergeMaps();
    const merged = {
        ...maps(theirs, ours),
        abilities: maps(theirs.abilities, ours.abilities),
        houses: maps(theirs.houses, ours.houses),
    };

    // The gear targets are merged per target rather than taken wholesale from
    // whichever side had one, and both sides are re-keyed first: a record
    // written by an older build files a +5 under the bare hrid, and folding
    // that in unchanged would put a second entry for the same target beside
    // the migrated one — the very duplicate the key change exists to prevent
    if (theirs.targets || ours.targets) {
        merged.targets = maps(migrateSavingsTargets(theirs.targets), migrateSavingsTargets(ours.targets));
    }
    return merged;
}

/**
 * The record as stored, per character — gear, abilities and rooms in one.
 *
 * A curated record: a read that cannot be made leaves what is in hand rather
 * than blanking it, no write goes out over a store that could not be read
 * first, and once this character's record has been read back what is held is
 * the record and a removed goal stays removed.
 */
const savings = createCuratedRecord({
    base: STORAGE_KEY,
    store: 'settings',
    empty: () => ({}),
    merge: mergeRecords,
    migrate: 'adopt',
    label: 'EquipmentSavings',
});

/** Whose record `goals`, `rooms` and `record` hold, so a switch never mixes two */
let owner = null;

/** @returns {Object} The whole record as held, ready to store */
function held() {
    return { ...record, abilities: { ...goals }, houses: { ...rooms } };
}

/**
 * One stored goal, with everything it must have and nothing it must not.
 *
 * @param {string} hrid - The ability or the room the goal is about
 * @param {Object} goal - What was handed over or read back
 * @param {number} [cap] - The highest level the game allows, when there is one
 * @returns {Object}
 */
function normalizeGoal(hrid, goal, cap = 0) {
    let targetLevel = Math.max(0, Math.floor(Number(goal?.targetLevel) || 0));
    // A goal above what the game allows is not a goal, it is a typo — and left
    // alone it would be costed for levels that cannot be built and never reached
    if (cap > 0) targetLevel = Math.min(cap, targetLevel);

    // Explicitly, because `Number(null)` is 0 and an unpriced goal recorded as
    // costing nothing reports itself as already affordable
    const raw = goal?.cost === null || goal?.cost === undefined || goal?.cost === '' ? null : Number(goal.cost);
    const cost = Number.isFinite(raw) && raw >= 0 ? raw : null;

    return {
        targetLevel,
        cost,
        label: String(goal?.label || goalLabel(hrid, targetLevel, '')),
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
        savings.set(held());
        return await savings.save();
    } catch (error) {
        console.error('[EquipmentSavings] Saving the savings record failed:', error);
        return false;
    }
}

/**
 * Bumped on every call. A character switch fires `character_switched` (and
 * `character_initialized`), each of which calls this — and if two switches
 * happen close enough together (three ironcows tabbed through in a hurry),
 * the first call can still be waiting on `storage.tryGet` when the second one
 * starts. Storage's own generation counter (`persisted-record.js`) keeps that
 * race from corrupting what is written to IndexedDB, but it says nothing
 * about the plain module-scope `goals`/`rooms`/`record` below: without a
 * check here, whichever call happened to finish LAST would win regardless of
 * which character it was for, and the first character's ability and house
 * goals could land — silently — on the second character's screen. Only the
 * call with the highest token when it finishes is the most recently
 * requested one, and only it may commit.
 */
let loadCall = 0;

/**
 * Read the whole savings record, keeping the level goals and handing back the
 * rest.
 *
 * The goals are absorbed rather than returned because this module owns them from
 * here on; the caller gets the gear side it owns, and a record written before
 * ability or house goals existed simply has no `abilities` or `houses` key and
 * comes back untouched.
 *
 * When the read cannot be made, what is held for this character stands — the
 * goals are not blanked, and the next write merges rather than overwrites —
 * unless it is another character's, which must not stand in for this one's.
 *
 * @returns {Promise<Object|null|undefined>} The record without the goals,
 *   `null` when nothing has been stored for this character, or `undefined`
 *   when a later call for a different character has since superseded this
 *   one — in which case nothing here was touched and a caller should do
 *   nothing at all, rather than treat it as "nothing stored"
 */
export async function loadSavingsRecord() {
    const call = ++loadCall;
    try {
        await storage.ready;
        const who = dataManager.getCurrentCharacterId() || null;
        const previous = who === owner ? held() : null;
        owner = who;
        savings.reset();
        const readable = await savings.load();

        // A newer call has since started (and may already have committed its
        // own goals/gear below) for whichever character is now selected.
        // Committing this stale read on top of it would swap that data back
        // out from under the character actually on screen.
        if (call !== loadCall) return undefined;

        if (!readable && previous) savings.set(previous);
        const saved = readable || previous ? savings.get() : null;

        const rest = { ...(saved || {}) };
        goals = {};
        for (const [abilityHrid, goal] of Object.entries(rest.abilities || {})) {
            if (!abilityHrid || !goal || typeof goal !== 'object') continue;
            goals[abilityHrid] = normalizeGoal(abilityHrid, goal);
        }
        delete rest.abilities;

        rooms = {};
        for (const [houseRoomHrid, goal] of Object.entries(rest.houses || {})) {
            if (!houseRoomHrid || !goal || typeof goal !== 'object') continue;
            rooms[houseRoomHrid] = normalizeGoal(houseRoomHrid, goal, MAX_HOUSE_ROOM_LEVEL);
        }
        delete rest.houses;

        record = rest;
        // A read that could not be made is not a read; the next caller tries again
        loaded = readable;
        const nothing =
            Object.keys(rest).length === 0 && Object.keys(goals).length === 0 && Object.keys(rooms).length === 0;
        return nothing ? null : rest;
    } catch (error) {
        console.error('[EquipmentSavings] Reading the savings record failed:', error);
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
    delete record.houses;
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
    savings.reset();
}

/**
 * Save towards a level of a house room.
 *
 * Idempotent per room, as an ability goal is per ability: a second call for a
 * room already on the list replaces its target and its cost rather than putting
 * a second guess beside the first, because the caller is usually something that
 * has just costed the same intention more accurately.
 *
 * @param {Object} goal - The goal
 * @param {string} goal.houseRoomHrid - e.g. `/house_rooms/mystical_study`
 * @param {number} goal.targetLevel - The level being saved for, capped at the game's own
 * @param {number|null} goal.cost - Coins for the build, or null when unpriced
 * @param {string} [goal.label] - How it should read, e.g. `Mystical Study Lv5`
 * @returns {Promise<void>}
 */
export async function addHouseGoal({ houseRoomHrid, targetLevel, cost, label } = {}) {
    if (!houseRoomHrid) return;
    await ensureLoaded();

    rooms[houseRoomHrid] = normalizeGoal(
        houseRoomHrid,
        { targetLevel, cost, label, updatedAt: Date.now() },
        MAX_HOUSE_ROOM_LEVEL
    );
    await write();
}

/**
 * Stop saving for a room level.
 * @param {string} houseRoomHrid - The room
 * @returns {Promise<void>}
 */
export async function removeHouseGoal(houseRoomHrid) {
    await ensureLoaded();
    if (!rooms[houseRoomHrid]) return;

    delete rooms[houseRoomHrid];
    await write();
}

/**
 * Every house room goal, as a list.
 * @returns {Array<{houseRoomHrid: string, targetLevel: number, cost: number|null, label: string}>}
 */
export function houseGoals() {
    return Object.entries(rooms).map(([houseRoomHrid, goal]) => ({ houseRoomHrid, ...goal }));
}

/**
 * One room's goal.
 * @param {string} houseRoomHrid - The room
 * @returns {Object|null}
 */
export function houseGoalFor(houseRoomHrid) {
    const goal = rooms[houseRoomHrid];
    return goal ? { houseRoomHrid, ...goal } : null;
}

/** @param {string} houseRoomHrid - Whether a level of this room is being saved for */
export function hasHouseGoal(houseRoomHrid) {
    return Boolean(rooms[houseRoomHrid]);
}

/**
 * Forget every room goal, for a test that must not inherit the last one.
 *
 * @param {{loaded?: boolean}} [options] - `loaded: false` also forgets that the
 *   record was ever read, as `resetAbilityGoals` does
 */
export function resetHouseGoals({ loaded: hasLoaded = true } = {}) {
    rooms = {};
    record = {};
    loaded = hasLoaded;
    savings.reset();
}

/** @returns {Promise<*>} The pending writes, for tests and shutdown */
export function flushSavingsWrites() {
    return savings.flushed();
}
