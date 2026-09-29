/**
 * Dungeon Tracker UI Run History Display
 * Handles grouping, filtering, and rendering of run history
 */

import dungeonTrackerStorage, {
    filterRunsForCharacter,
    currentCharacter,
    runIdentity,
    minMaxOf,
} from './dungeon-tracker-storage.js';
import dungeonTrackerChatAnnotations from './dungeon-tracker-chat-annotations.js';
import {
    serializeBackupWithinLimits,
    parseDungeonRunsJson,
    validateDungeonRunsEnvelope,
    planDungeonRunImport,
    dungeonRunsBackupFilename,
    MAX_IMPORT_FILE_BYTES,
    MAX_IMPORT_RUNS,
} from './dungeon-tracker-run-import.js';
import { trendsFor, directionMarker, NOT_ENOUGH_RUNS, TREND_WINDOW } from './dungeon-tracker-trends.js';
import { toCsv, csvFilename, downloadCsv, downloadFile } from '../../utils/csv-export.js';
import { formatDateTime } from '../../utils/formatters.js';
import { openPlayerProfile, VALID_PLAYER_NAME_RE } from '../../utils/profile-command.js';

/**
 * How many of a group's runs the list actually renders, most recent first.
 *
 * Every run in a group still counts toward that group's stats
 * (`calculateStatsForRuns` runs over the whole, unsliced array) and the CSV
 * and JSON exports still cover every run regardless of what is on screen —
 * this bounds only the HTML the group's own expandable list builds. A single
 * dungeon+team group can hold up to `MAX_IMPORT_RUNS` (50,000) after a JSON
 * backup import, and building one `innerHTML` string with a row's worth of
 * markup for every one of them — and rebuilding it on every filter change,
 * every delete, every redraw — is real work with no reader behind most of
 * it: nobody scrolls through tens of thousands of rows looking for one run.
 */
export const MAX_RENDERED_RUNS_PER_GROUP = 200;

/** The run-history export, one row per run. */
export const DUNGEON_RUN_CSV_COLUMNS = [
    { key: 'timestamp', label: 'Timestamp' },
    { key: 'dungeon', label: 'Dungeon' },
    { key: 'tier', label: 'Tier' },
    { key: 'durationSeconds', label: 'Duration (s)' },
    { key: 'team', label: 'Team' },
    { key: 'teamSize', label: 'Team Size' },
    { key: 'keyCounts', label: 'Key Counts' },
    { key: 'validated', label: 'Server-timed' },
];

/**
 * A stored timestamp as ISO, or as it was when it will not parse.
 * @param {string} value - Run timestamp
 * @returns {string} ISO timestamp
 */
function isoTimestamp(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || '') : date.toISOString();
}

/**
 * Run history as CSV rows, one per run.
 *
 * Pure and DOM-free: it reads the same run list the panel just grouped, not the
 * grouped markup, so the export carries whatever the current filters allowed —
 * in the order the groups hold it — with raw numbers a spreadsheet can sort.
 *
 * @param {Array<Object>} runs - Stored runs, as `dungeon-tracker-storage` keeps them
 * @returns {Array<Object>} Rows for `DUNGEON_RUN_CSV_COLUMNS`
 */
export function buildRunHistoryRows(runs) {
    return (runs || []).map((run) => {
        const team =
            Array.isArray(run.team) && run.team.length ? run.team : (run.teamKey || '').split(',').filter(Boolean);
        const keyCounts = run.keyCountsMap
            ? Object.entries(run.keyCountsMap)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([name, count]) => `${name}: ${count}`)
                  .join('; ')
            : '';

        return {
            timestamp: isoTimestamp(run.timestamp),
            dungeon: run.dungeonName || 'Unknown',
            // Tier is only known for runs recorded by routes that saw it
            tier: run.tier ?? null,
            durationSeconds: (run.duration || run.totalTime || 0) / 1000,
            team: team.length ? team.join(', ') : 'Solo',
            teamSize: team.length || 1,
            keyCounts,
            // Party runs are timed by the server's own "Key counts" timestamps;
            // a solo run only has this client's wall clock behind it
            validated: run.validated !== false,
        };
    });
}

class DungeonTrackerUIHistory {
    constructor(state, formatTimeFunc) {
        this.state = state;
        this.formatTime = formatTimeFunc;
        /** Set by dispose(); guards the hidden file-input's change handler against firing after teardown */
        this.disposed = false;
        /**
         * How many of each group's runs "Show N more" has revealed so far,
         * keyed by `group.label`. Missing means the default,
         * {@link MAX_RENDERED_RUNS_PER_GROUP} — every group starts capped,
         * and a click grows only the one group clicked. Not part of the
         * persisted panel state: it is exactly as ephemeral as which groups
         * are expanded, and a fresh session showing every group capped again
         * is the right default, not a regression.
         */
        this.visibleRunCounts = new Map();
    }

    /**
     * Tear this section down: remove the hidden file-input it owns (and its
     * listener with it) and stop any file already picked from importing.
     *
     * `triggerImportBackup` appends that `<input>` straight to `document.body`
     * the first time Import is clicked, and nothing before this method ever
     * removed it again — not on a character switch, which builds a fresh
     * `DungeonTrackerUIHistory` for the arriving character
     * (`dungeon-tracker-ui.js#cleanup`/`initialize`) and simply drops the old
     * one. The old instance's input stayed in the document forever, and a
     * file chosen through it — a slow picker dialog left open across a
     * switch, say — still ran `importBackupText` against `this.state` and
     * `this.onImportCallback`, which by then describe a character nobody is
     * looking at any more.
     */
    dispose() {
        this.disposed = true;
        // Belt and suspenders alongside every `this.disposed` check
        // `importBackupText` makes after its own awaits: even if one of
        // those checks were ever missed, there would be no callback left to
        // wrongly fire against the parent panel this section no longer
        // belongs to.
        this.onImportCallback = null;
        this.onDeleteCallback = null;
        if (this.importInput) {
            this.importInput.remove();
            this.importInput = null;
        }
    }

    /**
     * Escape a string for safe interpolation into innerHTML.
     * Team keys and dungeon labels derive from other players' names — untrusted input.
     * @param {string} value - Raw string
     * @returns {string} HTML-escaped string
     */
    escapeHtml(value) {
        return String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    /**
     * Group runs by team
     * @param {Array} runs - Array of runs
     * @returns {Array} Grouped runs with stats
     */
    groupByTeam(runs) {
        // A `Map`, not `{}`: `run.teamKey` can be anything a JSON backup
        // supplies, and a plain object keyed by `__proto__` (or `constructor`,
        // `toString`, ...) does not create an own property at all — it reads
        // or replaces something on `Object.prototype`, and `groups[key].runs.push`
        // then throws because that inherited value is never the group object
        // this loop just tried to build.
        const groups = new Map();

        for (const run of runs) {
            const key = run.teamKey || 'Solo';
            if (!groups.has(key)) {
                groups.set(key, {
                    key: key,
                    label: key === 'Solo' ? 'Solo Runs' : key,
                    runs: [],
                });
            }
            groups.get(key).runs.push(run);
        }

        // Convert to array and calculate stats
        return [...groups.values()].map((group) => ({
            ...group,
            stats: this.calculateStatsForRuns(group.runs),
        }));
    }

    /**
     * Group runs by dungeon
     * @param {Array} runs - Array of runs
     * @returns {Array} Grouped runs with stats
     */
    groupByDungeon(runs) {
        // A `Map`, for the same reason `groupByTeam` uses one — `dungeonName`
        // is validated to be a non-empty string on import, but nothing stops
        // that string from being `__proto__`.
        const groups = new Map();

        for (const run of runs) {
            const key = run.dungeonName || 'Unknown';
            if (!groups.has(key)) {
                groups.set(key, {
                    key: key,
                    label: key,
                    runs: [],
                });
            }
            groups.get(key).runs.push(run);
        }

        // Convert to array and calculate stats
        return [...groups.values()].map((group) => ({
            ...group,
            stats: this.calculateStatsForRuns(group.runs),
        }));
    }

    /**
     * Calculate stats for a set of runs
     * @param {Array} runs - Array of runs
     * @returns {Object} Stats object
     */
    calculateStatsForRuns(runs) {
        if (!runs || runs.length === 0) {
            return {
                totalRuns: 0,
                avgTime: 0,
                fastestTime: 0,
                slowestTime: 0,
            };
        }

        const durations = runs.map((r) => r.duration || r.totalTime || 0);
        const total = durations.reduce((sum, d) => sum + d, 0);
        // minMaxOf, not Math.min(...durations)/Math.max(...durations): a
        // spread of ~125k+ arguments overflows the engine's call-stack
        // argument limit and throws a RangeError instead of answering — a
        // single dungeon+team group can reach that size once a JSON backup
        // import (capped, but still large) and years of live history land in
        // the same bucket.
        const { min: fastestTime, max: slowestTime } = minMaxOf(durations);

        return {
            totalRuns: runs.length,
            avgTime: Math.floor(total / runs.length),
            fastestTime,
            slowestTime,
        };
    }

    /**
     * Whether the last update reset a stale filter to 'all', cleared on read. The
     * header, chart and saved state are drawn from the filters before the list is,
     * so the caller has to redraw them when this is true.
     * @returns {boolean}
     */
    consumeFilterReset() {
        const reset = Boolean(this.filtersReset);
        this.filtersReset = false;
        return reset;
    }

    /**
     * Update run history display with grouping and filtering
     * @param {HTMLElement} container - Main container element
     */
    async update(container) {
        const runList = container.querySelector('#mwi-dt-run-list');
        if (!runList) return;

        // Who the list is for, settled before the store is read rather than
        // after it: a character switch landing inside that read used to move
        // the answer, and the list — with the dungeon and team dropdowns built
        // from it — was rewritten for the arriving character inside the
        // departing character's panel.
        const character = currentCharacter();

        try {
            // Get all runs from unified storage, narrowed to whoever the
            // character filter says the panel is speaking for. Everything below
            // — the dungeon and team dropdowns included — is built from that
            // narrowed list, so the choices offered are choices that have runs.
            const allRuns = filterRunsForCharacter(
                await dungeonTrackerStorage.getAllRuns(),
                this.state.filterCharacter,
                character
            );

            // Dropdown options and an auto-scoped selection are both built from
            // the whole (character-narrowed) list, before the dungeon/tier/team
            // filters below narrow it further — otherwise a run auto-scoped to a
            // dungeon+tier with no matching history yet took the "no runs match
            // filters" branch below before ever reaching this, and the dropdown
            // was left showing whatever it had before (usually "All Dungeons"),
            // silently disagreeing with the state the header was actually using.
            const dungeons = [...new Set(allRuns.map((r) => r.dungeonName).filter(Boolean))].sort();
            const teams = [...new Set(allRuns.map((r) => r.teamKey).filter(Boolean))].sort();
            const tiers = [...new Set(allRuns.map((r) => r.tier).filter((t) => t !== null && t !== undefined))].sort(
                (a, b) => a - b
            );
            if (this.updateFilterDropdowns(container, dungeons, teams, tiers)) this.filtersReset = true;

            if (allRuns.length === 0) {
                runList.innerHTML =
                    '<div style="color: #888; font-style: italic; text-align: center; padding: 8px;">No runs yet</div>';
                // Import has to be reachable even with nothing recorded yet —
                // that is exactly when restoring a backup is the point
                runList.prepend(this.historyBackupBar());
                return;
            }

            // Apply filters. Read back from state rather than the arguments
            // above: updateFilterDropdowns may just have reset a stale manual
            // filter to 'all'.
            let filteredRuns = allRuns;
            if (this.state.filterDungeon !== 'all') {
                filteredRuns = filteredRuns.filter((r) => r.dungeonName === this.state.filterDungeon);
            }
            if (this.state.filterTier !== 'all') {
                filteredRuns = filteredRuns.filter((r) => String(r.tier) === this.state.filterTier);
            }
            if (this.state.filterTeam !== 'all') {
                filteredRuns = filteredRuns.filter((r) => r.teamKey === this.state.filterTeam);
            }

            if (filteredRuns.length === 0) {
                runList.innerHTML =
                    '<div style="color: #888; font-style: italic; text-align: center; padding: 8px;">No runs match filters</div>';
                runList.prepend(this.historyBackupBar());
                return;
            }

            // Group runs
            const groups =
                this.state.groupBy === 'team' ? this.groupByTeam(filteredRuns) : this.groupByDungeon(filteredRuns);

            // Trends are per dungeon+tier, so they are computed from the runs
            // the filters allowed rather than from whichever grouping the
            // panel happens to be showing. Memoised on the run list, so a
            // redraw that changed nothing recomputes nothing.
            const { groups: trendGroups, deltas } = trendsFor(filteredRuns);

            // The groups get a container of their own inside the list:
            // "Show N more" redraws just that subtree, so the bars prepended
            // below survive paging instead of being replaced with it.
            const groupsEl = document.createElement('div');
            groupsEl.className = 'mwi-dt-groups';
            runList.innerHTML = '';
            runList.appendChild(groupsEl);
            this.renderGroupedRuns(groupsEl, groups, deltas);

            runList.prepend(this.trendsBlock(trendGroups));

            // The export bars sit inside the list they describe, so the redraw
            // that replaces the list replaces them with it. The CSV rows come
            // from the grouped data at click time — what the filters allowed,
            // in the order the groups hold it — never from the DOM. The JSON
            // backup bar is filter-independent — see `historyBackupBar`.
            runList.prepend(this.csvExportBar(groups.flatMap((group) => group.runs)));
            runList.prepend(this.historyBackupBar());
        } catch (error) {
            console.error('[Dungeon Tracker UI History] Update error:', error);
            runList.innerHTML =
                '<div style="color: #ff6b6b; text-align: center; padding: 8px;">Error loading run history</div>';
        }
    }

    /**
     * Update filter dropdown options
     * @param {HTMLElement} container - Main container element
     * @param {Array} dungeons - List of dungeon names
     * @param {Array} teams - List of team keys
     * @returns {boolean} Whether a stale filter was reset to 'all'
     */
    updateFilterDropdowns(container, dungeons, teams, tiers = []) {
        let reset = false;
        // Update dungeon filter. Restored from state, not the DOM's own live
        // value — `autoScopeToRun` writes state directly, and reading the DOM
        // here would miss that until something else re-synced the select first.
        const dungeonFilter = container.querySelector('#mwi-dt-filter-dungeon');
        if (dungeonFilter) {
            const desired = this.state.filterDungeon;
            // Auto-scoped to a dungeon with no saved runs yet (its first-ever run,
            // or the only runs so far are a different character's): offer it as
            // its own option rather than silently falling back to "All Dungeons"
            // for lack of history. A manually-chosen dungeon gets no such pass —
            // if its runs are gone (e.g. deleted), the filter really is stale.
            const isAutoScoped = desired !== 'all' && !this.state.isDungeonFilterManual;
            const options = isAutoScoped && !dungeons.includes(desired) ? [...dungeons, desired].sort() : dungeons;
            dungeonFilter.innerHTML =
                '<option value="all">All Dungeons</option>' +
                options
                    .map(
                        (dungeon) => `<option value="${this.escapeHtml(dungeon)}">${this.escapeHtml(dungeon)}</option>`
                    )
                    .join('');
            if (desired === 'all' || options.includes(desired)) {
                dungeonFilter.value = desired;
            } else {
                this.state.filterDungeon = 'all';
                reset = true;
                // Reset, not just discarded: clearing the manual flag lets
                // auto-scope resume choosing this dimension on the next run.
                this.state.isDungeonFilterManual = false;
                dungeonFilter.value = 'all';
            }
        }

        // Update tier filter
        const tierFilter = container.querySelector('#mwi-dt-filter-tier');
        if (tierFilter) {
            // Restore from state, not the DOM, so a saved tier survives a reload
            // (the select is rebuilt back to "All Tiers" each render).
            const desired = String(this.state.filterTier);
            // Same auto-scope pass as the dungeon filter above, for a tier this
            // dungeon has no history at yet.
            const isAutoScoped = desired !== 'all' && !this.state.isTierFilterManual;
            const tierStrs = tiers.map(String);
            const options =
                isAutoScoped && !tierStrs.includes(desired) ? [...tiers, Number(desired)].sort((a, b) => a - b) : tiers;
            // Built with DOM properties, not `innerHTML` — a tier is only
            // ever supposed to be a small integer, but nothing here re-checks
            // that a stored run actually kept to it, and `.value`/.textContent`
            // can never be read back as markup the way a template-literal
            // attribute string can.
            tierFilter.replaceChildren();
            const allTiersOption = document.createElement('option');
            allTiersOption.value = 'all';
            allTiersOption.textContent = 'All Tiers';
            tierFilter.appendChild(allTiersOption);
            for (const tier of options) {
                const option = document.createElement('option');
                option.value = String(tier);
                option.textContent = `T${tier}`;
                tierFilter.appendChild(option);
            }
            if (desired === 'all' || options.map(String).includes(desired)) {
                tierFilter.value = desired;
            } else {
                // The saved tier no longer exists in the data — fall back to all,
                // and clear the manual flag so auto-scope can resume for tier.
                this.state.filterTier = 'all';
                reset = true;
                this.state.isTierFilterManual = false;
                tierFilter.value = 'all';
            }
        }

        // Update team filter
        const teamFilter = container.querySelector('#mwi-dt-filter-team');
        if (teamFilter) {
            // From state, like the dungeon and tier above: the select is rebuilt to
            // "All Teams" on every render, so its own value lost a saved team on reload
            const desired = this.state.filterTeam;
            teamFilter.innerHTML =
                '<option value="all">All Teams</option>' +
                teams
                    .map((team) => `<option value="${this.escapeHtml(team)}">${this.escapeHtml(team)}</option>`)
                    .join('');
            // Restore selection if still valid
            if (desired === 'all' || teams.includes(desired)) {
                teamFilter.value = desired;
            } else {
                this.state.filterTeam = 'all';
                reset = true;
                teamFilter.value = 'all';
            }
        }
        return reset;
    }

    /**
     * A group header label, with team-member names individually clickable.
     *
     * Only the team grouping's headers are player lists ("Aster,Briar,cove");
     * dungeon headers and the Solo bucket come back escaped but unwrapped. The
     * wrap keeps the label's exact text, with each valid player name in its own
     * span that fills "/profile <name>" into chat when clicked.
     *
     * @param {Object} group - A group from groupByTeam/groupByDungeon
     * @returns {string} HTML for the header label
     */
    renderGroupLabel(group) {
        if (this.state.groupBy !== 'team' || group.key === 'Solo') {
            return this.escapeHtml(group.label);
        }

        return String(group.label)
            .split(',')
            .map((name) => {
                // A malformed name gets no click handler — plain text, never a
                // broken /profile command
                if (!VALID_PLAYER_NAME_RE.test(name)) return this.escapeHtml(name);
                const escaped = this.escapeHtml(name);
                return (
                    `<span class="mwi-dt-player-name" data-player-name="${escaped}" style="cursor: pointer; ` +
                    `text-decoration: underline dotted; text-underline-offset: 2px;" ` +
                    `title="Open ${escaped}'s profile">${escaped}</span>`
                );
            })
            .join(',');
    }

    /**
     * The trends block: one compact line per dungeon+tier.
     *
     * Duration only. The stored run shape records how long a run took and who
     * spent which keys, and says nothing about what a run paid out, so this
     * block makes no claim about earnings — see `dungeon-tracker-trends.js`.
     *
     * @param {Array<Object>} trendGroups - From `trendsFor`
     * @returns {HTMLElement} The block
     */
    trendsBlock(trendGroups) {
        const block = document.createElement('div');
        block.dataset.dungeonTrends = 'true';
        block.style.cssText =
            'border: 1px solid #444; border-radius: 4px; padding: 6px; margin: 0 0 6px 0; font-size: 10px;';

        const heading = document.createElement('div');
        heading.textContent = 'Trends';
        heading.title =
            `Average run time over the last ${TREND_WINDOW} runs against the ${TREND_WINDOW} before, ` +
            'per dungeon and tier.';
        heading.style.cssText = 'font-weight: bold; color: #4a9eff; margin-bottom: 4px;';
        block.appendChild(heading);

        if (!trendGroups.length) {
            const empty = document.createElement('div');
            empty.textContent = NOT_ENOUGH_RUNS;
            empty.style.cssText = 'color: #888; font-style: italic;';
            block.appendChild(empty);
            return block;
        }

        for (const group of trendGroups) {
            const row = document.createElement('div');
            row.dataset.trendKey = group.key;
            row.style.cssText = 'display: flex; justify-content: space-between; gap: 6px; padding: 1px 0;';

            const label = document.createElement('span');
            label.textContent = group.label;
            label.style.cssText = 'color: #ddd;';
            row.appendChild(label);

            const figures = document.createElement('span');
            figures.style.cssText = 'color: #aaa; text-align: right;';
            figures.textContent = this.trendFigures(group.trend);
            row.appendChild(figures);

            block.appendChild(row);
        }

        return block;
    }

    /**
     * One group's figures as text.
     *
     * A group without enough runs says so instead of quoting a rate, and a
     * group with no earlier window quotes its rate without inventing a
     * comparison for it.
     *
     * @param {Object} trend - From `computeTrend`
     * @returns {string} The figures
     */
    trendFigures(trend) {
        if (!trend.enough) return `${NOT_ENOUGH_RUNS} (${trend.runCount})`;

        const parts = [`avg ${this.formatTime(trend.recentAvgMs)}`];

        if (trend.direction) {
            const percent = Math.abs(trend.changePercent).toFixed(1);
            const word = trend.direction === 'flat' ? 'flat' : `${percent}% ${trend.direction}`;
            parts.push(`${directionMarker(trend.direction)} ${word} vs earlier runs`);
        } else {
            parts.push('no earlier window yet');
        }

        if (trend.runsPerHour !== null) parts.push(`${trend.runsPerHour.toFixed(1)} runs/hr`);

        return parts.join(' | ');
    }

    /**
     * A single run against the rolling average of the five before it.
     *
     * @param {Object|null} delta - From `buildRunDeltas`, or null when the run
     *   has too little history behind it to be compared
     * @returns {string} HTML for the marker, or an empty string
     */
    renderDeltaMarker(delta) {
        if (!delta) return '';

        const colors = { faster: '#6bcf7f', slower: '#ff6b6b', flat: '#888' };
        const percent = Math.abs(delta.percent).toFixed(0);
        const text = delta.direction === 'flat' ? '→ even' : `${directionMarker(delta.direction)} ${percent}%`;

        return (
            `<span class="mwi-dt-run-delta" style="color: ${colors[delta.direction]}; font-size: 9px; ` +
            `margin-right: 6px;" title="Against the rolling average of the previous 5 runs">` +
            `${this.escapeHtml(text)}</span>`
        );
    }

    /**
     * An Export CSV bar for the run list.
     *
     * Only built when there are runs to write — `update` bails out before this
     * on an empty or fully filtered-out list, so an exportless empty state
     * never shows a button with nothing behind it.
     *
     * @param {Array} runs - The runs the current grouping holds, in group order
     * @returns {HTMLElement} The bar
     */
    csvExportBar(runs) {
        const bar = document.createElement('div');
        bar.dataset.csvExport = 'dungeon-runs';
        bar.style.cssText = 'display: flex; justify-content: flex-end; margin: 0 0 6px 0;';

        const button = document.createElement('button');
        button.textContent = 'Export CSV';
        button.title = 'Save the listed runs as a spreadsheet — one row per run, raw numbers.';
        button.style.cssText =
            'background: none; border: 1px solid #555; color: #aaa; border-radius: 2px; ' +
            'font-size: 9px; padding: 1px 6px; cursor: pointer;';
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            try {
                const rows = buildRunHistoryRows(runs);
                if (!rows.length) return;
                downloadCsv(csvFilename('dungeon-runs'), toCsv(rows, DUNGEON_RUN_CSV_COLUMNS));
            } catch (error) {
                console.error('[Dungeon Tracker UI History] CSV export failed:', error);
            }
        });

        bar.appendChild(button);
        return bar;
    }

    /**
     * An Export / Import bar for a lossless JSON backup of the run history.
     *
     * Unlike {@link csvExportBar}, this is not built from whatever the current
     * filters allow — Export always reads this character's whole stored
     * history fresh from storage, unfiltered by the panel's dungeon, tier or
     * team dropdowns, because a backup that quietly left out runs the panel
     * happened to be filtering when it was pressed would not be a backup.
     * Always present, even on an empty list: an empty history is exactly when
     * importing a backup is the point.
     *
     * @returns {HTMLElement} The bar
     */
    historyBackupBar() {
        const bar = document.createElement('div');
        bar.dataset.jsonBackup = 'dungeon-runs';
        bar.style.cssText = 'display: flex; justify-content: flex-end; gap: 6px; margin: 0 0 6px 0;';

        const buttonStyle =
            'background: none; border: 1px solid #555; color: #aaa; border-radius: 2px; ' +
            'font-size: 9px; padding: 1px 6px; cursor: pointer;';

        const exportButton = document.createElement('button');
        exportButton.textContent = 'Export';
        exportButton.title =
            'Download a JSON backup of the runs THIS CHARACTER recorded, for re-importing later. ' +
            'For every character at once, use "Back Up Everything" in Settings instead.';
        exportButton.style.cssText = buttonStyle;
        exportButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this.exportRunHistoryBackup().catch((error) => {
                console.error('[Dungeon Tracker UI History] JSON export failed:', error);
            });
        });
        bar.appendChild(exportButton);

        const importButton = document.createElement('button');
        importButton.textContent = 'Import';
        importButton.title =
            'Restore runs from a JSON backup and merge them into the history — a run already present adds nothing';
        importButton.style.cssText = buttonStyle;
        importButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this.triggerImportBackup();
        });
        bar.appendChild(importButton);

        return bar;
    }

    /**
     * Download this character's stored run history as a JSON backup — every
     * field, for every run `recordedBy` this character (the same "This
     * character" scope the panel's own character filter uses), unfiltered by
     * whatever the panel's dungeon/tier/team dropdowns currently show. Not the
     * whole account: every character's runs in one file are already reachable
     * through Settings' full backup, which walks every store rather than one
     * character's slice of one.
     *
     * Refuses rather than downloading when the store could not be read:
     * `getRunsForCharacterOrNull` — not the ordinary `getRunsForCharacter`,
     * which turns that same failure into an empty array for a display that
     * has nothing better to show — is what lets this tell "there is no
     * history" from "the read failed" apart. A valid-looking empty backup
     * downloaded from the second case is worse than no file at all.
     * @returns {Promise<void>}
     */
    async exportRunHistoryBackup() {
        const characterId = currentCharacter().id;
        const runs = await dungeonTrackerStorage.getRunsForCharacterOrNull('mine');
        if (runs === null) {
            alert('Export refused: the stored run history could not be read. Nothing was downloaded.');
            return;
        }
        // Import refuses a file over its run or byte ceiling, so the export
        // stays inside both and says so when it had to leave the oldest out.
        const { text, omitted } = serializeBackupWithinLimits({ characterId, runs });
        downloadFile(dungeonRunsBackupFilename(), text, 'application/json;charset=utf-8;');
        if (omitted > 0) {
            alert(
                `The backup holds your newest ${(runs.length - omitted).toLocaleString()} runs. The older ` +
                    `${omitted.toLocaleString()} were left out because a backup can hold at most ` +
                    `${MAX_IMPORT_RUNS.toLocaleString()} runs and ${Math.round(MAX_IMPORT_FILE_BYTES / (1024 * 1024))} MB.`
            );
        }
    }

    /**
     * Open a file picker for a JSON backup and import whatever is chosen.
     *
     * A single hidden `<input type="file">` is reused across openings rather
     * than recreated each time, and its value is cleared after every change so
     * picking the same file twice in a row still fires `change`. Removed by
     * {@link dispose}, whose own doc comment says why that matters; the
     * `change` handler checks `this.disposed` too, for the file already
     * chosen through a picker dialog that was still open when teardown ran.
     */
    triggerImportBackup() {
        if (!this.importInput) {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.style.display = 'none';
            input.addEventListener('change', async (event) => {
                const file = event.target.files?.[0];
                input.value = '';
                if (!file || this.disposed) return;
                await this.importBackupFile(file);
            });
            document.body.appendChild(input);
            this.importInput = input;
        }
        this.importInput.click();
    }

    /**
     * @param {File} file - The chosen file
     * @returns {Promise<void>}
     */
    async importBackupFile(file) {
        // Refused by size alone, before a byte of it is read — a genuine
        // export is roughly 0.7 KB per run compact (about 30,000 runs in the
        // whole limit), so a file this large is not
        // one worth reading into memory just to reject afterwards.
        if (file.size > MAX_IMPORT_FILE_BYTES) {
            const limitMb = Math.round(MAX_IMPORT_FILE_BYTES / (1024 * 1024));
            alert(
                `Import refused: the file is too large (${Math.ceil(file.size / (1024 * 1024))} MB; ` +
                    `limit is ${limitMb} MB).`
            );
            return;
        }

        let text;
        try {
            text = await file.text();
        } catch (error) {
            alert(`Could not read the file: ${error.message}`);
            return;
        }
        // Re-checked here, not just by the `change` handler that called this:
        // `file.text()` is itself an await a teardown can land inside — a
        // character switch mid-read disposes this section while a large file
        // is still being decoded — and `this.state`/`this.onImportCallback`
        // describe whoever the panel belongs to now, not whoever picked the
        // file.
        if (this.disposed) return;
        await this.importBackupText(text);
    }

    /**
     * Validate and merge a JSON backup's runs into the stored history, after a
     * confirmation summary. Nothing is written until the user confirms, and
     * any refusal below leaves storage untouched.
     *
     * **The character-swap race class**: the active character is captured
     * before the first `await` and re-checked right before the write, the same
     * guard `alchemy-session-import.js`'s viewers use — a change anywhere in
     * that window (a confirm dialog can sit open indefinitely) cancels the
     * import rather than merging a payload built for one character's panel
     * into whatever history happens to be current when it finally lands.
     *
     * **Ownership is never rewritten.** An imported run keeps the
     * `recordedBy` it already carries — the character it was actually
     * recorded under, possibly not this one — because that is a fact about
     * who ran it, not about who is doing the importing. A run recorded by
     * someone else shows up under "All characters" in this panel, never under
     * "This character", however it arrived here.
     *
     * @param {string} text - The file's raw contents
     * @returns {Promise<void>}
     */
    async importBackupText(text) {
        // Captured before any further await — see the race note above
        const charIdBefore = currentCharacter().id;

        const parsed = parseDungeonRunsJson(text);
        if (!parsed.ok) {
            alert(`Import refused: ${parsed.error}`);
            return;
        }

        const envelope = parsed.envelope;
        const envelopeCheck = validateDungeonRunsEnvelope(envelope);
        if (!envelopeCheck.ok) {
            alert(`Import refused: ${envelopeCheck.error}`);
            return;
        }

        if (envelope.characterId && envelope.characterId !== charIdBefore) {
            const proceed = confirm(
                `This backup was exported from a different character (${envelope.characterId}), ` +
                    `not the current one (${charIdBefore}).\n\n` +
                    `The runs keep their original owner — they will show up under "All characters" in this ` +
                    `panel, not under "This character".\n\nImport them anyway?`
            );
            if (!proceed) return;
        }

        const { valid, rejected } = planDungeonRunImport(envelope.runs);

        if (currentCharacter().id !== charIdBefore) {
            alert('The active character changed during import — cancelled to avoid writing to the wrong character.');
            return;
        }

        const confirmed = confirm(
            `Import ${envelope.runs.length} run(s) from the backup:\n` +
                `${valid.length} usable, ${rejected.length} rejected (bad or implausible).\n\nContinue?`
        );
        if (!confirmed) return;

        if (currentCharacter().id !== charIdBefore) {
            alert('The active character changed — import cancelled to avoid writing to the wrong character.');
            return;
        }

        const { added, alreadyPresent, ok } = await dungeonTrackerStorage.importRuns(valid);
        // A character switch disposing this section can land inside either
        // await above — this one, or the chat refresh below. Past this
        // point, `this.state` and `this.onImportCallback` describe whoever
        // the panel belongs to now, not whoever ran the import, and an alert
        // describing it would be talking about a panel nobody is looking at.
        if (this.disposed) return;

        // Runs land in memory before the write is even attempted (see
        // `importRuns`), so the panel and chat have something new to show
        // whenever `added` is positive — whether or not that write landed.
        // Leaving the redraw out on a failed write would hide a merge that
        // already happened and that `getAllRuns()` already reflects.
        if (added > 0) {
            // Chat annotation run numbers and cumulative averages are seeded
            // from stored history at load time and never revisited on their
            // own — the same reason Backfill and "Delete all history" both
            // refresh them (dungeon-tracker-ui-interactions.js). Without
            // this, the panel and storage would agree on the merged history
            // while chat kept counting from before the import.
            await dungeonTrackerChatAnnotations.refreshRunCounts();
            if (this.disposed) return;
            if (this.onImportCallback) this.onImportCallback();
        }

        if (!ok) {
            alert(
                added > 0
                    ? 'Import merged the runs, but the write to storage did not land — they may not survive a ' +
                          'reload. Try importing again.'
                    : 'Import failed: the stored history could not be read. Nothing was written.'
            );
            return;
        }

        alert(
            `Imported ${added} run(s), ${alreadyPresent} already present, ${rejected.length} rejected.` +
                (rejected.length ? `\n\nRejected: ${rejected.map((entry) => entry.reason).join('; ')}` : '')
        );
    }

    /**
     * Set callback for when a backup import lands, so the panel redraws and
     * recomputes stats from the merged history — the same refresh
     * {@link onDelete}'s callback triggers.
     * @param {Function} callback - Callback function
     */
    onImport(callback) {
        this.onImportCallback = callback;
    }

    /**
     * Render grouped runs
     * @param {HTMLElement} runList - Container the groups are drawn into; its
     *   whole content is replaced, so callers that keep sibling controls pass a
     *   dedicated child rather than the list itself
     * @param {Array} groups - Grouped runs with stats
     * @param {Map<string, Object>} [deltas] - Per-run deltas, keyed by `runIdentity`
     */
    renderGroupedRuns(runList, groups, deltas) {
        let html = '';

        for (const group of groups) {
            const avgTime = this.formatTime(group.stats.avgTime);
            const bestTime = this.formatTime(group.stats.fastestTime);
            const worstTime = this.formatTime(group.stats.slowestTime);

            // Check if this group is expanded
            const isExpanded = this.state.expandedGroups.has(group.label);
            const displayStyle = isExpanded ? 'block' : 'none';
            const toggleIcon = isExpanded ? '▲' : '▼';

            // How many of this group's runs "Show N more" has revealed so
            // far — capped to the group's own size so a group that shrank
            // (a delete) never tries to slice past its own end.
            const visibleCount = Math.min(
                this.visibleRunCounts.get(group.label) ?? MAX_RENDERED_RUNS_PER_GROUP,
                group.runs.length
            );

            html += `
                <div class="mwi-dt-group" style="
                    margin-bottom: 8px;
                    border: 1px solid #444;
                    border-radius: 4px;
                    padding: 8px;
                ">
                    <div style="
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 6px;
                        cursor: pointer;
                    " class="mwi-dt-group-header" data-group-label="${this.escapeHtml(group.label)}">
                        <div style="flex: 1;">
                            <div style="font-weight: bold; color: #4a9eff; margin-bottom: 2px;">
                                ${this.renderGroupLabel(group)}
                            </div>
                            <div style="font-size: 10px; color: #aaa;">
                                Runs: ${group.stats.totalRuns} | Avg: ${avgTime} | Best: ${bestTime} | Worst: ${worstTime}
                            </div>
                        </div>
                        <span class="mwi-dt-group-toggle" style="color: #aaa; font-size: 10px;">${toggleIcon}</span>
                    </div>
                    <div class="mwi-dt-group-runs" style="
                        display: ${displayStyle};
                        border-top: 1px solid #444;
                        padding-top: 6px;
                        margin-top: 4px;
                    ">
                        ${this.renderRunList(group.runs.slice(0, visibleCount), deltas, group.runs.length)}
                        ${this.renderShowMoreControl(group.label, visibleCount, group.runs.length)}
                    </div>
                </div>
            `;
        }

        runList.innerHTML = html;

        // "Show N more": grows just the one group clicked and redraws with
        // the same groups/deltas this call already has in scope — every run
        // stays reachable (and its delete button with it), just not all
        // rendered at once.
        runList.querySelectorAll('.mwi-dt-show-more').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                const label = btn.dataset.groupLabel;
                const group = groups.find((g) => g.label === label);
                if (!group) return;
                const current = this.visibleRunCounts.get(label) ?? MAX_RENDERED_RUNS_PER_GROUP;
                this.visibleRunCounts.set(label, Math.min(current + MAX_RENDERED_RUNS_PER_GROUP, group.runs.length));
                this.renderGroupedRuns(runList, groups, deltas);
            });
        });

        // Attach toggle handlers
        runList.querySelectorAll('.mwi-dt-group-header').forEach((header) => {
            header.addEventListener('click', () => {
                const groupLabel = header.dataset.groupLabel;
                const runsDiv = header.nextElementSibling;
                const toggle = header.querySelector('.mwi-dt-group-toggle');

                if (runsDiv.style.display === 'none') {
                    runsDiv.style.display = 'block';
                    toggle.textContent = '▲';
                    this.state.expandedGroups.add(groupLabel);
                } else {
                    runsDiv.style.display = 'none';
                    toggle.textContent = '▼';
                    this.state.expandedGroups.delete(groupLabel);
                }
            });
        });

        // Player-name clicks fill "/profile <name>" into chat. Stopped, so the
        // click does not also toggle the group open or shut underneath it.
        runList.querySelectorAll('.mwi-dt-player-name').forEach((el) => {
            el.addEventListener('click', (event) => {
                event.stopPropagation();
                openPlayerProfile(el.dataset.playerName, { logPrefix: 'DungeonHistory' });
            });
        });

        // Attach delete handlers
        runList.querySelectorAll('.mwi-dt-delete-run').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                const row = e.target.closest('[data-run-timestamp]');

                // Full identity, not the timestamp: an imported partymate's
                // record of the same run can share it and is a different run.
                await dungeonTrackerStorage.deleteRun(row.dataset.runIdentity);

                // A teardown landing inside that await has already disposed
                // this section (and nulled onDeleteCallback below, belt and
                // suspenders) — nothing left here should reach for the panel
                // this section no longer belongs to.
                if (this.disposed) return;

                // Trigger refresh via callback
                if (this.onDeleteCallback) {
                    this.onDeleteCallback();
                }
            });
        });
    }

    /**
     * Render individual run list
     * @param {Array} runs - The runs to render — possibly only the most
     *   recent slice of a larger group, in which case `totalCount` says how
     *   many the group actually holds
     * @param {Map<string, Object>} [deltas] - Per-run deltas, keyed by `runIdentity`
     * @param {number} [totalCount] - The group's true run count, for
     *   numbering; defaults to `runs.length` when the caller passed the
     *   whole group
     * @returns {string} HTML for run list
     */
    renderRunList(runs, deltas, totalCount = runs.length) {
        let html = '';
        runs.forEach((run, index) => {
            const runNumber = totalCount - index;
            const timeStr = this.formatTime(run.duration || run.totalTime || 0);
            // A solo run is timed by this client's clock rather than the server's
            // party timestamps. Marked, so the two are never read as equal evidence.
            const clientTimed = run.validated === false;
            const timeMark = clientTimed
                ? ' <span style="color: #ffc107; font-size: 9px;" title="Timed by this client’s clock ' +
                  '(solo run — no party timestamps to check it against)">~</span>'
                : '';
            const dateObj = new Date(run.timestamp);
            const dateTime = formatDateTime(dateObj);
            const dungeonLabel = run.dungeonName || 'Unknown';
            const delta = deltas?.get(runIdentity(run)) || null;

            html += `
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 4px 0;
                    border-bottom: 1px solid #333;
                    font-size: 10px;
                " data-run-timestamp="${this.escapeHtml(run.timestamp)}" data-run-identity="${this.escapeHtml(runIdentity(run))}">
                    <span style="color: #aaa; min-width: 25px;">#${runNumber}</span>
                    <span style="color: #fff; flex: 1; text-align: center;">
                        ${timeStr}${timeMark} <span style="color: #888; font-size: 9px;">(${dateTime})</span>
                    </span>
                    ${this.renderDeltaMarker(delta)}
                    <span style="color: #888; margin-right: 6px; font-size: 9px;">${this.escapeHtml(dungeonLabel)}</span>
                    <button class="mwi-dt-delete-run" style="
                        background: none;
                        border: 1px solid #ff6b6b;
                        color: #ff6b6b;
                        cursor: pointer;
                        font-size: 9px;
                        padding: 1px 4px;
                        border-radius: 2px;
                        font-weight: bold;
                    " title="Delete this run">✕</button>
                </div>
            `;
        });
        return html;
    }

    /**
     * The "showing latest N of M" note plus a "Show N more" button, for a
     * group whose run list is not fully rendered yet. Empty string once
     * `visibleCount` has caught up to `totalCount`, so a normal-sized group —
     * or one paged all the way open — renders nothing extra. Every run stays
     * reachable this way, delete button included, just not all rendered at
     * once: the cap this replaces made anything past the first
     * {@link MAX_RENDERED_RUNS_PER_GROUP} runs impossible to even see, let
     * alone delete.
     *
     * @param {string} groupLabel - The group this control belongs to, so its
     *   click handler knows which group to grow
     * @param {number} visibleCount - How many of the group's runs are
     *   rendered right now
     * @param {number} totalCount - The group's true run count
     * @returns {string} HTML for the note and button, or `''`
     */
    renderShowMoreControl(groupLabel, visibleCount, totalCount) {
        if (visibleCount >= totalCount) return '';
        const nextBatch = Math.min(MAX_RENDERED_RUNS_PER_GROUP, totalCount - visibleCount);
        return `
            <div style="text-align: center; padding: 6px 0;">
                <div style="color: #888; font-style: italic; font-size: 9px; margin-bottom: 4px;">
                    Showing latest ${visibleCount} of ${totalCount} — Export for the full list
                </div>
                <button class="mwi-dt-show-more" data-group-label="${this.escapeHtml(groupLabel)}" style="
                    background: none;
                    border: 1px solid #555;
                    color: #aaa;
                    border-radius: 2px;
                    font-size: 9px;
                    padding: 2px 8px;
                    cursor: pointer;
                ">Show ${nextBatch} more</button>
            </div>
        `;
    }

    /**
     * Set callback for when a run is deleted
     * @param {Function} callback - Callback function
     */
    onDelete(callback) {
        this.onDeleteCallback = callback;
    }
}

export default DungeonTrackerUIHistory;
