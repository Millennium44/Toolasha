/**
 * Lab Sim trigger tuning: the section's options and its results box. Pure string builders, so
 * the panel stays a thin wire-up and the markup can be tested without one.
 */

import { PRECISIONS, DEFAULT_PRECISION, TUNABLE_SCOPES, DEFAULT_TUNABLE_SCOPE, describeRow } from './trigger-tuning.js';
import { esc } from './trigger-optimizer-view.js';

const ACCENT = '#4a9eff';

/** The one condition whose threshold is a percentage (`describeRow` puts the % on the old value) */
const LOWEST_HP_PCT = '/combat_trigger_conditions/lowest_hp_percentage';

/** The include choices, worded as the Combat Sim's Triggers chip words them */
export const LAB_TRIGGER_INCLUDE_LABELS = {
    both: 'Abilities + food',
    abilities: 'Abilities only',
    consumables: 'Food & drinks only',
};

/**
 * The remembered choices, cleaned: anything unknown falls back to its default.
 * @param {*} saved - What storage held
 * @returns {{open: boolean, include: string, precision: string, skipped: Array<string>}}
 */
export function sanitizeLabTriggerChoices(saved) {
    const record = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    return {
        open: record.open === true,
        include: TUNABLE_SCOPES.includes(record.include) ? record.include : DEFAULT_TUNABLE_SCOPE,
        precision: PRECISIONS[record.precision] ? record.precision : DEFAULT_PRECISION,
        // Loadouts unticked, so a loadout saved later starts ticked
        skipped: Array.isArray(record.skipped) ? record.skipped.filter((k) => typeof k === 'string').slice(0, 50) : [],
    };
}

/**
 * The include and precision selects.
 * @param {Object} choices - From `sanitizeLabTriggerChoices`
 * @param {string} selectStyle - Inline style for the selects
 * @returns {string} HTML
 */
export function labTriggerOptionsHtml(choices, selectStyle) {
    const include = TUNABLE_SCOPES.map(
        (key) =>
            `<option value="${key}"${key === choices.include ? ' selected' : ''}>${esc(LAB_TRIGGER_INCLUDE_LABELS[key])}</option>`
    ).join('');
    const precision = Object.values(PRECISIONS)
        .map(
            (p) => `<option value="${p.key}"${p.key === choices.precision ? ' selected' : ''}>${esc(p.label)}</option>`
        )
        .join('');
    return (
        `<select class="toolasha-select" id="mwi-labsim-trigger-include" style="${selectStyle}" ` +
        `title="Which triggers to tune: ability enemy-HP gates, food and drink HP/MP thresholds, or both.">${include}</select>` +
        `<select class="toolasha-select" id="mwi-labsim-trigger-precision" style="${selectStyle}" ` +
        `title="How many attempts each candidate value is simulated for. Quick is a rough pass; Precise tightens the error bars and takes several times longer.">${precision}</select>`
    );
}

/**
 * One checkbox per loadout group.
 * @param {Array<Object>} groups - From `groupFightsByLoadout`
 * @param {Set<string>} skipped - Group keys left unticked
 * @returns {string} HTML
 */
export function labTriggerLoadoutsHtml(groups, skipped) {
    if (!groups.length) {
        return '<span style="color:#666; font-size:11px;">No labyrinth fights with room levels yet.</span>';
    }
    return groups
        .map((group) => {
            const monsters = group.fights.map((f) => f.monsterName).join(', ');
            return (
                `<label style="display:inline-flex; align-items:center; gap:4px; color:#aaa; font-size:12px; cursor:pointer;" ` +
                `title="${esc(monsters)}">` +
                `<input type="checkbox" data-lab-trigger-group="${esc(group.key)}" style="margin:0; cursor:pointer;"` +
                `${skipped.has(group.key) ? '' : ' checked'}>` +
                `${esc(group.name)} <span style="color:#666;">(${group.fights.length} fight${group.fights.length === 1 ? '' : 's'})</span></label>`
            );
        })
        .join('');
}

/**
 * The cost line shown before a run.
 * @param {Object} estimate - From `estimateLabTriggerRun`
 * @returns {string} Plain text
 */
export function describeLabTriggerEstimate(estimate) {
    if (!estimate.groups.length) return 'Tick a loadout to tune.';
    const tunable = estimate.groups.reduce((s, g) => s + g.tunables, 0);
    if (tunable === 0) return 'No tunable trigger rows in the ticked loadouts.';
    return (
        `About ${estimate.sims.toLocaleString('en-US')} fight sims (${tunable} trigger row${tunable === 1 ? '' : 's'}), ` +
        `${estimate.trials.first}–${estimate.trials.confirm} attempts each.`
    );
}

const pct = (rate) => (rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`);
const attempts = (v) => (Number.isFinite(v) ? v.toFixed(2) : '?');
const se = (v) => (Number.isFinite(v) ? v.toFixed(2) : '?');

/**
 * Where a changed row lives, as the game words its slots.
 * @param {Object} change - A change from the search
 * @returns {string}
 */
function slotWord(change) {
    if (change.slotType === 'abilities') return 'ability';
    return change.slotType === 'food' ? 'food' : 'drink';
}

/**
 * One loadout's block.
 * @param {Object} group - From `runLabTriggerOptimization`
 * @param {Object} gameData - Game data payload (display names)
 * @returns {string} HTML
 */
function groupHtml(group, gameData) {
    const head = `<div style="color:#e0e0e0; font-weight:700; font-size:12px; margin-top:8px;">${esc(group.name)}</div>`;
    const result = group.result;
    if (!result) return head + '<div style="color:#888; font-size:12px;">Stopped before the baseline finished.</div>';
    if (result.noTunables) {
        return (
            head +
            '<div style="color:#888; font-size:12px;">Nothing to tune: no trigger in this loadout compares an HP ' +
            'or MP reading to a number.</div>'
        );
    }

    let body = '';
    const changes = result.changes || [];
    if (result.reliable === false) {
        body +=
            '<div style="color:#ff9800; font-size:12px; font-weight:600;">No reliable improvement found.</div>' +
            '<div style="color:#aaa; font-size:12px;">Some values looked better in single runs, but together ' +
            'they did not beat the current triggers on fresh seeds by a clear margin, so none are recommended.</div>';
    } else if (changes.length === 0) {
        body +=
            '<div style="color:#aaa; font-size:12px;">No change beat the current thresholds by a clear margin.</div>';
    }
    for (const c of changes) {
        const before = describeRow(c, gameData, c.from);
        body +=
            `<div style="font-size:12px; margin:3px 0 3px 8px;" data-lab-trigger-change="${esc(c.key)}">` +
            `<span style="color:#e0e0e0;">${esc(c.itemName)}</span> <span style="color:#888;">(${slotWord(c)})</span> — ` +
            `${esc(before)} <span style="color:${ACCENT}; font-weight:700;">→ ${esc(c.to)}${c.conditionHrid === LOWEST_HP_PCT ? '%' : ''}</span><br>` +
            `<span style="color:#4caf50;">saves ${esc(attempts(c.deltaScore))} ± ${esc(se(c.se))} attempts</span></div>`;
    }

    if (result.combined) {
        const c = result.combined;
        const good = result.reliable !== false && c.deltaScore > 0;
        body +=
            `<div style="font-size:12px; margin-top:6px;"><b>All changes together</b> (fresh seeds, ${esc(c.seeds)} runs): ` +
            `<span style="color:${good ? '#4caf50' : '#ff9800'};" title="Means across the check's seeds: each seed's ` +
            `expected attempts for these fights, averaged. A fight a seed never won counts as half a win.">` +
            `expected attempts (mean of ${esc(c.seeds)} seeds) ` +
            `${esc(attempts(group.baselineAttempts))} → ${esc(attempts(group.tunedAttempts))}, ` +
            `saves ${esc(attempts(c.deltaScore))} ± ${esc(se(c.se))}</span></div>`;
    } else if (changes.length > 0) {
        body +=
            '<div style="font-size:11px; color:#ff9800; margin-top:6px;">Stopped before the all-together check ' +
            'ran; each figure above is from the step that accepted it.</div>';
    }

    const fights = group.fights || [];
    if (fights.length) {
        const showAfter = fights.some((f) => f.tunedWinRate !== null && f.tunedWinRate !== undefined);
        body +=
            '<table style="border-collapse:collapse; font-size:11px; margin:4px 0 0 8px;">' +
            '<tr style="color:#888;"><td style="padding:1px 8px 1px 0;">Fight</td><td style="padding:1px 8px;">Room</td>' +
            `<td style="padding:1px 8px;">Win rate</td>${showAfter ? '<td style="padding:1px 8px;">Tuned</td><td style="padding:1px 8px;">Change</td>' : ''}</tr>` +
            fights
                .map((f) => {
                    const delta =
                        showAfter && f.winRate !== null && f.tunedWinRate !== null
                            ? (f.tunedWinRate - f.winRate) * 100
                            : null;
                    const deltaText = delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pp`;
                    return (
                        `<tr><td style="padding:1px 8px 1px 0; color:#ccc;">${esc(f.monsterName)}</td>` +
                        `<td style="padding:1px 8px; color:#aaa;">${esc(f.roomLevel)}</td>` +
                        `<td style="padding:1px 8px; color:#aaa;">${pct(f.winRate)}</td>` +
                        (showAfter
                            ? `<td style="padding:1px 8px; color:#e0e0e0;">${pct(f.tunedWinRate)}</td>` +
                              `<td style="padding:1px 8px; color:${delta > 0 ? '#4caf50' : '#aaa'};">${deltaText}</td>`
                            : '') +
                        '</tr>'
                    );
                })
                .join('') +
            '</table>';
    }

    const unused = [...new Set((result.unused || []).map((t) => t.itemName))];
    if (unused.length > 0) {
        body +=
            `<div style="font-size:11px; color:#666; margin-top:4px;">Never came into play in these fights: ` +
            `${esc(unused.join(', '))}.</div>`;
    }
    return head + body;
}

/**
 * The results box: one block per loadout, then the footer.
 * @param {Object} run - From `runLabTriggerOptimization`
 * @param {Object} gameData - Game data payload (display names)
 * @returns {string} HTML
 */
export function renderLabTriggerResultsHtml(run, gameData) {
    const groups = run?.groups || [];
    const body = groups.length
        ? groups.map((g) => groupHtml(g, gameData)).join('')
        : '<div style="color:#888; font-size:12px;">No loadout was tuned.</div>';
    const footer =
        `<div style="font-size:11px; color:#666; margin-top:8px;">` +
        `Score is the expected number of attempts to clear the loadout's fights (sum of 1 / win rate). ` +
        `A change is kept only when it clears a 95% test on seeds that did not pick it and saves at least ` +
        `${esc(run?.minGain)} attempts. ${esc(run?.simCount)} fight sims. ` +
        `<b style="color:#ff9800;">Simulated only: set these values in the game by hand.</b> ` +
        `Toolasha never changes a trigger in the game.</div>`;
    return (
        `<div style="border:1px solid #2a2a4a; border-radius:6px; padding:8px 10px;">` +
        `<div style="color:${ACCENT}; font-weight:700; font-size:13px;">Trigger tuning</div>${body}${footer}</div>`
    );
}
