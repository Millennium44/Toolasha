/**
 * Prediction calibration panel
 *
 * What the profit calculators promised, against what the runs paid.
 *
 * The panel answers one question a per-action figure never can: is this
 * calculator *systematically* wrong about this skill? A single run says nothing
 * — drops are random and a rare find swamps any modelling error — so the tile
 * and the panel both lead with the median deviation across runs, and only call a
 * gap persistent once enough runs agree on it.
 *
 * Drawing is all this file does. The arithmetic is in `calibration-math.js`, and
 * the pairs come from `prediction-calibration.js`.
 */

import { formatKMB } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS, signedPercent } from '../../utils/overlay-format.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { predictionCalibration } from './prediction-calibration.js';
import { summarizeCalibration, dailySeries, deviationPercent, DEFAULT_GAP_PERCENT } from './calibration-math.js';

const ACCENT = '#7fd4c1';

/**
 * A skill name as a heading.
 * @param {string} actionType - e.g. `milking`
 * @returns {string} e.g. `Milking`
 */
function titleCase(actionType) {
    if (!actionType) return 'Unknown';
    return actionType.charAt(0).toUpperCase() + actionType.slice(1).replace(/_/g, ' ');
}

/**
 * Coins per hour, or a dash when there is no figure.
 * @param {number|null} value - Coins per hour
 * @returns {string}
 */
function perHour(value) {
    return Number.isFinite(value) ? `${formatKMB(Math.round(value))}/h` : '—';
}

/**
 * The records the panel draws, or null while the first read is in flight.
 * @returns {Array<Object>|null}
 */
function records() {
    const cached = predictionCalibration.getCachedRecords();
    if (cached === null) {
        // Fire and forget: the panel redraws on its own timer, and by then the
        // read has landed. Blocking a draw on IndexedDB is what leaves a panel
        // blank on the first frame.
        predictionCalibration.getRecords();
    }
    return cached;
}

/**
 * One skill's verdict.
 * @param {HTMLElement} body - Where it goes
 * @param {Object} group - A group from `summarizeCalibration`
 */
function drawGroup(body, group) {
    const gap = group.medianDeviation === null ? null : signedPercent(group.medianDeviation, DEFAULT_GAP_PERCENT);
    const card = panelCard(body, titleCase(group.actionType), group.flagged ? ROW_COLORS.bad : ACCENT);

    card.appendChild(panelLine('Predicted', perHour(group.predictedMean), ROW_COLORS.dim));
    card.appendChild(panelLine('Actual', perHour(group.actualMean), ROW_COLORS.gold));
    card.appendChild(
        panelLine(
            `Deviation (median of ${group.rated})`,
            gap ? gap.text : '—',
            gap ? gap.color : ROW_COLORS.dim,
            'Negative means the run paid less than the calculator predicted.'
        )
    );

    if (group.flagged) {
        card.appendChild(
            panelLine(
                'Persistent gap',
                group.direction === 'optimistic' ? 'Calculator too optimistic' : 'Calculator too pessimistic',
                ROW_COLORS.bad,
                `At least ${group.rated} runs agree the forecast is off by ${DEFAULT_GAP_PERCENT}% or more.`
            )
        );
    }
}

/**
 * The last week, a day at a time.
 * @param {HTMLElement} body - Where it goes
 * @param {Array<Object>} all - Every record
 */
function drawTrend(body, all) {
    const series = dailySeries(all, { days: 7 });
    if (series.length < 2) return;

    const card = panelCard(body, 'Last 7 days', ACCENT);
    for (const day of series) {
        const gap = day.deviation === null ? null : signedPercent(day.deviation, DEFAULT_GAP_PERCENT);
        card.appendChild(
            panelLine(
                `${day.day} (${day.samples})`,
                `${perHour(day.predictedMean)} → ${perHour(day.actualMean)}  ${gap ? gap.text : ''}`,
                gap ? gap.color : ROW_COLORS.dim
            )
        );
    }
}

/**
 * The runs behind the figures, newest first.
 * @param {HTMLElement} body - Where it goes
 * @param {Array<Object>} all - Every record
 */
function drawRecent(body, all) {
    const card = panelCard(body, 'Recent runs', ACCENT);
    const recent = [...all].sort((a, b) => b.t - a.t).slice(0, 12);

    for (const record of recent) {
        const deviation = deviationPercent(record.predicted, record.actual);
        const gap = deviation === null ? null : signedPercent(deviation, DEFAULT_GAP_PERCENT);
        card.appendChild(
            panelLine(
                `${titleCase(record.actionType)} ×${record.actionCount}`,
                `${perHour(record.predicted)} → ${perHour(record.actual)}  ${gap ? gap.text : ''}`,
                gap ? gap.color : ROW_COLORS.dim,
                new Date(record.t).toLocaleString()
            )
        );
    }
}

export const calibrationPanel = createPanel({
    id: 'predictionCalibration',
    title: 'Prediction Calibration',
    size: { width: 400, height: 460 },
    accent: ACCENT,
    draw: (body) => {
        const all = records();
        if (all === null) {
            body.appendChild(panelNote('Reading history…'));
            return;
        }
        if (!all.length) {
            body.appendChild(panelNote('No finished runs measured yet.'));
            body.appendChild(
                panelNote(
                    'A run is measured once a later action replaces it in the loot log, so the first pair appears ' +
                        'after you switch actions.'
                )
            );
            return;
        }

        const summary = summarizeCalibration(all);

        const overall = panelCard(body, `Overall (${summary.overall.samples} runs)`, ACCENT);
        overall.appendChild(panelLine('Predicted', perHour(summary.overall.predictedMean), ROW_COLORS.dim));
        overall.appendChild(panelLine('Actual', perHour(summary.overall.actualMean), ROW_COLORS.gold));
        const overallGap =
            summary.overall.medianDeviation === null
                ? null
                : signedPercent(summary.overall.medianDeviation, DEFAULT_GAP_PERCENT);
        overall.appendChild(
            panelLine('Deviation', overallGap ? overallGap.text : '—', overallGap ? overallGap.color : ROW_COLORS.dim)
        );

        for (const group of summary.groups) drawGroup(body, group);
        drawTrend(body, all);
        drawRecent(body, all);
    },
});

/**
 * Register the overlay tile. Called from the feature's `initialize` so a
 * switched-off feature leaves no tile and no command palette entry behind.
 */
export function registerCalibrationRow() {
    registerRow({
        key: 'predictionCalibration',
        name: 'Prediction Calibration',
        empty: 'No runs measured yet',
        defaultVisible: false,
        defaultSize: { width: 230, height: 30 },
        render: (container) => {
            const all = records();
            if (!all?.length) return blank(container);

            const summary = summarizeCalibration(all);
            const worst = summary.flagged[0] || summary.groups[0];
            if (!worst || worst.medianDeviation === null) return blank(container);

            const gap = signedPercent(worst.medianDeviation, DEFAULT_GAP_PERCENT);
            row(container, [
                { text: titleCase(worst.actionType), color: ROW_COLORS.dim, ellipsis: true },
                { text: gap.text, color: gap.color, bold: worst.flagged },
                { text: `${worst.rated} runs`, color: ROW_COLORS.dim, push: true },
            ]);
            container.title =
                `Predicted ${perHour(worst.predictedMean)}, actually ${perHour(worst.actualMean)}.` +
                (worst.flagged ? '\nThis gap has held across enough runs to be real.' : '') +
                '\nDouble-click for every skill measured.';
        },
        onOpen: () => calibrationPanel.toggle(),
    });
}
