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
import { transmuteHistoryTracker } from '../alchemy/transmute-history-tracker.js';
import { decomposeHistoryTracker } from '../alchemy/decompose-history-tracker.js';
import { coinifyHistoryTracker } from '../alchemy/coinify-history-tracker.js';
import { summarizeAlchemyCalibration, verdictText } from './alchemy-calibration.js';
import {
    summarizeCalibration,
    dailySeries,
    deviationPercent,
    median,
    xpGoldSplit,
    cohortSplit,
    actionSplit,
    bidSpread,
    versionSplit,
    OLDER_COHORT,
    DEFAULT_GAP_PERCENT,
} from './calibration-math.js';

const ACCENT = '#7fd4c1';

/**
 * Which skill groups are showing their per-action breakdown.
 *
 * Module scope rather than panel state because the body is rebuilt from scratch
 * every refresh — a flag living in the DOM would be forgotten three seconds
 * after it was set, which reads as the panel refusing to open.
 */
const expandedGroups = new Set();

/**
 * Which skill groups are showing their per-script-version breakdown.
 *
 * Its own set rather than a flag on `expandedGroups`: the two folds answer
 * different questions and a reader opening one has not asked for the other.
 */
const expandedVersions = new Set();

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

/** The three alchemy trackers, by the kind of session they keep */
const ALCHEMY_TRACKERS = {
    transmute: transmuteHistoryTracker,
    decompose: decomposeHistoryTracker,
    coinify: coinifyHistoryTracker,
};

/** How stale the alchemy read may get before it is taken again */
const ALCHEMY_REREAD_MS = 15_000;

let alchemyCache = null;
let alchemyReadAt = 0;
let alchemyReading = false;

/**
 * The alchemy sessions, read on the same fire-and-forget terms as the pairs.
 *
 * The trackers keep their sessions in IndexedDB and expose only an async read,
 * while a panel body has to be built synchronously — so the draw uses whatever
 * the last read produced and asks for a fresh one when it has gone stale. The
 * first draw after opening has nothing yet and simply leaves the cards out; the
 * refresh a few seconds later has them.
 *
 * @returns {Object|null} `{transmute, decompose, coinify}` arrays, or null before the first read
 */
function alchemySessions() {
    if (!alchemyReading && Date.now() - alchemyReadAt > ALCHEMY_REREAD_MS) {
        alchemyReading = true;
        readAlchemySessions();
    }
    return alchemyCache;
}

/**
 * Take the read, and never let a failing tracker blank the others.
 * @returns {Promise<void>}
 */
async function readAlchemySessions() {
    try {
        const kinds = Object.keys(ALCHEMY_TRACKERS);
        const results = await Promise.all(
            kinds.map(async (kind) => {
                try {
                    return await ALCHEMY_TRACKERS[kind].loadSessions();
                } catch (error) {
                    console.error(`[CalibrationPanel] Could not read ${kind} sessions:`, error);
                    return [];
                }
            })
        );
        alchemyCache = Object.fromEntries(kinds.map((kind, index) => [kind, results[index] || []]));
    } finally {
        alchemyReadAt = Date.now();
        alchemyReading = false;
    }
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
 * An action's own name, e.g. `/actions/milking/cow` → `Cow`.
 * @param {string} actionHrid - Action HRID
 * @returns {string}
 */
function actionLabel(actionHrid) {
    return titleCase((actionHrid || '').split('/').pop());
}

/**
 * A heading you can click to fold a section open or shut.
 *
 * The panel has no collapsible idiom of its own — `attachMinimize` folds a whole
 * panel, not a section — so this is the plainest thing that works: a line that
 * says which way it is pointing and redraws the body when clicked.
 *
 * @param {string} label - What is behind it
 * @param {boolean} open - Whether it is showing
 * @param {Function} onToggle - Called on click
 * @param {string} [title] - Tooltip
 * @returns {HTMLElement}
 */
function foldHeading(label, open, onToggle, title = '') {
    const line = document.createElement('div');
    line.textContent = `${open ? '▾' : '▸'} ${label}`;
    Object.assign(line.style, {
        cursor: 'pointer',
        color: 'rgba(232, 236, 245, 0.72)',
        marginTop: '3px',
        userSelect: 'none',
    });
    if (title) line.title = title;
    line.addEventListener('click', onToggle);
    return line;
}

/**
 * One skill's median, broken out by the action that earned it.
 *
 * Folded away by default: most groups are one or two actions and the breakdown
 * would only repeat the group line, while a skill with a dozen actions would
 * bury every other card under it.
 *
 * @param {HTMLElement} card - The group's card
 * @param {Object} group - The group summary
 * @param {Array<Object>} groupRecords - That group's records
 */
function drawActionSplit(card, group, groupRecords) {
    const split = actionSplit(groupRecords);
    if (!split.actions.length) return;

    const open = expandedGroups.has(group.actionType);
    card.appendChild(
        foldHeading(
            `Per action (${split.actions.length})` + (split.thin ? ` · ${split.thin} too thin` : ''),
            open,
            () => {
                if (open) expandedGroups.delete(group.actionType);
                else expandedGroups.add(group.actionType);
                calibrationPanel.render();
            },
            'The same median, per action rather than pooled over the skill. A skill is not what the ' +
                'calculator has an opinion about — actions are, and each one is gated on its own run count.'
        )
    );
    if (!open) return;

    for (const action of split.actions) {
        const gap = action.medianDeviation === null ? null : signedPercent(action.medianDeviation, DEFAULT_GAP_PERCENT);
        card.appendChild(
            panelLine(
                `  ${actionLabel(action.actionHrid)} (${action.rated})`,
                gap ? gap.text : action.text,
                gap ? gap.color : ROW_COLORS.dim,
                action.decided
                    ? `${action.rated} runs of this action, median deviation.`
                    : `${action.rated} runs is too few for this action to be judged on its own, ` +
                          'so no figure is shown for it. It still counts towards the skill median above.'
            )
        );
    }

    if (split.unattributed) {
        card.appendChild(
            panelLine(
                '  no action recorded',
                `${split.unattributed}`,
                ROW_COLORS.dim,
                'Pairs recorded without an action HRID. They cannot be attributed to any action, ' +
                    'so they are counted here rather than pooled into one that would then be read as real.'
            )
        );
    }
}

/**
 * A cohort's heading, e.g. `3.32` or the legacy bucket's own name.
 * @param {Object} cohort - A cohort from `versionSplit`
 * @returns {string}
 */
function cohortLabel(cohort) {
    return cohort.version === OLDER_COHORT ? 'older / unstamped' : cohort.version;
}

/**
 * One skill's median, a script version at a time, oldest release first.
 *
 * Every pair records the version that forecast it, and until now the panel only
 * counted the odd ones out as a caveat — "12 from older script versions" — which
 * is the measurement stated as a disclaimer. Broken out, the same field answers
 * the question a release note cannot: the cohort recorded after a calculator
 * change is the direct reading of whether that change helped.
 *
 * Folded away by default, like the per-action breakdown: most readers have one
 * cohort and the fold would just repeat the group line.
 *
 * Two honesty rules are drawn, not merely intended. Each cohort prints how many
 * pairs it *still* holds, because the ledger rolls the oldest out as new pairs
 * arrive and a cohort silently shrinking towards nothing must not read as a
 * stable measurement. And nothing here says a release caused a move: a version
 * boundary is a calendar boundary, and the market crossed it too.
 *
 * @param {HTMLElement} card - The group's card
 * @param {Object} group - The group summary
 * @param {Array<Object>} groupRecords - That group's records
 */
function drawVersionSplit(card, group, groupRecords) {
    const split = versionSplit(groupRecords);
    // One cohort is not a comparison — it is the group median with a version
    // written next to it, and drawing it would invite reading a trend into it
    if (split.cohorts.length < 2) return;

    const open = expandedVersions.has(group.actionType);
    card.appendChild(
        foldHeading(
            `Per script version (${split.cohorts.length})` + (split.thin ? ` · ${split.thin} too thin` : ''),
            open,
            () => {
                if (open) expandedVersions.delete(group.actionType);
                else expandedVersions.add(group.actionType);
                calibrationPanel.render();
            },
            'The same median, split by the script version that made the forecast, oldest first. ' +
                'A version boundary is also a calendar boundary — the market and your gear crossed it ' +
                'too — so read a change as happening AT a release, never because of one.'
        )
    );
    if (!open) return;

    for (const cohort of split.cohorts) {
        const gap = cohort.medianDeviation === null ? null : signedPercent(cohort.medianDeviation, DEFAULT_GAP_PERCENT);
        const remaining =
            `The ${cohortLabel(cohort)} cohort has ${cohort.rated} pair${cohort.rated === 1 ? '' : 's'} left ` +
            'in the ledger — it keeps a fixed number of pairs, so old cohorts shrink as new runs are ' +
            'recorded and eventually roll out entirely.';
        card.appendChild(
            panelLine(
                `  ${cohortLabel(cohort)} (${cohort.rated})`,
                gap ? gap.text : cohort.text,
                gap ? gap.color : ROW_COLORS.dim,
                cohort.decided
                    ? remaining
                    : `${cohort.rated} pairs is too few for this version to be judged on its own, so no ` +
                          `figure is shown for it. ${remaining}` +
                          (cohort.unordered
                              ? ' Versions that are not dot-separated digits, and pairs recorded before ' +
                                'stamping existed, share this bucket rather than claiming a place in the sequence.'
                              : '')
            )
        );
    }

    card.appendChild(
        panelLine(
            'Ask vs bid across cohorts',
            split.movement.text,
            split.movement.decidable && split.movement.verdict !== 'steady' ? ROW_COLORS.gold : ROW_COLORS.dim,
            'The same runs priced twice, compared between the oldest and newest cohorts that can speak. ' +
                'Both series shifting together is the market being worth different coins; only the ' +
                'ask-priced one shifting is the spread moving, which is the forecast’s assumption that ' +
                'you sell into the ask changing value rather than the goods. This says what moved at a ' +
                'boundary, not what caused it.'
        )
    );
}

/**
 * How much of the group's measured profit is only there at the ask.
 *
 * Every figure on this panel is ask-priced, and a skill whose output is thinly
 * traded is being quoted a rate that is real only for somebody willing to wait
 * in the order book. The pairs have carried the bid-priced figure since they
 * were first written and nothing has ever read it.
 *
 * @param {HTMLElement} card - The group's card
 * @param {Array<Object>} groupRecords - That group's records
 */
function drawBidSpread(card, groupRecords) {
    const spread = bidSpread(groupRecords);
    card.appendChild(
        panelLine(
            'Ask vs bid',
            spread.text,
            spread.verdict === 'insufficient'
                ? ROW_COLORS.dim
                : Math.abs(spread.askShare) >= DEFAULT_GAP_PERCENT
                  ? ROW_COLORS.bad
                  : ROW_COLORS.gold,
            spread.detail
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

    const groupRecords = (all || []).filter((record) => (record.actionType || 'unknown') === group.actionType);
    drawBidSpread(card, groupRecords);
    drawActionSplit(card, group, groupRecords);
    drawVersionSplit(card, group, groupRecords);

    if (group.actionType === 'combat') {
        drawCombatXpSplit(card, groupRecords);
        drawCombatCaveats(card, groupRecords);
        drawCombatCohorts(card, groupRecords);
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

/**
 * A rate as a percentage, or a dash.
 * @param {number|null} rate - Proportion 0..1
 * @returns {string}
 */
function ratePercent(rate) {
    return Number.isFinite(rate) ? `${(rate * 100).toFixed(1)}%` : '—';
}

/**
 * An alchemy combo as a line label, e.g. `Cheese +2 · prime`.
 * @param {Object} combo - A combo from `summarizeKind`
 * @returns {string}
 */
function comboLabel(combo) {
    const item = titleCase((combo.inputItemHrid || 'unknown').split('/').pop());
    const level = combo.enhancementLevel ? ` +${combo.enhancementLevel}` : '';
    const catalyst = combo.catalystHrid
        ? ` · ${titleCase(
              combo.catalystHrid
                  .split('/')
                  .pop()
                  .replace(/^catalyst_of_/, '')
          )}`
        : '';
    return `${item}${level}${catalyst}`;
}

/**
 * Alchemy success rates, observed against what was predicted when the session
 * started.
 *
 * A card per tracker, never pooled: transmute, decompose and coinify are three
 * different models — a per-item drop table rate and two flat ones — and pooling
 * them would let a wrong transmute table hide inside two correct flat rates.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} summary - From `summarizeAlchemyCalibration`
 */
function drawAlchemy(body, summary) {
    for (const group of summary.kinds) {
        const decided = group.verdict !== 'too few attempts' && group.verdict !== 'unstamped';
        const off = group.verdict === 'sim too high' || group.verdict === 'sim too low';
        const card = panelCard(
            body,
            `${titleCase(group.kind)} success (${group.attempts} attempts)`,
            off ? ROW_COLORS.bad : ACCENT
        );

        card.appendChild(
            panelLine(
                'Observed',
                ratePercent(group.observed),
                ROW_COLORS.gold,
                `${group.successes} of ${group.attempts} attempts produced output.`
            )
        );
        card.appendChild(
            panelLine(
                'Predicted',
                ratePercent(group.predicted),
                ROW_COLORS.dim,
                'The rate the model gave each session as it started, weighted by the attempts that ' +
                    'session went on to make. Stamped then rather than computed now: the tea, the ' +
                    'catalyst and the under-level penalty behind it have all moved since.'
            )
        );
        if (decided) {
            card.appendChild(
                panelLine(
                    '95% interval',
                    `${ratePercent(group.low)} – ${ratePercent(group.high)}`,
                    ROW_COLORS.dim,
                    'Wilson interval on the observed rate. The verdict is whether the prediction falls inside it.'
                )
            );
        }
        card.appendChild(
            panelLine(
                'Verdict',
                group.text,
                decided ? (off ? ROW_COLORS.bad : ROW_COLORS.good) : ROW_COLORS.dim,
                decided
                    ? 'The prediction sits outside the interval the observed attempts allow for, so the ' +
                          'sample is saying something the model does not.'
                    : `${group.attempts} attempts is too few to contradict a prediction. Below that a run of ` +
                          'bad luck and a wrong model look the same.'
            )
        );

        if (group.unstamped) {
            card.appendChild(
                panelLine(
                    'Excluded',
                    `${group.unstamped} unstamped session${group.unstamped === 1 ? '' : 's'}`,
                    ROW_COLORS.dim,
                    'Sessions recorded before the predicted rate was stamped on them. They are never judged ' +
                        'against today’s model — the tea, catalyst and level penalty they ran under are gone, ' +
                        'so a prediction computed now would be measuring the model’s history, not its accuracy. ' +
                        'History fills forward only.'
                )
            );
        }

        if (!group.combos.length) continue;
        const foldKey = `alchemy:${group.kind}`;
        const open = expandedGroups.has(foldKey);
        card.appendChild(
            foldHeading(`Per item and catalyst (${group.combos.length})`, open, () => {
                if (open) expandedGroups.delete(foldKey);
                else expandedGroups.add(foldKey);
                calibrationPanel.render();
            })
        );
        if (!open) continue;

        for (const combo of group.combos) {
            const comboOff = combo.verdict === 'sim too high' || combo.verdict === 'sim too low';
            card.appendChild(
                panelLine(
                    `  ${comboLabel(combo)} (${combo.attempts})`,
                    combo.verdict === 'too few attempts'
                        ? 'too few attempts to call'
                        : `${ratePercent(combo.observed)} vs ${ratePercent(combo.predicted)} · ${verdictText(combo)}`,
                    comboOff ? ROW_COLORS.bad : combo.verdict === 'consistent' ? ROW_COLORS.good : ROW_COLORS.dim,
                    combo.verdict === 'too few attempts'
                        ? `${combo.attempts} attempts on this combination is too few to judge it on its own.`
                        : `Observed against the rate stamped for this item and catalyst, over ${combo.sessions} session(s).`
                )
            );
        }
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
        const alchemy = alchemySessions();
        if (all === null || enhancing === null) {
            body.appendChild(panelNote('Reading history…'));
            return;
        }
        const alchemySummary = alchemy ? summarizeAlchemyCalibration(alchemy) : { kinds: [] };
        if (!all.length && !enhancing.length && !alchemySummary.kinds.length) {
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

        // Same reasoning, same treatment: an alchemy session is a proportion out
        // of n trials, judged against its own interval rather than reduced to a
        // percentage gap. See `alchemy-calibration.js` for why it does not go
        // through the shared ledger.
        drawAlchemy(body, alchemySummary);

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
