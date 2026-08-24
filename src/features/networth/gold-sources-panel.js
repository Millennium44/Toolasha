/**
 * The gold source attribution panel.
 *
 * A stacked bar per day and a totals table, opened from the coin button beside
 * the net worth history chart.
 *
 * ## What the drawing is trying to say
 *
 * Each day's bar is the day's *measured* net worth change, cut into the pieces
 * the recordings can account for — plus one grey piece, the residual, which is
 * everything they cannot. The grey is not an error bar and not a rounding
 * remainder: it is market movement, activity older than a recorder's window,
 * and activity nothing records. Drawing it at the same weight as the rest is
 * the whole point of the panel; a chart whose colours summed to the total would
 * be claiming a certainty that does not exist.
 *
 * Sources that cost coins — consumables burned, market tax paid — are negative,
 * and are drawn at the left of the bar and dimmed, so a day where the food bill
 * ate the drops looks like what it was rather than like a shorter good day.
 *
 * ## Tooltips
 *
 * Every source names the recording it came from and the date that recording
 * starts, because "you earned nothing from production last week" and "nothing
 * was recording production last week" are completely different statements and
 * the numbers alone cannot tell them apart.
 */

import config from '../../core/config.js';
import { networthFormatter } from '../../utils/formatters.js';
import { attributeGoldSources, SOURCE_KEYS, SOURCE_META, dayStart } from './gold-sources.js';
import { collectGoldSourceInputs } from './gold-sources-collect.js';

export const MODAL_ID = 'mwi-gold-sources-modal';
export const BUTTON_ID = 'mwi-gold-sources-btn';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The windows the panel offers */
export const WINDOWS = [
    { key: 'day', label: 'Day', days: 1 },
    { key: 'week', label: 'Week', days: 7 },
    { key: 'month', label: '30 days', days: 30 },
];

/** One colour per source, warm for income and cold for costs */
const SOURCE_COLORS = {
    combat: '#ef4444',
    gathering: '#22c55e',
    production: '#3b82f6',
    alchemy: '#a855f7',
    enhancement: '#f97316',
    marketplace: '#eab308',
    offline: '#14b8a6',
    consumables: '#94a3b8',
    marketTax: '#64748b',
    residual: '#4b5563',
};

const RESIDUAL_NOTE =
    'Everything the recordings cannot account for: market movement repricing what you already own, ' +
    'activity older than a recorder’s window, and activity nothing records (quests, task rewards, ' +
    'chests, gifts). It is shown as it falls out, never spread over the other rows.';

/**
 * A day id as `MM-DD`, which is what a per-day axis needs.
 * @param {string} dayId - `YYYY-MM-DD`
 * @returns {string} Short label
 */
function shortDay(dayId) {
    return String(dayId || '').slice(5);
}

/**
 * When a recording starts, phrased for a tooltip.
 * @param {number|null} since - Milliseconds since the epoch, or null
 * @returns {string} A sentence
 */
export function coverageText(since) {
    if (!Number.isFinite(since)) return 'Nothing has been recorded for this source yet.';
    return `Covers activity since ${new Date(since).toISOString().slice(0, 10)}, when recording began.`;
}

/**
 * The tooltip for one source row.
 * @param {string} key - Source key
 * @param {Object} coverage - `attributeGoldSources` coverage map
 * @returns {string} Tooltip text
 */
export function sourceTooltip(key, coverage) {
    const meta = SOURCE_META[key];
    if (!meta) return '';
    const kind = meta.measured ? 'Measured' : 'Estimated';
    return `${meta.label} — ${kind}\nData source: ${meta.source}\n${meta.note}\n${coverageText(coverage?.[key])}`;
}

/**
 * A signed gold figure, coloured.
 * @param {number|null} value - Coins
 * @returns {HTMLElement} A span
 */
function goldCell(value) {
    const span = document.createElement('span');
    if (!Number.isFinite(value)) {
        span.textContent = '—';
        span.style.color = '#6b7280';
        return span;
    }
    span.textContent = (value > 0 ? '+' : '') + networthFormatter(Math.round(value));
    span.style.color = value > 0 ? '#22c55e' : value < 0 ? '#f87171' : '#9ca3af';
    return span;
}

/**
 * The per-day stacked bars.
 *
 * Scaled to the largest single day in the window, so the bars are comparable
 * with each other rather than each being full width.
 *
 * @param {Object} attribution - From `attributeGoldSources`
 * @returns {HTMLElement} The chart block
 */
export function buildBars(attribution) {
    const block = document.createElement('div');
    block.className = 'mwi-gold-sources-bars';
    block.style.cssText = 'display: flex; flex-direction: column; gap: 3px; margin: 10px 0;';

    const rows = attribution?.days || [];

    // The scale is the biggest one-sided total any day reaches, so a day of
    // pure income and a day of pure loss are drawn at the same weight
    let scale = 0;
    for (const row of rows) {
        let positive = 0;
        let negative = 0;
        for (const key of SOURCE_KEYS) {
            const value = row.sources[key];
            if (value > 0) positive += value;
            else negative -= value;
        }
        if (Number.isFinite(row.residual)) {
            if (row.residual > 0) positive += row.residual;
            else negative -= row.residual;
        }
        scale = Math.max(scale, positive, negative);
    }
    if (scale <= 0) scale = 1;

    for (const row of rows) {
        const line = document.createElement('div');
        line.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 11px;';

        const label = document.createElement('span');
        label.textContent = shortDay(row.day);
        label.style.cssText = 'width: 38px; flex: 0 0 38px; color: #9ca3af;';
        line.appendChild(label);

        const track = document.createElement('div');
        track.className = 'mwi-gold-sources-track';
        track.style.cssText = 'flex: 1; display: flex; height: 14px; background: rgba(255,255,255,0.04);';

        const segments = [];
        for (const key of SOURCE_KEYS) segments.push([key, row.sources[key]]);
        if (Number.isFinite(row.residual)) segments.push(['residual', row.residual]);

        // Costs first so they read as a block on the left, then income
        const ordered = [...segments.filter(([, value]) => value < 0), ...segments.filter(([, value]) => value > 0)];

        for (const [key, value] of ordered) {
            const segment = document.createElement('div');
            const width = (Math.abs(value) / scale) * 100;
            const meta = SOURCE_META[key];
            segment.className = `mwi-gold-sources-seg mwi-gold-sources-seg-${key}`;
            segment.style.cssText = [
                `width: ${width.toFixed(2)}%`,
                `background: ${SOURCE_COLORS[key] || '#6b7280'}`,
                value < 0 ? 'opacity: 0.55' : 'opacity: 0.9',
            ].join('; ');
            segment.title = `${meta ? meta.label : 'Unexplained'} on ${row.day}: ${
                value > 0 ? '+' : ''
            }${networthFormatter(Math.round(value))}`;
            track.appendChild(segment);
        }

        line.appendChild(track);

        const total = document.createElement('span');
        total.style.cssText = 'width: 74px; flex: 0 0 74px; text-align: right;';
        total.appendChild(goldCell(row.delta));
        total.title =
            row.delta === null
                ? 'No net worth snapshot on this day, so there is no measured change to split.'
                : `Measured net worth change on ${row.day}`;
        line.appendChild(total);

        block.appendChild(line);
    }

    if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = 'No days in this window yet.';
        empty.style.cssText = 'color: #9ca3af; font-size: 11px;';
        block.appendChild(empty);
    }

    return block;
}

/**
 * The totals table, residual included as a row of its own.
 * @param {Object} attribution - From `attributeGoldSources`
 * @returns {HTMLElement} The table block
 */
export function buildTotalsTable(attribution) {
    const table = document.createElement('table');
    table.className = 'mwi-gold-sources-table';
    table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 12px;';

    const head = document.createElement('tr');
    for (const [text, align] of [
        ['Source', 'left'],
        ['Total', 'right'],
        ['Share of change', 'right'],
        ['Basis', 'left'],
    ]) {
        const cell = document.createElement('th');
        cell.textContent = text;
        cell.style.cssText = `text-align: ${align}; padding: 3px 6px; color: #9ca3af; font-weight: 600;
            border-bottom: 1px solid rgba(255,255,255,0.12);`;
        head.appendChild(cell);
    }
    table.appendChild(head);

    const totals = attribution?.totals?.sources || {};
    const delta = attribution?.totals?.delta ?? null;
    const residual = attribution?.totals?.residual ?? null;

    // Both sides of the share are magnitudes, so the rows answer "how much of
    // what happened was this" and never a negative percentage. Dividing a
    // signed amount by a signed delta flipped the sign on a losing window;
    // dividing a signed amount by an unsigned delta fixed the gaining window
    // and left the both-negative case reading -80% of a loss it in fact
    // explains 80% of. The direction stays on the amount in the column beside
    // it. With no measured change there is nothing honest to divide by
    const scale = Number.isFinite(delta) ? Math.abs(delta) : 0;
    const share = (value) => {
        if (!(scale > 0) || !Number.isFinite(value)) return '—';
        return `${((Math.abs(value) / scale) * 100).toFixed(0)}%`;
    };

    const addRow = (key, label, value, tooltip, basis, emphasis = false) => {
        const tr = document.createElement('tr');
        tr.className = `mwi-gold-sources-row mwi-gold-sources-row-${key}`;
        tr.title = tooltip;

        const name = document.createElement('td');
        name.style.cssText = `padding: 3px 6px; ${emphasis ? 'font-weight: 700;' : ''}`;
        const swatch = document.createElement('span');
        swatch.style.cssText = `display: inline-block; width: 8px; height: 8px; margin-right: 6px;
            background: ${SOURCE_COLORS[key] || '#6b7280'};`;
        name.appendChild(swatch);
        name.appendChild(document.createTextNode(label));
        tr.appendChild(name);

        const amount = document.createElement('td');
        amount.style.cssText = 'padding: 3px 6px; text-align: right; font-variant-numeric: tabular-nums;';
        amount.appendChild(goldCell(value));
        tr.appendChild(amount);

        const shareCell = document.createElement('td');
        shareCell.textContent = share(value);
        shareCell.style.cssText = 'padding: 3px 6px; text-align: right; color: #9ca3af;';
        tr.appendChild(shareCell);

        const basisCell = document.createElement('td');
        basisCell.textContent = basis;
        basisCell.style.cssText = 'padding: 3px 6px; color: #9ca3af;';
        tr.appendChild(basisCell);

        table.appendChild(tr);
    };

    for (const key of SOURCE_KEYS) {
        const meta = SOURCE_META[key];
        addRow(
            key,
            meta.label,
            totals[key] || 0,
            sourceTooltip(key, attribution?.coverage),
            meta.measured ? 'Measured' : 'Estimated'
        );
    }

    addRow('residual', 'Unexplained residual', residual, RESIDUAL_NOTE, 'Not attributed', true);

    const totalRow = document.createElement('tr');
    totalRow.className = 'mwi-gold-sources-row-total';
    totalRow.title = 'The net worth history’s own figure for this window: the last snapshot against the one before it.';
    const totalName = document.createElement('td');
    totalName.textContent = 'Measured net worth change';
    totalName.style.cssText = `padding: 5px 6px; font-weight: 700;
        border-top: 1px solid rgba(255,255,255,0.12);`;
    totalRow.appendChild(totalName);
    const totalValue = document.createElement('td');
    totalValue.style.cssText = `padding: 5px 6px; text-align: right; font-weight: 700;
        border-top: 1px solid rgba(255,255,255,0.12); font-variant-numeric: tabular-nums;`;
    totalValue.appendChild(goldCell(delta));
    totalRow.appendChild(totalValue);
    for (let i = 0; i < 2; i += 1) {
        const filler = document.createElement('td');
        filler.style.cssText = 'border-top: 1px solid rgba(255,255,255,0.12);';
        totalRow.appendChild(filler);
    }
    table.appendChild(totalRow);

    return table;
}

/**
 * The whole body of the panel for one attribution.
 *
 * Split out from the modal so a test can render it without opening anything.
 *
 * @param {Object} attribution - From `attributeGoldSources`
 * @returns {HTMLElement} The body element
 */
export function buildPanelBody(attribution) {
    const body = document.createElement('div');
    body.className = 'mwi-gold-sources-body';

    const summary = document.createElement('div');
    summary.className = 'mwi-gold-sources-summary';
    summary.style.cssText = 'font-size: 12px; color: #d1d5db; margin-bottom: 4px;';
    const delta = attribution?.totals?.delta;
    const explained = attribution?.totals?.explained ?? 0;
    if (Number.isFinite(delta)) {
        // Magnitude over magnitude, for the same reason the table's share
        // column is: -16M explained out of a -20M change is 80% accounted for,
        // not -80%, and a signed numerator said the latter
        const pct = delta === 0 ? null : Math.round((Math.abs(explained) / Math.abs(delta)) * 100);
        summary.textContent =
            `Net worth changed by ${networthFormatter(Math.round(delta))}; ` +
            `the recordings account for ${networthFormatter(Math.round(explained))}` +
            (pct === null ? '.' : ` (${pct}%).`);
    } else {
        summary.textContent =
            'There are not two net worth snapshots in this window, so there is no measured change to split. ' +
            'The sources below still show what was recorded.';
    }
    body.appendChild(summary);

    const note = document.createElement('div');
    note.className = 'mwi-gold-sources-note';
    note.style.cssText = 'font-size: 10px; color: #9ca3af; margin-bottom: 6px;';
    note.textContent = 'Days run midnight to midnight UTC. Everything is priced at today’s market, not the day’s.';
    body.appendChild(note);

    body.appendChild(buildBars(attribution));
    body.appendChild(buildTotalsTable(attribution));

    const unpriced = attribution?.unpricedEnhancementSessions || 0;
    if (unpriced > 0) {
        const warning = document.createElement('div');
        warning.className = 'mwi-gold-sources-unpriced';
        warning.style.cssText = 'font-size: 10px; color: #fbbf24; margin-top: 6px;';
        warning.textContent =
            `${unpriced} enhancement session${unpriced === 1 ? '' : 's'} could not be valued — the item has no ` +
            'market price at one of its two levels — so they are in the residual rather than the enhancement row.';
        body.appendChild(warning);
    }

    const unpricedProduction = attribution?.unpricedProductionActions || 0;
    if (unpricedProduction > 0) {
        const warning = document.createElement('div');
        warning.className = 'mwi-gold-sources-unpriced-production';
        warning.style.cssText = 'font-size: 10px; color: #fbbf24; margin-top: 6px;';
        warning.textContent =
            `${unpricedProduction} production action${unpricedProduction === 1 ? '' : 's'} could not be valued — ` +
            'an input or output has no market price — so the production row is short by whatever they were worth ' +
            'and the difference sits in the residual.';
        body.appendChild(warning);
    }

    return body;
}

class GoldSourcesPanel {
    constructor() {
        this.modal = null;
        this.activeWindow = 'week';
    }

    /**
     * Open the panel, or close it if it is already open.
     * @returns {Promise<void>}
     */
    async toggleModal() {
        if (this.modal) {
            this.closeModal();
            return;
        }
        await this.openModal();
    }

    /**
     * Build the attribution for the active window.
     * @returns {Promise<Object>} From `attributeGoldSources`
     */
    async buildAttribution() {
        const days = WINDOWS.find((entry) => entry.key === this.activeWindow)?.days || 7;
        const to = Date.now();
        const from = dayStart(new Date(to - (days - 1) * DAY_MS).toISOString().slice(0, 10));
        const inputs = await collectGoldSourceInputs();
        return attributeGoldSources({ ...inputs, from, to });
    }

    /**
     * Draw the modal.
     * @returns {Promise<void>}
     */
    async openModal() {
        if (this.modal) return;

        const modal = document.createElement('div');
        modal.id = MODAL_ID;
        modal.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            width: min(640px, 94vw); max-height: 82vh; overflow-y: auto; padding: 12px 14px;
            background: #12141c; border: 1px solid rgba(255,255,255,0.14); border-radius: 6px;
            color: #e5e7eb; font-size: 12px; z-index: ${config.Z_FLOATING_PANEL || 1100};`;

        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;';
        const title = document.createElement('h3');
        title.textContent = 'Where the gold came from';
        title.style.cssText = 'margin: 0; flex: 1; font-size: 14px;';
        header.appendChild(title);

        const close = document.createElement('button');
        close.textContent = '✕';
        close.style.cssText = 'background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 14px;';
        close.addEventListener('click', () => this.closeModal());
        header.appendChild(close);
        modal.appendChild(header);

        const rangeRow = document.createElement('div');
        rangeRow.className = 'mwi-gold-sources-ranges';
        rangeRow.style.cssText = 'display: flex; gap: 4px; margin-bottom: 8px;';
        for (const window of WINDOWS) {
            const button = document.createElement('button');
            button.textContent = window.label;
            button.dataset.window = window.key;
            button.style.cssText = `padding: 3px 10px; font-size: 11px; cursor: pointer; border-radius: 3px;
                border: 1px solid rgba(255,255,255,0.16); background: ${
                    window.key === this.activeWindow ? 'rgba(34,197,94,0.18)' : 'transparent'
                }; color: ${window.key === this.activeWindow ? '#22c55e' : '#9ca3af'};`;
            button.addEventListener('click', async () => {
                this.activeWindow = window.key;
                this.closeModal();
                await this.openModal();
            });
            rangeRow.appendChild(button);
        }
        modal.appendChild(rangeRow);

        const bodyHolder = document.createElement('div');
        bodyHolder.className = 'mwi-gold-sources-holder';
        bodyHolder.textContent = 'Reading the recordings…';
        modal.appendChild(bodyHolder);

        document.body.appendChild(modal);
        this.modal = modal;

        try {
            const attribution = await this.buildAttribution();
            if (!this.modal) return;
            bodyHolder.textContent = '';
            bodyHolder.appendChild(buildPanelBody(attribution));
        } catch (error) {
            console.error('[GoldSources] The panel could not be drawn:', error);
            bodyHolder.textContent = 'The attribution could not be drawn.';
        }
    }

    /** Take the modal down. */
    closeModal() {
        this.modal?.remove();
        this.modal = null;
    }
}

const goldSourcesPanel = new GoldSourcesPanel();
export default goldSourcesPanel;
