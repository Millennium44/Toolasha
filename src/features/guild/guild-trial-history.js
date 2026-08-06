/**
 * The archived cycles, read back.
 *
 * `guild-trials-store.js` puts a finished week's tiles away in `record.history`
 * — up to four cycles, each with its tiles, when it was archived and why — on
 * the grounds that the figures were real when they were taken and a player who
 * wants last cycle's numbers has nowhere else to get them. Until now nothing
 * ever read them back, which made the archive a promise the panel never kept.
 *
 * These helpers turn one archived cycle into the short line a player actually
 * wants about a past week: when it was, what each half cleared, what the cards
 * said it was worth. Everything here is pure — a cycle in, a summary or a line
 * out — so the two consumers (the "Past weeks" block in `guild-trials.js` and
 * the pasteable tail in `guild-trial-report.js`) print exactly the same week,
 * and the printing is tested without a DOM, a clock or storage.
 *
 * ## What is stated and what is derived
 *
 * A card's stated Guild Points were real when they were archived and are
 * repeated exactly as they stand. The token figure never was on a card — it is
 * half the base points times the Treasury bonus — and the only bonuses in hand
 * are *today's*, so it is derived, marked `~`, and refused outright for a cycle
 * archived off another guild's record, whose buildings these are not. Anything
 * genuinely unknown renders as "—", because an archived week that banked
 * nothing is a real outcome — a failed week — and prints its zeros, and the two
 * must never look alike.
 */

import { eligibleMemberTokens, trialWeekStart } from './guild-trials-math.js';
import { formatWithSeparator } from '../../utils/formatters.js';

/** One trial week, in ms */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The reason stamped on a cycle archived off a record that names another guild.
 *
 * `_healStaleRecord` in `guild-trials.js` is the author: when `recordProvenance`
 * answers `'foreign'`, the record's tiles are archived under exactly this
 * string rather than deleted. It is therefore the one marker by which an
 * archived cycle can be known not to be this guild's — the cycles themselves
 * carry no provenance stamp of their own, and a foreign *record* never gets far
 * enough to donate its history because `loadTrialRecord` discards it whole. A
 * week so marked is labelled rather than silently mixed in, and no figure is
 * ever derived for it with this guild's building bonuses.
 */
export const FOREIGN_CYCLE_REASON = 'belongs to another guild';

/**
 * How long ago an archived cycle's week was, as a person would say it.
 *
 * From the cycle's own `weekStart` where it has one — the tiles belong to that
 * week's ladder whenever they were put away — falling back to `archivedAt` for
 * an entry written before the week was stamped. Measured in week boundaries
 * rather than elapsed time, because "last week" means the previous cycle and
 * not "roughly seven days".
 *
 * @param {Object} cycle - An archived cycle from `record.history`
 * @param {number} [now] - Clock, in ms
 * @returns {string|null} `'this week'`, `'last week'`, `'N weeks ago'`, or null
 *   when the cycle carries no usable timestamp
 */
export function describeCycleAge(cycle, now = Date.now()) {
    const ref = Number.isFinite(cycle?.weekStart)
        ? cycle.weekStart
        : Number.isFinite(cycle?.archivedAt)
          ? cycle.archivedAt
          : null;
    if (ref === null) return null;

    const weeks = Math.round((trialWeekStart(now) - trialWeekStart(ref)) / WEEK_MS);
    if (weeks <= 0) return 'this week';
    if (weeks === 1) return 'last week';
    return `${weeks} weeks ago`;
}

/**
 * The tier an archived tile finished on.
 *
 * The badge counts tiers *finished*, so a stored `tier` is already the cleared
 * count. A card whose badge was never read can still have quoted points for a
 * tier, and the highest tier it quoted a real figure for is the same fact. A
 * completed card with neither — no badge, no points — is a party that wiped
 * before tier 1, which is a zero rather than a gap; and a tile that says none
 * of these things says nothing.
 *
 * @param {Object} tile - An archived tile
 * @returns {number|null} Tiers cleared, or null when the tile does not say
 */
function clearedTier(tile) {
    if (Number.isFinite(tile?.tier)) return tile.tier;

    const quoted = Object.keys(tile?.pointsByTier || {})
        .map(Number)
        .filter((tier) => Number.isFinite(tier) && Number(tile.pointsByTier[tier]) > 0);
    if (quoted.length) return Math.max(...quoted);

    if (tile?.completed && !(tile?.points > 0)) return 0;
    return null;
}

/**
 * One archived cycle, reduced to the figures a week line prints.
 *
 * `points` is the sum of the Guild Points the cards themselves stated — the
 * figure the guild's own announcement paid — and stays null when no card ever
 * stated one. `tokens` is derived from it with the bonuses passed in, which are
 * the guild's *current* ones: close enough for this guild's own recent weeks,
 * marked `~` by the line, and never computed for a foreign cycle at all.
 *
 * @param {Object} cycle - An archived cycle from `record.history`
 * @param {Object} [options] - Context
 * @param {number} [options.now] - Clock, in ms
 * @param {number|null} [options.buildersHallBonus] - Builders Hall bonus fraction, null when unknown
 * @param {number|null} [options.treasuryBonus] - Treasury bonus fraction, null when unknown
 * @returns {{when: string|null, combatTier: number|null, skillingTier: number|null,
 *   points: number|null, tokens: number|null, foreign: boolean, reason: string|null}} The summary
 */
export function summariseArchivedCycle(
    cycle,
    { now = Date.now(), buildersHallBonus = null, treasuryBonus = null } = {}
) {
    const tiles = Object.values(cycle?.tiles || {});
    const foreign = cycle?.reason === FOREIGN_CYCLE_REASON;

    const highest = (kind) => {
        const tiers = tiles
            .filter((tile) => tile?.kind === kind)
            .map(clearedTier)
            .filter((tier) => tier !== null);
        return tiers.length ? Math.max(...tiers) : null;
    };

    let points = null;
    for (const tile of tiles) {
        if (Number.isFinite(tile?.points)) points = (points ?? 0) + tile.points;
    }

    let tokens = null;
    const bonusesUsable =
        Number.isFinite(buildersHallBonus) && buildersHallBonus > -1 && Number.isFinite(treasuryBonus);
    if (!foreign && Number.isFinite(points) && bonusesUsable) {
        tokens = eligibleMemberTokens(points / (1 + buildersHallBonus), treasuryBonus);
    }

    return {
        when: describeCycleAge(cycle, now),
        combatTier: highest('combat'),
        skillingTier: highest('skilling'),
        points,
        tokens,
        foreign,
        reason: typeof cycle?.reason === 'string' ? cycle.reason : null,
    };
}

/**
 * The week line both surfaces print, panel and report alike.
 *
 * One compact line, ` · `-separated like the rest of the report, with every
 * slot always present so weeks line up under each other. "—" is what is not
 * known; a zero is a result and prints as one. The token figure carries a `~`
 * because it is derived from today's bonuses rather than stated by a card, and
 * a foreign cycle says whose week it was not.
 *
 * @param {Object} summary - From {@link summariseArchivedCycle}
 * @returns {string} e.g. `Last week · combat T5 · skilling T6 · 1,800 pts · ~825 tokens each`
 */
export function pastWeekLine(summary) {
    const dash = '—';
    const tier = (value) => (Number.isFinite(value) ? `T${value}` : dash);
    const when = summary?.when ? summary.when.charAt(0).toUpperCase() + summary.when.slice(1) : dash;

    const parts = [
        when,
        `combat ${tier(summary?.combatTier)}`,
        `skilling ${tier(summary?.skillingTier)}`,
        `${Number.isFinite(summary?.points) ? formatWithSeparator(Math.round(summary.points)) : dash} pts`,
        `${Number.isFinite(summary?.tokens) ? `~${formatWithSeparator(Math.round(summary.tokens))}` : dash} tokens each`,
    ];
    if (summary?.foreign) parts.push('another guild’s week');
    return parts.join(' · ');
}
