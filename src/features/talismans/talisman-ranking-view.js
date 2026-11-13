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
import { getProductionChainActions } from '../../utils/enhancement-pricing.js';
import { gatheringProfit, productionProfit } from '../../utils/bundle-bridge.js';
import { fiberFor } from '../../utils/react-click.js';
import { orbWeights } from '../../utils/talisman-orb-weights.js';
import { OrbCostSolver, freshCores, referenceOrb } from '../../utils/talisman-orb-costs.js';
import { parseShorthandAmount } from '../../utils/number-parser.js';
import {
    DEFAULT_CAP_GRADE,
    DEFAULT_SET_MODE,
    SET_MODES,
    planImprovements,
    rankingMetric,
    talismanLimits,
    talismanLines,
} from '../../utils/talisman-line-sets.js';
import {
    COST_BASES,
    COST_UNIT,
    DEFAULT_COST_BASIS,
    candidateLabel,
    emptySlotNote,
    rateRow,
    sortBeltRows,
} from './talisman-belt-advisor.js';
import { CORE_BASIS, adviseCores, coreQuoteKey } from './talisman-core-advisor.js';

export const ACCENT = '#4a9eff';
export const CHIP_BUTTON_STYLE =
    'background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa; padding:3px 8px; border-radius:4px; ' +
    'font-size:11px; cursor:pointer; font-family:inherit;';
export const SELECT_STYLE = `background:${GAME_COLORS.inputBackground}; color:#e0e0e0; border:1px solid ${GAME_COLORS.inputBorder}; border-radius:4px; padding:2px 4px; font-size:11px;`;

/** The banner for a profit figure built with an input that has no price */
export const UNPRICED_INPUTS_NOTE = 'Materials without a price are counted as free, so profit may be overstated';

/** Budget per talisman when the player has not typed one, in Reforging Orb equivalents (shown as coins) */
export const DEFAULT_BUDGET = 20;

/** What a Rank-by choice means, by metric key (hover text) */
export const METRIC_HELP = {
    dps: 'Damage per second the build deals in the simulated fights.',
    xp: 'Experience per hour: from the combat sim, or from the skilling math for an action.',
    profit: 'Profit per hour at live market prices (income less running costs, after the market fee).',
    encounters: 'Monsters fought per hour.',
    deaths: 'Deaths per hour. Lower is better, so a line that cuts deaths shows as a gain.',
    balanced:
        'One score: the weighted average of the % gains in EXP/hr, Profit/hr and DPS (weights set beside it), less a share of any clear rise in deaths.',
};

const TIP_RANK_BY = 'The figure each talisman line is ranked by. Hover an option for what it measures.';
const TIP_GRADE = 'The grade each line is measured at. Other grades are shown from it.';
const SET_MODE_HELP = {
    practical:
        'At most one Special line (Echo, Fortify, Overkill, Shatter, Smite) per talisman, and grades no higher than Cap.',
    ideal: 'The measured grade for every line, with no limit on Special lines. Shows what the best case is worth, not what is cheap to roll.',
    budget: 'The most valuable set whose expected orb cost per talisman fits your budget (grades no higher than Cap, at most one Special per talisman).',
};
const TIP_SET = 'Which kind of set to recommend. Hover an option for what it does.';
const TIP_CAP = 'Practical and Budget sets aim no higher than this grade.';
const TIP_BUDGET =
    'The most a single talisman may cost to roll, as expected orb spend from a fresh talisman (cores are not counted). ' +
    'Type coins: 200m, 1.5b, 500k or 6,000,000. Coins are converted to orbs at the same values the costs use: your own price or the listing when every orb has one, else the orb item value.';
const TIP_RUN = 'Measure every line and build the recommended set with these settings.';
const TIP_STOP = 'Stop the run. What was already measured is kept, but no set is built from a partial ranking.';
const TIP_SORT = 'Order the lines by their gain, or by gain per expected orb spent on them.';
const TIP_SORT_GAIN = 'Biggest gain first.';
const TIP_SORT_PER_ORB = 'Most gain per expected orb first: the cheapest lines to get.';
const TIP_COPY = 'Copies the set as reroll targets: per talisman, each line with its lowest acceptable grade.';
const TIP_IMPROVE = 'From the talismans you own of this type, the next targets with the most value per orb.';
const TIP_AIM = 'Hands this target to the reroll advisor in the talisman window and opens the talisman there.';
const TIP_BELT_HEAD =
    'Which belt upgrade is worth buying: every candidate belt is valued with the talismans slotted now, then set against its cost.';
const TIP_BELT_COST =
    'What a belt costs: buy it, buy it and sell your current one, or an estimate of enhancing it yourself. Hover an option for what it counts. Changing it re-reads the figures without a new check.';
const TIP_BELT_RUN =
    'Value your current belt at higher levels and each larger belt, with the talismans slotted now, and price each from the market.';
const TIP_BELT_ESTIMATE = 'What a Check belts press will do with the build and gear as they stand.';
const TIP_BELT_CANDIDATE = 'The belt and enhancement level. Larger belts are compared with the one worn now.';
const TIP_BELT_GAIN =
    'What the belt adds, in the chosen Rank by metric, over the belt worn now with the same talismans slotted.';
const TIP_BELT_COST_COL =
    'The cost on the chosen basis, from live market prices when the check ran. "No price" means no listing.';
const TIP_BELT_RATIO = `Gain per ${COST_UNIT / 1e6}m coins of cost. Only for a priced upgrade with a real, positive gain.`;
const TIP_BELT_NOTE = 'What to know about the row.';
const TIP_CORE_HEAD =
    'Is adding the next line to a worn talisman with a core worth it? The next line is a draw (G1-G3 only, any type the talisman does not hold, by weight); each outcome is valued from the ranking rows above, and the cores are priced from the market. No sims are run.';
const TIP_CORE_RUN =
    'Value the next line of every worn talisman of this type that has room, from the ranking above, and price its cores from the market. Rank first.';
const TIP_CORE_GAIN =
    'The expected change in the chosen Rank by metric from the next line: every line it can roll, at G1-G3, times its chance, valued from the ranking rows. A line already worn on another talisman adds only its later-copy value. Lines the ranking has no row for count as 0.';
const TIP_CORE_USEFUL = 'The chance the new line is worth something (a gain above zero). The rest is a blank draw.';
const TIP_CORE_BEST = 'The best single outcome: the line and grade, its gain and its chance of being the one drawn.';
const TIP_CORE_COST =
    'The cores the game asks for that line, at the market Buy price under your profit pricing mode (or your own price). "No price" means a core has no listing: it is never counted as free.';
const TIP_CORE_RATIO = `Expected gain per ${COST_UNIT / 1e6}m coins of cores. Only for a priced row with a real, positive gain.`;
const TIP_HASH = 'Rank: the line with the biggest gain is 1.';
const TIP_LINE = 'The talisman line. Hover the name for its value at the measured grade.';

/**
 * A coin amount as the shorthand the field accepts: 6m, 1.5b, 500k, else grouped digits.
 * @param {number} coins
 * @returns {string}
 */
export function budgetCoinsText(coins) {
    const n = Math.round(Number(coins));
    if (!Number.isFinite(n) || n < 0) return '';
    for (const [unit, letter] of [
        [1e9, 'b'],
        [1e6, 'm'],
        [1e3, 'k'],
    ]) {
        const scaled = (n / unit) * 100;
        if (n >= unit && Math.abs(scaled - Math.round(scaled)) < 1e-6) return `${Math.round(scaled) / 100}${letter}`;
    }
    return n.toLocaleString('en-US');
}

/**
 * Read the budget field's text as coins.
 * @param {string} text
 * @returns {{ok: true, coins: number}|{ok: false, error: string}}
 */
export function parseBudgetCoins(text) {
    if (String(text ?? '').trim() === '') return { ok: false, error: 'Type a budget in coins, e.g. 200m.' };
    const coins = parseShorthandAmount(text);
    if (coins === null || !Number.isFinite(coins)) {
        return { ok: false, error: `"${String(text).trim()}" is not an amount. Use 200m, 1.5b, 500k or 6,000,000.` };
    }
    return { ok: true, coins };
}

/**
 * A reference orb a coin budget can be converted with: its weight must come from a market price, the player's own
 * override or the item's value (not a bare count).
 * @param {string} hrid
 * @param {number} weight
 * @param {string} scaleName - 'market', 'itemValue' or 'count'
 * @returns {{hrid: string, name: string, weight: number}|null}
 */
function usableReference(hrid, weight, scaleName) {
    if (!(weight > 0) || scaleName === 'count') return null;
    const name = dataManager.getInitClientData?.()?.itemDetailMap?.[hrid]?.name || 'Reforging Orb';
    return { hrid, name, weight };
}

/** @returns {{hrid: string, name: string, weight: number}|null} The reference orb on today's weights */
export function liveOrbReference() {
    const init = dataManager.getInitClientData?.();
    if (!init?.talismanInfo) return null;
    const scale = orbWeights(init.talismanInfo, init.itemDetailMap);
    const ref = referenceOrb(init.talismanInfo, scale.weights);
    return ref ? usableReference(ref.hrid, ref.weight, scale.scale) : null;
}

/**
 * @param {Object|null} solver - OrbCostSolver
 * @returns {{hrid: string, name: string, weight: number}|null} The reference orb that run's costs are weighed on
 */
export function solverOrbReference(solver) {
    return solver?.reference
        ? usableReference(solver.reference.hrid, solver.reference.weight, solver.scale?.scale)
        : null;
}

/**
 * The figures one skilling action gives with this gear and these drinks: profit/hr from the action's own profit
 * calculator, and XP/hr from its actions per hour, efficiency and experience multiplier.
 * @param {string} actionHrid
 * @param {{equipment: Map, drinks: Array}} actionContext
 * @returns {Promise<{profitPerHour: number, revenuePerHour: number, xpPerHour: number, hasMissingPrices: boolean,
 *   outputsUnpriced: boolean, unpricedCost: string[], unpricedCostRates: Object<string, number>}|null>}
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
    // When the calculator charged the upgrade item's production chain time inside actionsPerHour, the chain's actions
    // are in the same hour, so what they teach counts too (as Craft & Enhance counts it). Only the ranked skill's XP:
    // a chain action that teaches another skill adds nothing to this skill's EXP/hr.
    let xpPerAction = (gain?.value || 0) * multiplier;
    if (data.upgradeChainCrafted && action.upgradeItemHrid && gain?.skillHrid) {
        for (const chainHrid of getProductionChainActions(action.upgradeItemHrid)) {
            const chain = gameData.actionDetailMap[chainHrid];
            if (chain?.experienceGain?.skillHrid !== gain.skillHrid) continue;
            xpPerAction +=
                (chain.experienceGain.value || 0) *
                calculateExperienceMultiplier(gain.skillHrid, chain.type, actionContext).totalMultiplier;
        }
    }
    const xpPerHour = (data.actionsPerHour || 0) * (data.efficiencyMultiplier || 1) * xpPerAction;
    // Inputs with no price (materials, drinks): the profit counts them as free. Rates are per hour, like the combat
    // sim's running costs, so a line that makes the action spend more of one is told apart from one that does not
    const perHour = (data.actionsPerHour || 0) * (data.efficiencyMultiplier || 1);
    const unpricedCostRates = {};
    for (const material of data.materialCosts || []) {
        if (!material?.missingPrice) continue;
        const name = material.itemName || material.itemHrid;
        unpricedCostRates[name] = (unpricedCostRates[name] || 0) + (Number(material.amount) || 0) * perHour;
    }
    for (const drink of [...(data.teaCosts || []), ...(data.drinkCosts || [])]) {
        if (!drink?.missingPrice) continue;
        const name = drink.itemName || drink.name;
        unpricedCostRates[name] = (unpricedCostRates[name] || 0) + (Number(drink.drinksPerHour) || 0);
    }
    const unpricedCost = Object.keys(unpricedCostRates);
    const hasMissingPrices = Boolean(data.hasMissingPrices);
    // What is left missing once the inputs are set aside: an output, a bonus drop, a conversion
    const otherMissing =
        (data.outputPriceMissing && !data.outputPriceEstimated) ||
        Boolean(data.bonusRevenue?.hasMissingPrices) ||
        [data.baseOutputs, data.gourmetBonuses, data.processingConversions].some(
            (list) => Array.isArray(list) && list.some((entry) => entry?.missingPrice)
        );
    return {
        profitPerHour: data.profitPerHour,
        revenuePerHour: data.revenuePerHour,
        xpPerHour,
        hasMissingPrices,
        outputsUnpriced: hasMissingPrices && (unpricedCost.length === 0 || Boolean(otherMissing)),
        unpricedCost,
        unpricedCostRates,
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

/**
 * A Budget run's budget as the player typed it, with the orbs it came to.
 * @param {{budget: number, budgetCoins?: number}} result
 * @returns {string} e.g. "6m coins (≈20 orbs)"
 */
export function budgetText(result) {
    const orbs = `${orbsText(result.budget)} orbs`;
    if (!Number.isFinite(result.budgetCoins)) return orbs;
    return `${budgetCoinsText(result.budgetCoins)} coins (≈${orbs})`;
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
        ? `A fresh talisman also takes ${parts.join(', ')} (create and add lines; not priced in these costs, the same for every target). ` +
              'Lines from creation and cores roll G1-G3 only (measured, 396 lines), then orbs take them higher. ' +
              'The Core advisor prices the next line of a talisman you wear.'
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
        /** The belt advisor's last result (`{status, rows, inputs, ...}`), or null */
        this._belt = null;
        /** The core advisor's last result (`{status, rows, inputs, ...}`), or null */
        this._core = null;
        this._rankSeq = 0;
        this._sortBy = 'gain';
        this._listeners = [];
        /** The player has typed in the budget field: the default is no longer refilled */
        this._budgetTouched = false;
        this._budgetDefaultText = '';
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
                    <label style="color:#888; font-size:11px;" title="${escapeHtml(TIP_RANK_BY)}">Rank by</label>
                    <select data-role="metric" class="toolasha-select" style="${SELECT_STYLE}" title="${escapeHtml(TIP_RANK_BY)}">
                        ${this.metrics.map((m) => `<option value="${m.key}" title="${escapeHtml(METRIC_HELP[m.key] || m.label)}">${escapeHtml(m.label)}</option>`).join('')}
                    </select>
                    <label style="color:#888; font-size:11px;" title="${escapeHtml(TIP_GRADE)}">Grade</label>
                    <select data-role="grade" class="toolasha-select" style="${SELECT_STYLE}" title="${escapeHtml(TIP_GRADE)}">${gradeOptions(maxGrade)}</select>
                    <label style="color:#888; font-size:11px;" title="${escapeHtml(TIP_SET)}">Set</label>
                    <select data-role="set-mode" class="toolasha-select" style="${SELECT_STYLE}" title="${escapeHtml(TIP_SET)}">
                        ${SET_MODES.map((m) => `<option value="${m.key}" title="${escapeHtml(SET_MODE_HELP[m.key] || m.label)}"${m.key === DEFAULT_SET_MODE ? ' selected' : ''}>${m.label}</option>`).join('')}
                    </select>
                    <span data-role="cap-box" style="display:inline-flex; align-items:center; gap:4px;">
                        <label style="color:#888; font-size:11px;" title="${escapeHtml(TIP_CAP)}">Cap</label>
                        <select data-role="cap" class="toolasha-select" style="${SELECT_STYLE}" title="${escapeHtml(TIP_CAP)}">${gradeOptions(Math.min(maxGrade, DEFAULT_CAP_GRADE))}</select>
                    </span>
                    <span data-role="budget-box" style="display:none; align-items:center; gap:4px;">
                        <label style="color:#888; font-size:11px;" title="${escapeHtml(TIP_BUDGET)}">Budget / talisman</label>
                        <input data-role="budget" type="text" spellcheck="false" autocomplete="off" value="" placeholder="e.g. 200m" style="${SELECT_STYLE} width:80px;" title="${escapeHtml(TIP_BUDGET)}">
                        <span data-role="budget-note" style="color:${GAME_COLORS.textDim}; font-size:11px;" title="${escapeHtml(TIP_BUDGET)}"></span>
                    </span>
                    <button data-role="run" style="${CHIP_BUTTON_STYLE}" title="${escapeHtml(TIP_RUN)}">Rank</button>
                    <button data-role="stop" style="${CHIP_BUTTON_STYLE} display:none; color:#f44336; border-color:rgba(244,67,54,0.4);" title="${escapeHtml(TIP_STOP)}">Stop</button>
                    <span data-role="estimate" style="color:${GAME_COLORS.textDim}; font-size:11px;"></span>
                </div>
                <div data-role="belt-controls" style="display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; margin-top:6px;">
                    <span style="color:${ACCENT}; font-weight:700; font-size:12px;" title="${escapeHtml(TIP_BELT_HEAD)}">Belt advisor</span>
                    <label style="color:#888; font-size:11px;" title="${escapeHtml(TIP_BELT_COST)}">Cost</label>
                    <select data-role="belt-cost" class="toolasha-select" style="${SELECT_STYLE}" title="${escapeHtml(TIP_BELT_COST)}">
                        ${COST_BASES.map((b) => `<option value="${b.key}" title="${escapeHtml(b.help)}"${b.key === DEFAULT_COST_BASIS ? ' selected' : ''}>${escapeHtml(b.label)}</option>`).join('')}
                    </select>
                    <button data-role="belt-run" style="${CHIP_BUTTON_STYLE}" title="${escapeHtml(TIP_BELT_RUN)}">Check belts</button>
                    <span data-role="belt-estimate" style="color:${GAME_COLORS.textDim}; font-size:11px;" title="${escapeHtml(TIP_BELT_ESTIMATE)}"></span>
                </div>
                <div data-role="core-controls" style="display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; margin-top:6px;">
                    <span style="color:${ACCENT}; font-weight:700; font-size:12px;" title="${escapeHtml(TIP_CORE_HEAD)}">Core advisor</span>
                    <button data-role="core-run" style="${CHIP_BUTTON_STYLE}" title="${escapeHtml(TIP_CORE_RUN)}">Check cores</button>
                    <span style="color:${GAME_COLORS.textDim}; font-size:11px;" title="${escapeHtml(TIP_CORE_HEAD)}">Adds one line to a worn talisman; run the ranking first. No sims.</span>
                </div>
                <div data-role="progress" style="display:none; color:${GAME_COLORS.textDim}; font-size:11px; margin-top:4px;"></div>
                <div data-role="notice" style="display:none; color:#ff9800; font-size:11px; margin-top:4px;"></div>
                <div data-role="stale" style="display:none; color:#ff9800; font-size:11px; margin-top:4px;"></div>
                <div data-role="results" style="margin-top:4px;"></div>
                <div data-role="improve" style="margin-top:4px;"></div>
                <div data-role="belt-stale" style="display:none; color:#ff9800; font-size:11px; margin-top:4px;"></div>
                <div data-role="belt-results" style="margin-top:4px;"></div>
                <div data-role="core-stale" style="display:none; color:#ff9800; font-size:11px; margin-top:4px;"></div>
                <div data-role="core-results" style="margin-top:4px;"></div>
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
        this._on(this._q('budget'), 'input', () => {
            this._budgetTouched = true;
            this._syncBudget();
            this._refreshStale?.();
        });
        this._on(this._q('grade'), 'change', () => this._updateEstimate());
        this._on(this._q('metric'), 'change', () => {
            this._syncMetricControls();
            this._updateEstimate();
            this._refreshBeltStale();
        });
        this._on(this._q('belt-run'), 'click', () => this._onBelts());
        this._on(this._q('belt-cost'), 'change', () => this._renderBelts());
        this._on(this._q('core-run'), 'click', () => this._onCores());
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
        this._syncBudget();
        this._afterMount();
        this._updateEstimate();
        this._updateBeltEstimate();
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
        this._belt = null;
        this._core = null;
        this._budgetTouched = false;
        this._budgetDefaultText = '';
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
        if (open) {
            this._syncBudget();
            this._updateEstimate();
        }
    }

    /**
     * The budget field as typed, against the reference orb it converts with.
     * @param {{hrid: string, name: string, weight: number}|null} [reference] - A run's own; today's weights if omitted
     * @returns {{ok: boolean, error?: string, coins?: number, orbs?: number, reference: Object|null}}
     */
    _budgetState(reference = liveOrbReference()) {
        if (!reference) {
            return {
                ok: false,
                reference: null,
                error: "A coin budget needs the orbs' values (a market price or an item value), which are not available yet.",
            };
        }
        const parsed = parseBudgetCoins(this._q('budget')?.value);
        if (!parsed.ok) return { ...parsed, reference };
        return { ok: true, coins: parsed.coins, orbs: parsed.coins / reference.weight, reference };
    }

    /** Refill the default while untouched, then show the conversion or what is wrong with the text */
    _syncBudget() {
        const input = this._q('budget');
        if (!input) return;
        // The default follows the weights until the player types; text set any other way is left alone
        if (!this._budgetTouched && (input.value === '' || input.value === this._budgetDefaultText)) {
            const reference = liveOrbReference();
            this._budgetDefaultText = reference ? budgetCoinsText(DEFAULT_BUDGET * reference.weight) : '';
            input.value = this._budgetDefaultText;
        }
        const state = this._budgetState();
        const note = this._q('budget-note');
        input.style.borderColor = state.ok ? '' : '#f44336';
        input.title = state.ok ? TIP_BUDGET : state.error;
        if (note) {
            note.textContent = state.ok ? `≈ ${orbsText(state.orbs)} ${state.reference.name}s` : state.error;
            note.style.color = state.ok ? GAME_COLORS.textDim : '#f44336';
        }
    }

    /** @returns {boolean} The Budget set was drawn for another budget than the field now holds */
    _budgetStale() {
        const result = this._result;
        if (!result || result.setMode !== 'budget' || !Number.isFinite(result.budgetCoins)) return false;
        const parsed = parseBudgetCoins(this._q('budget')?.value);
        return parsed.ok && parsed.coins !== result.budgetCoins;
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

    /**
     * The controls as they stand. The budget is read in coins and converted to the solver's reference orbs with the
     * reference orb of the run in hand, so the budget and the costs share one scale.
     * @param {{hrid: string, name: string, weight: number}|null} [reference] - The run's own reference orb
     */
    _readControls(reference = liveOrbReference()) {
        const state = this._budgetState(reference);
        return {
            metricKey: this._q('metric')?.value,
            grade: parseInt(this._q('grade')?.value) || 0,
            setMode: this._q('set-mode')?.value || DEFAULT_SET_MODE,
            capGrade: parseInt(this._q('cap')?.value) || DEFAULT_CAP_GRADE,
            // Without a valid budget the run is refused before it starts (see _onRun); 0 only fills the slot
            budget: state.ok ? state.orbs : 0,
            budgetCoins: state.ok ? state.coins : null,
            budgetError: state.ok ? null : state.error,
        };
    }

    _setRunning(running) {
        this._running = running;
        const run = this._q('run');
        const coreRun = this._q('core-run');
        if (coreRun) coreRun.style.display = running ? 'none' : '';
        const beltRun = this._q('belt-run');
        const stop = this._q('stop');
        const progress = this._q('progress');
        if (run) run.style.display = running ? 'none' : '';
        if (beltRun) beltRun.style.display = running ? 'none' : '';
        if (stop) stop.style.display = running ? '' : 'none';
        if (progress) progress.style.display = running ? 'block' : 'none';
        // However a run ends, its last progress text goes with it
        if (progress && !running) progress.textContent = '';
        if (running) this._notice('');
        if (!running) {
            this._updateEstimate();
            this._updateBeltEstimate();
        }
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
     * @param {Object} [options]
     * @param {Function} [options.refuse] - `(text)`: where a refused press or a failure says why (default: the ranking's)
     */
    async _guardedRun(body, options = {}) {
        if (this._running) return;
        // A refused press says why without wiping a ranking already drawn
        const refuse = options.refuse || ((text) => (this._result ? this._notice(text) : this._renderMessage(text)));
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
            if (current()) {
                if (options.refuse) options.refuse(`Failed: ${error.message || error}`);
                else this._renderMessage(`Ranking failed: ${error.message || error}`);
            }
        } finally {
            if (token === this._token) {
                this._setRunning(false);
                this._refreshStale?.();
                this._afterRun();
            }
        }
    }

    _onRun() {
        // A Budget set needs a readable budget: refused here, with the reason, rather than run on a guess
        const typed = this._readControls();
        if (typed.setMode === 'budget' && typed.budgetError) {
            this._syncBudget();
            if (this._result) this._notice(typed.budgetError);
            else this._renderMessage(typed.budgetError);
            return;
        }
        return this._guardedRun(async (current) => {
            this._renderMessage('');
            this._improve = null;
            this._renderImprove();
            // The cores were valued from the rows of the ranking being replaced
            this._core = null;
            this._renderCores();
            this._orbs = makeOrbSolver(() => this._aborted || !current());
            // Read now, with the controls the run reads before its first await: a later edit must not relabel it
            const ref = solverOrbReference(this._orbs);
            const started = this._budgetState(ref);
            const result = await this._runRanking(current, this._orbs);
            if (!current() || !result) return;
            if (result.setMode === 'budget') {
                result.budgetCoins = started.ok ? started.coins : typed.budgetCoins;
                result.budgetOrbName = ref?.name || 'Reforging Orb';
            }
            result.rankingId = ++this._rankSeq;
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
            ? `<div style="font-size:11px; color:#888; margin-bottom:2px;" title="${escapeHtml(TIP_SORT)}">Sort <select data-role="sort" class="toolasha-select" style="${SELECT_STYLE}" title="${escapeHtml(TIP_SORT)}">
                    <option value="gain" title="${escapeHtml(TIP_SORT_GAIN)}"${this._sortBy === 'gain' ? ' selected' : ''}>Gain</option>
                    <option value="perOrb" title="${escapeHtml(TIP_SORT_PER_ORB)}"${this._sortBy === 'perOrb' ? ' selected' : ''}>Value per orb</option>
               </select></div>`
            : '';
        const head =
            `<tr><th style="text-align:left; padding:2px 6px; color:#888;" title="${escapeHtml(TIP_HASH)}">#</th><th style="text-align:left; padding:2px 6px; color:#888;" title="${escapeHtml(TIP_LINE)}">Line</th>` +
            th(
                `${escapeHtml(metric.label)} at G${result.grade}`,
                exact
                    ? `Exact change in ${metric.label} from this line alone at G${result.grade}, from the skilling math`
                    : `Change in ${metric.label} from this line alone at G${result.grade}, measured by sim`
            ) +
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
                    row.costUnpriced?.length
                        ? `<span data-cost-unpriced title="${escapeHtml(`No price for ${row.costUnpriced.join(', ')}: this line spends more of it and the profit counts that as free (unpriced materials counted as free), so its profit gain is a ceiling`)}" style="color:#ff9800;">⚠</span>`
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
                : `<button data-role="improve-run" style="${CHIP_BUTTON_STYLE} margin-top:4px;" title="${escapeHtml(TIP_IMPROVE)}">Improve mine</button>`;
        if (!set) {
            let why = `No line adds to ${metric.label} here, so there is no set to recommend.`;
            if (result.setReason === 'budget') {
                why = `No talisman target fits a budget of ${budgetText(result)}; the cheapest one measured needs ~${result.cheapestIsUpperBound ? 'at most ' : ''}${orbsText(result.cheapest)}.`;
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
                        const unpriced = member?.costUnpriced?.length
                            ? ` <span data-cost-unpriced style="color:#ff9800;" title="${escapeHtml(`No price for ${member.costUnpriced.join(', ')}: its profit gain is a ceiling`)}">(unpriced costs)</span>`
                            : '';
                        return `${escapeHtml(nameOf(m.hrid))} G${m.grade}${flag}${unpriced}`;
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
        if (set.hasUnpricedInputs && metric.key === 'profit') {
            lines.push(`${UNPRICED_INPUTS_NOTE}.`);
        }
        if (!this.exact && set.members.some((m) => m.assumedLinear && m.copies > 1)) {
            lines.push('Repeated lines outside the first few were assumed to add as much per copy as the first.');
        }
        const modeText =
            result.setMode === 'budget'
                ? `Budget: ${budgetText(result)} per talisman, grades up to G${result.setGrade}, at most one Special per talisman`
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
            `<button data-role="copy-targets" style="${CHIP_BUTTON_STYLE} margin-top:4px;" title="${escapeHtml(TIP_COPY)}">Copy targets</button> ` +
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
                    `<button data-role="aim" data-index="${index}" style="${CHIP_BUTTON_STYLE} margin-top:2px;" title="${escapeHtml(TIP_AIM)}">Aim for this</button> ` +
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

    // -----------------------------------------------------------------------------------------------------------
    // Belt advisor: which belt upgrade is worth buying. A third guarded run beside Rank and Improve mine, with its
    // own result (`_belt`), stamped with the inputs it was run for. A subclass supplies `_runBelts`, `_beltInputs`
    // and `_beltEstimateText`.
    // -----------------------------------------------------------------------------------------------------------

    /**
     * The belt run; a subclass returns its result (`{status, rows, ...}`), or null when it was cancelled.
     * @param {Function} _current - `() => boolean`: this run is still the live one
     * @param {string} _metricKey
     * @returns {Promise<Object|null>}
     */
    async _runBelts(_current, _metricKey) {
        return null;
    }

    /** @returns {Object} What a belt result was valued for, by the words a stale note uses (a subclass adds its own) */
    _beltInputs() {
        return {};
    }

    /** @returns {string} The pre-run line for the belt advisor (a subclass says what a run will do) */
    _beltEstimateText() {
        return '';
    }

    /** @returns {Object} The inputs a belt result is valued for, as they stand now */
    _beltInputsNow() {
        let inputs = {};
        try {
            inputs = this._beltInputs();
        } catch (error) {
            console.error('[TalismanRanking] Reading the belt inputs failed:', error);
        }
        return { 'Rank by': this._q('metric')?.value || '', ...inputs };
    }

    _updateBeltEstimate() {
        const estimate = this._q('belt-estimate');
        if (!estimate || this._running) return;
        try {
            estimate.textContent = this._beltEstimateText();
        } catch (error) {
            console.error('[TalismanRanking] Belt estimate failed:', error);
            estimate.textContent = '';
        }
    }

    /** Say when the drawn belt figures were valued for other inputs than the controls now hold */
    _refreshBeltStale() {
        this._refreshCoreStale();
        const note = this._q('belt-stale');
        if (!note) return;
        const result = this._belt;
        let changed = [];
        if (result && result.status !== 'refused' && result.inputs && !this._running) {
            const now = this._beltInputsNow();
            changed = Object.keys({ ...result.inputs, ...now }).filter(
                (key) => JSON.stringify(result.inputs[key]) !== JSON.stringify(now[key])
            );
        }
        note.style.display = changed.length ? 'block' : 'none';
        note.textContent = changed.length
            ? `The belt figures are out of date: the ${changed.join(', ')} changed since the check ran. Check belts again.`
            : '';
    }

    /** Put a line where the belt results go */
    _beltMessage(text) {
        const box = this._q('belt-results');
        if (box) {
            box.innerHTML = text
                ? `<div style="color:#ff9800; font-size:12px; padding:4px 0;">${escapeHtml(text)}</div>`
                : '';
        }
    }

    /** Check the belts: never a second run beside one in flight */
    _onBelts() {
        if (this._running) return;
        return this._guardedRun(
            async (current) => {
                this._belt = null;
                this._beltMessage('');
                this._refreshBeltStale();
                // Read now, before the first await: a later edit must not relabel the run
                const inputs = this._beltInputsNow();
                const result = await this._runBelts(current, this._q('metric')?.value);
                if (!current() || !result) return;
                result.inputs = inputs;
                this._belt = result;
                this._renderBelts();
            },
            { refuse: (text) => (this._belt ? this._notice(text) : this._beltMessage(text)) }
        );
    }

    /** A gain per cost in the metric's units */
    _ratioText(value, metric) {
        if (metric.balanced) return signedPct(value);
        return metric.key === 'deaths' ? signed(-value, 3) : signed(value, Math.abs(value) >= 10 ? 1 : 2);
    }

    /** Draw the belt result on the cost basis the select holds */
    _renderBelts() {
        const box = this._q('belt-results');
        if (!box) return;
        const result = this._belt;
        if (!result) {
            box.innerHTML = '';
            this._refreshBeltStale();
            return;
        }
        if (result.status === 'refused') {
            this._beltMessage(result.message || 'Nothing to check.');
            this._refreshBeltStale();
            return;
        }
        const gameData = dataManager.getInitClientData?.() || {};
        const metric = rankingMetric(result.metricKey, this.metrics);
        const basis = this._q('belt-cost')?.value || DEFAULT_COST_BASIS;
        const basisInfo = COST_BASES.find((b) => b.key === basis) || COST_BASES[0];
        const beltName = `${gameData.itemDetailMap?.[result.belt.hrid]?.name || 'Talisman Belt'} +${result.belt.enhancementLevel || 0}`;
        const parts = [
            `<div style="color:#bbb; font-size:11px; margin:2px 0 6px;">${escapeHtml(
                `${result.context || result.actionName ? `${result.context || result.actionName} · ` : ''}Belts against ${beltName} (Talisman Power ${(result.power * 100).toFixed(1)}%, ${result.slots} slot${result.slots === 1 ? '' : 's'}), ` +
                    `valued with the talismans slotted now, by ${metric.label}. ` +
                    (this.exact
                        ? 'Exact: the same skilling math as the ranking, once per belt.'
                        : `One sim per belt, ${result.paired ? 'one shared seed' : 'independent samples (shared seed off: wider error bars)'}${result.hours ? `, ${result.hours} h each` : ''}.`) +
                    ' Prices were read when the check ran.'
            )}</div>`,
        ];
        const warn = (text) =>
            parts.push(`<div style="color:#ff9800; font-size:11px; margin-bottom:4px;">${escapeHtml(text)}</div>`);
        if (result.status === 'stopped') {
            const measured = result.rows?.length || 0;
            const why = result.cancelledElsewhere ? ' (another simulation cancelled this run)' : '';
            warn(
                result.reason === 'no_figures'
                    ? `The action's figures could not be worked out for every belt: ${measured} of ${result.of} shown.`
                    : `Stopped early${why}: ${measured} of ${result.of} belts valued. The rows shown are complete.`
            );
        }
        if (result.unmodeled?.length) {
            warn(
                `The sim does not model ${result.unmodeled.join(', ')}: ${result.unmodeled.length === 1 ? 'that line counts' : 'those lines count'} for nothing on every belt, so gains are understated.`
            );
        }
        if ((metric.key === 'profit' || metric.balanced) && (result.unpriced?.length || result.hasMissingPrices)) {
            warn('Some prices are missing and are left out: profit figures are floors.');
        }
        if (metric.key === 'profit' && result.hasUnpricedInputs) warn(`${UNPRICED_INPUTS_NOTE}.`);
        if (basis === 'enhance') {
            // Pro rates or a manual bench price the estimate on a bench that is not the player's: say whose
            const benches = [...new Set((result.rows || []).map((row) => row.costs?.enhance?.bench).filter(Boolean))];
            if (benches.length) warn(`The enhancement estimate uses ${benches.join('; ')}.`);
        }
        const rows = sortBeltRows(result.rows || [], basis);
        if (!rows.length) {
            parts.push(
                `<div style="color:${GAME_COLORS.textDim}; font-size:12px;">${
                    result.status === 'done'
                        ? 'Nothing to compare: no larger belt and no higher level is on offer for this belt.'
                        : 'No belt was valued.'
                }</div>`
            );
            box.innerHTML = parts.join('');
            this._refreshBeltStale();
            return;
        }
        if (rows.every((row) => rateRow(row, basis).kind === 'unpriced')) {
            warn(
                `No belt has a price on the "${basisInfo.label}" basis: the gains are shown, but none can be set against a cost.`
            );
        }
        const th = (text, title, align = 'right') =>
            `<th style="text-align:${align}; padding:2px 6px; color:#888; font-weight:600;" title="${escapeHtml(title)}">${text}</th>`;
        const head =
            `<tr>${th('#', TIP_HASH, 'left')}${th('Belt', TIP_BELT_CANDIDATE, 'left')}` +
            th(escapeHtml(metric.label), TIP_BELT_GAIN) +
            (this.exact ? '' : th('%', 'Change against the belt worn now, with its 95% error bar')) +
            th('Cost', `${TIP_BELT_COST_COL} Basis: ${basisInfo.label}. ${basisInfo.help}`) +
            th(`per ${COST_UNIT / 1e6}m`, TIP_BELT_RATIO) +
            th('Note', TIP_BELT_NOTE, 'left') +
            '</tr>';
        const body = rows
            .map((row, index) => {
                const rate = rateRow(row, basis);
                const dim = row.significant === false || row.gainUnreal;
                const color = dim
                    ? '#777'
                    : row.value > 0
                      ? GAME_COLORS.good
                      : row.value < 0
                        ? GAME_COLORS.bad
                        : '#aaa';
                const cost = row.costs?.[basis];
                const costCell =
                    rate.cost === null
                        ? `<span style="color:#ff9800;" title="${escapeHtml(rate.why)}">No price</span>`
                        : `<span title="${escapeHtml(
                              cost?.resale != null
                                  ? `${formatKMB(row.costs.market.price)} to buy, less ${formatKMB(cost.resale)} for your belt after tax`
                                  : `${Math.round(rate.cost).toLocaleString('en-US')} coins`
                          )}">${rate.cost < 0 ? '−' : ''}${formatKMB(Math.abs(rate.cost))}</span>`;
                const ratioCell =
                    rate.kind === 'ratio'
                        ? this._ratioText(rate.per100m, metric)
                        : rate.kind === 'free'
                          ? `<span title="${basis === 'net' ? "Your current belt's sale pays for this one: " : 'Nothing to pay on this basis: '}no cost to divide by">free</span>`
                          : `<span style="color:#777;" title="${escapeHtml(rate.why || '')}">—</span>`;
                const notes = [
                    emptySlotNote(row.emptySlots),
                    rate.kind === 'none' ? rate.why : '',
                    row.noEffect ? 'No effect for these talismans here.' : '',
                    row.deathsRise ? 'Deaths/hr rose beyond its error bar.' : '',
                    row.hasMissingPrices ? 'Some prices are missing: profit is a floor.' : '',
                    rate.kind === 'free'
                        ? basis === 'net'
                            ? 'Free: selling your belt covers it.'
                            : 'No cost on this basis.'
                        : '',
                ].filter(Boolean);
                const pct = this.exact
                    ? ''
                    : `<td style="text-align:right; padding:2px 6px; color:${color};">${signedPct(row.valuePct)}${Number.isFinite(row.errPct) ? ` <span style="color:#777;">±${row.errPct.toFixed(2)}</span>` : ''}</td>`;
                return (
                    `<tr><td style="padding:2px 6px; color:#888;">${index + 1}</td>` +
                    `<td style="padding:2px 6px; color:${dim ? '#999' : '#ddd'}; white-space:nowrap;" title="${escapeHtml(`Talisman Power ${(row.power * 100).toFixed(1)}%, ${row.slots} slot${row.slots === 1 ? '' : 's'}`)}">${escapeHtml(candidateLabel(row))}</td>` +
                    `<td style="text-align:right; padding:2px 6px; color:${color};" title="${escapeHtml(TIP_BELT_GAIN)}">${this._formatValue(row.value, metric)}</td>` +
                    pct +
                    `<td style="text-align:right; padding:2px 6px; color:#ccc;">${costCell}</td>` +
                    `<td style="text-align:right; padding:2px 6px; color:#ccc;">${ratioCell}</td>` +
                    `<td style="padding:2px 6px; color:#999;">${escapeHtml(notes.join(' '))}</td></tr>`
                );
            })
            .join('');
        parts.push(
            `<div style="overflow-x:auto;"><table style="border-collapse:collapse; font-size:11px; width:100%;">${head}${body}</table></div>`
        );
        parts.push(
            `<div style="font-size:11px; color:#888; margin-top:4px;">${escapeHtml(
                `Cost basis: ${basisInfo.label}. ${basisInfo.help} A larger belt's extra slots hold nothing yet, so they add nothing here.`
            )}</div>`
        );
        box.innerHTML = parts.join('');
        this._refreshBeltStale();
    }

    // -----------------------------------------------------------------------------------------------------------
    // Core advisor: is adding the next line to a worn talisman with a core worth it. No sim: it values the draw from
    // the ranking's rows (`_result`), so it needs a finished ranking, and is stamped with the ranking it read and every
    // input that changes it (gear, worn lines, belt, core quotes). A subclass supplies `_coreContext`.
    // -----------------------------------------------------------------------------------------------------------

    /**
     * The gear the cores are valued for, now.
     * @returns {Promise<{status: 'refused', message: string}|{talismans: Array<Object>, power: number, slots: number}>}
     */
    async _coreContext() {
        return { status: 'refused', message: 'The core advisor is not available here.' };
    }

    /** @returns {Object} What a core result was valued for: the belt check's inputs, the ranking, and the core quotes */
    _coreInputsNow() {
        const gameData = dataManager.getInitClientData?.() || {};
        let prices = null;
        try {
            prices = coreQuoteKey(gameData.talismanInfo, gameData.itemDetailMap);
        } catch (error) {
            console.error('[TalismanRanking] Reading the core quotes failed:', error);
        }
        return { ...this._beltInputsNow(), ranking: this._result?.rankingId ?? null, 'core prices': prices };
    }

    /** Say when the drawn core figures were valued for other inputs than stand now */
    _refreshCoreStale() {
        const note = this._q('core-stale');
        if (!note) return;
        const result = this._core;
        let changed = [];
        if (result && result.inputs && !this._running) {
            const now = this._coreInputsNow();
            changed = Object.keys({ ...result.inputs, ...now }).filter(
                (key) => JSON.stringify(result.inputs[key]) !== JSON.stringify(now[key])
            );
        }
        note.style.display = changed.length ? 'block' : 'none';
        note.textContent = changed.length
            ? `The core figures are out of date: the ${changed.join(', ')} changed since the check ran. Check cores again.`
            : '';
    }

    /** Put a line where the core results go */
    _coreMessage(text) {
        const box = this._q('core-results');
        if (box) {
            box.innerHTML = text
                ? `<div style="color:#ff9800; font-size:12px; padding:4px 0;">${escapeHtml(text)}</div>`
                : '';
        }
    }

    /** Check the cores: never beside a run in flight */
    _onCores() {
        if (this._running) return;
        return this._guardedRun(
            async (current) => {
                this._core = null;
                this._coreMessage('');
                this._refreshCoreStale();
                const ranking = this._result;
                if (!ranking) {
                    this._coreMessage('Run the ranking first: the cores are valued from its rows.');
                    return;
                }
                // Read now, before the first await: a later edit must not relabel the check
                const inputs = this._coreInputsNow();
                this._progress('Checking cores…');
                const ctx = await this._coreContext();
                if (!current()) {
                    this._coreMessage('The character or the panel changed while checking. Press Check cores again.');
                    return;
                }
                // The ranking on screen is the one that was read: a replaced one holds other rows
                if (this._result !== ranking) {
                    this._coreMessage('The ranking changed while checking. Press Check cores again.');
                    return;
                }
                let result;
                if (ctx?.status === 'refused') {
                    result = { status: 'refused', message: ctx.message, rows: [] };
                } else {
                    result = adviseCores({
                        talismans: ctx.talismans,
                        ranking,
                        power: ctx.power,
                        typeHrid: this.typeHrid,
                        gameData: dataManager.getInitClientData?.() || {},
                    });
                    result.notValued = ranking?.notValued?.length || 0;
                    result.context = ranking?.zoneName
                        ? `${ranking.zoneName} T${ranking.difficultyTier}`
                        : ranking?.actionName || '';
                }
                result.inputs = inputs;
                this._core = result;
                this._renderCores();
                // Every ending says something: a check that drew nothing is reported, never left blank
                if (this._q('core-results') && !this._q('core-results').innerHTML) {
                    this._coreMessage('The core check drew nothing. This is a bug: please report it.');
                }
            },
            { refuse: (text) => this._coreMessage(text) }
        );
    }

    /** Draw the core result */
    _renderCores() {
        const box = this._q('core-results');
        if (!box) return;
        const result = this._core;
        if (!result) {
            box.innerHTML = '';
            this._refreshCoreStale();
            return;
        }
        if (result.status === 'refused') {
            this._coreMessage(result.message || 'Nothing to check.');
            this._refreshCoreStale();
            return;
        }
        const metric = rankingMetric(result.metricKey, this.metrics);
        const pct = (p) => `${Math.round(p * 100)}%`;
        const oddsText = result.odds.map((p, i) => `G${i + 1} ${(p * 100).toFixed(0)}%`).join(' / ');
        const parts = [
            `<div style="color:#bbb; font-size:11px; margin:2px 0 6px;">${escapeHtml(
                `${result.context ? `${result.context} · ` : ''}Next line from a core, valued from the ranking above by ${metric.label} ` +
                    `(Talisman Power ${(result.power * 100).toFixed(1)}%). The draw: ${oddsText} (cores roll G1-G3 only), any type the ` +
                    `talisman does not hold, by its game-data weight. Prices were read when the check ran.`
            )}</div>`,
        ];
        const rows = result.rows;
        if (rows.every((row) => rateRow(row, CORE_BASIS).kind === 'unpriced')) {
            parts.push(
                `<div style="color:#ff9800; font-size:11px; margin-bottom:4px;">${escapeHtml(
                    'No core has a market price: the gains are shown, but none can be set against a cost.'
                )}</div>`
            );
        }
        const th = (text, title, align = 'right') =>
            `<th style="text-align:${align}; padding:2px 6px; color:#888; font-weight:600;" title="${escapeHtml(title)}">${text}</th>`;
        const head =
            `<tr>${th('#', TIP_HASH, 'left')}${th('Talisman', 'The worn talisman and the lines it has now.', 'left')}` +
            th('Adds', 'The line number the core adds.') +
            th(escapeHtml(metric.label), TIP_CORE_GAIN) +
            th('Useful', TIP_CORE_USEFUL) +
            th('Best', TIP_CORE_BEST, 'left') +
            th('Cost', TIP_CORE_COST) +
            th(`per ${COST_UNIT / 1e6}m`, TIP_CORE_RATIO) +
            th('Note', TIP_BELT_NOTE, 'left') +
            '</tr>';
        const body = rows
            .map((row, index) => {
                const rate = rateRow(row, CORE_BASIS);
                const dim = row.significant === false;
                const color = dim
                    ? '#777'
                    : row.value > 0
                      ? GAME_COLORS.good
                      : row.value < 0
                        ? GAME_COLORS.bad
                        : '#aaa';
                const cost = row.costs[CORE_BASIS];
                const costCell =
                    rate.cost === null
                        ? `<span style="color:#ff9800;" title="${escapeHtml(rate.why)}">No price</span>`
                        : `<span title="${escapeHtml(`${cost.count} × ${formatKMB(cost.unit)}`)}">${formatKMB(rate.cost)}</span>`;
                const ratioCell =
                    rate.kind === 'ratio'
                        ? this._ratioText(rate.per100m, metric)
                        : `<span style="color:#777;" title="${escapeHtml(rate.why || '')}">—</span>`;
                const notes = [
                    rate.kind === 'unpriced' ? 'Unpriced: no gain per cost.' : '',
                    row.value < 0 ? 'The expected change is negative.' : '',
                    row.value === 0 ? 'No line it can roll is worth anything here.' : '',
                    row.value > 0 && row.significant === false ? 'The gain is within noise.' : '',
                    row.mechanicShare > 0 ? 'Leans on mechanic or non-linear lines: rough.' : '',
                    row.assumedShare > 0
                        ? 'Later copies of a line already worn are assumed to add as much as the first.'
                        : '',
                    row.unvaluedShare > 0
                        ? `${pct(row.unvaluedShare)} of draws land on lines the ranking did not value (counted 0).`
                        : '',
                    row.unrealShare > 0
                        ? `${pct(row.unrealShare)} of draws land on lines whose gain counts a free input (counted 0).`
                        : '',
                ].filter(Boolean);
                const lines = row.lines.map((l) => `${l.name} G${l.grade}`).join(', ');
                const best = row.best
                    ? `${escapeHtml(row.best.name)} G${row.best.grade} ${this._formatValue(row.best.value, metric)} <span style="color:#777;">(${(row.best.chance * 100).toFixed(1)}%)</span>`
                    : '<span style="color:#777;">—</span>';
                return (
                    `<tr><td style="padding:2px 6px; color:#888;">${index + 1}</td>` +
                    `<td style="padding:2px 6px; color:${dim ? '#999' : '#ddd'};" title="${escapeHtml(lines)}">${escapeHtml(`${row.id != null ? `#${row.id} ` : ''}slot ${row.slotIndex}`)} <span style="color:#777;">(${row.lines.length} line${row.lines.length === 1 ? '' : 's'})</span></td>` +
                    `<td style="text-align:right; padding:2px 6px; color:#ccc;">line ${row.lineNumber}</td>` +
                    `<td style="text-align:right; padding:2px 6px; color:${color};" title="${escapeHtml(TIP_CORE_GAIN)}">${this._formatValue(row.value, metric)}</td>` +
                    `<td style="text-align:right; padding:2px 6px; color:#ccc;" title="${escapeHtml(TIP_CORE_USEFUL)}">${pct(row.pUseful)}</td>` +
                    `<td style="padding:2px 6px; color:#ccc; white-space:nowrap;">${best}</td>` +
                    `<td style="text-align:right; padding:2px 6px; color:#ccc;">${costCell}</td>` +
                    `<td style="text-align:right; padding:2px 6px; color:#ccc;">${ratioCell}</td>` +
                    `<td style="padding:2px 6px; color:#999;">${escapeHtml(notes.join(' '))}</td></tr>`
                );
            })
            .join('');
        parts.push(
            `<div style="overflow-x:auto;"><table style="border-collapse:collapse; font-size:11px; width:100%;">${head}${body}</table></div>`
        );
        parts.push(
            `<div style="font-size:11px; color:#888; margin-top:4px;">${escapeHtml(
                'Each outcome is the ranking row for that line (measured with that line alone on the belt), so lines are assumed to add up. ' +
                    'It is a lottery: the expected gain is an average over draws, and the Useful chance and Best outcome show the spread. ' +
                    'What the extra line does to the orbs the other lines need later is not included. ' +
                    (result.notValued ? `${result.notValued} lines were not valued by the sim and count as 0.` : '')
            )}</div>`
        );
        box.innerHTML = parts.join('');
        this._refreshCoreStale();
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
