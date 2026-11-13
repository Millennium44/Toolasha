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
import {
    describeActionContextSource,
    resolveActionContext,
    resolveActionTalismans,
} from '../../utils/action-context.js';
import {
    RANKABLE_SKILLING_TYPES,
    SKILLING_RANKING_METRICS,
    SKILLING_TALISMAN_TYPE,
    runSkillingLineRanking,
} from '../../utils/talisman-line-sets.js';
import { BELT_LOCATION, getBeltSlotCount, getTalismanPower, talismanBonusesOf } from '../../utils/talisman-bonuses.js';
import { beltCandidates, runSkillingBeltAdvisor } from './talisman-belt-advisor.js';
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

    /**
     * The context a run values, with the source it names, taken in one call (ranking and belt advisor alike).
     * @param {string} type - The action's type hrid
     * @returns {{context: {equipment: Map, drinks: Array}, source: Object, talismans: Array<Object>|null}} The
     *   talismans are the gear's own records (null when the host does not say), taken in the same call
     */
    _gearContextFor(type) {
        const source = this._gearSource(type);
        const context = source.own
            ? { equipment: source.own.equipment, drinks: source.own.drinks }
            : resolveActionContext(type);
        const talismans = source.own
            ? Array.isArray(source.own.talismans)
                ? source.own.talismans
                : null
            : resolveActionTalismans(type);
        return { context, source, talismans };
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
        this._updateBeltEstimate();
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
        this._refreshBeltStale();
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

    /** What a belt result was valued for, by the words the stale note uses */
    _beltInputs() {
        const actionHrid = this._q('action')?.value || this._actionHrid;
        const type = dataManager.getInitClientData?.()?.actionDetailMap?.[actionHrid]?.type;
        let gear = null;
        if (type) {
            const { context, source, talismans } = this._gearContextFor(type);
            const belt = context?.equipment?.get?.(BELT_LOCATION);
            gear = {
                source: source.key,
                belt: belt ? [belt.itemHrid, belt.enhancementLevel || 0] : null,
                talismans: talismanBonusesOf(context?.equipment),
                // The lines themselves: the core advisor values the next line of each
                worn: (talismans || []).map((t) => [t.slotIndex, (t.modifiers || []).map((m) => [m.hrid, m.grade])]),
            };
        }
        return { character: dataManager.getCurrentCharacterId(), action: actionHrid || null, gear };
    }

    _beltEstimateText() {
        const actionHrid = this._q('action')?.value || this._actionHrid;
        const gameData = dataManager.getInitClientData?.();
        const type = gameData?.actionDetailMap?.[actionHrid]?.type;
        if (!type) return 'No action selected: pick one in the Optimizer first.';
        if (!RANKABLE_SKILLING_TYPES.includes(type)) return 'Only gathering and production actions are valued.';
        const { context, source } = this._gearContextFor(type);
        const belt = context?.equipment?.get?.(BELT_LOCATION);
        if (!belt?.itemHrid) return `${source.label} has no Talisman Belt.`;
        const count = beltCandidates(
            { hrid: belt.itemHrid, enhancementLevel: belt.enhancementLevel || 0 },
            gameData.itemDetailMap,
            gameData.enhancementLevelTotalBonusMultiplierTable
        ).length;
        return count === 0
            ? 'No larger belt or higher level to check.'
            : `No sims: exact figures for ${count} candidate belts.`;
    }

    /**
     * What the core advisor values, for the gear a run would use now: the belt's power and slots and the worn
     * talisman records (slots the belt does not have are dropped).
     * @returns {Promise<{status: 'refused', message: string}|{talismans: Array<Object>, power: number, slots: number,
     *   rankingId: *}>}
     */
    async _coreContext() {
        const result = this._result;
        const actionHrid = result?.actionHrid || this._q('action')?.value || this._actionHrid;
        const gameData = dataManager.getInitClientData?.();
        const type = gameData?.actionDetailMap?.[actionHrid]?.type;
        if (!type) return { status: 'refused', message: 'No action selected: pick one in the Optimizer first.' };
        const { context, source, talismans } = this._gearContextFor(type);
        const belt = context?.equipment?.get?.(BELT_LOCATION);
        const slots = getBeltSlotCount(belt, gameData.itemDetailMap);
        if (!belt?.itemHrid || slots === 0) {
            return { status: 'refused', message: `${source.label} has no Talisman Belt. Put one on first.` };
        }
        if (!Array.isArray(talismans)) {
            return { status: 'refused', message: `The talismans of ${source.label} could not be read.` };
        }
        return {
            talismans: talismans.filter(
                (t) => Number.isInteger(t?.slotIndex) && t.slotIndex >= 1 && t.slotIndex <= slots
            ),
            power: getTalismanPower(belt, gameData.itemDetailMap, gameData.enhancementLevelTotalBonusMultiplierTable),
            slots,
            gearKey: source.key,
        };
    }

    async _runBelts(current, metricKey) {
        const actionHrid = this._q('action')?.value || this._actionHrid;
        if (!actionHrid) return { status: 'refused', message: 'No action selected: pick one in the Optimizer first.' };
        this._progress('Valuing every candidate belt…');
        // Gear and its name taken in one call, as in the ranking: the header names what the figures used
        let source = null;
        const result = await runSkillingBeltAdvisor(
            { actionHrid, metricKey },
            {
                getGameData: () => dataManager.getInitClientData(),
                resolveContext: (type) => {
                    const picked = this._gearContextFor(type);
                    source = picked.source;
                    return picked.context;
                },
                evaluate: evaluateSkillingAction,
                onProgress: ({ current: done, total, description }) => {
                    if (current()) this._progress(`${done} / ${total} · ${description}`);
                },
            },
            { abortSignal: () => this._aborted || !current() }
        );
        if (!current()) return null;
        if (source) {
            result.gearKey = source.key;
            result.gearLabel = source.label;
            if (result.status === 'refused' && result.reason === 'no_belt') {
                result.message = source.own
                    ? `${source.label} has no Talisman Belt. Pick a loadout that wears one, or put a belt on it.`
                    : `${source.label} has no Talisman Belt. Put one on first.`;
            } else if (result.status === 'refused' && result.reason === 'no_talismans') {
                result.message = `No skilling talisman is slotted in ${source.label}, so a belt changes nothing here.`;
            } else if (result.actionName) {
                result.context = `${result.actionName} · ${source.label}`;
            }
        }
        return result;
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
                    const picked = this._gearContextFor(type);
                    source = picked.source;
                    return picked.context;
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
