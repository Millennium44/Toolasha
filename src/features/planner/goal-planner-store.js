/**
 * Where the planner's goals live.
 *
 * Goals are per character and nothing else would do: "Enhancing 110" means a
 * different amount of work to the main than to the iron cow, and a shared list
 * would show each of them the other's ambitions. Every key goes through
 * {@link characterKey}'s helpers rather than being written bare, which is the
 * one thing that keeps that true.
 *
 * The *plans* are cached rather than stored in the sense that matters: a plan
 * is a function of goals and the market, and both move. The snapshot exists so
 * the panel has something to draw the instant it opens, and is replaced the
 * moment a refresh finishes. Nothing is ever read back as fact — the progress
 * you see after a reload is recomputed against the character as they are now.
 */

import dataManager from '../../core/data-manager.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';
import { createCuratedRecord, mergeById } from '../../utils/persisted-record.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { normalizeGoal } from './goal-planner.js';

/** Unscoped key for the goal list; the real key carries the character id */
export const GOALS_KEY = 'goalPlannerGoals';
/** Unscoped key for the last computed plans */
export const SNAPSHOT_KEY = 'goalPlannerSnapshot';
/** Unscoped key for the combat loadout the all-zones run is judged against */
export const COMBAT_GEAR_KEY = 'goalPlannerCombatGear';

/** Nobody needs a hundred goals, and a runaway list is a slow panel */
const MAX_GOALS = 40;

/**
 * Two devices' goal lists as one.
 *
 * The list is authored a goal at a time, and a whole-key sync write is the
 * data-loss case: a goal added on the phone this morning and one added on the
 * desktop this afternoon are two goals, and writing the key whole leaves
 * whichever list the payload happened to carry. So the union by goal id, which
 * is the same identity {@link goalsRecord}'s own `mergeById` merge uses for two
 * tabs on one machine.
 *
 * A goal is written once and never edited — `addGoal` and `removeGoal` are the
 * whole of the mutation, and `createdAt` is stamped at creation and never
 * moved — so two copies of one id are the same goal, not two versions of it.
 * The rule is stated anyway, because it is what an id collision *would* mean:
 * the later `createdAt` wins, and a tie or a missing stamp resolves to the
 * incoming copy on the registry's `(local, incoming)` convention.
 *
 * **A removal can come back.** The list keeps no tombstones, so a goal deleted
 * on one device is indistinguishable from one the other device has not seen
 * yet, and the union keeps it — re-deleting costs one click, while losing an
 * afternoon of goals to a pull does not.
 *
 * The {@link MAX_GOALS} cap is re-applied to the union the way `saveGoals`
 * applies it: the first forty, so the goals that have been on the list longest
 * are the ones that survive rather than whichever device pushed last.
 *
 * @param {Array<Object>|*} local - This device's goals
 * @param {Array<Object>|*} incoming - The downloaded goals
 * @returns {Array<Object>} The union, oldest first
 */
export function mergeGoalLists(local, incoming) {
    const byId = new Map();
    for (const goal of Array.isArray(local) ? local : []) {
        if (goal?.id) byId.set(goal.id, goal);
    }
    for (const goal of Array.isArray(incoming) ? incoming : []) {
        if (!goal?.id) continue;
        const held = byId.get(goal.id);
        const mine = Number(held?.createdAt);
        const theirs = Number(goal?.createdAt);
        const keepMine = held && Number.isFinite(mine) && (!Number.isFinite(theirs) || mine > theirs);
        byId.set(goal.id, keepMine ? held : goal);
    }
    // Sorted before the cap, and by the stamp rather than by which side the
    // goal arrived on. The union's natural order is "everything local had,
    // then everything only incoming had", so cutting its tail cut exactly the
    // goals the pull brought — and both sides are already capped by
    // `saveGoals`, which makes "local is full" the ordinary case. A device at
    // the cap therefore discarded the whole of the other device's list, and
    // the two merge directions kept different sets.
    //
    // A goal written before `createdAt` existed sorts as the oldest there is,
    // which is what it is.
    const stamp = (goal) => (Number.isFinite(Number(goal?.createdAt)) ? Number(goal.createdAt) : 0);
    return [...byId.values()].sort((a, b) => stamp(a) - stamp(b)).slice(0, MAX_GOALS);
}

/*
 * Registered so a cross-device sync PULL combines the goal list instead of
 * overwriting it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: 'settings',
    // `goalPlannerGoals` and `goalPlannerGoals_<charId>`. The sibling keys
    // (`goalPlannerSnapshot`, `goalPlannerCombatGear`) are caches and derived
    // state, are written whole by the feature itself, and do not start with
    // this base's own underscore — so they stay out of this registration.
    base: GOALS_KEY,
    merge: mergeGoalLists,
    label: 'Goal planner goals',
});

/**
 * The goal list as stored, per character.
 *
 * Goals are authored, so this is a curated record: a read that cannot be made
 * leaves the list in hand rather than blanking it — the accident this guards
 * against is `addGoal` reading nothing, appending one goal and writing a list
 * of one over the list of twenty — and no write goes out over a store that
 * could not be read first. Before the list has been read back a save folds the
 * stored list under memory by goal id; once it has, what is in memory is the
 * list and a removal sticks.
 *
 * 'discard' rather than 'adopt': there is no legacy global list to inherit,
 * and if one ever appears it belongs to whoever wrote it.
 */
const goalsRecord = createCuratedRecord({
    base: GOALS_KEY,
    store: 'settings',
    empty: () => [],
    merge: mergeById((goal) => goal?.id),
    migrate: 'discard',
    label: 'GoalPlanner',
});

/** Whose goals the record holds, so a switch never shows one character the other's */
let goalsOwner = null;

/**
 * Point the record at the character logged in now: a different one forgets
 * the list in hand (without writing), so nothing of theirs is folded into
 * this one's.
 * @returns {void}
 */
function claimGoals() {
    const who = dataManager.getCurrentCharacterId() || null;
    if (who === goalsOwner) return;
    goalsRecord.reset();
    goalsOwner = who;
}

/**
 * Who the goals, the snapshot and the gear record belong to.
 * @returns {string|null} Character id, or null before login
 */
function currentOwner() {
    return dataManager.getCurrentCharacterId() || null;
}

/**
 * @param {*} list - Whatever is in the record
 * @returns {Array<Object>} Normalised goals, oldest first
 */
function cleanGoals(list) {
    return (Array.isArray(list) ? list : []).map((goal) => normalizeGoal(goal)).filter(Boolean);
}

/**
 * This character's goals.
 *
 * Read back fresh when storage can be read; when it cannot, the list last held
 * for this character stands (empty when there is none) rather than an empty
 * list that the next save would write over the stored one.
 *
 * Anything that no longer normalises — an item removed from the game, a goal
 * written by a newer version — is dropped on read rather than carried around as
 * a row that cannot be planned.
 *
 * @returns {Promise<Array<Object>>} Normalised goals, oldest first
 */
export async function loadGoals() {
    try {
        claimGoals();
        const previous = goalsRecord.get();
        goalsRecord.set([]);
        const readable = await goalsRecord.load();
        if (!readable) goalsRecord.set(previous);
        return cleanGoals(goalsRecord.get());
    } catch (error) {
        console.error('[GoalPlanner] Loading goals failed:', error);
        return [];
    }
}

/**
 * Replace this character's goal list.
 * @param {Array<Object>} goals - Goals to keep
 * @returns {Promise<Array<Object>>} What was actually written
 */
export async function saveGoals(goals) {
    const clean = cleanGoals(goals).slice(0, MAX_GOALS);
    try {
        claimGoals();
        goalsRecord.set(clean);
        await goalsRecord.save();
    } catch (error) {
        console.error('[GoalPlanner] Saving goals failed:', error);
    }
    return clean;
}

/** @returns {Promise<*>} The pending goal writes, for tests and shutdown */
export function flushGoalWrites() {
    return goalsRecord.flushed();
}

/**
 * Add a goal, ignoring one that is already on the list.
 *
 * "Already on the list" is by content rather than by id, because the second
 * press of Add is a mistake and not a second goal.
 *
 * @param {Object} raw - A goal from the creation form
 * @returns {Promise<Array<Object>>} The new goal list
 */
export async function addGoal(raw) {
    const goal = normalizeGoal(raw);
    if (!goal) return loadGoals();

    // Whose list this is, fixed before the read. `saveGoals` calls
    // `claimGoals()` itself, which points the record at whoever is current
    // *now* — so a switch inside the read would have it write the departing
    // character's list, plus this goal, into the arriving character's record,
    // where `mergeById` folds it into their stored goals and the `MAX_GOALS`
    // cap then drops their newest ones to make room.
    const owner = currentOwner();
    const goals = await loadGoals();
    if (currentOwner() !== owner) return goals;

    const key = (entry) => JSON.stringify({ ...entry, id: null, createdAt: null });
    if (goals.some((existing) => key(existing) === key(goal))) return goals;

    return saveGoals([...goals, goal]);
}

/**
 * Drop a goal.
 * @param {string} goalId - The goal's id
 * @returns {Promise<Array<Object>>} The new goal list
 */
export async function removeGoal(goalId) {
    // Same window as addGoal: the read is one character's, the write would be
    // whoever is current when it lands
    const owner = currentOwner();
    const goals = await loadGoals();
    if (currentOwner() !== owner) return goals;

    return saveGoals(goals.filter((goal) => goal.id !== goalId));
}

/**
 * The last plans computed, for drawing before a refresh finishes.
 *
 * Written whole and on purpose: the snapshot is one derived blob, replaced
 * the moment a refresh finishes and never read back as fact, so a plain
 * overwrite is the right write for it.
 * @returns {Promise<{plans: Array<Object>, computedAt: number}|null>} The snapshot
 */
export async function loadSnapshot() {
    try {
        const stored = await readScoped(SNAPSHOT_KEY, 'settings', null, { migrate: 'discard' });
        if (!stored || !Array.isArray(stored.plans)) return null;
        return stored;
    } catch (error) {
        console.error('[GoalPlanner] Loading the last plans failed:', error);
        return null;
    }
}

/**
 * Remember the plans just computed.
 *
 * The plans were computed against one character's gold, gear and rates, and the
 * pricing that produced them takes seconds. Pass `expectedOwner` from whoever
 * the caller started planning for and the write is refused rather than filed
 * under whoever is logged in when it finishes.
 *
 * @param {Array<Object>} plans - Plans from `planGoals`
 * @param {string|null} [expectedOwner] - Who these plans are for; omitted skips the check
 * @returns {Promise<void>}
 */
export async function saveSnapshot(plans, expectedOwner) {
    if (expectedOwner !== undefined && currentOwner() !== expectedOwner) return;
    try {
        await writeScoped(SNAPSHOT_KEY, { plans: Array.isArray(plans) ? plans : [], computedAt: Date.now() });
    } catch (error) {
        console.error('[GoalPlanner] Saving the last plans failed:', error);
    }
}

/**
 * What the combat rates are being judged against.
 *
 * Two things, and they are stored together because neither is worth a key of
 * its own:
 *
 * - `preferred` — which combat loadout the player picked, when they have more
 *   than one and none of them is the default. A choice, so it is remembered.
 * - `baseline` — `{savedAt, signature, name}`: the combat loadout as it stood
 *   when the planner first saw the all-zones run saved at `savedAt`. This is
 *   what "your gear has changed since the run" is measured against, because the
 *   run itself keeps only an opaque digest of the gear it was simulated in and
 *   the function that produced it lives in another bundle.
 *
 * @returns {Promise<{preferred: string|null, baseline: Object|null}>} The record
 */
export async function loadCombatGear() {
    try {
        const stored = await readScoped(COMBAT_GEAR_KEY, 'settings', null, { migrate: 'discard' });
        return {
            preferred: typeof stored?.preferred === 'string' ? stored.preferred : null,
            baseline: stored?.baseline && Number.isFinite(stored.baseline.savedAt) ? stored.baseline : null,
        };
    } catch (error) {
        console.error('[GoalPlanner] Loading the combat gear record failed:', error);
        return { preferred: null, baseline: null };
    }
}

/**
 * Update part of the combat gear record, leaving the rest alone.
 * @param {Object} patch - `{preferred}` and/or `{baseline}`
 * @returns {Promise<{preferred: string|null, baseline: Object|null}>} The new record
 */
export async function saveCombatGear(patch) {
    // A read-modify-write across an await: `writeScoped` resolves its key when
    // it runs, so a switch inside the read files the departing character's
    // preferred loadout and baseline under the arriving character's key
    const owner = currentOwner();
    const current = await loadCombatGear();
    const next = { ...current, ...(patch || {}) };
    if (currentOwner() !== owner) return next;

    try {
        await writeScoped(COMBAT_GEAR_KEY, next, 'settings');
    } catch (error) {
        console.error('[GoalPlanner] Saving the combat gear record failed:', error);
    }
    return next;
}

export default {
    GOALS_KEY,
    SNAPSHOT_KEY,
    COMBAT_GEAR_KEY,
    loadGoals,
    saveGoals,
    addGoal,
    removeGoal,
    loadSnapshot,
    saveSnapshot,
    loadCombatGear,
    saveCombatGear,
};
