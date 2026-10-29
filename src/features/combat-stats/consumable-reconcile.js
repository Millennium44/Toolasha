/**
 * Consumable reconciliation against `new_battle` snapshots.
 *
 * The player's own consumption is counted from `battle_consumable_ability_updated`
 * events, and those only arrive while the page is listening. A closed tab, a
 * suspended page or a reconnect misses them, and the time they cover stays in
 * the rate's time base, so the rate and the runway read low after every gap.
 *
 * Every `new_battle` carries each player's current consumable counts
 * (`players[].combatConsumables[].count`), so the drop from the count last held
 * to the count in the payload is the consumption that was missed. This module
 * decides how much of that drop to believe, and how much of the unobserved time
 * belongs in the time base. It is pure: the collector applies the result.
 *
 * A count that went UP is a refill and is never consumption. A drop larger than
 * the cooldowns allow in the time available (selling, moving items out) is
 * rejected rather than credited. Either way the caller moves its baseline to
 * the snapshot, so the next comparison starts from what is really there.
 */

/** A silence in battle traffic longer than this means nobody was watching. */
export const UNOBSERVED_GAP_SECONDS = 180;

/** Headroom over the cooldown-based maximum rate, for rounding and drink concentration. */
export const PLAUSIBILITY_FACTOR = 1.5;

/** Ordinary wave intervals needed before an average wave time is trusted. */
export const MIN_WAVE_SAMPLES = 3;

/**
 * Classify one item's count difference.
 * @param {Object} params
 * @param {number|undefined|null} params.lastKnown - Count last held; undefined/null when never seen
 * @param {number} params.snapshot - Count in the `new_battle` payload
 * @param {number} params.effectiveGapSeconds - Seconds the item could have been consumed for
 * @param {number} params.maxRatePerSecond - Cooldown-based maximum consumption rate
 * @returns {{action: 'none'|'baseline'|'credit'|'reject'|'restock', credited: number, missed: number}}
 */
export function classifyItem({ lastKnown, snapshot, effectiveGapSeconds, maxRatePerSecond }) {
    if (typeof lastKnown !== 'number' || !Number.isFinite(lastKnown)) {
        return { action: 'baseline', credited: 0, missed: 0 };
    }

    const missed = lastKnown - snapshot;
    if (missed === 0) return { action: 'none', credited: 0, missed: 0 };
    if (missed < 0) return { action: 'restock', credited: 0, missed };

    // At least one, so a single use on a wave boundary is never thrown away
    const plausibleMax = Math.max(1, Math.ceil(effectiveGapSeconds * maxRatePerSecond * PLAUSIBILITY_FACTOR));
    if (missed <= plausibleMax) return { action: 'credit', credited: missed, missed };
    return { action: 'reject', credited: 0, missed };
}

/**
 * Reconcile every item of one tracker against one snapshot.
 *
 * The span is the time since this tracker was last reconciled against a
 * snapshot; the drop could have happened anywhere in it. Whether anybody was
 * watching is a separate question, answered by `unobservedSeconds`: the battle
 * traffic silences longer than {@link UNOBSERVED_GAP_SECONDS} inside the span.
 * A long battle watched throughout is not a gap, however long it ran.
 *
 * - Watched throughout: the whole span bounds the drop and stays in the time base.
 * - A silence, with the fighting time estimable: that time bounds the drop; a
 *   credit keeps it in the time base and leaves out the rest of the silence.
 * - A silence with no estimate: nothing bounds the drop (it could be a sell-off
 *   as easily as hours of eating), so nothing is credited.
 * - Nothing credited across a silence: its consumption is unknown and the
 *   silence is left out whole.
 *
 * @param {Object} params
 * @param {Array<{itemHrid: string, lastKnown: (number|undefined), snapshot: number, maxRatePerSecond: number}>} params.items
 * @param {number|null} params.gapSeconds - Seconds since this tracker's last snapshot; null if never
 * @param {number} [params.unobservedSeconds] - Seconds of that span nobody was watching
 * @param {number|null} params.fightingSeconds - Estimated fighting time in the span; null if unknown
 * @returns {{unobserved: boolean, excludeSeconds: number, items: Array<{itemHrid: string, action: string, credited: number, missed: number}>}}
 */
export function reconcileSnapshot({ items, gapSeconds, unobservedSeconds = 0, fightingSeconds }) {
    if (gapSeconds === null || gapSeconds === undefined || !Number.isFinite(gapSeconds)) {
        return {
            unobserved: false,
            excludeSeconds: 0,
            items: items.map((item) => ({ itemHrid: item.itemHrid, action: 'baseline', credited: 0, missed: 0 })),
        };
    }

    const gap = Math.max(0, gapSeconds);
    const silence = Math.min(gap, Math.max(0, Number(unobservedSeconds) || 0));
    const unobserved = silence > 0;
    const estimated = fightingSeconds > 0;
    const effectiveGap = unobserved && estimated ? Math.min(gap, fightingSeconds) : gap;

    const results = items.map((item) => {
        const classified = classifyItem({
            lastKnown: item.lastKnown,
            snapshot: item.snapshot,
            effectiveGapSeconds: effectiveGap,
            maxRatePerSecond: item.maxRatePerSecond,
        });
        if (unobserved && !estimated && classified.action === 'credit') {
            return { itemHrid: item.itemHrid, action: 'reject', credited: 0, missed: classified.missed };
        }
        return { itemHrid: item.itemHrid, ...classified };
    });

    let excludeSeconds = 0;
    if (unobserved) {
        const creditedAny = results.some((result) => result.action === 'credit');
        excludeSeconds = creditedAny ? Math.min(silence, gap - effectiveGap) : silence;
    }

    return { unobserved, excludeSeconds, items: results };
}

/**
 * Waves fought between two `new_battle` messages of the same run.
 *
 * Ordinary zones advance `battleId` once per wave. Dungeons advance `battleId`
 * once per run and restart `wave` each run, so there it is runs × max waves plus
 * the change in wave.
 *
 * @param {Object} params
 * @param {number|null} params.previousBattleId
 * @param {number|null} params.previousWave
 * @param {number} params.battleId
 * @param {number|null} params.wave
 * @param {number|null} params.dungeonMaxWaves - Max waves when in a dungeon, otherwise null
 * @returns {number|null} Null when it cannot be derived or is not positive
 */
export function wavesElapsed({ previousBattleId, previousWave, battleId, wave, dungeonMaxWaves }) {
    if (typeof previousBattleId !== 'number' || typeof battleId !== 'number') return null;

    let waves;
    if (dungeonMaxWaves > 0) {
        if (typeof previousWave !== 'number' || typeof wave !== 'number') return null;
        waves = (battleId - previousBattleId) * dungeonMaxWaves + (wave - previousWave);
    } else {
        waves = battleId - previousBattleId;
    }
    return waves > 0 ? waves : null;
}

/**
 * Estimated fighting time for a gap, from its wave count and the run's average wave time.
 * @param {number|null} waves
 * @param {{sum: number, count: number}|null} waveStats - Sum and count of ordinary message intervals
 * @returns {number|null} Seconds, or null when there is not enough to go on
 */
export function estimateFightingSeconds(waves, waveStats) {
    if (!waves || !waveStats || waveStats.count < MIN_WAVE_SAMPLES || waveStats.sum <= 0) return null;
    return waves * (waveStats.sum / waveStats.count);
}
