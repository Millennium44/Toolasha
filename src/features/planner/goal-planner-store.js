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

import { readScoped, writeScoped } from '../../utils/character-key.js';
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
 * This character's goals.
 *
 * Anything that no longer normalises — an item removed from the game, a goal
 * written by a newer version — is dropped on read rather than carried around as
 * a row that cannot be planned.
 *
 * @returns {Promise<Array<Object>>} Normalised goals, oldest first
 */
export async function loadGoals() {
    try {
        // 'discard' rather than 'adopt': there is no legacy global list to
        // inherit, and if one ever appears it belongs to whoever wrote it
        const stored = await readScoped(GOALS_KEY, 'settings', [], { migrate: 'discard' });
        if (!Array.isArray(stored)) return [];
        return stored.map((goal) => normalizeGoal(goal)).filter(Boolean);
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
    const clean = (Array.isArray(goals) ? goals : [])
        .map((goal) => normalizeGoal(goal))
        .filter(Boolean)
        .slice(0, MAX_GOALS);
    try {
        await writeScoped(GOALS_KEY, clean, 'settings');
    } catch (error) {
        console.error('[GoalPlanner] Saving goals failed:', error);
    }
    return clean;
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

    const goals = await loadGoals();
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
    const goals = await loadGoals();
    return saveGoals(goals.filter((goal) => goal.id !== goalId));
}

/**
 * The last plans computed, for drawing before a refresh finishes.
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
 * @param {Array<Object>} plans - Plans from `planGoals`
 * @returns {Promise<void>}
 */
export async function saveSnapshot(plans) {
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
    const current = await loadCombatGear();
    const next = { ...current, ...(patch || {}) };
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
