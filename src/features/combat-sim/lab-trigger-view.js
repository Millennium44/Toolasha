/**
 * Lab Sim trigger tuning: the section's options and its results box. Pure string builders, so
 * the panel stays a thin wire-up and the markup can be tested without one.
 */

import { PRECISIONS, DEFAULT_PRECISION, describeRow } from './trigger-tuning.js';
import { esc } from './trigger-optimizer-view.js';
import { LAB_TRIGGER_SCOPE, describeTriggerRows } from './lab-condition-search.js';

const ACCENT = '#4a9eff';

/** The one condition whose threshold is a percentage (`describeRow` puts the % on the old value) */
const LOWEST_HP_PCT = '/combat_trigger_conditions/lowest_hp_percentage';

/**
 * The remembered choices, cleaned: anything unknown falls back to its default.
 * @param {*} saved - What storage held
 * @returns {{open: boolean, include: string, precision: string, skipped: Array<string>, conditions: boolean}}
 */
export function sanitizeLabTriggerChoices(saved) {
    const record = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    return {
        open: record.open === true,
        // Abilities only: the labyrinth allows no food or drink, so any stored consumables choice is dropped
        include: LAB_TRIGGER_SCOPE,
        precision: PRECISIONS[record.precision] ? record.precision : DEFAULT_PRECISION,
        // Loadouts unticked, so a loadout saved later starts ticked
        skipped: Array.isArray(record.skipped) ? record.skipped.filter((k) => typeof k === 'string').slice(0, 50) : [],
        // The condition search is slow: off unless the player ticked it
        conditions: record.conditions === true,
    };
}

/**
 * The abilities note and the precision select.
 * @param {Object} choices - From `sanitizeLabTriggerChoices`
 * @param {string} selectStyle - Inline style for the selects
 * @returns {string} HTML
 */
export function labTriggerOptionsHtml(choices, selectStyle) {
    const precision = Object.values(PRECISIONS)
        .map(
            (p) => `<option value="${p.key}"${p.key === choices.precision ? ' selected' : ''}>${esc(p.label)}</option>`
        )
        .join('');
    return (
        `<span style="color:#aaa; font-size:12px;" id="mwi-labsim-trigger-scope" ` +
        `title="The labyrinth allows no food or drink, so only ability triggers are tuned.">Abilities</span>` +
        `<select class="toolasha-select" id="mwi-labsim-trigger-precision" style="${selectStyle}" ` +
        `title="How many attempts each candidate value is simulated for. Quick is a rough pass; Precise tightens the error bars and takes several times longer.">${precision}</select>` +
        `<label style="display:inline-flex; align-items:center; gap:4px; color:#aaa; font-size:12px; cursor:pointer;" ` +
        `title="Also try different trigger conditions, not just different numbers: the buffs the room's monsters cast ` +
        `on themselves or on you, your own buffs, and HP/MP readings, alone and ANDed in pairs. Runs after the ` +
        `threshold tuning and costs many more sims.">` +
        `<input type="checkbox" id="mwi-labsim-trigger-conditions" style="margin:0; cursor:pointer;"` +
        `${choices.conditions ? ' checked' : ''}>Search new conditions (slow)</label>`
    );
}

/**
 * One checkbox per loadout group; the Configure fight, which is not a loadout, is a plain label.
 * @param {Array<Object>} groups - From `groupFightsForScope` or `configureFightGroup`
 * @param {Set<string>} skipped - Group keys left unticked
 * @param {string} [note] - Why there is nothing to list, when the target scope says so
 * @returns {string} HTML
 */
export function labTriggerLoadoutsHtml(groups, skipped, note = '') {
    if (!groups.length) {
        return `<span style="color:#666; font-size:11px;">${esc(note || 'No labyrinth fights with room levels yet.')}</span>`;
    }
    return groups
        .map((group) => {
            const monsters = group.fights.map((f) => f.monsterName).join(', ');
            if (group.configure) {
                const fight = group.fights[0];
                return (
                    `<span style="color:#aaa; font-size:12px;" data-lab-trigger-configure="${esc(group.key)}" ` +
                    `title="The Configure tab's fight in the setup edited there, saved or not. Change the scope on the Upgrade tab to tune loadouts instead.">` +
                    `${esc(group.name)}: ${esc(fight.monsterName)} <span style="color:#666;">L${esc(fight.roomLevel)}</span></span>`
                );
            }
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
    const conditionSims = Number(estimate.conditionSims) || 0;
    const slots = estimate.groups.reduce((s, g) => s + (g.conditionSlots || 0), 0);
    const conditions =
        conditionSims > 0
            ? `Condition search: up to ${conditionSims.toLocaleString('en-US')} more fight sims ` +
              `(${slots} abilit${slots === 1 ? 'y' : 'ies'}).`
            : '';
    if (tunable === 0) return conditions || 'No tunable trigger rows in the ticked loadouts.';
    return (
        `About ${estimate.sims.toLocaleString('en-US')} fight sims (${tunable} trigger row${tunable === 1 ? '' : 's'}), ` +
        `${estimate.trials.first}–${estimate.trials.confirm} attempts each.` +
        (conditions ? ` ${conditions}` : '')
    );
}

const pct = (rate) => (rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`);
const attempts = (v) => (Number.isFinite(v) ? v.toFixed(2) : '?');
const se = (v) => (Number.isFinite(v) ? v.toFixed(2) : '?');
/** A saving in attempts with its sign: "+0.03", "−0.05" */
const signed = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(2)}` : '?');

/**
 * The best candidate a search measured when none was recommended, said plainly as not a recommendation:
 * either the candidate with its saving (within noise) or that the current setting measured best.
 * @param {Object|null|undefined} best - `{ deltaScore, se }` plus whatever `describe` reads
 * @param {Function} describe - `(best) => string`: the candidate in the game's wording (plain text)
 * @param {string} attr - Data attribute name for tests and styling
 * @param {string} [currentPrefix] - Text before "Current setting measured best." (escaped by the caller)
 * @returns {string} HTML ('' when nothing was measured)
 */
function bestFoundHtml(best, describe, attr, currentPrefix = '') {
    if (!best || !Number.isFinite(best.deltaScore)) return '';
    const text =
        best.deltaScore > 0
            ? `Best found: ${esc(describe(best))}, saves ${esc(signed(best.deltaScore))} ± ${esc(se(best.se))} attempts ` +
              '(within noise, not a recommendation).'
            : `${currentPrefix}Current setting measured best.`;
    return `<div style="color:#888; font-size:11px; margin:2px 0 0 8px;" ${attr}="${esc(best.key)}">${text}</div>`;
}

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
 * The win-rate table of some per-fight figures.
 * @param {Array<Object>} fights - `{ monsterName, roomLevel, winRate, tunedWinRate }`
 * @param {string} afterLabel - What the second column is called
 * @returns {string} HTML
 */
function fightsTableHtml(fights, afterLabel) {
    if (!fights.length) return '';
    const showAfter = fights.some((f) => f.tunedWinRate !== null && f.tunedWinRate !== undefined);
    return (
        '<table style="border-collapse:collapse; font-size:11px; margin:4px 0 0 8px;">' +
        '<tr style="color:#888;"><td style="padding:1px 8px 1px 0;">Fight</td><td style="padding:1px 8px;">Room</td>' +
        `<td style="padding:1px 8px;">Win rate</td>${showAfter ? `<td style="padding:1px 8px;">${esc(afterLabel)}</td><td style="padding:1px 8px;">Change</td>` : ''}</tr>` +
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
        '</table>'
    );
}

/**
 * The best candidate measured for each condition slot that is not recommended.
 * @param {Object} conditions - A group's `conditions`
 * @param {Object} gameData - Game data payload (the trigger names)
 * @returns {string} HTML
 */
function conditionBestsHtml(conditions, gameData) {
    return (conditions.bestMeasured || [])
        .map((b) =>
            bestFoundHtml(
                b,
                (x) => `${x.itemName} (${slotWord(x)}), ${describeTriggerRows(x.toRows, gameData)}`,
                'data-lab-condition-best',
                `${esc(b.itemName)} (${slotWord(b)}): `
            )
        )
        .join('');
}

/**
 * The condition search's part of a loadout's block.
 * @param {Object} conditions - A group's `conditions`, from `runLabTriggerOptimization`
 * @param {Object} gameData - Game data payload (the trigger names)
 * @returns {string} HTML
 */
export function conditionResultsHtml(conditions, gameData) {
    if (!conditions) return '';
    let body =
        `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-top:8px;">New conditions</div>` +
        (conditions.afterThresholds
            ? '<div style="color:#888; font-size:11px;">Searched after the threshold changes above; ' +
              'savings are on top of them.</div>'
            : '');
    const changes = conditions.changes || [];
    if (conditions.reliable === false) {
        body +=
            '<div style="color:#ff9800; font-size:12px;">Some conditions looked better one at a time, but together ' +
            'they did not beat the current triggers on fresh seeds by a clear margin, so none are recommended.</div>' +
            conditionBestsHtml(conditions, gameData);
    } else if (changes.length === 0) {
        body += `<div style="color:#aaa; font-size:12px;">No condition beat the current triggers by a clear margin${
            conditions.stopped ? ' before the run was stopped' : ''
        }.</div>`;
        body += conditionBestsHtml(conditions, gameData);
    }
    for (const c of changes) {
        body +=
            `<div style="font-size:12px; margin:4px 0 4px 8px;" data-lab-condition-change="${esc(c.key)}">` +
            `<span style="color:#e0e0e0;">${esc(c.itemName)}</span> <span style="color:#888;">(${slotWord(c)})</span><br>` +
            `<span style="color:${ACCENT}; font-weight:700;">${esc(describeTriggerRows(c.toRows, gameData))}</span><br>` +
            `<span style="color:#888;">was: ${esc(describeTriggerRows(c.fromRows, gameData))}</span><br>` +
            `<span style="color:#4caf50;">saves ${esc(attempts(c.deltaScore))} ± ${esc(se(c.se))} attempts</span></div>`;
    }
    if (conditions.combined) {
        const c = conditions.combined;
        const good = conditions.reliable !== false && c.deltaScore > 0;
        body +=
            `<div style="font-size:12px; margin-top:6px;"><b>All new conditions together</b> (fresh seeds, ${esc(c.seeds)} runs): ` +
            `<span style="color:${good ? '#4caf50' : '#ff9800'};">expected attempts ` +
            `${esc(attempts(c.attemptsBefore))} → ${esc(attempts(c.attemptsAfter))}, ` +
            `saves ${esc(attempts(c.deltaScore))} ± ${esc(se(c.se))}</span></div>`;
        body += fightsTableHtml(conditions.fights || [], 'New');
    }
    if (conditions.capped) {
        body +=
            '<div style="font-size:11px; color:#ff9800; margin-top:4px;">Stopped at the condition search\'s sim ' +
            'limit; abilities and consumables after that point were not searched.</div>';
    }
    return body;
}

/**
 * The best threshold candidate measured, shown when nothing is recommended.
 * @param {Object} result - A group's threshold `result`
 * @param {Object} gameData - Game data payload (display names)
 * @returns {string} HTML
 */
function triggerBestHtml(result, gameData) {
    return bestFoundHtml(
        result.bestMeasured,
        (b) =>
            `${b.itemName} (${slotWord(b)}), ${describeRow(b, gameData, b.from)} → ${b.to}` +
            (b.conditionHrid === LOWEST_HP_PCT ? '%' : ''),
        'data-lab-trigger-best'
    );
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
            '<div style="color:#888; font-size:12px;">No thresholds to tune: no trigger in this loadout compares an HP ' +
            'or MP reading to a number.</div>' +
            conditionResultsHtml(group.conditions, gameData)
        );
    }

    let body = '';
    const changes = result.changes || [];
    if (result.reliable === false) {
        body +=
            '<div style="color:#ff9800; font-size:12px; font-weight:600;">No reliable improvement found.</div>' +
            '<div style="color:#aaa; font-size:12px;">Some values looked better in single runs, but together ' +
            'they did not beat the current triggers on fresh seeds by a clear margin, so none are recommended.</div>' +
            triggerBestHtml(result, gameData);
    } else if (changes.length === 0) {
        body +=
            '<div style="color:#aaa; font-size:12px;">No change beat the current thresholds by a clear margin.</div>' +
            triggerBestHtml(result, gameData);
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

    body += fightsTableHtml(group.fights || [], 'Tuned');

    const unused = [...new Set((result.unused || []).map((t) => t.itemName))];
    if (unused.length > 0) {
        body +=
            `<div style="font-size:11px; color:#666; margin-top:4px;">Never came into play in these fights: ` +
            `${esc(unused.join(', '))}.</div>`;
    }
    return head + body + conditionResultsHtml(group.conditions, gameData);
}

/**
 * How many changes a run found, threshold changes and new conditions together.
 * @param {Object} run - From `runLabTriggerOptimization`
 * @returns {number}
 */
export function countLabTriggerChanges(run) {
    return (run?.groups || []).reduce(
        (sum, group) => sum + (group.result?.changes?.length || 0) + (group.conditions?.changes?.length || 0),
        0
    );
}

/**
 * The one-line headline of a run, for the Tune triggers header while it is collapsed.
 * @param {Object} run - From `runLabTriggerOptimization`
 * @returns {string} "2 changes found", "No change beat the current thresholds" or "Stopped"
 */
export function summarizeLabTriggerRun(run) {
    if (run?.stopped) return 'Stopped';
    const changes = countLabTriggerChanges(run);
    if (changes > 0) return `${changes} change${changes === 1 ? '' : 's'} found`;
    return 'No change beat the current thresholds';
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
