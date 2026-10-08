/**
 * The sync PULL fold for XP sample series that compact as they record.
 *
 * The skill XP tracker (`features/skills/xp-tracker.js`) and the guild XP
 * tracker (`features/guild/guild-xp-tracker.js`) keep `name → [{t, xp}]` maps
 * and thin each series on every new sample with the same three rules: the
 * last ten minutes keep only their first and last sample, a run of equal XP
 * within an hour keeps only its last, and samples a week older than the newest
 * go. So a series is not a set that only grows: a sample this device uploaded
 * is very often one it has since thinned away.
 *
 * Folding the gist's copy back in by plain union — or by a union replayed
 * through the thinning, which does not give back the same series either,
 * because thinning depends on samples that were themselves thinned since — put
 * those samples back on every pull, the record read as changed, and the pull
 * asked for a reload over nothing it did not already have.
 *
 * So a pull takes from the gist only what can be news:
 *
 * - a sample newer than this device's newest: the other device recorded on;
 * - a sample older than this device's oldest, with less XP than that oldest
 *   sample, and inside the week the series keeps less its last ten minutes.
 *   Before a series' first sample, the equal-XP and ten-minute rules only ever
 *   remove samples with that first sample's XP (a run of equal XP collapses
 *   onto its last sample; the ten-minute rule keeps the first sample of its
 *   window) — except where the week rule later took that window's first
 *   sample, which leaves the ten minutes after it at the week's edge. So
 *   anything with less XP, short of that edge, is history this device never
 *   had: a device that started recording later than another;
 * - a whole series this device does not have, where `acceptSeries` allows it.
 *
 * Samples inside the span this device already covers are its own business: it
 * may have thinned them, and it cannot tell those from samples another device
 * took in a gap of its own. Taking none of them is what makes a pull of the
 * gist this device itself just pushed change nothing. The gist keeps them —
 * the upload still folds the full union — so nothing is lost from the gist.
 *
 * A series with nothing new is returned exactly as this device holds it.
 *
 * Accepted trade-off: samples another device took inside a gap of this device's own span (play that switched
 * devices within the week) are not taken here; this device's chart is coarser over that stretch, the gist keeps them.
 */

/**
 * @typedef {Object} XPSeriesPullOptions
 * @property {number} windowMs - How far behind the newest sample a series keeps samples
 * @property {number} recentMs - The span the "first and last only" rule thins (ten minutes)
 * @property {number} [keepLast=0] - Trailing samples the week rule never drops (the guild tracker keeps two)
 * @property {(series: Array<{t: number, xp: number}>, local: Object) => boolean} [acceptSeries] - Whether a
 *   series only the gist has is taken; every one is by default
 */

/**
 * @param {*} sample - A stored sample
 * @returns {boolean} Whether it has a usable time and XP
 */
function isSample(sample) {
    return Boolean(sample) && Number.isFinite(sample.t) && Number.isFinite(sample.xp);
}

/**
 * Fold the gist's XP series map into this device's for a pull, taking only
 * what can be news (see the module header).
 * @param {Object<string, Array<{t: number, xp: number}>>} local - This device's map
 * @param {Object<string, Array<{t: number, xp: number}>>} incoming - The gist's map
 * @param {XPSeriesPullOptions} options - The series' week rule, and which new series to take
 * @returns {Object<string, Array<{t: number, xp: number}>>} The folded map; this device's copy when nothing is new
 */
export function foldXPSeriesForPull(local, incoming, { windowMs, recentMs, keepLast = 0, acceptSeries = null }) {
    const mine = local && typeof local === 'object' && !Array.isArray(local) ? local : null;
    const theirs = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : null;
    if (!mine) return incoming;
    if (!theirs) return local;

    const out = { ...mine };
    for (const [name, series] of Object.entries(theirs)) {
        if (!Array.isArray(series)) continue;
        const held = mine[name];
        const heldSamples = Array.isArray(held) ? held.filter(isSample) : [];
        if (heldSamples.length === 0) {
            // A series this device does not keep (or keeps nothing of)
            if (held !== undefined && !Array.isArray(held)) continue;
            const offered = series.filter(isSample);
            if (offered.length === 0) continue;
            if (acceptSeries && !acceptSeries(offered, mine)) continue;
            out[name] = offered;
            continue;
        }

        let first = heldSamples[0];
        let last = heldSamples[0];
        for (const sample of heldSamples) {
            if (sample.t < first.t) first = sample;
            if (sample.t > last.t) last = sample;
        }
        const times = new Set(heldSamples.map((sample) => sample.t));
        const offered = series.filter((sample) => isSample(sample) && !times.has(sample.t));

        const newer = offered.filter((sample) => sample.t > last.t);
        const newest = newer.reduce((at, sample) => Math.max(at, sample.t), last.t);
        const older = offered.filter(
            (sample) => sample.t < first.t && sample.xp < first.xp && newest - sample.t <= windowMs - recentMs
        );
        if (newer.length === 0 && older.length === 0) continue;

        const merged = [...heldSamples, ...newer, ...older].sort((a, b) => a.t - b.t);
        // The week rule over the result, as the tracker's own next sample would apply it
        let drop = 0;
        while (drop < merged.length - keepLast && newest - merged[drop].t > windowMs) drop++;
        out[name] = merged.slice(drop);
    }
    return out;
}

export default { foldXPSeriesForPull };
