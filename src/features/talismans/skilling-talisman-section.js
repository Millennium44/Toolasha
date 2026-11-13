/**
 * The Skilling Optimizer's "Talismans" section: which skilling talisman lines are worth most for one of the
 * Optimizer's actions, the set to aim for, value per orb, and Improve mine. Test server only, behind
 * `skillingOptimizer_talismans` (a sibling of the Optimizer's own `skillingOptimizer` switch).
 *
 * Exact figures, no sim: each line rides on the equipment Map of the gear the panel shows (the Optimizer's picked
 * loadout, with its Equipment rows as edited; with none picked, the loadout the game puts on for the action's skill),
 * through the action's own profit and experience math. The controls, table, set box, Improve mine
 * and Aim for this are shared with the Combat Sim (talisman-ranking-view.js).
 */

import dataManager from '../../core/data-manager.js';
import { escapeHtml } from '../../utils/html-escape.js';
import { describeActionContextSource, resolveActionContext } from '../../utils/action-context.js';
import {
    RANKABLE_SKILLING_TYPES,
    SKILLING_RANKING_METRICS,
    SKILLING_TALISMAN_TYPE,
    runSkillingLineRanking,
} from '../../utils/talisman-line-sets.js';
import {
    SELECT_STYLE,
    TalismanRankingSectionBase,
    UNPRICED_INPUTS_NOTE,
    evaluateSkillingAction,
    solverOrbReference,
    talismanRankingAvailableFor,
} from './talisman-ranking-view.js';

const ACTION_TIP =
    'The action the lines are ranked for: the actions chosen in the Optimizer, with the gear the header names.';

const SECTION_HELP =
    'Test server only. Ranks every skilling talisman line by what it adds to the chosen action, with the loadout ' +
    'picked in the Optimizer (its belt and talismans, its Equipment rows as shown; none picked: the loadout this ' +
    'skill equips), from the profit and experience math (exact, no sim), and builds the set your belt can hold. ' +
    'Practical sets (the default) cap the grades; Budget sets fit an expected orb cost per talisman.';

/**
 * Whether the section belongs on the page: the test server, the game data's skilling talisman lines.
 * @returns {boolean}
 */
export function skillingTalismansAvailable() {
    return talismanRankingAvailableFor(SKILLING_TALISMAN_TYPE);
}

/**
 * The actions the section can rank for the Optimizer's skill and selection.
 * @param {string} skillName - The Optimizer's skill ("Woodcutting")
 * @param {Set<string>|Array<string>|null} selected - The Optimizer's chosen actions (null: all, empty: none)
 * @returns {{type: string, actions: Array<Object>}}
 */
export function rankableActions(skillName, selected) {
    const type = `/action_types/${String(skillName || '').toLowerCase()}`;
    const map = dataManager.getInitClientData?.()?.actionDetailMap || {};
    let actions = Object.values(map)
        .filter((a) => a?.type === type)
        .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
    // The Optimizer keeps its choice as a Set (an array is read the same way); null is every action, and an empty
    // choice is none
    if (selected instanceof Set || Array.isArray(selected)) {
        const chosen = new Set(selected);
        actions = actions.filter((a) => chosen.has(a.hrid));
    }
    return { type, actions };
}

/** The Optimizer's Talismans section */
export class SkillingTalismanSection extends TalismanRankingSectionBase {
    /**
     * @param {Object} host - `{getSkill(): string, getSelectedActions(): Set<string>|string[]|null,
     *   getGearContext?(): {key: string, label: string, detail?: string, note?: string, equipment: Map,
     *   drinks: Array}|null}`. `getGearContext` is the gear the Optimizer shows (a picked loadout, its rows as edited),
     *   a fresh Map each call; null (or absent) means the skill's own loadout / worn gear.
     */
    constructor(host) {
        super({
            typeHrid: SKILLING_TALISMAN_TYPE,
            metrics: SKILLING_RANKING_METRICS,
            title: 'Talismans',
            subtitle: 'which lines to aim for on this action, and the best set',
            help: SECTION_HELP,
            rootId: 'toolasha-skilling-talismans',
            exact: true,
        });
        this.host = host;
        this._actionHrid = null;
    }

    _extraControlsHtml() {
        return `<label style="color:#888; font-size:11px;" title="${escapeHtml(ACTION_TIP)}">Action</label>
            <select data-role="action" class="toolasha-select" style="${SELECT_STYLE} max-width:180px;" title="${escapeHtml(ACTION_TIP)}"></select>`;
    }

    _afterMount() {
        this._on(this._q('action'), 'change', (e) => {
            this._actionHrid = e.target.value || null;
            this._refreshStale();
        });
        this.refreshActions();
    }

    /**
     * The gear a run would rank on right now, and the words for it: the host's shown gear, else the loadout the game
     * equips for the skill. Never a mix: a picked loadout's belt is never read from live slots.
     * @param {string} type - The action's type hrid
     * @returns {{own: Object|null, key: string, label: string}}
     */
    _gearSource(type) {
        const own = this.host.getGearContext?.() || null;
        if (own) return { own, key: own.key, label: own.label };
        const { key, label } = describeActionContextSource(type);
        return { own: null, key, label };
    }

    /** The host's gear, picked loadout or its rows, changed: a shown ranking may be for other gear */
    gearChanged() {
        this._refreshStale();
    }

    /** Fill the action list from the Optimizer's skill and selection (its skill or selection changed) */
    refreshActions() {
        const select = this._q('action');
        if (!select) return;
        const { actions } = rankableActions(this.host.getSkill(), this.host.getSelectedActions());
        if (!actions.some((a) => a.hrid === this._actionHrid))
            this._actionHrid = actions[actions.length - 1]?.hrid || null;
        select.innerHTML = actions
            .map(
                (a) =>
                    `<option value="${escapeHtml(a.hrid)}"${a.hrid === this._actionHrid ? ' selected' : ''}>${escapeHtml(a.name)}</option>`
            )
            .join('');
        this._updateEstimate();
        this._refreshStale();
    }

    _updateEstimate() {
        const estimate = this._q('estimate');
        if (!estimate || this._running) return;
        const { type, actions } = rankableActions(this.host.getSkill(), this.host.getSelectedActions());
        if (actions.length === 0) {
            estimate.textContent = 'No action selected: pick one in the Optimizer first.';
        } else if (!RANKABLE_SKILLING_TYPES.includes(type)) {
            estimate.textContent = 'Only gathering and production actions are ranked (not Alchemy or Enhancing).';
        } else {
            estimate.textContent =
                this._readControls().setMode === 'budget'
                    ? 'No sims: exact figures, then orb-cost solves.'
                    : 'No sims: exact figures from the skilling math.';
        }
    }

    _refreshStale() {
        const note = this._q('stale');
        if (!note) return;
        const was = this._result?.actionHrid;
        const otherAction = !this._running && was && this._actionHrid && was !== this._actionHrid;
        const otherBudget = !this._running && this._budgetStale();
        const result = this._result;
        const otherGear =
            !this._running &&
            result?.gearKey &&
            result.gearKey !== this._gearSource(rankableActions(this.host.getSkill(), null).type).key;
        const stale = otherAction || otherGear || otherBudget;
        note.style.display = stale ? 'block' : 'none';
        note.textContent = otherAction
            ? 'These figures are for another action. Rank again.'
            : otherGear
              ? `These figures are for ${result.gearLabel}, not the gear the Optimizer shows now. Rank again.`
              : otherBudget
                ? 'These figures are for another budget. Rank again.'
                : '';
    }

    async _runRanking(current, orbs) {
        const { metricKey, grade, setMode, capGrade, budget } = this._readControls(solverOrbReference(orbs));
        const actionHrid = this._q('action')?.value || this._actionHrid;
        if (!actionHrid) {
            this._renderMessage('No action selected: pick one in the Optimizer first.');
            return null;
        }
        this._progress('Valuing every skilling line…');
        // The gear and the words for it are taken in one call, at the run's start, so the header can only name the
        // gear the figures used
        let source = null;
        const result = await runSkillingLineRanking(
            { actionHrid, grade, metricKey, setMode, capGrade, budget },
            {
                getGameData: () => dataManager.getInitClientData(),
                resolveContext: (type) => {
                    const picked = this._gearSource(type);
                    source = picked;
                    return picked.own
                        ? { equipment: picked.own.equipment, drinks: picked.own.drinks }
                        : resolveActionContext(type);
                },
                evaluate: evaluateSkillingAction,
                orbs,
            },
            { abortSignal: () => this._aborted || !current() }
        );
        if (!current()) return null;
        if (source) {
            result.gearKey = source.key;
            result.gearLabel = source.label;
            result.gearDetail = source.own?.detail || '';
            result.gearNote = source.own?.note || '';
            if (result.status === 'refused' && result.reason === 'no_belt') {
                result.message = source.own
                    ? `${source.label} has no Talisman Belt. Pick a loadout that wears one, or put a belt on it.`
                    : `${source.label} has no Talisman Belt. Put one on first.`;
            }
        }
        return result;
    }

    _headerParts(result, metric) {
        const gameData = dataManager.getInitClientData?.() || {};
        const beltName = result.belt
            ? `${gameData.itemDetailMap?.[result.belt.itemHrid]?.name || 'Talisman Belt'} +${result.belt.enhancementLevel || 0}`
            : '';
        const source = result.gearLabel ? `${escapeHtml(result.gearLabel)}: ` : '';
        const header =
            `<b>${escapeHtml(result.actionName || '')}</b> · ranked by ${escapeHtml(metric.label)} at G${result.grade} · ` +
            `${source}${escapeHtml(beltName)}, Talisman Power ${(result.power * 100).toFixed(1)}%, ${result.slots} slot${result.slots === 1 ? '' : 's'} · ` +
            `exact (skilling math${result.evaluations ? `, ${result.evaluations} evaluations` : ''}, no sampling error), ` +
            'at live market prices, read as each figure was worked out, with ' +
            (result.gearLabel
                ? `${escapeHtml(result.gearLabel)}${result.gearDetail ? ` (${escapeHtml(result.gearDetail)})` : ''} gear`
                : 'the gear shown') +
            ' as it was at the start.';
        const parts = [`<div style="color:#bbb; font-size:11px; margin:2px 0 6px;">${header}</div>`];
        if (result.gearNote) {
            parts.push(
                `<div style="color:#ff9800; font-size:11px; margin-bottom:4px;">${escapeHtml(result.gearNote)}</div>`
            );
        }
        if (metric.key === 'profit' && result.hasMissingPrices) {
            parts.push(
                `<div style="color:#ff9800; font-size:11px; margin-bottom:4px;">Some prices are missing and are left out: profit figures are floors.</div>`
            );
        }
        if (metric.key === 'profit' && result.hasUnpricedInputs) {
            parts.push(`<div style="color:#ff9800; font-size:11px; margin-bottom:4px;">${UNPRICED_INPUTS_NOTE}.</div>`);
        }
        return parts;
    }

    _setCheckLines(result, metric) {
        return result.combined ? [`Exact for the whole set: ${this._formatValue(result.combined.value, metric)}.`] : [];
    }
}
