/**
 * Which Upgrade rows are real gains, which drink swaps only trade power for a cheaper coffee, and which rows the
 * results fold behind a "+N more" line. Pure: nothing here measures, prices or draws.
 *
 * Folding is display only. Every row stays in the analysis (the planner, Verify, Pin and Exclude, the CSV and
 * Copy for chat read the full list); a folded row is simply not drawn until the group is opened.
 */

/** Rows kept per drink slot before the rest fold, and orders kept when none clears the noise */
export const FOLD_KEEP = 3;

const GOOD_UP = ['dps', 'xp', 'encounters'];

/**
 * Whether a drink row replaces a worn coffee (an addition to a free slot is not a swap).
 * @param {Object} row - Result row
 * @returns {boolean}
 */
export function isDrinkSwap(row) {
    const c = row?.candidate;
    return c?.type === 'drink' && Boolean(c.currentHrid) && c.fillsFreeDrinkSlot !== true;
}

/**
 * Whether a row clears its error bar as an improvement on a metric other than profit: DPS, EXP, encounters
 * per hour up, or deaths down. Needs the row's `significantBy`; a row without one (a remembered run from before
 * it existed) is never judged.
 * @param {Object} row - Result row
 * @returns {boolean}
 */
function improvesBeyondNoise(row) {
    const sig = row?.significantBy;
    const d = row?.deltas;
    if (!sig || !d) return false;
    if (GOOD_UP.some((k) => sig[k] === true && d[k] > 0)) return true;
    return sig.deaths === true && d.deaths < 0;
}

/**
 * A drink swap that gains profit only because the new coffee is cheaper: it loses DPS or EXP beyond the noise,
 * gains profit beyond the noise, and improves nothing beyond the noise. It is a trade (power for gold), not an upgrade, so
 * the Score does not rank it and the row says what it trades.
 * @param {Object} row - Result row
 * @returns {boolean}
 */
export function isCheaperSwap(row) {
    if (!isDrinkSwap(row) || !row.significantBy || !row.deltas) return false;
    if (row.costUnpricedBaseline?.length || row.costUnpriced?.length) return false;
    const gain = row.economics?.profitGainPerHour;
    if (!Number.isFinite(gain) || gain <= 0) return false;
    const sig = row.significantBy;
    // A within-noise profit sliver is not a saving to quote
    if (sig.profit !== true) return false;
    const d = row.deltas;
    const loses = (sig.dps === true && d.dps < 0) || (sig.xp === true && d.xp < 0);
    return loses && !improvesBeyondNoise(row);
}

/**
 * A drink swap that loses DPS or EXP beyond the noise and gains nothing beyond the noise (no improvement on any
 * metric, profit included). Worse than the build it replaces, so the Score ranks it at 0; unlabeled, since there
 * is no saving to quote. A cheaper swap is the labeled kind of the same thing.
 * @param {Object} row - Result row
 * @returns {boolean}
 */
export function isLosingSwap(row) {
    if (!isDrinkSwap(row) || !row.significantBy || !row.deltas) return false;
    const sig = row.significantBy;
    const d = row.deltas;
    const loses = (sig.dps === true && d.dps < 0) || (sig.xp === true && d.xp < 0);
    return loses && !clearsNoiseAsImprovement(row);
}

/**
 * Whether the Score leaves a row out of the ranking and gives it 0: a cheaper swap or a losing swap.
 * @param {Object} row - Result row
 * @returns {boolean}
 */
export function isUnrankedSwap(row) {
    return isCheaperSwap(row) || isLosingSwap(row);
}

/**
 * What a cheaper swap trades, for the label on its row.
 * @param {Object} row - A row for which `isCheaperSwap` is true
 * @returns {{saves: number, dpsPct: number|null, xpPct: number|null}}
 */
export function cheaperSwapTrade(row) {
    const loss = (key) => (row.significantBy?.[key] === true && row.deltas?.[key] < 0 ? -row.deltas[key] : null);
    return { saves: row.economics.profitGainPerHour, dpsPct: loss('dps'), xpPct: loss('xp') };
}

/**
 * Whether a row clears the noise as an improvement on any metric, so folding must never hide it. A cheaper
 * swap's profit gain does not count (that is what makes it a labeled, unranked cheaper swap). A row with no
 * `significantBy` (a remembered run from before verdicts existed) was never judged, so it counts: it is never
 * folded.
 * @param {Object} row - Result row
 * @returns {boolean}
 */
export function clearsNoiseAsImprovement(row) {
    if (row && row.candidate && (!row.significantBy || !row.deltas)) return true;
    if (improvesBeyondNoise(row)) return true;
    if (isCheaperSwap(row)) return false;
    return row?.significantBy?.profit === true && row.deltas?.profit > 0;
}

/**
 * The fold group of a row: the drink slot it replaces (a swap) or the one group of additions. Null for rows
 * that are never folded in the table (ability orders have their own section and rule).
 * @param {Object} row - Result row
 * @returns {string|null}
 */
export function foldGroupOf(row) {
    const c = row?.candidate;
    if (c?.type !== 'drink') return null;
    if (isDrinkSwap(row)) return `drink-swap:${c.drinkIndex ?? ''}:${c.currentHrid}`;
    return 'drink-add';
}

/**
 * Decide which rows of a sorted table fold. Per group the first `keep` rows in the table's order stay, and so
 * does every row that clears the noise as an improvement, is in `protect`, or has a verdict (`isProtected`);
 * the rest fold.
 * @param {Array<Object>} sorted - Rows in the order the table draws them
 * @param {Object} [options]
 * @param {number} [options.keep=FOLD_KEEP] - Rows kept per group
 * @param {(row: Object) => boolean} [options.isProtected] - Rows that must stay (pinned, excluded, verified...)
 * @returns {{folded: Set<Object>, groups: Map<string, {rows: Object[], folded: Object[]}>}}
 */
export function planFold(sorted, { keep = FOLD_KEEP, isProtected = null } = {}) {
    const groups = new Map();
    for (const row of sorted) {
        const key = foldGroupOf(row);
        if (key === null) continue;
        if (!groups.has(key)) groups.set(key, { rows: [], folded: [] });
        groups.get(key).rows.push(row);
    }
    const folded = new Set();
    for (const group of groups.values()) {
        let kept = 0;
        for (const row of group.rows) {
            const must = clearsNoiseAsImprovement(row) || (isProtected ? isProtected(row) : false);
            if (must || kept < keep) {
                // A protected row uses a place only when it would have had one, so it never crowds out a top row
                if (kept < keep) kept++;
                continue;
            }
            group.folded.push(row);
            folded.add(row);
        }
    }
    return { folded, groups };
}

/**
 * The ability-order entries to show: those that clear the noise as an improvement on the ranked metric, or the
 * first `keep` by that metric when none does. Entries a verify confirmed stay. Order is untouched.
 * @param {Array<{r: Object, gain: number, within: boolean}>} measured - Ranked entries, best gain first
 * @param {Object} [options]
 * @param {number} [options.keep=FOLD_KEEP] - Entries shown when none clears the noise
 * @param {(row: Object) => boolean} [options.isConfirmed] - Rows a verify confirmed
 * @returns {Set<Object>} The entries to show
 */
export function orderEntriesToShow(measured, { keep = FOLD_KEEP, isConfirmed = null } = {}) {
    const clearing = measured.filter((e) => e.gain > 0 && !e.within);
    const shown = new Set(clearing.length ? clearing : measured.slice(0, keep));
    if (isConfirmed) for (const e of measured) if (isConfirmed(e.r)) shown.add(e);
    return shown;
}
