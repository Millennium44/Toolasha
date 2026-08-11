/**
 * Labyrinth Fight Log
 *
 * Turns the tail end of a labyrinth fight into a recorded attempt.
 *
 * A skilling room announces every action it takes, so its log writes itself. A
 * combat room announces nothing: `battle_updated` pushes both sides' health
 * three times a second and then simply stops, and the tick carrying the killing
 * blow is as likely to be missing as present. So the outcome is not read off
 * the last tick alone — the floor is asked whether the room ended up cleared,
 * and the tick only supplies the detail the floor cannot: how close it was.
 *
 * That detail is the point of logging combat at all. "Lost" is one bit; "lost
 * with the monster on 4%" and "lost with it on 71%" are different problems, and
 * the first is worth another attempt while the second is worth a different
 * loadout.
 *
 * Pure: fight state in, attempt out.
 */

import { FIGHT_TIMEOUT_SECONDS } from './labyrinth-live-combat.js';

/**
 * How near the limit a fight has to run before an undecided one is called a
 * timeout. Ticks stop a beat before the room does, so demanding the full 120
 * seconds would file every timeout as unknown.
 */
export const TIMEOUT_GRACE_SECONDS = 5;

/** Health below this is zero — fractions arrive as divisions, not integers */
const DEAD = 1e-6;

/**
 * Classify one attempt at a combat room.
 *
 * `cleared` is the floor's word and outranks everything: a monster whose death
 * tick never arrived still shows on screen with health left, and only the room
 * knows better. It is deliberately three-valued — true, false, and unknown —
 * because "the floor has not said yet" is not the same as "the floor said no",
 * and treating it as one would file every win as a timeout.
 *
 * @param {Object} fight - Last known state of the fight
 * @param {number} fight.monsterHpFraction - Monster health remaining, 0..1
 * @param {number} fight.playerHpFraction - Yours, 0..1
 * @param {number} fight.seconds - How long the fight ran
 * @param {boolean} [fight.cleared] - Whether the room ended up cleared
 * @param {number} [timeoutSeconds] - Room timer, for the rare non-120s case
 * @returns {{outcome: string, text: string, seconds: number, monsterHpLeft: number, playerHpLeft: number}}
 */
export function classifyFight(fight, timeoutSeconds = FIGHT_TIMEOUT_SECONDS) {
    const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    const monsterHpLeft = clamp(fight?.monsterHpFraction);
    const playerHpLeft = clamp(fight?.playerHpFraction);
    const seconds = Math.max(0, Number(fight?.seconds) || 0);

    let outcome = 'unknown';
    if (fight?.cleared === true || monsterHpLeft <= DEAD) outcome = 'clear';
    else if (playerHpLeft <= DEAD) outcome = 'death';
    else if (seconds >= timeoutSeconds - TIMEOUT_GRACE_SECONDS) outcome = 'timeout';

    // A win is worth its duration — the number that says whether the room is
    // comfortable or a coin toss. A loss is worth the margin instead.
    const text = outcome === 'clear' ? `${Math.round(seconds)}s` : `${Math.round(monsterHpLeft * 100)}%`;

    return { outcome, text, seconds, monsterHpLeft, playerHpLeft };
}

/** A monster at or above this fraction of its maximum has just spawned, not healed */
const FRESH_MONSTER_HP_FRACTION = 0.95;
/** ...and a spawn is a jump to full from below this — the low a beaten monster sat at */
const REVIVED_FROM_HP_FRACTION = 0.9;

/**
 * Whether a `battle_updated` tick starts a new fight rather than continuing one.
 *
 * The labyrinth reuses one battleId across every retry of a room, so that alone
 * cannot tell a fresh fight from the next tick of the current one. Three things
 * can: a battleId that changed, a monster whose maximum health changed, and the
 * player's attack counter going down — only a fresh battle resets it.
 *
 * A fourth signal — the monster's health going up — catches a retry the others
 * miss, but "health went up" is not the same as "a fresh monster spawned". A
 * monster with life drain, guardian aura or a heal nudges its own health up
 * mid-fight, and reading every such nudge as a new fight splits one attempt into
 * several, each starting at whatever low health the split happened to land on. So
 * the health signal counts only the jump a spawn makes — from the low a beaten
 * monster sat at, back to full — not the small bump a self-heal gives.
 *
 * @param {Object|null} prev - The fight in progress: `{battleId, monsterMaxHp,
 *   lastMonsterHp, lastAtkCounter}`, or null when none is being watched
 * @param {Object} curr - This tick: `{battleId, monsterMaxHp, monsterHp, atkCounter}`
 * @returns {boolean}
 */
export function isFreshLabyrinthFight(prev, curr) {
    if (!prev) return true;
    if (prev.battleId !== curr.battleId) return true;
    if (prev.monsterMaxHp !== curr.monsterMaxHp) return true;
    if (curr.atkCounter < prev.lastAtkCounter) return true;

    const max = curr.monsterMaxHp || 0;
    if (
        max > 0 &&
        curr.monsterHp >= max * FRESH_MONSTER_HP_FRACTION &&
        prev.lastMonsterHp < max * REVIVED_FROM_HP_FRACTION
    ) {
        return true;
    }
    return false;
}

/**
 * Add up a room's attempts.
 *
 * Attempts of unknown outcome are left out of the count rather than assumed
 * lost. A fight the log lost track of is not evidence against the sim, and
 * quietly filing it as a defeat would make the measured rate drift down every
 * time the page was refreshed mid-room.
 *
 * @param {Array<Object>} attempts - Classified attempts
 * @returns {{total: number, clears: number, deaths: number, timeouts: number, unknown: number, rate: number|null}}
 */
export function fightTally(attempts) {
    const list = Array.isArray(attempts) ? attempts : [];
    const count = (outcome) => list.filter((attempt) => attempt?.outcome === outcome).length;

    const clears = count('clear');
    const deaths = count('death');
    const timeouts = count('timeout');
    const total = clears + deaths + timeouts;

    return {
        total,
        clears,
        deaths,
        timeouts,
        unknown: count('unknown'),
        rate: total > 0 ? clears / total : null,
    };
}

/**
 * Why a room is being lost, when it is.
 *
 * Deaths and timeouts fail the same room for opposite reasons — one says you
 * cannot survive the fight, the other says you cannot finish it — and the fix
 * for each makes the other worse. Worth naming, because the clear rate alone
 * cannot distinguish them.
 *
 * @param {Object} tally - Output of fightTally
 * @returns {string} Empty when there is nothing to explain
 */
export function failureShape(tally) {
    const losses = (tally?.deaths || 0) + (tally?.timeouts || 0);
    if (!losses) return '';
    if (!tally.timeouts) return 'dying';
    if (!tally.deaths) return 'running out of time';
    return `${tally.deaths} died, ${tally.timeouts} timed out`;
}
