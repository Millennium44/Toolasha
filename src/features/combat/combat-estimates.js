/**
 * Combat estimates
 *
 * The arithmetic behind the extra portrait-meter lines, kept pure so every one
 * of them is testable without a battle panel.
 *
 * The rule shared by everything here: **never invent a number**. Each helper
 * returns `null` when its inputs cannot honestly support an estimate — a
 * missing health bar, a rate that has not existed long enough to divide by, a
 * hit count too small to be a measurement — and the caller renders a dash
 * rather than a guess. Null is a different thing from zero and must never be
 * drawn as one.
 */

import { formatWithSeparator } from '../../utils/formatters.js';

/**
 * Below this many swings a hit rate is one fight's luck, not a measurement.
 */
export const MIN_SWINGS_FOR_ACCURACY = 20;

/**
 * A mana runway longer than this is not worth a line: "empty in four minutes"
 * is not actionable mid-fight, and drawing it would bury the readings that are.
 */
export const MANA_RUNWAY_SHOW_SECONDS = 60;

/**
 * The mana series must span at least this long before a drain rate is claimed.
 * A shorter window reads one cast as a trend.
 */
export const MANA_RUNWAY_MIN_SPAN_MS = 10_000;

/** How much of the mana series is kept — the window the drain is measured over */
export const MANA_RUNWAY_WINDOW_MS = 90_000;

/** An enrage countdown under this many seconds turns amber */
export const ENRAGE_WARN_SECONDS = 30;

/**
 * A duration the width of a meter line: `8s` under a minute, `1:42` over it.
 *
 * @param {number} seconds - A non-negative duration
 * @returns {string}
 */
export function formatSecondsShort(seconds) {
    const whole = Math.max(0, Math.round(seconds));
    if (whole < 60) return `${whole}s`;

    const minutes = Math.floor(whole / 60);
    const rest = whole % 60;
    return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * How long an enemy has left, at the party's measured rate on it.
 *
 * @param {number|null} hp - Its remaining health, or null when never reported
 * @param {number|null} dps - The party's rate on that enemy, or null when too
 *   early to divide by
 * @returns {number|null} Seconds, or null when either input is missing —
 *   including a rate of zero, which is "nobody is hitting it", not "forever"
 */
export function timeToKillSeconds(hp, dps) {
    if (!Number.isFinite(hp) || hp <= 0) return null;
    if (!Number.isFinite(dps) || dps <= 0) return null;
    return hp / dps;
}

/**
 * How long the whole wave has left: every living enemy's remaining health over
 * the party's combined rate.
 *
 * One unknown health bar makes the sum a lie, so it voids the estimate rather
 * than shrinking it — a countdown that silently excluded a monster would read
 * as the wave ending while something is still alive. An unknown *rate* on a
 * living enemy is different: a slot nobody has touched contributes health and
 * no rate, which is exactly the truth of it.
 *
 * @param {Object|Array<Object>} enemies - From `battleBreakdown().enemies`,
 *   each `{hp, dps}`
 * @returns {number|null} Seconds, or null when it cannot be honest
 */
export function waveClearSeconds(enemies) {
    const list = Array.isArray(enemies) ? enemies : Object.values(enemies || {});
    if (!list.length) return null;

    let totalHP = 0;
    let totalDps = 0;
    let living = 0;

    for (const enemy of list) {
        // Checked before coercing, because `Number(null)` is 0 — and an
        // unknown health bar read as a dead monster is exactly the silent
        // exclusion this null exists to prevent
        if (enemy?.hp === null || enemy?.hp === undefined) return null;
        const hp = Number(enemy.hp);
        if (!Number.isFinite(hp)) return null;
        if (hp <= 0) continue;

        living += 1;
        totalHP += hp;
        if (Number.isFinite(enemy?.dps) && enemy.dps > 0) totalDps += enemy.dps;
    }

    if (!living || totalDps <= 0) return null;
    return totalHP / totalDps;
}

/**
 * Append a mana reading and drop everything older than the window.
 *
 * @param {Array<{at: number, mana: number}>} samples - The series, mutated
 * @param {number} at - When the reading was taken (ms)
 * @param {number} mana - The reading
 * @param {number} [windowMs] - How much history to keep
 * @returns {Array<{at: number, mana: number}>} The same array
 */
export function pushManaSample(samples, at, mana, windowMs = MANA_RUNWAY_WINDOW_MS) {
    if (!Number.isFinite(at) || !Number.isFinite(mana)) return samples;

    samples.push({ at, mana });
    const cutoff = at - windowMs;
    while (samples.length && samples[0].at < cutoff) samples.shift();
    return samples;
}

/**
 * How long until this player's mana runs out, at the net rate it is moving.
 *
 * Net over the window rather than gross casting cost, so regeneration and
 * potions are already inside the figure. Steady or rising mana is not a runway
 * of infinity — it is nothing to warn about, and the answer is null.
 *
 * @param {Array<{at: number, mana: number}>} samples - From `pushManaSample`
 * @returns {number|null} Seconds until empty, or null when not draining or the
 *   series is too short to claim a rate
 */
export function manaRunwaySeconds(samples) {
    if (!Array.isArray(samples) || samples.length < 2) return null;

    const first = samples[0];
    const last = samples[samples.length - 1];
    const spanMs = last.at - first.at;
    if (spanMs < MANA_RUNWAY_MIN_SPAN_MS) return null;

    const drainPerSecond = (first.mana - last.mana) / (spanMs / 1000);
    if (drainPerSecond <= 0) return null;

    return last.mana / drainPerSecond;
}

/**
 * The mana line, or nothing.
 *
 * Only a runway under {@link MANA_RUNWAY_SHOW_SECONDS} earns a line — the
 * feature is a warning, not a gauge.
 *
 * @param {number|null} runwaySeconds - From `manaRunwaySeconds`
 * @returns {string|null} e.g. `mana ~40s`
 */
export function manaRunwayText(runwaySeconds) {
    if (!Number.isFinite(runwaySeconds)) return null;
    if (runwaySeconds > MANA_RUNWAY_SHOW_SECONDS) return null;
    return `mana ~${formatSecondsShort(runwaySeconds)}`;
}

/**
 * What a player is taking, and whether their healing keeps up.
 *
 * The net is only stated where regeneration is measurable — "taken 220/s"
 * alone is honest without it, while a net that assumed zero healing would call
 * every sustained fight a slow death.
 *
 * @param {Object|null} taken - A player row from `takenBreakdown().players`,
 *   carrying `dps` (taken per second) and `hps` (regen per second)
 * @returns {{text: string, negative: boolean}|null} Null while there is no rate
 */
export function sustainLine(taken) {
    if (!taken || taken.dps === null || taken.dps === undefined) return null;

    let text = `taken ${formatWithSeparator(Math.round(taken.dps))}/s`;
    let negative = false;

    if (taken.hps !== null && taken.hps !== undefined) {
        const net = Math.round(taken.hps - taken.dps);
        negative = net < 0;
        text += ` · net ${net < 0 ? '−' : '+'}${formatWithSeparator(Math.abs(net))}/s`;
    }

    return { text, negative };
}

/**
 * Hit and crit rate, once enough swings back them.
 *
 * @param {Object} entry - A player row carrying `hits`, `crits`, `misses`
 * @param {number} [minSwings] - The floor below which luck is not a rate
 * @returns {string|null} e.g. `94% hit · 31% crit`; the crit half is omitted
 *   when nothing has landed to measure it on
 */
export function accuracyText(entry, minSwings = MIN_SWINGS_FOR_ACCURACY) {
    const hits = Number(entry?.hits) || 0;
    const misses = Number(entry?.misses) || 0;
    const swings = hits + misses;
    if (swings < minSwings) return null;

    let text = `${Math.round((hits / swings) * 100)}% hit`;
    if (hits > 0) text += ` · ${Math.round(((Number(entry?.crits) || 0) / hits) * 100)}% crit`;
    return text;
}

/**
 * What an enemy is doing to the party, as a line.
 *
 * @param {number|null} dps - From `battleTakenBreakdown().enemies[slot].dps`
 * @returns {string|null} e.g. `hits for 210/s`
 */
export function outgoingText(dps) {
    if (!Number.isFinite(dps)) return null;
    return `hits for ${formatWithSeparator(Math.round(dps))}/s`;
}

/**
 * @param {number|null} seconds - From `timeToKillSeconds`
 * @returns {string|null} e.g. `dead ~8s`
 */
export function timeToKillText(seconds) {
    if (!Number.isFinite(seconds)) return null;
    return `dead ~${formatSecondsShort(seconds)}`;
}

/**
 * @param {number|null} seconds - From `waveClearSeconds`
 * @returns {string|null} e.g. `wave ~19s`
 */
export function waveClearText(seconds) {
    if (!Number.isFinite(seconds)) return null;
    return `wave ~${formatSecondsShort(seconds)}`;
}

/**
 * How long until a monster enrages.
 *
 * @param {number|null} enrageAt - When it enrages (ms since epoch), or null
 *   when its sheet carried no timer
 * @param {number} [now] - The clock, injectable for tests
 * @returns {number|null} Seconds left — negative once past — or null
 */
export function enrageSecondsLeft(enrageAt, now = Date.now()) {
    if (!Number.isFinite(enrageAt)) return null;
    return (enrageAt - now) / 1000;
}

/**
 * The enrage line, amber when close.
 *
 * @param {number|null} secondsLeft - From `enrageSecondsLeft`
 * @returns {{text: string, warn: boolean}|null}
 */
export function enrageLine(secondsLeft) {
    if (!Number.isFinite(secondsLeft)) return null;
    if (secondsLeft <= 0) return { text: 'enraged', warn: true };
    return { text: `enrage ${formatSecondsShort(secondsLeft)}`, warn: secondsLeft < ENRAGE_WARN_SECONDS };
}
