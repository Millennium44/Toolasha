/**
 * Lab Sim comparison runs
 *
 * A single-target labyrinth run answers one question — "does this clear?" — and
 * the answer is only interesting next to another answer. The combat sim panel
 * already learned this: it keeps the last several runs, lets one be pinned as
 * the baseline, and prints every other run as a delta against it. This is the
 * same idea for the lab panel's single-target fights, kept in its own file so
 * the shape (what a recorded run is, how it is labelled, how a delta is
 * coloured, how the table is drawn and wired) lives in one place rather than
 * being smeared through a 3500-line panel.
 *
 * Two differences from the combat sim's version, both of them the labyrinth's
 * doing:
 *
 * - The headline metrics are win rate, expected tries to clear (1/win rate, the
 *   figure the all-fights analysis ranks by, because the labyrinth lets you
 *   retry a room) and deaths per hundred attempts. Raw death counts are not
 *   comparable across runs of different lengths, so they are normalised.
 * - The runs survive a reload. A combat sim history is a working set inside one
 *   sitting; a labyrinth comparison is usually "is the gear I bought last week
 *   better", which does not fit in one sitting.
 */

import storage from '../../core/storage.js';
import { characterKey } from '../../utils/character-key.js';
import { formatWithSeparator } from '../../utils/formatters.js';

/** Where recorded runs live, in the shared settings store. */
export const LAB_COMPARISON_KEY = 'labSimComparisonRuns';

/** Which recorded run is pinned as the baseline, by id. */
export const LAB_COMPARISON_BASELINE_KEY = 'labSimComparisonBaseline';

/**
 * How many runs are kept.
 *
 * The same ten the combat sim keeps. Past that the table stops being something
 * you can read at a glance, which is the only thing it is for.
 */
export const MAX_LAB_COMPARISON_RUNS = 10;

const ACCENT = '#4a9eff';
const GOOD = '#7ec87e';
const BAD = '#ff6b6b';

/**
 * The metrics a recorded run is compared on.
 *
 * `epsilon` is the movement below which a delta is not printed at all: a
 * hundredth of a percent of win rate is sampling noise wearing a plus sign, and
 * a table full of those reads as a table full of findings.
 */
export const LAB_COMPARISON_METRICS = [
    {
        key: 'winRate',
        label: 'Win %',
        title: 'Share of labyrinth attempts that cleared the room',
        higherIsBetter: true,
        format: (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(2)}%`),
        formatDelta: (delta) => `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(2)}%`,
        epsilon: 0.00005,
    },
    {
        key: 'tries',
        label: 'Tries',
        title: 'Expected attempts to clear the room once (1 / win rate) — lower is better',
        higherIsBetter: false,
        format: (value) => (Number.isFinite(value) ? value.toFixed(2) : '—'),
        formatDelta: (delta) => `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`,
        epsilon: 0.005,
    },
    {
        key: 'deathsPer100',
        label: 'Deaths/100',
        title: 'Deaths per hundred attempts — normalised so runs of different lengths compare',
        higherIsBetter: false,
        format: (value) => (Number.isFinite(value) ? value.toFixed(2) : '—'),
        formatDelta: (delta) => `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`,
        epsilon: 0.005,
    },
];

/**
 * A monster hrid rendered the way the rest of the panel renders one.
 * @param {string} hrid - e.g. `/monsters/gobo_chief`
 * @returns {string} e.g. `Gobo Chief`
 */
export function labMonsterName(hrid) {
    if (!hrid) return 'Unknown';
    return hrid
        .split('/')
        .pop()
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Escape text that is about to be interpolated into the table's HTML.
 *
 * Loadout names are user-supplied, and a run recorded under a name with an
 * angle bracket in it should show the bracket rather than close the cell.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * The one-line name a recorded run goes by in the baseline picker and the table.
 * @param {Object} settings - From `makeLabRunEntry`
 * @returns {string}
 */
export function labRunLabel(settings = {}) {
    const parts = [`${settings.monsterName || labMonsterName(settings.monsterHrid)} L${settings.roomLevel ?? '?'}`];
    if (settings.gearLabel && settings.gearLabel !== 'Current Gear') parts.push(settings.gearLabel);
    if (settings.taskFight) parts.push('task fight');
    return parts.join(' · ');
}

/**
 * The settings behind a run, spelled out for the row's tooltip.
 *
 * The label has to fit in a cell, so it drops the things that are usually the
 * same between two runs and occasionally are not — the hours, the crates. Those
 * are exactly what you want when a delta surprises you.
 * @param {Object} entry - A recorded run
 * @returns {string} Plain text
 */
export function describeLabRun(entry) {
    const settings = entry?.settings || {};
    const metrics = entry?.metrics || {};
    const crates = (settings.crates || [])
        .map((hrid) =>
            hrid
                .split('/')
                .pop()
                .replace(/_crate$/, '')
        )
        .join(', ');
    const when = entry?.timestamp ? new Date(entry.timestamp).toLocaleString() : '';
    return [
        labRunLabel(settings),
        `Level ${settings.roomLevel ?? '?'} · ${settings.hours ?? '?'}h budget`,
        crates ? `Crates: ${crates}` : 'Crates: none',
        `${formatWithSeparator(metrics.attempts || 0)} attempts, ${formatWithSeparator(metrics.deaths || 0)} deaths`,
        when,
    ]
        .filter(Boolean)
        .join('\n');
}

/**
 * Turn a finished single-target run into the record the comparison keeps.
 *
 * Deliberately stores the raw counts alongside the derived rates: a rate with
 * no sample size behind it cannot be argued with, and a 100% win rate off four
 * attempts is not the same claim as one off four thousand.
 *
 * @param {Object} input
 * @param {string} input.monsterHrid - Labyrinth monster
 * @param {string} [input.monsterName] - Display name; derived from the hrid when absent
 * @param {number} input.roomLevel - Room level simulated
 * @param {number} input.hours - Hour budget the run was given
 * @param {boolean} [input.taskFight] - Whether taskDamage was applied
 * @param {string[]} [input.crates] - Crate hrids in force
 * @param {string} [input.gearLabel] - What the loadout was, from the editor
 * @param {number} [input.attempts] - Labyrinth attempts simulated
 * @param {number} [input.encounters] - Attempts that cleared
 * @param {number} [input.deaths] - Deaths across those attempts
 * @param {number} [input.simHours] - Hours actually simulated
 * @param {number} [input.timestamp] - When, defaulting to now
 * @returns {Object} A recorded run
 */
export function makeLabRunEntry({
    monsterHrid,
    monsterName,
    roomLevel,
    hours,
    taskFight = false,
    crates = [],
    gearLabel = '',
    attempts = 0,
    encounters = 0,
    deaths = 0,
    simHours = 0,
    timestamp = Date.now(),
} = {}) {
    const safeAttempts = Math.max(0, Math.round(Number(attempts) || 0));
    const safeEncounters = Math.max(0, Math.round(Number(encounters) || 0));
    const safeDeaths = Math.max(0, Math.round(Number(deaths) || 0));
    const winRate = safeAttempts > 0 ? safeEncounters / safeAttempts : 0;

    const settings = {
        monsterHrid: monsterHrid || '',
        monsterName: monsterName || labMonsterName(monsterHrid),
        roomLevel: Math.round(Number(roomLevel) || 0),
        hours: Math.round(Number(hours) || 0),
        taskFight: Boolean(taskFight),
        crates: [...crates],
        gearLabel: gearLabel || '',
    };

    return {
        // Ids rather than indices, because the baseline has to survive a delete
        // of the row above it and a reload that reorders nothing but could
        id: `${timestamp.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp,
        settings,
        label: labRunLabel(settings),
        metrics: {
            winRate,
            // No clears means no finite number of tries to a clear; null says so
            // where an Infinity would print as a very confident "∞"
            tries: winRate > 0 ? 1 / winRate : null,
            deathsPer100: safeAttempts > 0 ? (safeDeaths / safeAttempts) * 100 : 0,
            attempts: safeAttempts,
            encounters: safeEncounters,
            deaths: safeDeaths,
            simHours: Number(simHours) || 0,
        },
    };
}

/**
 * Whatever came back from storage, made safe to draw.
 *
 * Storage is shared with older versions of this script and with whatever a user
 * has poked at in devtools, so a stored value is input rather than data.
 * @param {*} raw - What storage returned
 * @returns {Object[]} Runs with the fields the table reads
 */
export function sanitizeLabRuns(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((entry) => entry && typeof entry === 'object' && entry.metrics)
        .map((entry, index) => ({
            id: typeof entry.id === 'string' && entry.id ? entry.id : `restored-${index}`,
            timestamp: Number(entry.timestamp) || 0,
            settings: entry.settings && typeof entry.settings === 'object' ? entry.settings : {},
            label: entry.label || labRunLabel(entry.settings || {}),
            metrics: {
                winRate: Number(entry.metrics.winRate) || 0,
                tries: Number.isFinite(entry.metrics.tries) ? entry.metrics.tries : null,
                deathsPer100: Number(entry.metrics.deathsPer100) || 0,
                attempts: Number(entry.metrics.attempts) || 0,
                encounters: Number(entry.metrics.encounters) || 0,
                deaths: Number(entry.metrics.deaths) || 0,
                simHours: Number(entry.metrics.simHours) || 0,
            },
        }))
        .slice(-MAX_LAB_COMPARISON_RUNS);
}

/**
 * A delta cell suffix, coloured by whether the move was in the good direction.
 *
 * Empty string when there is nothing to say — no baseline, an unmeasurable
 * value, or a move small enough to be the random seed rather than the gear.
 * @param {number|null} current
 * @param {number|null} previous
 * @param {Object} metric - One of `LAB_COMPARISON_METRICS`
 * @returns {string} HTML span, or ''
 */
export function formatLabDelta(current, previous, metric) {
    if (current === null || current === undefined || previous === null || previous === undefined) return '';
    const delta = Number(current) - Number(previous);
    if (!Number.isFinite(delta) || Math.abs(delta) < (metric.epsilon ?? 0)) return '';
    const isGood = metric.higherIsBetter ? delta > 0 : delta < 0;
    return ` <span style="color:${isGood ? GOOD : BAD}; font-size:11px;">(${metric.formatDelta(delta)})</span>`;
}

/**
 * The rows the comparison table draws, baseline first.
 *
 * Split out from the rendering so the ordering and the delta arithmetic can be
 * tested without a DOM, and so the CSV export and the table agree by
 * construction rather than by both being edited at the same time.
 * @param {Object[]} runs - Recorded runs
 * @param {string|null} baselineId - Pinned baseline
 * @returns {Array<{entry: Object, isBaseline: boolean, deltas: Object}>}
 */
export function labComparisonRows(runs, baselineId) {
    const list = Array.isArray(runs) ? runs : [];
    if (!list.length) return [];

    const baseline = list.find((entry) => entry.id === baselineId) || list[0];
    const ordered = [baseline, ...list.filter((entry) => entry !== baseline)];

    return ordered.map((entry) => ({
        entry,
        isBaseline: entry === baseline,
        deltas: Object.fromEntries(
            LAB_COMPARISON_METRICS.map((metric) => [
                metric.key,
                entry === baseline ? null : (entry.metrics?.[metric.key] ?? null),
            ])
        ),
        baselineMetrics: baseline.metrics,
    }));
}

/**
 * Draw the comparison section.
 *
 * Returns a string rather than nodes because the results pane it lands in is
 * built by `innerHTML` assignment; `wireLabComparisonPanel` then attaches the
 * behaviour once the string is in the document.
 *
 * @param {Object[]} runs - Recorded runs, oldest first
 * @param {string|null} baselineId - Pinned baseline, or null for "the first one"
 * @returns {string} HTML, or '' when there is nothing worth comparing
 */
export function renderLabComparisonPanel(runs, baselineId) {
    const rows = labComparisonRows(runs, baselineId);
    if (rows.length < 2) return '';

    const baselineEntry = rows[0].entry;

    let html = '<div style="margin-bottom:12px;" data-labsim-comparison>';
    html +=
        `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; ` +
        'user-select:none;" id="mwi-labsim-cmp-toggle">';
    html +=
        '<span id="mwi-labsim-cmp-arrow" style="display:inline-block; width:14px; font-size:10px;">&#9660;</span> ' +
        `Comparison (${rows.length} runs)`;
    html += '</div>';
    html += '<div id="mwi-labsim-cmp-body" style="display:block;">';

    // Baseline picker — the same control the combat sim's history panel uses,
    // because it is the same choice: which run everything else is read against
    html += '<div style="display:flex; align-items:center; gap:6px; margin-bottom:6px; font-size:11px;">';
    html += '<span style="color:#888;">Baseline:</span>';
    html +=
        '<select id="mwi-labsim-cmp-baseline" style="flex:1; background:#1a1a2e; color:#e0e0e0; ' +
        'border:1px solid #444; border-radius:4px; padding:1px 4px; font-size:11px; font-family:inherit;">';
    for (const entry of runs) {
        const selected = entry === baselineEntry ? ' selected' : '';
        html += `<option value="${escapeHtml(entry.id)}"${selected}>${escapeHtml(entry.label)}</option>`;
    }
    html += '</select>';
    html +=
        '<button id="mwi-labsim-cmp-clear" title="Forget every recorded run" style="background:#1a1a2e; ' +
        'color:#ff8a8a; border:1px solid #333; border-radius:3px; padding:2px 8px; font-size:11px; ' +
        'cursor:pointer; font-family:inherit; flex-shrink:0;">Clear All</button>';
    html += '</div>';

    html += '<table style="width:100%; font-size:11px; border-collapse:collapse;">';
    html += '<tr style="border-bottom:1px solid #333; color:#666;">';
    html += '<th style="text-align:left; padding:2px 4px;">Run</th>';
    for (const metric of LAB_COMPARISON_METRICS) {
        html += `<th style="text-align:right; padding:2px 4px;" title="${escapeHtml(metric.title)}">${metric.label}</th>`;
    }
    html +=
        '<th style="text-align:right; padding:2px 4px;" title="Attempts simulated — the sample the rates came off">Attempts</th>';
    html += '<th style="width:20px;"></th>';
    html += '</tr>';

    for (const row of rows) {
        const { entry, isBaseline, baselineMetrics } = row;
        const rowStyle = isBaseline ? ' style="background:rgba(74,158,255,0.10);"' : '';
        html += `<tr${rowStyle} data-labsim-cmp-row="${escapeHtml(entry.id)}">`;
        html +=
            `<td style="padding:2px 4px; color:${isBaseline ? ACCENT : '#ccc'}; max-width:200px; overflow:hidden; ` +
            `text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(describeLabRun(entry))}">` +
            `${isBaseline ? '★ ' : ''}${escapeHtml(entry.label)}</td>`;

        for (const metric of LAB_COMPARISON_METRICS) {
            const value = entry.metrics?.[metric.key] ?? null;
            const delta = isBaseline ? '' : formatLabDelta(value, baselineMetrics?.[metric.key] ?? null, metric);
            html += `<td style="text-align:right; padding:2px 4px; color:#e0e0e0;">${metric.format(value)}${delta}</td>`;
        }

        html +=
            '<td style="text-align:right; padding:2px 4px; color:#888;">' +
            formatWithSeparator(entry.metrics?.attempts || 0) +
            '</td>';
        html +=
            '<td style="text-align:center; padding:2px; cursor:pointer; color:#555;" ' +
            `data-labsim-cmp-delete="${escapeHtml(entry.id)}" title="Forget this run">✕</td>`;
        html += '</tr>';
    }

    html += '</table>';
    html += '</div></div>';
    return html;
}

/**
 * Attach the comparison section's behaviour to a container it was drawn into.
 *
 * @param {HTMLElement} container - Element whose innerHTML holds the panel
 * @param {Object} handlers
 * @param {Function} [handlers.onBaseline] - Called with the chosen run id
 * @param {Function} [handlers.onDelete] - Called with the run id to forget
 * @param {Function} [handlers.onClear] - Called with no arguments
 */
export function wireLabComparisonPanel(container, { onBaseline, onDelete, onClear } = {}) {
    if (!container) return;

    const toggle = container.querySelector('#mwi-labsim-cmp-toggle');
    const body = container.querySelector('#mwi-labsim-cmp-body');
    const arrow = container.querySelector('#mwi-labsim-cmp-arrow');
    if (toggle && body && arrow) {
        toggle.addEventListener('click', () => {
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : 'block';
            arrow.innerHTML = open ? '&#9654;' : '&#9660;';
        });
    }

    const baselineSelect = container.querySelector('#mwi-labsim-cmp-baseline');
    if (baselineSelect && onBaseline) {
        baselineSelect.addEventListener('change', () => onBaseline(baselineSelect.value));
    }

    const clearButton = container.querySelector('#mwi-labsim-cmp-clear');
    if (clearButton && onClear) clearButton.addEventListener('click', () => onClear());

    if (onDelete) {
        container.querySelectorAll('[data-labsim-cmp-delete]').forEach((cell) => {
            cell.addEventListener('click', (event) => {
                event.stopPropagation();
                onDelete(cell.getAttribute('data-labsim-cmp-delete'));
            });
        });
    }
}

/**
 * The recorded runs, and which one is the baseline.
 *
 * A tiny store rather than three fields on the panel: the panel already carries
 * a dozen pieces of run state, and the part that has to be written to storage
 * on every change is the part most likely to be forgotten in one of the paths
 * that changes it.
 */
export class LabComparisonStore {
    constructor() {
        /** @type {Object[]} Oldest first */
        this.runs = [];
        /** @type {string|null} */
        this.baselineId = null;
        this._loaded = false;
    }

    /**
     * Read the runs back from storage. Safe to call repeatedly; only the first
     * call reaches the database.
     * @returns {Promise<Object[]>} The runs
     */
    async load() {
        if (this._loaded) return this.runs;
        this._loaded = true;
        try {
            this.runs = sanitizeLabRuns(await storage.get(characterKey(LAB_COMPARISON_KEY), 'settings', null));
            const savedBaseline = await storage.get(characterKey(LAB_COMPARISON_BASELINE_KEY), 'settings', null);
            this.baselineId = this.runs.some((entry) => entry.id === savedBaseline) ? savedBaseline : null;
        } catch (error) {
            console.error('[LabSimComparison] Failed to load recorded runs:', error);
            this.runs = [];
            this.baselineId = null;
        }
        return this.runs;
    }

    /**
     * Record a finished run, evicting the oldest once the window is full.
     * @param {Object} entry - From `makeLabRunEntry`
     * @returns {Promise<Object[]>} The runs
     */
    async add(entry) {
        if (!entry) return this.runs;
        this.runs.push(entry);
        while (this.runs.length > MAX_LAB_COMPARISON_RUNS) {
            const evicted = this.runs.shift();
            if (evicted.id === this.baselineId) this.baselineId = null;
        }
        // The first run has nothing to compare against, so the second is where a
        // baseline starts to mean something — and the oldest is the one people
        // mean by "before"
        if (!this.baselineId && this.runs.length > 1) this.baselineId = this.runs[0].id;
        await this._persist();
        return this.runs;
    }

    /**
     * Pin a run as the baseline.
     * @param {string} id - Run id
     * @returns {Promise<void>}
     */
    async setBaseline(id) {
        if (!this.runs.some((entry) => entry.id === id)) return;
        this.baselineId = id;
        await this._persist();
    }

    /**
     * Forget one run. Deleting the baseline falls back to the oldest survivor;
     * deleting down to a single run unpins entirely, since one run is not a
     * comparison and the pin would only be a stale answer waiting for the next.
     * @param {string} id - Run id
     * @returns {Promise<Object[]>} The runs
     */
    async remove(id) {
        const before = this.runs.length;
        this.runs = this.runs.filter((entry) => entry.id !== id);
        if (this.runs.length === before) return this.runs;
        if (this.runs.length <= 1) {
            this.baselineId = null;
        } else if (this.baselineId === id) {
            this.baselineId = this.runs[0].id;
        }
        await this._persist();
        return this.runs;
    }

    /**
     * Forget everything.
     * @returns {Promise<void>}
     */
    async clear() {
        this.runs = [];
        this.baselineId = null;
        await this._persist();
    }

    /**
     * The baseline run, or null.
     * @returns {Object|null}
     */
    baseline() {
        return this.runs.find((entry) => entry.id === this.baselineId) || this.runs[0] || null;
    }

    /** @private */
    async _persist() {
        try {
            // Keyed per character: a run is a comparison against one
            // character's gear, and the runs were recorded on this one.
            await storage.set(characterKey(LAB_COMPARISON_KEY), this.runs, 'settings');
            await storage.set(characterKey(LAB_COMPARISON_BASELINE_KEY), this.baselineId, 'settings');
        } catch (error) {
            console.error('[LabSimComparison] Failed to save recorded runs:', error);
        }
    }
}
