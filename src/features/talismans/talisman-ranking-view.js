/**
 * Talisman ranking view
 *
 * Test server only. What the Combat Sim's "Talisman lines" section and the Skilling Optimizer's "Talismans" section
 * share: the controls (rank by, grade, set mode, cap, budget), the line table with value per orb, the recommended set
 * with its expected orbs, "Improve mine" over the talismans the player owns, and "Aim for this", which hands a target
 * to the reroll advisor in the talisman window.
 *
 * A section is a subclass of {@link TalismanRankingSectionBase}; it supplies the run (`_runRanking`) and anything of
 * its own (the Combat Sim's Balanced weights and close-call re-sims, the Optimizer's action). Everything a section
 * owns goes with `detach()`. A run captures the character and its own token before the first await and checks both
 * after every await.
 *
 * Orb costs: the reroll advisor's solver (utils/talisman-orb-costs.js) on the reroll advisor's orb scale
 * (utils/talisman-orb-weights.js), counted in Reforging Orb equivalents. Costs from a fresh talisman start from lines
 * rolled at G1-G3 only, as creation and cores were measured to roll them; cores are listed apart, not priced.
 */

import dataManager from '../../core/data-manager.js';
import { isTestServer } from '../../utils/game-server.js';
import { formatKMB } from '../../utils/formatters.js';
import { escapeHtml } from '../../utils/html-escape.js';
import { GAME_COLORS } from '../../utils/game-look.js';
import { GATHERING_TYPES } from '../../utils/profit-constants.js';
import { calculateExperienceMultiplier } from '../../utils/experience-parser.js';
import { gatheringProfit, productionProfit } from '../../utils/bundle-bridge.js';
import { fiberFor } from '../../utils/react-click.js';
import { orbWeights } from '../../utils/talisman-orb-weights.js';
import { OrbCostSolver, freshCores } from '../../utils/talisman-orb-costs.js';
import {
    DEFAULT_CAP_GRADE,
    DEFAULT_SET_MODE,
    SET_MODES,
    planImprovements,
    rankingMetric,
    talismanLimits,
    talismanLines,
} from '../../utils/talisman-line-sets.js';

export const ACCENT = '#4a9eff';
export const CHIP_BUTTON_STYLE =
    'background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa; padding:3px 8px; border-radius:4px; ' +
    'font-size:11px; cursor:pointer; font-family:inherit;';
export const SELECT_STYLE = `background:${GAME_COLORS.inputBackground}; color:#e0e0e0; border:1px solid ${GAME_COLORS.inputBorder}; border-radius:4px; padding:2px 4px; font-size:11px;`;

/** Budget per talisman when the player has not typed one, in Reforging Orb equivalents */
export const DEFAULT_BUDGET = 20;

/**
 * The figures one skilling action gives with this gear and these drinks: profit/hr from the action's own profit
 * calculator, and XP/hr from its actions per hour, efficiency and experience multiplier.
 * @param {string} actionHrid
 * @param {{equipment: Map, drinks: Array}} actionContext
 * @returns {Promise<{profitPerHour: number, revenuePerHour: number, xpPerHour: number, hasMissingPrices: boolean}|null>}
 */
export async function evaluateSkillingAction(actionHrid, actionContext) {
    const gameData = dataManager.getInitClientData();
    const action = gameData?.actionDetailMap?.[actionHrid];
    if (!action) return null;
    const gathering = GATHERING_TYPES.includes(action.type);
    const calculator = gathering ? gatheringProfit() : productionProfit();
    if (!calculator) return null;
    const data = gathering
        ? await calculator.calculateGatheringProfit(actionHrid, { keepSellTax: true, actionContext })
        : await calculator.calculateProductionProfit(actionHrid, { keepSellTax: true, actionContext });
    if (!data || !Number.isFinite(data.profitPerHour)) return null;
    const gain = action.experienceGain;
    const multiplier = gain?.skillHrid
        ? calculateExperienceMultiplier(gain.skillHrid, action.type, actionContext).totalMultiplier
        : 0;
    const xpPerHour = (data.actionsPerHour || 0) * (data.efficiencyMultiplier || 1) * (gain?.value || 0) * multiplier;
    return {
        profitPerHour: data.profitPerHour,
        revenuePerHour: data.revenuePerHour,
        xpPerHour,
        hasMissingPrices: Boolean(data.hasMissingPrices),
    };
}

/**
 * Whether a section belongs on the page: the test server, and the game data's talisman lines of this type.
 * @param {string} typeHrid
 * @returns {boolean}
 */
export function talismanRankingAvailableFor(typeHrid) {
    if (!isTestServer()) return false;
    const map = dataManager.getInitClientData?.()?.talismanModifierDetailMap;
    return talismanLines(map, typeHrid).length > 0;
}

/**
 * An orb solver for one run, on the reroll advisor's scale, or null without the game's talisman tables.
 * @param {Function} abortSignal
 * @returns {OrbCostSolver|null}
 */
export function makeOrbSolver(abortSignal) {
    const init = dataManager.getInitClientData?.();
    if (!init?.talismanInfo || !init.talismanModifierDetailMap) return null;
    const scale = orbWeights(init.talismanInfo, init.itemDetailMap);
    const solver = new OrbCostSolver({
        info: init.talismanInfo,
        modifierDetailMap: init.talismanModifierDetailMap,
        scale,
        abortSignal,
    });
    return solver.reference ? solver : null;
}

/**
 * Hand a target to the reroll advisor in the talisman window (the ui bundle's one copy, `Toolasha.UI`).
 * @param {number|string} talismanId
 * @param {Array<{hrid: string, minGrade: number}>} targets
 * @returns {'ok'|'refused'|'off'} 'refused': the advisor runs but would not take it (not this character's
 *   talisman); 'off': no advisor running
 */
export function aimRerollAdvisor(talismanId, targets) {
    const advisor = globalThis.window?.Toolasha?.UI?.talismanRerollAdvisor;
    if (typeof advisor?.aimAt !== 'function' || advisor.initialized === false) return 'off';
    try {
        return advisor.aimAt(talismanId, targets) === true ? 'ok' : 'refused';
    } catch (error) {
        console.error('[TalismanRanking] Handing the target to the reroll advisor failed:', error);
        return 'refused';
    }
}

/**
 * Open a talisman in the game's talisman window: the Talismans panel keeps the open one in its own state
 * (`selectedTalismanId`), so setting it opens the window as a click on the talisman would. Only while the panel is on
 * the page (the character's Talismans tab).
 * @param {number|string} talismanId
 * @returns {boolean} false when the panel is not on the page or has no such state
 */
export function openTalismanWindow(talismanId) {
    const panel = document.querySelector('[class*="TalismansPanel_talismansPanel"]');
    let fiber = panel ? fiberFor(panel) : null;
    for (let hops = 0; fiber && hops < 8; hops++, fiber = fiber.return) {
        const instance = fiber.stateNode;
        if (
            instance &&
            typeof instance.setState === 'function' &&
            instance.state &&
            'selectedTalismanId' in instance.state
        ) {
            // Only the panel listing this character's own talismans: its talisman Map (id to record) must hold this id
            // with this character's id on it, so a panel showing another player's talismans is never steered
            if (!panelListsOwnTalisman(instance.props, talismanId)) return false;
            try {
                instance.setState({ selectedTalismanId: talismanId });
                return true;
            } catch (error) {
                console.error('[TalismanRanking] Opening the talisman window failed:', error);
                return false;
            }
        }
    }
    return false;
}

/**
 * Whether a Talismans panel's props hold this talisman as one of the current character's (a Map of id to record,
 * as the game passes it).
 * @param {Object} props
 * @param {number|string} talismanId
 * @returns {boolean}
 */
function panelListsOwnTalisman(props, talismanId) {
    const me = String(dataManager.getCurrentCharacterId?.() ?? '');
    for (const value of Object.values(props || {})) {
        if (!(value instanceof Map)) continue;
        const record = value.get(talismanId) ?? value.get(Number(talismanId)) ?? value.get(String(talismanId));
        if (record && typeof record === 'object' && 'talismanTypeHrid' in record) {
            return me !== '' && String(record.characterID) === me;
        }
    }
    return false;
}

/** A signed figure in the metric's own units */
export function signed(value, digits = 1) {
    if (!Number.isFinite(value)) return '—';
    const text = Math.abs(value) >= 1000 ? formatKMB(Math.abs(value), digits) : Math.abs(value).toFixed(digits);
    return `${value < 0 ? '−' : '+'}${text}`;
}

/** A signed percentage */
export function signedPct(value) {
    if (!Number.isFinite(value)) return '—';
    return `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(2)}%`;
}

/** A line's scaled stat value, as the talisman window prints it */
export function statText(detail, value) {
    if (!Number.isFinite(value)) return '';
    const shown = detail?.isPercent ? value * 100 : value;
    return `${shown < 0 ? '−' : '+'}${String(Number(Math.abs(shown).toFixed(2)))}${detail?.isPercent ? '%' : ''}`;
}

/**
 * The note for a cost the solver could only bound from above, or '' for an exact one.
 * @param {Object|null} limits - `{gradeClamped, clampGrade, mutationLeftOut}`
 * @returns {string}
 */
export function costLimitNote(limits) {
    if (!limits) return '';
    const parts = [];
    if (limits.gradeClamped) parts.push(`grades above G${limits.clampGrade} counted as G${limits.clampGrade}`);
    if (limits.mutationLeftOut) parts.push('Mutation left out');
    return parts.length ? `upper bound: ${parts.join('; ')}` : '';
}

/** Orbs, two significant figures */
export function orbsText(value) {
    if (!Number.isFinite(value)) return '—';
    if (value >= 100) return String(Math.round(value));
    return String(Number(value.toPrecision(2)));
}

/**
 * What one orb is in a section's figures, and on what scale: a coin price only when every orb has a market price.
 * @param {Object|null} orbs - OrbCostSolver
 * @returns {string}
 */
export function orbScaleNote(orbs) {
    if (!orbs?.reference) return '';
    const name = dataManager.getInitClientData?.()?.itemDetailMap?.[orbs.reference.hrid]?.name || 'Reforging Orb';
    const scale = orbs.scale?.scale;
    const how =
        scale === 'market'
            ? `every orb weighed by its market price (1 ${name} = ${formatKMB(orbs.reference.weight)} coins)`
            : scale === 'itemValue'
              ? 'orbs weighed by their game item value, not a market price (not every orb has a listing): no coin cost is shown'
              : 'orbs counted one each (no prices or item values)';
    return `Orbs are ${name} equivalents, ${how}.`;
}

/**
 * The cores a fresh talisman takes, which no figure here prices.
 * @returns {string}
 */
export function coresNote() {
    const init = dataManager.getInitClientData?.();
    const { linesPerTalisman } = talismanLimits(init?.talismanInfo);
    const cores = freshCores(init?.talismanInfo, linesPerTalisman);
    const parts = Object.entries(cores).map(
        ([hrid, count]) => `${count} ${init?.itemDetailMap?.[hrid]?.name || hrid.replace('/items/', '')}`
    );
    return parts.length
        ? `A fresh talisman also takes ${parts.join(', ')} (create and add lines; not priced, the same for every target). ` +
              'Lines from creation and cores roll G1-G3 only (measured, 396 lines), then orbs take them higher.'
        : '';
}

/**
 * The base of both talisman sections.
 */
export class TalismanRankingSectionBase {
    /**
     * @param {Object} options
     * @param {string} options.typeHrid - The talisman type the section ranks
     * @param {Array<Object>} options.metrics - Rank-by choices
     * @param {string} options.title
     * @param {string} options.subtitle
     * @param {string} options.help - The header's tooltip
     * @param {string} options.rootId
     * @param {boolean} options.exact - Figures are exact (skilling) rather than sampled (combat)
     */
    constructor({ typeHrid, metrics, title, subtitle, help, rootId, exact }) {
        this.typeHrid = typeHrid;
        this.metrics = metrics;
        this.title = title;
        this.subtitle = subtitle;
        this.help = help;
        this.rootId = rootId;
        this.exact = exact;
        this.root = null;
        this._open = false;
        this._running = false;
        this._aborted = false;
        this._token = 0;
        this._result = null;
        this._orbs = null;
        this._improve = null;
        this._sortBy = 'gain';
        this._listeners = [];
    }

    /** @returns {boolean} A run (ranking or Improve mine) is in flight */
    isBusy() {
        return this._running;
    }

    /** Controls a subclass adds before the shared ones */
    _extraControlsHtml() {
        return '';
    }

    /** Wire a subclass's own controls */
    _afterMount() {}

    /**
     * Build the section into `container`.
     * @param {HTMLElement} container
     */
    mount(container) {
        const root = document.createElement('div');
        root.id = this.rootId;
        root.style.cssText = 'padding:6px 14px; border-bottom:1px solid #222; flex-shrink:0;';
        const { maxGrade } = talismanLimits(dataManager.getInitClientData?.()?.talismanInfo);
        const gradeOptions = (selected) =>
            Array.from({ length: maxGrade }, (_, i) => i + 1)
                .map((g) => `<option value="${g}"${g === selected ? ' selected' : ''}>G${g}</option>`)
                .join('');
        root.innerHTML = `
            <div data-role="header" style="display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none;"
                title="${escapeHtml(this.help)}">
                <span data-role="toggle" style="font-size:10px; color:#888;">▶</span>
                <span style="color:${ACCENT}; font-weight:700; font-size:12px;">${escapeHtml(this.title)}</span>
                <span style="color:${GAME_COLORS.textDim}; font-size:11px;">${escapeHtml(this.subtitle)}</span>
            </div>
            <div data-role="body" style="display:none; margin-top:4px;">
                <div style="display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px;">
                    ${this._extraControlsHtml()}
                    <label style="color:#888; font-size:11px;">Rank by</label>
                    <select data-role="metric" class="toolasha-select" style="${SELECT_STYLE}">
                        ${this.metrics.map((m) => `<option value="${m.key}">${escapeHtml(m.label)}</option>`).join('')}
                    </select>
                    <label style="color:#888; font-size:11px;" title="The grade each line is measured at. Other grades are shown from it.">Grade</label>
                    <select data-role="grade" class="toolasha-select" style="${SELECT_STYLE}">${gradeOptions(maxGrade)}</select>
                    <label style="color:#888; font-size:11px;" title="Practical: at most one Special line (Echo, Fortify, Overkill, Shatter, Smite) per talisman, grades capped. Ideal: the measured grade, no limit. Budget: the most value whose expected orbs per talisman fit the budget.">Set</label>
                    <select data-role="set-mode" class="toolasha-select" style="${SELECT_STYLE}">
                        ${SET_MODES.map((m) => `<option value="${m.key}"${m.key === DEFAULT_SET_MODE ? ' selected' : ''}>${m.label}</option>`).join('')}
                    </select>
                    <span data-role="cap-box" style="display:inline-flex; align-items:center; gap:4px;">
                        <label style="color:#888; font-size:11px;" title="Practical and Budget sets aim no higher than this grade">Cap</label>
                        <select data-role="cap" class="toolasha-select" style="${SELECT_STYLE}">${gradeOptions(Math.min(maxGrade, DEFAULT_CAP_GRADE))}</select>
                    </span>
                    <span data-role="budget-box" style="display:none; align-items:center; gap:4px;">
                        <label style="color:#888; font-size:11px;" title="Expected orbs one talisman may take, from a fresh talisman, in Reforging Orb equivalents (cores not counted)">Budget / talisman</label>
                        <input data-role="budget" type="number" min="0" step="1" value="${DEFAULT_BUDGET}" style="${SELECT_STYLE} width:56px;">
                    </span>
                    <button data-role="run" style="${CHIP_BUTTON_STYLE}">Rank</button>
                    <button data-role="stop" style="${CHIP_BUTTON_STYLE} display:none; color:#f44336; border-color:rgba(244,67,54,0.4);">Stop</button>
                    <span data-role="estimate" style="color:${GAME_COLORS.textDim}; font-size:11px;"></span>
                </div>
                <div data-role="progress" style="display:none; color:${GAME_COLORS.textDim}; font-size:11px; margin-top:4px;"></div>
                <div data-role="notice" style="display:none; color:#ff9800; font-size:11px; margin-top:4px;"></div>
                <div data-role="stale" style="display:none; color:#ff9800; font-size:11px; margin-top:4px;"></div>
                <div data-role="results" style="margin-top:4px;"></div>
                <div data-role="improve" style="margin-top:4px;"></div>
            </div>`;
        container.appendChild(root);
        this.root = root;
        // Set by value as well: a `selected` attribute in markup is not honored the same way by every DOM
        if (this._q('grade')) this._q('grade').value = String(maxGrade);
        if (this._q('cap')) this._q('cap').value = String(Math.min(maxGrade, DEFAULT_CAP_GRADE));
        if (this._q('set-mode')) this._q('set-mode').value = DEFAULT_SET_MODE;

        this._on(this._q('header'), 'click', () => this._setOpen(!this._open));
        this._on(this._q('run'), 'click', () => this._onRun());
        this._on(this._q('stop'), 'click', () => this.stop());
        this._on(this._q('set-mode'), 'change', () => {
            this._syncSetControls();
            this._updateEstimate();
        });
        this._on(this._q('grade'), 'change', () => this._updateEstimate());
        this._on(this._q('metric'), 'change', () => {
            this._syncMetricControls();
            this._updateEstimate();
        });
        this._on(this._q('results'), 'click', (e) => {
            if (e.target.closest?.('[data-role="copy-targets"]')) this._copyTargets(e.target);
            if (e.target.closest?.('[data-role="improve-run"]')) this._onImprove();
        });
        this._on(this._q('results'), 'change', (e) => {
            if (e.target?.dataset?.role === 'sort' && this._result) {
                this._sortBy = e.target.value === 'perOrb' ? 'perOrb' : 'gain';
                this._render(this._result);
            }
        });
        this._on(this._q('improve'), 'click', (e) => {
            const button = e.target.closest?.('[data-role="aim"]');
            if (button) this._aim(Number(button.dataset.index));
        });
        this._syncSetControls();
        this._syncMetricControls();
        this._afterMount();
        this._updateEstimate();
    }

    /** Stop the run in flight; what was measured is kept */
    stop() {
        if (!this._running) return;
        this._aborted = true;
        this._onStop();
    }

    /** What else Stop must end (the Combat Sim's workers) */
    _onStop() {}

    /** Let go of everything: the run in flight, listeners, nodes */
    detach() {
        if (this._running) this.stop();
        this._token++;
        this._running = false;
        for (const [node, type, handler] of this._listeners) node.removeEventListener(type, handler);
        this._listeners = [];
        this.root?.remove();
        this.root = null;
        this._result = null;
        this._orbs = null;
        this._improve = null;
    }

    _on(node, type, handler) {
        if (!node) return;
        node.addEventListener(type, handler);
        this._listeners.push([node, type, handler]);
    }

    _q(role) {
        return this.root?.querySelector(`[data-role="${role}"]`) || null;
    }

    _setOpen(open) {
        this._open = open;
        const body = this._q('body');
        const toggle = this._q('toggle');
        if (body) body.style.display = open ? 'block' : 'none';
        if (toggle) toggle.textContent = open ? '▼' : '▶';
        if (open) this._updateEstimate();
    }

    _syncSetControls() {
        const mode = this._q('set-mode')?.value;
        const cap = this._q('cap-box');
        const budget = this._q('budget-box');
        if (cap) cap.style.display = mode === 'ideal' ? 'none' : 'inline-flex';
        if (budget) budget.style.display = mode === 'budget' ? 'inline-flex' : 'none';
    }

    /** A subclass's metric-dependent controls */
    _syncMetricControls() {}

    /** The pre-run line; a subclass says what a run will cost */
    _updateEstimate() {}

    _readControls() {
        const budget = Number(this._q('budget')?.value);
        return {
            metricKey: this._q('metric')?.value,
            grade: parseInt(this._q('grade')?.value) || 0,
            setMode: this._q('set-mode')?.value || DEFAULT_SET_MODE,
            capGrade: parseInt(this._q('cap')?.value) || DEFAULT_CAP_GRADE,
            budget: Number.isFinite(budget) && budget >= 0 ? budget : DEFAULT_BUDGET,
        };
    }

    _setRunning(running) {
        this._running = running;
        const run = this._q('run');
        const stop = this._q('stop');
        const progress = this._q('progress');
        if (run) run.style.display = running ? 'none' : '';
        if (stop) stop.style.display = running ? '' : 'none';
        if (progress) progress.style.display = running ? 'block' : 'none';
        // However a run ends, its last progress text goes with it
        if (progress && !running) progress.textContent = '';
        if (running) this._notice('');
        if (!running) this._updateEstimate();
    }

    /** A one-line note that leaves the drawn results alone (a refused press) */
    _notice(text) {
        const notice = this._q('notice');
        if (!notice) return;
        notice.textContent = text || '';
        notice.style.display = text ? 'block' : 'none';
    }

    _progress(text) {
        const progress = this._q('progress');
        if (progress) progress.textContent = text;
    }

    /** Whether something else must not run under this one (the host's other runs) */
    _blocked() {
        return null;
    }

    /** After a run ends (the host's owed redraws) */
    _afterRun() {}

    /**
     * Start a run: the ranking (`_runRanking`) or Improve mine. One at a time, refused while the host runs something.
     * @param {Function} body - `(current) => Promise`
     */
    async _guardedRun(body) {
        if (this._running) return;
        // A refused press says why without wiping a ranking already drawn
        const refuse = (text) => (this._result ? this._notice(text) : this._renderMessage(text));
        const blocked = this._blocked();
        if (blocked) {
            refuse(blocked);
            return;
        }
        if (!talismanRankingAvailableFor(this.typeHrid)) {
            refuse('Talismans exist on the test server only.');
            return;
        }
        const ownerId = dataManager.getCurrentCharacterId();
        const token = ++this._token;
        const current = () => token === this._token && dataManager.getCurrentCharacterId() === ownerId && this.root;
        this._aborted = false;
        this._setRunning(true);
        try {
            await body(current);
        } catch (error) {
            console.error('[TalismanRanking] Run failed:', error);
            if (current()) this._renderMessage(`Ranking failed: ${error.message || error}`);
        } finally {
            if (token === this._token) {
                this._setRunning(false);
                this._refreshStale?.();
                this._afterRun();
            }
        }
    }

    _onRun() {
        return this._guardedRun(async (current) => {
            this._renderMessage('');
            this._improve = null;
            this._renderImprove();
            this._orbs = makeOrbSolver(() => this._aborted || !current());
            const result = await this._runRanking(current, this._orbs);
            if (!current() || !result) return;
            this._result = result;
            this._render(result);
        });
    }

    /** The run; a subclass returns its result (or null when it drew a message itself) */
    async _runRanking() {
        return null;
    }

    _onImprove() {
        // A press while it runs stops it: never a second run beside the first
        if (this._running) {
            if (this._improveRunning) this.stop();
            return;
        }
        const result = this._result;
        if (!result || result.status !== 'done') return;
        if (result.isSelf === false) {
            this._notice(
                `Improve mine looks at your own talismans; this ranking is for ${result.playerName || 'another player'}.`
            );
            return;
        }
        this._improveRunning = true;
        this._syncImproveButton();
        return this._guardedRun(async (current) => {
            if (!this._orbs) this._orbs = makeOrbSolver(() => this._aborted || !current());
            if (!this._orbs) {
                this._improve = { status: 'no_orbs', options: [] };
                this._renderImprove();
                return;
            }
            this._orbs.abortSignal = () => this._aborted || !current();
            this._orbs.cancelled = false;
            // Its own count: the ranking's solves are cached, but its counter and limit are not this run's
            this._orbs.solves = 0;
            this._orbs.limited = false;
            const ownerId = dataManager.getCurrentCharacterId();
            this._orbs.onSolve = (solves, max) => {
                if (current()) {
                    this._progress(
                        `Improve mine: orb solve ${solves} (at most ${max}) · Stop, or Improve mine again, to stop`
                    );
                }
            };
            this._progress('Improve mine: working out expected orbs for your talismans…');
            const improve = await planImprovements(result.rows, {
                owned: dataManager.getCharacterTalismans?.() || [],
                typeHrid: this.typeHrid,
                capGrade: result.setMode === 'ideal' ? result.grade : result.setGrade,
                orbs: this._orbs,
                linesPerTalisman: talismanLimits(dataManager.getInitClientData?.()?.talismanInfo).linesPerTalisman,
            });
            if (this._orbs) this._orbs.onSolve = null;
            if (!current()) return;
            improve.allNoise = (result.rows || []).filter((r) => !r.noEffect).every((r) => !r.significant);
            improve.ownerId = ownerId;
            improve.maxSolves = this._orbs.maxSolves;
            this._improve = improve;
            this._renderImprove();
        }).finally(() => {
            this._improveRunning = false;
            this._syncImproveButton();
        });
    }

    /** The Improve mine button says it stops a run in flight */
    _syncImproveButton() {
        const button = this.root?.querySelector('[data-role="improve-run"]');
        if (button) button.textContent = this._improveRunning ? 'Stop Improve mine' : 'Improve mine';
    }

    _aim(index) {
        const option = this._improve?.options?.[index];
        const note = this._q('improve')?.querySelector(`[data-role="aim-note"][data-index="${index}"]`);
        if (!option || !note) return;
        const id = option.talisman.id;
        // These options are one character's talismans: never aimed for another one after a switch
        if (this._improve.ownerId !== dataManager.getCurrentCharacterId()) {
            note.textContent = 'These options were for another character. Run Improve mine again.';
            return;
        }
        const handed = aimRerollAdvisor(id, option.targets);
        const ok = handed === 'ok';
        // Opened after the target is in, so the window's first draw already shows it
        const opened = ok && openTalismanWindow(id);
        note.textContent = !ok
            ? handed === 'refused'
                ? `The reroll advisor did not take it: talisman #${id} is not one of this character's talismans (any more).`
                : `The reroll advisor is not running (turn on "Talisman window: Reroll advisor" in Settings), then open talisman #${id} in the talisman window and pick these lines there.`
            : opened
              ? `Talisman #${id} is open in the game's talisman window with this target: the reroll advisor there shows it and Do next step.`
              : `Target handed to the reroll advisor. Open talisman #${id} in the game's talisman window (character panel, Talismans tab): the advisor there shows this target and Do next step.`;
    }

    _renderMessage(text) {
        const results = this._q('results');
        if (results) {
            results.innerHTML = text
                ? `<div style="color:#ff9800; font-size:12px; padding:4px 0;">${escapeHtml(text)}</div>`
                : '';
        }
    }

    /** The header line(s) a subclass puts above the table */
    _headerParts() {
        return [];
    }

    /**
     * Draw a finished (or stopped, or refused) run.
     * @param {Object} result
     */
    _render(result) {
        const results = this._q('results');
        if (!results) return;
        if (result.status === 'refused') {
            this._renderMessage(result.message || 'Nothing to rank.');
            return;
        }
        const metric = rankingMetric(result.metricKey, this.metrics);
        const parts = [...this._headerParts(result, metric)];
        if (result.status === 'stopped') {
            const measured = result.rows?.length || 0;
            const why = result.cancelledElsewhere ? ' (another simulation cancelled this run)' : '';
            const text =
                result.stage === 'orbs'
                    ? `Stopped while working out expected orbs${why}: every line was measured, but no set is recommended without its costs.`
                    : result.of && measured >= result.of
                      ? `Stopped before the set was checked${why}: every line was measured, but no set is recommended unchecked.`
                      : `Stopped early${why}: ${measured}${result.of ? ` of ${result.of}` : ''} lines measured. No set is built from a partial ranking.`;
            parts.push(`<div style="color:#ff9800; font-size:11px; margin-bottom:4px;">${escapeHtml(text)}</div>`);
        }
        parts.push(this._tableHtml(result, metric));
        const noEffect = (result.rows || []).filter((r) => r.noEffect).map((r) => r.name);
        if (noEffect.length) {
            parts.push(
                `<div style="color:${GAME_COLORS.textDim}; font-size:11px; margin-top:4px;">No effect for this ${this.exact ? 'action' : 'build here'}: ${escapeHtml(noEffect.join(', '))}</div>`
            );
        }
        if (result.notValued?.length) {
            parts.push(
                `<div style="color:#ff9800; font-size:11px; margin-top:4px;">Not valued (left out, not zero): ${escapeHtml(result.notValued.map((n) => `${n.detail.name} (${n.reason})`).join(', '))}</div>`
            );
        }
        if (result.otherLines?.length) {
            parts.push(
                `<div style="color:${GAME_COLORS.textDim}; font-size:11px; margin-top:4px;">${result.otherLines.length} other skilling lines do not apply to this action.</div>`
            );
        }
        if (result.status === 'done') parts.push(this._setHtml(result, metric));
        results.innerHTML = parts.join('');
    }

    _formatValue(value, metric) {
        if (metric.balanced) return signedPct(value);
        return metric.key === 'deaths' ? signed(-value, 3) : signed(value, metric.key === 'dps' ? 1 : 0);
    }

    _tableHtml(result, metric) {
        const exact = this.exact;
        let rows = (result.rows || []).filter((r) => !r.noEffect);
        if (!rows.length) {
            return `<div style="color:${GAME_COLORS.textDim}; font-size:12px;">${exact ? 'No talisman line changes this action.' : 'No line was measured.'}</div>`;
        }
        const hasPerOrb = rows.some((r) => Number.isFinite(r.perOrb));
        if (this._sortBy === 'perOrb' && hasPerOrb) {
            rows = [...rows].sort((a, b) => (b.perOrb ?? -Infinity) - (a.perOrb ?? -Infinity));
        }
        const grades = rows[0].byGrade.length || 6;
        const setGrade = result.setMode === 'ideal' ? result.grade : result.setGrade;
        const th = (text, title = '') =>
            `<th style="text-align:right; padding:2px 6px; color:#888; font-weight:600;"${title ? ` title="${escapeHtml(title)}"` : ''}>${text}</th>`;
        const sort = hasPerOrb
            ? `<div style="font-size:11px; color:#888; margin-bottom:2px;">Sort <select data-role="sort" class="toolasha-select" style="${SELECT_STYLE}">
                    <option value="gain"${this._sortBy === 'gain' ? ' selected' : ''}>Gain</option>
                    <option value="perOrb"${this._sortBy === 'perOrb' ? ' selected' : ''}>Value per orb</option>
               </select></div>`
            : '';
        const head =
            `<tr><th style="text-align:left; padding:2px 6px; color:#888;">#</th><th style="text-align:left; padding:2px 6px; color:#888;">Line</th>` +
            th(`${escapeHtml(metric.label)} at G${result.grade}`, exact ? 'Exact change' : 'Measured by sim') +
            (exact ? '' : th('%', 'Change against the build without talismans, with its 95% error bar')) +
            (hasPerOrb
                ? th(
                      `per orb (G${setGrade})`,
                      `Value at G${setGrade} over the expected orbs to get that one line at G${setGrade} on a fresh talisman (its first lines roll G1-G3, as measured)`
                  )
                : '') +
            Array.from({ length: grades }, (_, i) =>
                th(
                    `G${i + 1}`,
                    exact
                        ? 'Exact'
                        : i + 1 === result.grade
                          ? 'Simulated'
                          : 'Scaled from the simulated grade by the grade values (≈)'
                )
            ).join('') +
            '</tr>';
        const body = rows
            .map((row, index) => {
                const dim = !exact && !row.significant;
                const color = dim
                    ? '#777'
                    : row.value > 0
                      ? GAME_COLORS.good
                      : row.value < 0
                        ? GAME_COLORS.bad
                        : '#aaa';
                const marks = [
                    row.special
                        ? '<span title="Special line: a Practical set holds at most one per talisman" style="color:#c084fc;">◆</span>'
                        : '',
                    !exact && row.nonlinear
                        ? '<span title="Not linear in its value: the scaled grades are rough" style="color:#888;">~</span>'
                        : '',
                    row.deathsRise
                        ? '<span title="Deaths/hr rose beyond its error bar with this line" style="color:#f87171;">⚠</span>'
                        : '',
                    row.hasMissingPrices
                        ? '<span title="Some prices are missing: profit is a floor" style="color:#ff9800;">*</span>'
                        : '',
                ].join('');
                const pctCell = exact
                    ? ''
                    : `<td style="text-align:right; padding:2px 6px; color:${color};">${signedPct(row.valuePct)}${Number.isFinite(row.errPct) ? ` <span style="color:#777;">±${row.errPct.toFixed(2)}</span>` : ''}</td>`;
                const perOrbNote = costLimitNote(row.orbLimits);
                const perOrbCell = hasPerOrb
                    ? `<td style="text-align:right; padding:2px 6px; color:#ccc;" title="${escapeHtml(Number.isFinite(row.orbCost) ? `~${orbsText(row.orbCost)} orbs for this line alone${perOrbNote ? ` (cost is an ${perOrbNote}, so this is a floor)` : ''}` : 'No gain, or no cost')}">${Number.isFinite(row.perOrb) ? `${perOrbNote ? '≥' : ''}${this._formatValue(row.perOrb, metric)}` : ''}</td>`
                    : '';
                const gradeCells = row.byGrade
                    .map((v, i) => {
                        const isExact = exact || i + 1 === result.grade;
                        return `<td style="text-align:right; padding:2px 6px; color:${isExact ? '#ccc' : '#888'};" title="${escapeHtml(statText(row.detail, row.lineValues?.[i]))}">${isExact ? '' : '≈'}${this._formatValue(v, metric)}</td>`;
                    })
                    .join('');
                return (
                    `<tr><td style="padding:2px 6px; color:#888;">${index + 1}</td>` +
                    `<td style="padding:2px 6px; color:${dim ? '#999' : '#ddd'}; white-space:nowrap;" title="${escapeHtml(`${row.name} G${result.grade} = ${statText(row.detail, row.lineValues?.[result.grade - 1])} with this belt`)}">${escapeHtml(row.name)} ${marks}</td>` +
                    `<td style="text-align:right; padding:2px 6px; color:${color};">${this._formatValue(row.value, metric)}</td>` +
                    pctCell +
                    perOrbCell +
                    gradeCells +
                    '</tr>'
                );
            })
            .join('');
        return `${sort}<div style="overflow-x:auto;"><table style="border-collapse:collapse; font-size:11px; width:100%;">${head}${body}</table></div>`;
    }

    /** Lines the set box adds for a subclass (the combined sim) */
    _setCheckLines() {
        return [];
    }

    _setHtml(result, metric) {
        const set = result.set;
        const improveButton =
            result.isSelf === false
                ? `<div style="color:${GAME_COLORS.textDim}; font-size:11px; margin-top:4px;">Improve mine is for your own talismans: this ranking is for ${escapeHtml(result.playerName || 'another player')}.</div>`
                : `<button data-role="improve-run" style="${CHIP_BUTTON_STYLE} margin-top:4px;" title="From the talismans you own of this type, the next targets with the most value per orb">Improve mine</button>`;
        if (!set) {
            let why = `No line adds to ${metric.label} here, so there is no set to recommend.`;
            if (result.setReason === 'budget') {
                why = `No talisman target fits a budget of ${orbsText(result.budget)} orbs; the cheapest one measured needs ~${result.cheapestIsUpperBound ? 'at most ' : ''}${orbsText(result.cheapest)}.`;
                if (result.overUpperBound > 0) {
                    why += ` ${result.overUpperBound} targets over the budget were costed only as an upper bound (the solver's grade clamp or Mutation left out), so they may fit.`;
                }
            } else if (result.setReason === 'limited') {
                why = 'The orb solve limit was reached before a target fit the budget.';
            } else if (result.setReason === 'no_orbs') {
                why = 'Budget needs the game data for talisman orbs, which has not loaded.';
            }
            return `<div style="color:${GAME_COLORS.textDim}; font-size:12px; margin-top:6px;">${escapeHtml(why)}</div>${improveButton}`;
        }
        const gameData = dataManager.getInitClientData?.() || {};
        const nameOf = (hrid) => gameData.talismanModifierDetailMap?.[hrid]?.name || hrid;
        const memberOf = (hrid) => set.members.find((m) => m.hrid === hrid);
        const talismans = set.talismans
            .map((t) => {
                const lines = t.modifiers
                    .map((m) => {
                        const member = memberOf(m.hrid);
                        const flag =
                            !this.exact && member && !member.significant
                                ? ' <span style="color:#777;" title="Its gain was within noise">(noise)</span>'
                                : '';
                        return `${escapeHtml(nameOf(m.hrid))} G${m.grade}${flag}`;
                    })
                    .join(', ');
                const cost = t.cost
                    ? ` <span style="color:#888;" title="Expected orbs from a fresh talisman (its first lines roll G1-G3, as measured)">~${t.cost.upperBound ? '≤' : ''}${orbsText(t.cost.orbs)} orbs</span>` +
                      (t.cost.upperBound
                          ? ` <span style="color:#888;">(${escapeHtml(costLimitNote(t.cost.limits))})</span>`
                          : '')
                    : '';
                return `<div style="margin:2px 0;"><span style="color:#888;">Talisman ${t.slotIndex}:</span> ${lines}${cost}</div>`;
            })
            .join('');
        const fmt = (v) => this._formatValue(v, metric);
        const lines = [`Predicted from the single lines: ${fmt(set.predicted)} ${escapeHtml(metric.label)}.`];
        if (Number.isFinite(set.slotsFilled) && set.slotsFilled < set.slots) {
            lines.push(
                `${set.slotsFilled} of ${set.slots} slots filled: ` +
                    (set.limited
                        ? 'the orb solve limit was reached before the rest could be planned.'
                        : 'no further target fit the budget.') +
                    (set.overUpperBound > 0
                        ? ` ${set.overUpperBound} targets over it were costed only as an upper bound, so they may fit.`
                        : '')
            );
        }
        lines.push(...this._setCheckLines(result, metric));
        if (result.current) {
            lines.push(
                `Your talismans now: ${fmt(result.current.value)}${!this.exact && Number.isFinite(result.current.valuePct) ? ` (${signedPct(result.current.valuePct)})` : ''}.`
            );
        }
        if (!this.exact && set.withinNoise > 0) {
            lines.push(
                `${set.withinNoise} of ${set.members.length} lines in this set did not clear their error bar (marked "noise"): they fill room no measured line could, and may add nothing.`
            );
        }
        if (set.hasMissingPrices && metric.key === 'profit') {
            lines.push('Some prices are missing: these profit figures are floors.');
        }
        if (!this.exact && set.members.some((m) => m.assumedLinear && m.copies > 1)) {
            lines.push('Repeated lines outside the first few were assumed to add as much per copy as the first.');
        }
        const modeText =
            result.setMode === 'budget'
                ? `Budget: ${orbsText(result.budget)} orbs per talisman, grades up to G${result.setGrade}, at most one Special per talisman`
                : result.setMode === 'ideal'
                  ? `Ideal: G${result.grade}, no limit on Special lines`
                  : `Practical: grades capped at G${result.setGrade}, at most one Special per talisman`;
        const orbNotes = set.talismans.some((t) => t.cost) ? [orbScaleNote(this._orbs), coresNote()] : [];
        return (
            `<div style="margin-top:8px; padding:6px 8px; border:1px solid #333; border-radius:4px;">` +
            `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:2px;">Recommended set (${set.lineCount} line${set.lineCount === 1 ? '' : 's'}) · ${escapeHtml(modeText)}</div>` +
            `<div style="font-size:11px; color:#ddd;">${talismans}</div>` +
            `<div style="font-size:11px; color:#bbb; margin-top:4px;">${lines.join(' ')}</div>` +
            (orbNotes.filter(Boolean).length
                ? `<div style="font-size:11px; color:#888; margin-top:4px;">${escapeHtml(orbNotes.filter(Boolean).join(' '))}</div>`
                : '') +
            `<button data-role="copy-targets" style="${CHIP_BUTTON_STYLE} margin-top:4px;" title="Copies the set as reroll targets: per talisman, each line with its lowest acceptable grade">Copy targets</button> ` +
            improveButton +
            `</div>`
        );
    }

    _renderImprove() {
        const box = this._q('improve');
        if (!box) return;
        const improve = this._improve;
        if (!improve) {
            box.innerHTML = '';
            return;
        }
        const typeName = this.typeHrid.endsWith('/combat') ? 'combat' : 'skilling';
        const message = {
            none_owned: 'You own no talismans yet.',
            none_of_type: `You own no ${typeName} talismans${improve.otherCount ? ` (${improve.otherCount} of the other type)` : ''}.`,
            nothing: `No ${typeName} talisman you own has a target here worth spending orbs on.`,
            cancelled: 'Stopped while working out expected orbs for your talismans.',
            no_orbs: 'The game data for talisman orbs has not loaded.',
        }[improve.status];
        const parts = [
            `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-top:6px;">Best next targets for your talismans</div>`,
        ];
        if (message) parts.push(`<div style="color:#ff9800; font-size:11px;">${escapeHtml(message)}</div>`);
        if (improve.limited) {
            parts.push(
                `<div style="color:#ff9800; font-size:11px;">The orb solve limit (${improve.maxSolves ?? 40}) was reached: some targets were not costed, so a better one may be missing.</div>`
            );
        }
        if (improve.allNoise) {
            parts.push(
                `<div style="color:#ff9800; font-size:11px;">Every line is within noise: these options are ordered mostly by sampling luck.</div>`
            );
        }
        const metric = rankingMetric(this._result?.metricKey, this.metrics);
        const nameOf = (hrid) => dataManager.getInitClientData?.()?.talismanModifierDetailMap?.[hrid]?.name || hrid;
        (improve.options || []).forEach((option, index) => {
            const lines = option.talisman.modifiers.map((m) => `${nameOf(m.hrid)} G${m.grade}`).join(', ');
            const targets = option.targets.map((t) => `${nameOf(t.hrid)} G${t.minGrade}+`).join(', ');
            const noise = !this.exact && option.withinNoise ? ` (${option.withinNoise} within noise)` : '';
            parts.push(
                `<div style="font-size:11px; color:#ddd; margin-top:4px; padding:4px 6px; border:1px solid #333; border-radius:4px;">` +
                    `<div><b>Talisman #${escapeHtml(String(option.talisman.id))}</b> <span style="color:#888;">(${escapeHtml(lines)}${option.talisman.slotIndex ? `, slot ${option.talisman.slotIndex}` : ', in the bag'})</span></div>` +
                    `<div>Aim for ${escapeHtml(targets)}${escapeHtml(noise)}: ${this._formatValue(option.gain, metric)} ${escapeHtml(metric.label)} for ~${option.cost.upperBound ? '≤' : ''}${orbsText(option.cost.orbs)} orbs (${this._formatValue(option.perOrb, metric)} per orb)` +
                    (option.cost.upperBound
                        ? ` <span style="color:#888;">(${escapeHtml(costLimitNote(option.cost.limits))})</span>`
                        : '') +
                    `</div>` +
                    `<button data-role="aim" data-index="${index}" style="${CHIP_BUTTON_STYLE} margin-top:2px;">Aim for this</button> ` +
                    `<span data-role="aim-note" data-index="${index}" style="color:#888;"></span>` +
                    `</div>`
            );
        });
        if (improve.options?.length) {
            parts.push(
                `<div style="font-size:11px; color:#888; margin-top:4px;">${escapeHtml(
                    `Gain counts the target lines less what the talisman's lines are worth now (lines the target leaves out count as nothing). Each talisman is valued on its own. ${orbScaleNote(this._orbs)}` +
                        (improve.considered < improve.ofType
                            ? ` The first ${improve.considered} of ${improve.ofType} talismans were looked at.`
                            : '')
                )}</div>`
            );
        }
        box.innerHTML = parts.join('');
    }

    async _copyTargets(button) {
        const targets = this._result?.rerollTargets;
        if (!targets?.length) return;
        try {
            await navigator.clipboard.writeText(JSON.stringify(targets));
            button.textContent = 'Copied';
        } catch (error) {
            console.error('[TalismanRanking] Copy failed:', error);
            button.textContent = 'Copy failed';
        }
    }
}
