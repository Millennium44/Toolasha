/**
 * The three states of the simulator's task-damage rule.
 *
 * `taskDamage`, from task badges and trinkets, is a conditional stat: the live
 * game pays it only while the monster in front of you is one your own combat
 * tasks name. How much of that a simulation should model is a judgement call,
 * not a fact, so it is the user's to make:
 *
 * - `off` — no task damage anywhere. The default, and what a general zone sim
 *   wants: a run of a mixed zone should not quietly carry a bonus that only a
 *   fraction of its fights would really earn.
 * - `perMonster` — the bonus applies only against monsters the player's own
 *   task board names, decided per encounter and per player.
 * - `everyFight` — treat every fight as a task fight. Overstates a mixed zone,
 *   and is what you want when comparing task gear head to head, or when the
 *   caller has already narrowed the spawn table down to one task monster.
 */
export const TASK_DAMAGE_OFF = 'off';
export const TASK_DAMAGE_PER_MONSTER = 'perMonster';
export const TASK_DAMAGE_EVERY_FIGHT = 'everyFight';

/** Every valid mode, in the order the settings dropdown lists them. */
export const TASK_DAMAGE_MODES = [TASK_DAMAGE_OFF, TASK_DAMAGE_PER_MONSTER, TASK_DAMAGE_EVERY_FIGHT];

/**
 * Coerce whatever a caller passed into one of the three modes.
 *
 * Booleans are the old `isTaskFight` wire value and keep their old meaning
 * exactly: `true` was "treat every fight in this run as a task fight", so it
 * maps to `everyFight`. Anything unrecognized — including `false`, `null` and
 * an absent field — is `off`, which is both the new default and how the
 * simulator behaved before the per-monster rule existed.
 *
 * @param {string|boolean|null|undefined} value - Mode, legacy boolean, or nothing
 * @returns {string} One of the TASK_DAMAGE_* constants
 */
export function normalizeTaskDamageMode(value) {
    if (value === true) return TASK_DAMAGE_EVERY_FIGHT;
    if (typeof value === 'string' && TASK_DAMAGE_MODES.includes(value)) return value;
    return TASK_DAMAGE_OFF;
}
