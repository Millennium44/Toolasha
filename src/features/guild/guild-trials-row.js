/**
 * Guild Trials overlay row
 *
 * Which tier the guild's trial is on, and whether it is going anywhere.
 *
 * ## The tile has to admit it is not live
 *
 * Everything the trial feature knows is scraped off the guild panel's In
 * Progress tab. There is no socket message carrying a trial's progress bar, so
 * the readings stop the moment that tab is closed, and the record on disk is a
 * photograph of whenever you last looked at it. A tile that drew those figures
 * with no date on them would be a tile that says a trial is 40% through when it
 * finished two hours ago — the single most misleading thing this overlay could
 * do, because the numbers themselves are perfectly correct.
 *
 * So the age is not in the tooltip, it is on the tile, beside the figure, in
 * the same glance: `T7 · as of 2h ago`. And past the hour a trial actually runs
 * for, the tile stops projecting altogether and says only how stale it is —
 * a pace fitted to readings older than the whole event is arithmetic about
 * nothing.
 *
 * ## Why there is nothing to open
 *
 * The detail behind this tile is the guild panel's own In Progress tab, which
 * is a page of the game rather than a panel of this script — there is no
 * `toggle()` that could reach it, and navigating the player somewhere on a
 * double-click is not what any other tile does. The tooltip says where to go
 * instead, which is also the only way to make the figures fresh again.
 */

import { registerRow } from '../../utils/overlay-rows.js';
import { row, blank, shortDuration, ROW_COLORS } from '../../utils/overlay-format.js';
import { analyseTrial, guildTrials } from './guild-trials.js';
import { TRIAL_ACTIVE_MS, levelFromTier } from './guild-trials-math.js';

/**
 * How stale a reading is allowed to be before the pace is withdrawn.
 *
 * A trial runs for an hour. A record older than that describes an event that
 * has ended, so the rate it carries projects a ladder nobody is climbing.
 */
export const STALE_MS = TRIAL_ACTIVE_MS;

/**
 * The most recently sampled tile of the guild's trial record.
 *
 * "Most recent" rather than "the combat one" or "the first": a week has two
 * trials running and the one you last looked at is the one you were watching.
 *
 * @param {Object} [record] - A record from `guild-trials-store.js`; the feature's own by default
 * @returns {{tile: Object, at: number}|null} The tile and its newest sample time
 */
export function latestTrialTile(record = guildTrials?.record) {
    const tiles = record?.tiles && typeof record.tiles === 'object' ? Object.values(record.tiles) : [];

    let best = null;
    for (const tile of tiles) {
        const samples = Array.isArray(tile?.samples) ? tile.samples : [];
        const at = samples.length ? samples[samples.length - 1]?.t : null;
        if (!Number.isFinite(at)) continue;
        if (!best || at > best.at) best = { tile, at };
    }
    return best;
}

registerRow({
    key: 'guildTrialsPace',
    name: 'Guild Trials',
    empty: 'No trial seen this week',
    defaultVisible: false,
    defaultSize: { width: 220, height: 30 },
    render: (container) => {
        const latest = latestTrialTile();
        if (!latest) return blank(container);

        const { tile, at } = latest;
        const ageSeconds = Math.max(0, (Date.now() - at) / 1000);
        const stale = Date.now() - at > STALE_MS;

        // Without a clock on the tab there is no time left to spend, so the
        // ladder walk `projectPace` does is not available — the projection here
        // is the one that needs no deadline: when the tier in progress clears
        // at the rate that was measured
        const analysis = analyseTrial(tile);
        const tier = Number.isFinite(analysis.tier) ? analysis.tier : null;
        const level = tier === null ? null : levelFromTier(tier);

        const projection = stale
            ? { text: 'stale', color: ROW_COLORS.dim }
            : analysis.etaMs === null
              ? { text: '—', color: ROW_COLORS.dim }
              : { text: shortDuration(analysis.etaMs / 1000), color: ROW_COLORS.accent };

        row(container, [
            { text: tier === null ? tile.name || 'Trial' : `T${tier}`, color: ROW_COLORS.gold, ellipsis: true },
            projection,
            // The age is on the tile rather than in the tooltip on purpose; see
            // the module note
            { text: `${shortDuration(ageSeconds)} ago`, color: ROW_COLORS.dim, push: true },
        ]);

        container.title =
            `${tile.name || 'Trial'} (${tile.kind === 'combat' ? 'combat' : 'skilling'}), ` +
            `tier ${tier ?? '?'}${level ? ` — level ${level}` : ''}, ` +
            `${analysis.tiersClearedSoFar} banked.\n` +
            (stale
                ? 'These readings are older than the hour a trial runs for, so no pace is projected from them.'
                : analysis.etaMs === null
                  ? 'Not enough movement was seen to measure a rate.'
                  : `At the rate last measured, this tier clears in ${shortDuration(analysis.etaMs / 1000)}.`) +
            `\nRead ${shortDuration(ageSeconds)} ago — open the guild In Progress tab to refresh.`;
    },
    // No onOpen: the detail behind this is a page of the game, not a panel
});
