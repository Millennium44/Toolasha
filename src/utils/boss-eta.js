/**
 * Boss battle ETA
 *
 * A combat zone with a boss cycles bosses on a fixed cadence: every Nth
 * battle is the boss (`battlesPerBoss`, read from the zone's
 * `combatZoneInfo.fightInfo` — see `combat-sim/engine/zone.js`, whose
 * `getRandomEncounter()` resets its kill counter to 1 and spawns the boss the
 * moment that counter hits `battlesPerBoss`). Battle numbers are a running
 * total, not a per-cycle count, so battle #323 at `battlesPerBoss` 10 is not
 * "3 into this cycle" by itself — it needs the same arithmetic every reader of
 * this module gets for free: the next boss is the next multiple of 10 at or
 * above 323, which is 330.
 *
 * ## Whose question this answers
 *
 * "When am I free to start another action" — which is when the boss *dies*,
 * not when it starts fighting. So the estimate spans the unfinished remainder
 * of the current battle plus every battle up to and including the boss fight
 * itself. There is no elapsed-time field on a battle in progress, so its
 * remainder is approximated as one more full average battle — the same
 * approximation used for every other battle in the estimate. That means the
 * "boss now" edge (the running battle already IS the boss) is not a zero: it
 * is one average battle, because the boss is still alive.
 */

import { formatEta } from './progress-eta.js';

/** Keep the last this-many inter-battle gaps for the rolling average */
export const DEFAULT_MAX_SAMPLES = 15;

/**
 * Above this a gap is not a slow battle, it is a disconnect or an AFK — the
 * player left the loop entirely and came back. Ordinary battles across every
 * zone run in seconds; two minutes gives a labyrinth-tier fight or a laggy
 * client generous room without also swallowing a real outage.
 */
export const DEFAULT_MAX_GAP_MS = 2 * 60 * 1000;

/**
 * Where the current battle sits in the boss cycle.
 *
 * @param {number} battleNumber - The running battle number (`battleId` off `new_battle`)
 * @param {number} battlesPerBoss - N, the zone's boss cadence
 * @returns {{battlesRemaining: number, bossBattleNumber: number, isBossNow: boolean}|null}
 *   `battlesRemaining` counts full battles strictly after the current one, up
 *   to and including the boss — 0 when the current battle already is the
 *   boss. Null when either input is not a usable positive number.
 */
export function battlesToBoss(battleNumber, battlesPerBoss) {
    const n = Number(battlesPerBoss);
    const b = Number(battleNumber);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (!Number.isFinite(b) || b <= 0) return null;

    const remainder = b % n;
    const isBossNow = remainder === 0;
    const battlesRemaining = isBossNow ? 0 : n - remainder;

    return { battlesRemaining, bossBattleNumber: b + battlesRemaining, isBossNow };
}

/**
 * Add one inter-battle gap to a rolling sample window, dropping implausible
 * outliers rather than letting one disconnect wreck the average.
 *
 * @param {Array<number>} samples - Existing gaps, oldest first
 * @param {number} gapMs - The new gap
 * @param {Object} [options]
 * @param {number} [options.maxSamples] - Window size
 * @param {number} [options.maxGapMs] - Gaps above this are dropped, not averaged
 * @returns {Array<number>} A new array — the input is never mutated
 */
export function addBattleGap(samples, gapMs, { maxSamples = DEFAULT_MAX_SAMPLES, maxGapMs = DEFAULT_MAX_GAP_MS } = {}) {
    const existing = Array.isArray(samples) ? samples : [];
    if (!Number.isFinite(gapMs) || gapMs <= 0 || gapMs > maxGapMs) return existing;

    const next = [...existing, gapMs];
    return next.length > maxSamples ? next.slice(next.length - maxSamples) : next;
}

/**
 * The rolling average battle duration.
 *
 * @param {Array<number>} samples - From `addBattleGap`
 * @returns {number|null} Milliseconds, or null with no samples yet
 */
export function averageBattleMs(samples) {
    if (!Array.isArray(samples) || samples.length === 0) return null;
    return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

/**
 * Milliseconds until the boss battle is defeated — not merely reached.
 *
 * @param {number} battlesRemaining - From `battlesToBoss`
 * @param {number|null} avgBattleMs - Rolling average battle duration, or null
 * @returns {number|null} Null without an average yet
 */
export function bossEtaMs(battlesRemaining, avgBattleMs) {
    if (!Number.isFinite(avgBattleMs) || avgBattleMs <= 0) return null;
    if (!Number.isFinite(battlesRemaining) || battlesRemaining < 0) return null;
    // +1: the unfinished remainder of the current battle, approximated as one
    // more full average battle (see module doc).
    return (battlesRemaining + 1) * avgBattleMs;
}

/**
 * The header chip text.
 *
 * @param {{battlesRemaining: number, isBossNow: boolean}|null} info - From `battlesToBoss`
 * @param {number|null} avgBattleMs - Rolling average battle duration, or null
 *   before enough samples exist — the count alone is shown until then
 * @returns {string} Empty when `info` is null
 */
export function formatBossEta(info, avgBattleMs) {
    if (!info) return '';
    const { battlesRemaining, isBossNow } = info;
    const countText = isBossNow ? 'boss now' : `${battlesRemaining} to boss`;

    const eta = bossEtaMs(battlesRemaining, avgBattleMs);
    if (eta === null) return countText;

    return `${countText} · ~${formatEta(eta)} left`;
}

/**
 * A tooltip spelling out the arithmetic behind `formatBossEta`.
 *
 * @param {{battlesRemaining: number, bossBattleNumber: number, isBossNow: boolean}|null} info
 * @param {number|null} avgBattleMs
 * @returns {string} Empty when `info` is null
 */
export function bossEtaTooltip(info, avgBattleMs) {
    if (!info) return '';
    const { battlesRemaining, bossBattleNumber, isBossNow } = info;

    const lines = [
        isBossNow
            ? `This battle is the boss (battle #${bossBattleNumber}).`
            : `Boss is battle #${bossBattleNumber} (${battlesRemaining} more battle${
                  battlesRemaining === 1 ? '' : 's'
              } first).`,
    ];

    if (Number.isFinite(avgBattleMs) && avgBattleMs > 0) {
        const battles = battlesRemaining + 1;
        lines.push(
            `~${formatEta(avgBattleMs)}/battle average × ${battles} battle${
                battles === 1 ? '' : 's'
            } (including the current one) ≈ time until the boss is defeated.`
        );
    } else {
        lines.push('Not enough battles tracked yet for a time estimate.');
    }

    return lines.join(' ');
}
