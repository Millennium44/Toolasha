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
 * the pairs come from `prediction-calibration.js` — including combat pairs,
 * which `combat-calibration.js` writes into the same ledger. Enhancement runs
 * come from `enhancement-calibration.js` and are drawn as percentiles of their
 * predicted attempt distributions, never as rate deviations: one draw from a
 * heavy-tailed spread has no honest "gap".
 */

import { formatTailPercent, describeAttemptOutcome } from '../enhancement/attempt-percentile.js';
import { formatKMB } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS, signedPercent, shortDuration } from '../../utils/overlay-format.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { predictionCalibration } from './prediction-calibration.js';
import { enhancementCalibration } from './enhancement-calibration.js';
import {
    summarizeCalibration,
    dailySeries,
    deviationPercent,
    median,
    xpGoldSplit,
    cohortSplit,
    DEFAULT_GAP_PERCENT,
} from './calibration-math.js';

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
 * The enhancement observations, on the same terms.
 * @returns {Array<Object>|null}
 */
function enhancementRecords() {
    const cached = enhancementCalibration.getCachedRecords();
    if (cached === null) enhancementCalibration.getRecords();
    return cached;
}

/**
 * A combat pair's forecast provenance, as a sentence for a tooltip.
 * @param {Object} record - A combat record
 * @returns {string}
 */
function combatProvenance(record) {
    const age =
        Number.isFinite(record.snapshotAgeMs) && record.snapshotAgeMs >= 0
            ? `The sim forecast was ${shortDuration(record.snapshotAgeMs / 1000)} old when this run started.`
            : 'The sim forecast is of unknown age.';
    const gear =
        record.fingerprintMatch === true
            ? 'Gear matched the sim run.'
            : record.fingerprintMatch === false
              ? 'Gear DIFFERED from the sim run — the forecast is about another loadout.'
              : 'Whether the gear matched the sim run could not be determined.';
    return `${age}\n${gear}`;
}

/**
 * A combat record's zone as a short label, e.g. `Rat Cave T1`.
 * @param {Object} record - A combat record
 * @returns {string}
 */
function combatZoneLabel(record) {
    const name = titleCase((record.actionHrid || '').split('/').pop());
    const tier = record.difficultyTier ?? 0;
    return `${name} T${tier}`;
}

/**
 * The combat group's honesty note.
 *
 * A combat pair's forecast is a saved sim run, and a saved run ages and
 * assumes a loadout. That context must sit with the figures — a deviation
 * measured against last month's gear is not a deviation, it is a change of
 * subject — so the card says how old the forecasts were and how many pairs
 * were played in gear the sim never saw.
 *
 * @param {HTMLElement} card - The combat group's card
 * @param {Array<Object>} combatRecords - Every combat pair
 */
function drawCombatCaveats(card, combatRecords) {
    if (!combatRecords.length) return;

    const mismatched = combatRecords.filter((record) => record.fingerprintMatch === false).length;
    const unknown = combatRecords.filter(
        (record) => record.fingerprintMatch !== true && record.fingerprintMatch !== false
    ).length;
    const medianAge = median(combatRecords.map((record) => record.snapshotAgeMs).filter((v) => Number.isFinite(v)));

    const parts = [];
    if (medianAge !== null) parts.push(`snapshot ${shortDuration(medianAge / 1000)} old (median)`);
    if (mismatched) parts.push(`${mismatched} of ${combatRecords.length} in different gear`);
    if (unknown) parts.push(`${unknown} gear unknown`);

    // Pairs stamped by a different script version were forecast by a different
    // sim — pooled in, an engine fix reads as prediction drift. The newest
    // stamped pair's version stands for "current": the running version would
    // damn every legacy pair recorded before versions were stamped.
    const currentV = [...combatRecords].sort((a, b) => (b.t || 0) - (a.t || 0)).find((record) => record.v)?.v ?? null;
    const older = currentV === null ? 0 : combatRecords.filter((record) => (record.v ?? null) !== currentV).length;
    if (older) parts.push(`${older} from older script versions`);

    card.appendChild(
        panelLine(
            'Forecast: all-zones sim',
            parts.join(' · ') || '—',
            mismatched ? ROW_COLORS.bad : ROW_COLORS.dim,
            'Combat forecasts come from the saved all-zones simulation, not a live calculator. ' +
                'A pair measured against an aged snapshot or different gear says less about the sim ' +
                'than about what changed since it ran — and a pair from an older script version was ' +
                'forecast by a different sim, so an engine fix in between reads as drift.'
        )
    );
}

/**
 * The XP rate beside the gold rate, and what the two of them together decide.
 *
 * Every combat pair has recorded an experience rate alongside the coin rate
 * since the pairing was written, and nothing has ever read it. It is the one
 * field that separates "the sim is wrong about the fight" from "the sim is
 * right about the fight and wrong about what it drops" — experience is paid per
 * kill, so it moves with kill speed and not with drop tables or prices.
 *
 * @param {HTMLElement} card - The combat group's card
 * @param {Array<Object>} combatRecords - Every combat pair
 */
function drawCombatXpSplit(card, combatRecords) {
    if (!combatRecords.length) return;

    const split = xpGoldSplit(combatRecords);
    const xpGap = split.xpDeviation === null ? null : signedPercent(split.xpDeviation, DEFAULT_GAP_PERCENT);

    card.appendChild(
        panelLine(
            `XP deviation (median of ${split.rated})`,
            xpGap ? xpGap.text : '—',
            xpGap ? xpGap.color : ROW_COLORS.dim,
            'Experience per hour, predicted against actual, over the pairs that carry both rates. ' +
                'Negative means the runs levelled slower than the sim said.'
        )
    );
    card.appendChild(
        panelLine(
            'XP pairs',
            `${split.rated} of ${combatRecords.length}${split.withoutXp ? ` · ${split.withoutXp} without XP` : ''}`,
            ROW_COLORS.dim,
            'Pairs recorded before the XP fields existed, or whose session reported no experience, ' +
                'are excluded rather than counted as zero — and both medians above are taken over the ' +
                'same pairs, so the comparison is like for like.'
        )
    );
    card.appendChild(
        panelLine(
            'XP vs gold',
            split.text,
            split.verdict === 'insufficient'
                ? ROW_COLORS.dim
                : split.verdict === 'aligned'
                  ? ROW_COLORS.good
                  : ROW_COLORS.bad,
            split.detail
        )
    );
}

/**
 * The combat median split by whether the gear matched the forecast's.
 *
 * The caveat line above says how many pairs were played in gear the sim never
 * saw. Saying so and then pooling them anyway leaves the reader with a number
 * they have been told not to trust and no way to correct it; the split is the
 * correction, and it refuses rather than guessing when either side is thin.
 *
 * @param {HTMLElement} card - The combat group's card
 * @param {Array<Object>} combatRecords - Every combat pair
 */
function drawCombatCohorts(card, combatRecords) {
    if (!combatRecords.length) return;

    const split = cohortSplit(combatRecords);
    const decided = split.verdict !== 'insufficient';

    card.appendChild(
        panelLine(
            'Gear cohorts',
            `${split.figures}${split.unsigned.rated ? ` · ${split.unsigned.rated} unsigned` : ''}`,
            decided ? ROW_COLORS.gold : ROW_COLORS.dim,
            'The same median, split by whether the pair was played in the gear the sim simulated. ' +
                'Pairs whose gear match could not be determined are their own "unsigned" bucket, ' +
                'never folded into either side.'
        )
    );
    card.appendChild(
        panelLine(
            'Cohort verdict',
            split.text,
            decided && split.verdict !== 'both_clean' ? ROW_COLORS.bad : ROW_COLORS.dim,
            split.detail
        )
    );
}

/**
 * One skill's verdict.
 * @param {HTMLElement} body - Where it goes
 * @param {Object} group - A group from `summarizeCalibration`
 * @param {Array<Object>} all - Every record, for group-specific caveats
 */
function drawGroup(body, group, all) {
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

    if (group.actionType === 'combat') {
        const combatRecords = (all || []).filter((record) => record.actionType === 'combat');
        drawCombatXpSplit(card, combatRecords);
        drawCombatCaveats(card, combatRecords);
        drawCombatCohorts(card, combatRecords);
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
        const isCombat = record.actionType === 'combat';
        // A combat pair's provenance flag travels with the pair: a row measured
        // against a stale or different-gear sim must not read like the others
        const tooltip = isCombat
            ? `${new Date(record.t).toLocaleString()}\n${combatProvenance(record)}`
            : new Date(record.t).toLocaleString();
        card.appendChild(
            panelLine(
                isCombat ? combatZoneLabel(record) : `${titleCase(record.actionType)} ×${record.actionCount}`,
                `${perHour(record.predicted)} → ${perHour(record.actual)}  ${gap ? gap.text : ''}` +
                    (isCombat && record.fingerprintMatch !== true ? ' ⚠' : ''),
                gap ? gap.color : ROW_COLORS.dim,
                tooltip
            )
        );
    }
}

/**
 * Enhancement runs, each as a percentile of its own predicted distribution.
 *
 * Never drawn as predicted-vs-actual differences: one run against a heavy-
 * tailed spread is only honest as "how often runs land here". The aggregate
 * *is* meaningful — a calibrated chain scatters the percentiles evenly, so a
 * median far from 50% across enough runs is the chain flattering itself — and
 * that is the headline the card leads with.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Array<Object>} observations - From `enhancement-calibration.js`
 */
function drawEnhancing(body, observations) {
    if (!observations.length) return;

    const card = panelCard(body, `Enhancing (${observations.length} runs)`, ACCENT);

    const percentiles = observations.map((entry) => (1 - entry.tailProbability) * 100);
    const midPercentile = median(percentiles);
    card.appendChild(
        panelLine(
            'Median outcome percentile',
            midPercentile === null ? '—' : `${Math.round(midPercentile)}%`,
            ROW_COLORS.gold,
            'Where finished runs land in the attempt distributions predicted for them. ' +
                'A calibrated chain scatters these evenly around 50%; runs piling up high ' +
                'means it promises fewer attempts than runs actually take.'
        )
    );

    const recent = [...observations].sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 8);
    for (const entry of recent) {
        const sentence = describeAttemptOutcome(entry.expectedAttempts, entry.observedAttempts, entry.tailProbability);
        card.appendChild(
            panelLine(
                `${entry.itemName || entry.itemHrid} +${entry.targetLevel}`,
                `${entry.observedAttempts} att · ${formatTailPercent(entry.tailProbability)} take ≥`,
                ROW_COLORS.dim,
                `${sentence}\n${new Date(entry.t).toLocaleString()}`
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
        const enhancing = enhancementRecords();
        if (all === null || enhancing === null) {
            body.appendChild(panelNote('Reading history…'));
            return;
        }
        if (!all.length && !enhancing.length) {
            body.appendChild(panelNote('No finished runs measured yet.'));
            body.appendChild(
                panelNote(
                    'A run is measured once a later action replaces it in the loot log, so the first pair appears ' +
                        'after you switch actions. Combat is paired when a session is archived, and enhancing when ' +
                        'a session reaches its target.'
                )
            );
            return;
        }

        if (all.length) {
            const summary = summarizeCalibration(all);

            const overall = panelCard(body, `Overall (${summary.overall.samples} runs)`, ACCENT);
            overall.appendChild(panelLine('Predicted', perHour(summary.overall.predictedMean), ROW_COLORS.dim));
            overall.appendChild(panelLine('Actual', perHour(summary.overall.actualMean), ROW_COLORS.gold));
            const overallGap =
                summary.overall.medianDeviation === null
                    ? null
                    : signedPercent(summary.overall.medianDeviation, DEFAULT_GAP_PERCENT);
            overall.appendChild(
                panelLine(
                    'Deviation',
                    overallGap ? overallGap.text : '—',
                    overallGap ? overallGap.color : ROW_COLORS.dim
                )
            );

            for (const group of summary.groups) drawGroup(body, group, all);
        }

        // Its own card rather than a group: an enhancement observation is a
        // percentile, not a rate pair, and pushing it through the deviation
        // arithmetic would be exactly the dishonesty it exists to avoid
        drawEnhancing(body, enhancing);

        if (all.length) {
            drawTrend(body, all);
            drawRecent(body, all);
        }
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
