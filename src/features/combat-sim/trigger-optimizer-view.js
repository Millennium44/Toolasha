/**
 * Trigger Optimizer: the options that live in the "Triggers" chip, and the
 * results box. Pure string builders, so the panel stays a thin wire-up and the
 * markup can be tested without one.
 */

import { formatKMB } from '../../utils/formatters.js';
import {
    PRECISIONS,
    DEFAULT_PRECISION,
    MIN_GAIN,
    MIN_GAIN_OPTIONS,
    DEFAULT_TUNABLE_SCOPE,
    OBJECTIVES,
    DEFAULT_OBJECTIVE,
    describeRow,
} from './trigger-tuning.js';
import { describeTriggerRows } from './lab-condition-search.js';

const ACCENT = '#4a9eff';
const BTN_STYLE =
    'background:rgba(74, 158, 255, 0.2); border:1px solid rgba(74, 158, 255, 0.4); color:#4a9eff; ' +
    'padding:3px 10px; border-radius:4px; font-size:11px; font-weight:600; cursor:pointer; font-family:inherit;';
const SELECT_STYLE =
    'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; padding:2px 4px; font-size:11px;';

/**
 * Escape text for HTML.
 * @param {*} text
 * @returns {string}
 */
export function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * The scope and precision selectors shown inside the chip while it is checked.
 * @returns {string} HTML
 */
export function triggerChipOptionsHtml() {
    const precisionOptions = Object.values(PRECISIONS)
        .map(
            (p) => `<option value="${p.key}"${p.key === DEFAULT_PRECISION ? ' selected' : ''}>${esc(p.label)}</option>`
        )
        .join('');
    const objectiveOptions = OBJECTIVES.map(
        (o) => `<option value="${o.key}"${o.key === DEFAULT_OBJECTIVE ? ' selected' : ''}>${esc(o.label)}</option>`
    ).join('');
    const minGainOptions = MIN_GAIN_OPTIONS.map(
        (v) => `<option value="${v}"${v === MIN_GAIN ? ' selected' : ''}>Min gain ${v}</option>`
    ).join('');
    return `
        <span data-mode-options="triggers" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <select class="toolasha-select" id="mwi-csim-trigger-scope" style="${SELECT_STYLE}"
                title="Just me tunes only the selected player's triggers and judges them on that player's results. Whole party tunes every member's triggers and judges the party total.">
                <option value="me" selected>Just me</option>
                <option value="party">Whole party</option>
            </select>
            <select class="toolasha-select" id="mwi-csim-trigger-include" style="${SELECT_STYLE}"
                title="Which triggers to tune: ability enemy-HP gates, food and drink HP/MP thresholds, or both.">
                <option value="both"${DEFAULT_TUNABLE_SCOPE === 'both' ? ' selected' : ''}>Abilities + food</option>
                <option value="abilities">Abilities only</option>
                <option value="consumables">Food &amp; drinks only</option>
            </select>
            <span style="color:#888; font-size:11px;">Optimize for</span>
            <select class="toolasha-select" id="mwi-csim-trigger-objective" style="${SELECT_STYLE}"
                title="Optimize for: Balanced weighs EXP/h, profit/h, DPS and encounters/h equally. XP/h or Profit/h judges a change on that one rate alone. Every choice loses 10 points per extra death per hour.">
                ${objectiveOptions}
            </select>
            <select class="toolasha-select" id="mwi-csim-trigger-precision" style="${SELECT_STYLE}"
                title="How long each candidate value is simulated. Quick is a rough pass; Precise tightens the error bars and takes several times longer.">
                ${precisionOptions}
            </select>
            <select class="toolasha-select" id="mwi-csim-trigger-mingain" style="${SELECT_STYLE}"
                title="Min gain: the smallest score gain worth offering, in score points. A change must also pass a 95% check against luck on fresh seeds, whatever this is set to.">
                ${minGainOptions}
            </select>
            <label style="display:inline-flex; align-items:center; gap:4px; color:#888; font-size:11px; cursor:pointer;"
                title="Also try different trigger conditions, not just different numbers: the buffs this zone's monsters cast on themselves or on you, your own buffs, and HP/MP readings, alone and ANDed in pairs. Runs after the threshold tuning for the selected player's abilities and food/drinks (per the choice above), takes many more sims, and its results are for you to enter by hand.">
                <input type="checkbox" id="mwi-csim-trigger-conditions" style="margin:0; cursor:pointer;">Search new conditions (slow)
            </label>
            <span id="mwi-csim-trigger-conditions-cost" style="color:#666; font-size:11px;"></span>
        </span>`;
}

const sign = (v, text) => (v < 0 ? text : `+${text}`);
const fmtScore = (v) => sign(v, v.toFixed(1));
const fmtRate = (v) => sign(v, formatKMB(Math.round(v)));
const fmtDeaths = (v) => sign(v, v.toFixed(3));
const fmtSe = (v) => (Number.isFinite(v) ? v.toFixed(1) : '?');

/**
 * The best candidate the search measured when no change was accepted, said plainly as not a
 * recommendation: the candidate with its gain in the objective's own score points (the unit the
 * accepted changes use), or that the current setting measured best. Display only.
 * @param {Object|null|undefined} best - `result.bestMeasured`: a tunable plus `from`, `to`, `deltaScore`, `se`
 * @param {Object} gameData - Game data payload (display names)
 * @returns {string} HTML ('' when nothing was measured)
 */
export function triggerBestHtml(best, gameData) {
    if (!best || !Number.isFinite(best.deltaScore)) return '';
    const text =
        best.deltaScore > 0
            ? `Best found: ${esc(best.itemName)} — ${esc(describeRow(best, gameData, best.to))} ` +
              `(was ${esc(best.from)}), Δscore ${esc(fmtScore(best.deltaScore))} ± ${esc(fmtSe(best.se))} ` +
              '(within noise, not a recommendation).'
            : 'Current setting measured best.';
    return `<div style="color:#888; font-size:11px; margin:2px 0 0 8px;" data-csim-trigger-best="${esc(best.key)}">${text}</div>`;
}

/** Where a changed slot lives, as the game words it */
function slotWord(change) {
    if (change.slotType === 'abilities') return 'ability';
    return change.slotType === 'food' ? 'food' : 'drink';
}

/**
 * The condition search's part of the results box, in the run's objective score points.
 * @param {Object|undefined} conditions - `result.conditions`
 * @param {Object} gameData - Game data payload (the trigger names)
 * @returns {string} HTML ('' when the search was not run)
 */
export function conditionResultsHtml(conditions, gameData) {
    if (!conditions) return '';
    let body =
        `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-top:8px;">New conditions</div>` +
        '<div style="color:#888; font-size:11px;">The selected player only; show-only, so enter any you want in the ' +
        'game by hand.' +
        (conditions.afterThresholds ? ' Searched after the threshold changes above; gains are on top of them.' : '') +
        '</div>';
    const skipped = {
        'no-slots': 'No ability, food or drink in this setup has a trigger the condition search can vary.',
        cap: "The condition search's sim limit is too small to measure a starting point, so it did not run.",
        profit: "Profit/h can't be valued for this setup, so there is nothing to optimize in the condition search.",
    }[conditions.skipped];
    if (skipped) return body + `<div style="color:#aaa; font-size:12px;">${esc(skipped)}</div>`;

    const bests = (conditions.bestMeasured || [])
        .filter((b) => Number.isFinite(b.deltaScore))
        .map((b) => {
            const text =
                b.deltaScore > 0
                    ? `Best found: ${esc(b.itemName)} (${slotWord(b)}), ${esc(describeTriggerRows(b.toRows, gameData))}, ` +
                      `Δscore ${esc(fmtScore(b.deltaScore))} ± ${esc(fmtSe(b.se))} (within noise, not a recommendation).`
                    : `${esc(b.itemName)} (${slotWord(b)}): Current setting measured best.`;
            return `<div style="color:#888; font-size:11px; margin:2px 0 0 8px;" data-csim-condition-best="${esc(b.key)}">${text}</div>`;
        })
        .join('');
    const changes = conditions.changes || [];
    if (conditions.reliable === false) {
        body +=
            '<div style="color:#ff9800; font-size:12px;">Some conditions looked better one at a time, but together ' +
            'they did not beat the current triggers on fresh seeds by a clear margin, so none are recommended.</div>' +
            bests;
    } else if (changes.length === 0) {
        body += `<div style="color:#aaa; font-size:12px;">No condition beat the current triggers by a clear margin${
            conditions.stopped ? ' before the run was stopped' : ''
        }.</div>${bests}`;
    }
    for (const c of changes) {
        body +=
            `<div style="font-size:12px; margin:4px 0 4px 8px;" data-csim-condition-change="${esc(c.key)}">` +
            `<span style="color:#e0e0e0;">${esc(c.itemName)}</span> <span style="color:#888;">(${slotWord(c)})</span><br>` +
            `<span style="color:${ACCENT}; font-weight:700;">${esc(describeTriggerRows(c.toRows, gameData))}</span><br>` +
            `<span style="color:#888;">was: ${esc(describeTriggerRows(c.fromRows, gameData))}</span><br>` +
            `<span style="color:#4caf50;">Δscore ${esc(fmtScore(c.deltaScore))} ± ${esc(fmtSe(c.se))}</span></div>`;
    }
    if (conditions.combined) {
        const c = conditions.combined;
        const good = conditions.reliable !== false && c.deltaScore > 0;
        body +=
            `<div style="font-size:12px; margin-top:6px;"><b>All new conditions together</b> (fresh seeds, ${esc(c.seeds)} runs): ` +
            `<span style="color:${good ? '#4caf50' : '#ff9800'};">Δscore ${esc(fmtScore(c.deltaScore))} ± ${esc(fmtSe(c.se))}</span></div>`;
    } else if (changes.length > 0) {
        // Stopped after slots passed one at a time but before the all-together check: not yet recommendations
        body +=
            '<div style="font-size:11px; color:#ff9800; margin-top:6px;" data-csim-condition-unconfirmed>Stopped before ' +
            'the all-together check ran; these passed one at a time and may not hold together.</div>';
    }
    if (conditions.capped) {
        body +=
            '<div style="font-size:11px; color:#ff9800; margin-top:4px;">Stopped at the limit on condition-search sims; ' +
            'abilities and consumables after that point were not searched.</div>';
    }
    return body;
}

function deltaCells(c, profitKnown = true) {
    // A profit figure with an unpriced item or a failed valuation in it is not shown as if it were one
    const profit = profitKnown ? fmtRate(c.deltaProfit) : '? (not valued)';
    const xp = esc(fmtRate(c.deltaXp));
    return `ΔEXP/h ${xp} · Δprofit/h ${esc(profit)} · Δdeaths/h ${esc(fmtDeaths(c.deltaDeaths))}`;
}

/**
 * Why profit could not be valued: the unpriced items by name, and/or a valuation that failed.
 * @param {Object} result - From `runTriggerOptimization`
 * @param {Object} gameData - Game data payload (display names)
 * @returns {string} Plain text, without a trailing period
 */
export function profitUnvaluedReason(result, gameData) {
    const names = [
        ...new Set((result?.unpriced || []).map((hrid) => gameData?.itemDetailMap?.[hrid]?.name || humanizeHrid(hrid))),
    ];
    const parts = [];
    if (names.length > 0) parts.push(`${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} no price`);
    if (result?.valuationFailed) parts.push('the valuation failed');
    return parts.length > 0 ? `profit can't be valued: ${parts.join('; ')}` : "profit can't be valued";
}

function humanizeHrid(hrid) {
    const tail = String(hrid).split('/').pop() || String(hrid);
    return tail.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * What the score means, for the footer.
 * @param {string} [objective] - An OBJECTIVES key
 * @returns {string} Plain text
 */
export function objectiveFooterText(objective) {
    const deaths = 'less 10 points per extra death per hour';
    if (objective === 'xp') return `Optimizing for XP/h: score is the percent change in EXP/h, ${deaths}.`;
    const profitScale =
        "profit/h is taken as a percent of the fight's loot value or consumable spend, whichever is larger";
    if (objective === 'profit') {
        return `Optimizing for profit/h: score is the percent change in profit/h, ${deaths}; ${profitScale}.`;
    }
    return `Score is the average of the EXP/h, profit/h, DPS and encounters/h changes, ${deaths}; ${profitScale}.`;
}

/**
 * The results box: changes grouped by player, sorted by impact, with the
 * all-together line at the bottom and the Apply / Copy buttons.
 * @param {Object|null} result - From `runTriggerOptimization`
 * @param {Object} gameData - Game data payload (display names)
 * @param {Object} [options] - `{ canApply, cached }`; `cached` labels a remembered result and offers Run again
 * @returns {string} HTML
 */
export function renderTriggerResultsHtml(result, gameData, { canApply = true, cached = false } = {}) {
    const cachedLabel = cached
        ? ` <span style="color:#888; font-weight:400; font-size:11px;">Last result (unchanged setup)</span>` +
          ` <button id="mwi-csim-trigger-rerun" style="${BTN_STYLE} margin-left:6px;" ` +
          `title="Runs the trigger search again on fresh seeds">Run again</button>`
        : '';
    const head = `<div style="color:${ACCENT}; font-weight:700; font-size:13px; margin-bottom:4px;">Trigger tuning${cachedLabel}</div>`;
    const wrap = (inner) =>
        `<div id="mwi-csim-trigger-results" style="border:1px solid #2a2a4a; border-radius:6px; padding:8px 10px; margin:8px 0;">${head}${inner}</div>`;

    if (!result) return wrap('<div style="color:#888; font-size:12px;">Stopped before the baseline finished.</div>');
    if (result.noTunables) {
        const who = result.scope === 'party' ? "party's" : "player's";
        const message =
            result.include === 'abilities'
                ? 'No tunable ability triggers in this setup: none of the ' +
                  `${who} abilities have a trigger that compares an enemy's HP to a number.`
                : result.include === 'consumables'
                  ? 'No tunable food or drink triggers in this setup: none of the ' +
                    `${who} food or drinks have a trigger that compares an HP or MP reading to a number.`
                  : `Nothing to tune: none of the ${who} ability or food triggers compare an HP or MP ` +
                    'reading to a number.';
        // With the condition search on, "no thresholds" is not the end: the conditions block still has its answer
        return wrap(
            `<div style="color:#888; font-size:12px;">${esc(message)}</div>` +
                conditionResultsHtml(result.conditions, gameData)
        );
    }

    const changes = result.changes || [];
    const players = new Map();
    for (const c of changes) {
        if (!players.has(c.playerHrid)) players.set(c.playerHrid, { name: c.playerName, rows: [] });
        players.get(c.playerHrid).rows.push(c);
    }
    const showNames = players.size > 1 || result.scope === 'party';
    const unused = result.unused || [];
    const allUnused = unused.length > 0 && (result.unchanged || []).length === 0 && changes.length === 0;

    const profitKnown = !result.profitLeftOut;
    const profitReason = profitKnown ? '' : profitUnvaluedReason(result, gameData);
    let body = '';
    if (!profitKnown && result.objective === 'profit') {
        body +=
            `<div style="color:#ff9800; font-size:12px; font-weight:600;">Nothing recommended: ${esc(profitReason)}.</div>` +
            '<div style="color:#aaa; font-size:12px; margin-top:2px;">Profit/h counts an unpriced item at zero, ' +
            'so any change would be a guess. Set a custom price for it, or optimize for Balanced or XP/h.</div>';
    } else if (result.reliable === false) {
        body +=
            '<div style="color:#ff9800; font-size:12px; font-weight:600;">No reliable improvement found.</div>' +
            '<div style="color:#aaa; font-size:12px; margin-top:2px;">Some values looked better in single runs, ' +
            'but the combination did not beat your current triggers on fresh seeds by a clear margin, so none ' +
            'are recommended.</div>' +
            triggerBestHtml(result.bestMeasured, gameData);
    } else if (changes.length === 0 && allUnused) {
        body +=
            '<div style="color:#e0e0e0; font-size:12px;">None of these triggers came into play in this fight, ' +
            'so no threshold could change the result.</div>';
    } else if (changes.length === 0) {
        body += '<div style="color:#e0e0e0; font-size:12px;">No change beat the current thresholds by a clear margin.';
        body += ' Your triggers are already about as good as this search can tell.</div>';
        body += triggerBestHtml(result.bestMeasured, gameData);
    }
    for (const { name, rows } of players.values()) {
        if (showNames)
            body += `<div style="color:#aaa; font-size:12px; font-weight:600; margin-top:6px;">${esc(name)}</div>`;
        for (const c of rows) {
            const row = describeRow(c, gameData, c.to);
            body +=
                `<div style="font-size:12px; margin:3px 0 3px 8px;">` +
                `<span style="color:#e0e0e0;">${esc(c.itemName)}</span> — ${esc(row)} ` +
                `<span style="color:#888;">(was ${esc(c.from)})</span><br>` +
                `<span style="color:#4caf50;">Δscore ${esc(fmtScore(c.deltaScore))} ± ${esc(fmtSe(c.se))}</span>` +
                ` <span style="color:#888;">· ${deltaCells(c, profitKnown)}</span></div>`;
        }
    }

    if (result.combined) {
        const c = result.combined;
        const good = c.deltaScore > 0 && result.reliable !== false;
        body +=
            `<div style="font-size:12px; margin-top:8px; padding-top:6px; border-top:1px solid #2a2a4a;">` +
            `<b>All changes together</b> (fresh seeds, ${c.seeds} runs): ` +
            `<span style="color:${good ? '#4caf50' : '#ff9800'};">Δscore ${esc(fmtScore(c.deltaScore))} ± ${esc(fmtSe(c.se))}</span>` +
            ` <span style="color:#888;">· ${deltaCells(c, profitKnown)}</span></div>`;
    } else if (changes.length > 0) {
        body +=
            '<div style="font-size:11px; color:#ff9800; margin-top:8px;">Stopped before the all-together check ' +
            'ran; each figure above is from the step that accepted it.</div>';
    }

    if (!profitKnown && result.objective !== 'profit') {
        body +=
            `<div style="font-size:11px; color:#ff9800; margin-top:6px;">Profit/h left out of the score ` +
            `where it could not be counted: ${esc(profitReason)}.</div>`;
    }

    const notPriced = [...new Set((result.notPriced || []).map((t) => t.itemName))];
    if (notPriced.length > 0) {
        body +=
            `<div style="font-size:11px; color:#ff9800; margin-top:6px;">Not tuned: ${esc(notPriced.join(', '))} ` +
            `${notPriced.length === 1 ? 'has' : 'have'} no price, so the gold effect can't be checked.</div>`;
    }

    const unchanged = result.unchanged || [];
    if (unchanged.length > 0) {
        body +=
            `<div style="font-size:11px; color:#666; margin-top:6px;">Kept as is: ` +
            `${esc([...new Set(unchanged.map((t) => t.itemName))].join(', '))}.</div>`;
    }
    if (unused.length > 0) {
        body +=
            `<div style="font-size:11px; color:#666; margin-top:4px;" title="Their triggers were never checked in ` +
            `the baseline runs: the ability or food never came off cooldown at a moment it was looked at, so no ` +
            `threshold could have changed anything.">Not used in this fight: ` +
            `${esc([...new Set(unused.map((t) => t.itemName))].join(', '))}.</div>`;
    }

    body += conditionResultsHtml(result.conditions, gameData);

    body +=
        `<div style="font-size:11px; color:#666; margin-top:6px;">` +
        `${esc(objectiveFooterText(result.objective))} ` +
        `A change is kept only when it clears a 95% test on seeds that did not pick it, and gains at least ${esc(result.minGain ?? MIN_GAIN)} points. ` +
        `${esc(result.simCount)} sims${
            result.conditionSimCount ? ` (${esc(result.conditionSimCount)} of them for the condition search)` : ''
        }${result.stopped ? ' (stopped early, showing what was accepted)' : ''}. ` +
        `The userscript never changes triggers in the game; enter these by hand.</div>`;

    if (changes.length > 0) {
        body +=
            `<div style="display:flex; gap:8px; margin-top:8px;">` +
            `<button id="mwi-csim-trigger-apply" style="${BTN_STYLE}"${canApply ? '' : ' disabled'} ` +
            `title="Writes the new values into this simulator's trigger editor so the next Simulate uses them. Nothing is sent to the game.">Apply to sim editor</button>` +
            `<button id="mwi-csim-trigger-copy" style="${BTN_STYLE}" title="Copies one line per change, to enter in the game yourself">Copy as text</button>` +
            `</div>`;
    }
    return wrap(body);
}
