/**
 * The Upgrade tab's "Talisman lines" section: which combat talisman lines are worth most for this build, and the set
 * to aim for. Test server only, behind `combatSim_talismanLineRanking`. Combat only: the skilling ranking lives in the
 * Skilling Optimizer's Talismans section.
 *
 * Built by `combat-sim-ui.js` into the Upgrade tab, beside Tune triggers: a combat ranking needs the same player,
 * zone, tier and hours the upgrade advisor reads, and the same worker runner. The controls, table, set box,
 * Improve mine and Aim for this are shared with the Optimizer (features/talismans/talisman-ranking-view.js).
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { isTestServer } from '../../utils/game-server.js';
import { escapeHtml } from '../../utils/html-escape.js';
import {
    SELECT_STYLE,
    TalismanRankingSectionBase,
    signedPct,
    solverOrbReference,
    talismanRankingAvailableFor,
} from '../talismans/talisman-ranking-view.js';
import {
    buildAllPlayerDTOs,
    buildGameDataPayload,
    getCommunityBuffs,
    seedSimPriceCache,
} from './combat-sim-adapter.js';
import { runSimulation, cancelActiveSimulations } from './combat-sim-runner.js';
import {
    analysisConcurrency,
    computeDeltas,
    computeMetrics,
    rateDeltaNoisePct,
    resimCloseCallRows,
    saleTaxRateOf,
    significantDeltas,
} from './upgrade-advisor.js';
import {
    COMBAT_RANKING_METRICS,
    COMBAT_TALISMAN_TYPE,
    DEFAULT_BALANCE_WEIGHTS,
    checkCombatLines,
    combatRankingReadiness,
    estimateCombatRankingSims,
    isSpecialLine,
    normalizeBalanceWeights,
    runCombatLineRanking,
    talismanLines,
    wornTalismans,
} from './talisman-line-ranking.js';
import { estimateBeltSims, runCombatBeltAdvisor } from './talisman-belt-run.js';
import { beltCandidates } from '../talismans/talisman-belt-advisor.js';

/** The settings the Balanced weights are kept in */
export const BALANCE_WEIGHT_SETTINGS = {
    xp: 'combatSim_talismanBalanceXp',
    profit: 'combatSim_talismanBalanceProfit',
    dps: 'combatSim_talismanBalanceDps',
};

const WEIGHTS_TIP =
    'Balanced weights: how much each % gain counts in the Balanced score (kept in Settings). A higher weight makes that metric matter more.';
const WEIGHT_TIPS = {
    xp: 'Weight of the EXP/hr % gain in the Balanced score.',
    profit: 'Weight of the Profit/hr % gain in the Balanced score.',
    dps: 'Weight of the DPS % gain in the Balanced score.',
};

const SECTION_HELP =
    'Test server only. Ranks every combat talisman line by what it adds to this build, and builds the set your belt ' +
    'can hold (up to 4 lines per talisman, no line twice on one talisman). One sim per line in the zone and tier ' +
    'chosen in Configure, against this build with its talismans off; the set is then checked with one combined sim. ' +
    'Practical sets (the default) hold at most one Special line per talisman and cap the grades; a second copy of the ' +
    'same Special adds nothing (measured), so a set never repeats one. Budget sets fit an ' +
    'expected orb cost per talisman.';

/**
 * Whether the section belongs on the page: the test server, the game data's combat talisman lines.
 * @returns {boolean}
 */
export function talismanRankingAvailable() {
    return talismanRankingAvailableFor(COMBAT_TALISMAN_TYPE);
}

/**
 * The Balanced weights as stored.
 * @returns {{xp: number, profit: number, dps: number}}
 */
export function storedBalanceWeights() {
    const out = {};
    for (const [key, id] of Object.entries(BALANCE_WEIGHT_SETTINGS)) {
        out[key] = Number(config.getSettingValue(id, DEFAULT_BALANCE_WEIGHTS[key]));
    }
    return normalizeBalanceWeights(out);
}

/**
 * What the whole roster wears, for telling a ranking's fight from the fight now: each player's gear, talismans, food,
 * drinks and abilities (party members change the fight, so the rows measured against it).
 * @param {Array<Object>|null} dtos
 * @returns {string}
 */
function rosterFingerprint(dtos) {
    return JSON.stringify(
        (dtos || []).map((dto) => [
            dto?.hrid ?? null,
            dto?.equipment ?? null,
            dto?.talismans ?? null,
            dto?.food ?? null,
            dto?.drinks ?? null,
            dto?.abilities ?? null,
        ])
    );
}

/** The Upgrade tab's Talisman lines section */
export class TalismanLineRankingSection extends TalismanRankingSectionBase {
    /**
     * @param {Object} host - The Combat Sim panel: `panel`, `_readUpgradeInputs`, `_upgradePlayerIndex`, `_editor`,
     *   `_isBusy`, `_setStatus`, `_afterRun`
     */
    constructor(host) {
        super({
            typeHrid: COMBAT_TALISMAN_TYPE,
            metrics: COMBAT_RANKING_METRICS,
            title: 'Talisman lines',
            subtitle: 'which lines to aim for, and the best set',
            help: SECTION_HELP,
            rootId: 'mwi-csim-talisman-rank',
            exact: false,
        });
        this.host = host;
    }

    _extraControlsHtml() {
        const weights = storedBalanceWeights();
        const input = (key, label) =>
            `<label style="color:#888; font-size:11px;" title="${escapeHtml(WEIGHT_TIPS[key])}">${label}</label><input data-role="weight-${key}" type="number" min="0" step="0.5" value="${weights[key]}" style="${SELECT_STYLE} width:44px;" title="${escapeHtml(WEIGHT_TIPS[key])}">`;
        return `<span data-role="weights" style="display:none; align-items:center; gap:4px;" title="${escapeHtml(WEIGHTS_TIP)}">
                ${input('xp', 'XP')} ${input('profit', 'Profit')} ${input('dps', 'DPS')}
            </span>`;
    }

    _afterMount() {
        for (const [key, id] of Object.entries(BALANCE_WEIGHT_SETTINGS)) {
            this._on(this._q(`weight-${key}`), 'change', (e) => {
                const value = Number(e.target.value);
                config.setSettingValue(id, Number.isFinite(value) && value >= 0 ? value : DEFAULT_BALANCE_WEIGHTS[key]);
                this._refreshStale();
            });
        }
        // The Upgrade tab's own inputs: a result drawn for other ones says so
        for (const id of ['#mwi-csim-upgrade-hours', '#mwi-csim-upgrade-player', '#mwi-csim-upgrade-resim']) {
            this._on(this.host.panel?.querySelector(id), 'change', () => {
                this._updateEstimate();
                this._updateBeltEstimate();
                this._refreshStale();
            });
        }
    }

    _syncMetricControls() {
        const weights = this._q('weights');
        if (weights) weights.style.display = this._q('metric')?.value === 'balanced' ? 'inline-flex' : 'none';
    }

    _onStop() {
        cancelActiveSimulations();
    }

    _blocked() {
        if (this.host._isBusy()) {
            this.host._setStatus('Something else is running in the Combat Sim. Stop it or wait, then Rank.');
            return 'Something else is running in the Combat Sim. Stop it or wait, then Rank.';
        }
        return null;
    }

    _afterRun() {
        // A redraw the panel put off while this ran (a view change) is made now
        this.host._afterRun?.();
    }

    /** Refresh the estimate and the stale note (the Upgrade tab was shown: the zone or build may have changed) */
    onShow() {
        if (!this.root) return;
        this._updateEstimate();
        this._updateBeltEstimate();
        this._refreshStale();
    }

    /**
     * The game-data payload, built once per init data (and server): the estimate runs on every tab show.
     * @returns {Object|null}
     */
    _payload() {
        const init = dataManager.getInitClientData?.() || null;
        const host = isTestServer();
        if (!this._payloadCache || this._payloadCache.init !== init || this._payloadCache.host !== host) {
            this._payloadCache = { init, host, value: buildGameDataPayload() };
        }
        return this._payloadCache.value;
    }

    /**
     * What a result was ranked for, read off the controls now.
     * @returns {Object}
     */
    _currentInputs() {
        const { zoneHrid, difficultyTier, hours } = this.host._readUpgradeInputs();
        const playerIndex = this.host._upgradePlayerIndex();
        const dtos = this.host._editor?.getEditedDTOs?.();
        const dto = dtos ? Object.values(dtos)[playerIndex] : null;
        return {
            characterId: dataManager.getCurrentCharacterId(),
            playerIndex,
            playerHrid: dto?.hrid ?? null,
            zoneHrid: zoneHrid || null,
            difficultyTier,
            hours,
            build: dto ? JSON.stringify(dto) : null,
        };
    }

    /**
     * Which of a result's inputs no longer match the controls.
     * @param {Object} result
     * @returns {string[]}
     */
    _staleInputs(result) {
        const was = result?.inputs;
        if (!was) return [];
        const now = this._currentInputs();
        const changed = [];
        if (now.playerIndex !== was.playerIndex || now.playerHrid !== was.playerHrid) changed.push('player');
        if (now.zoneHrid !== was.zoneHrid) changed.push('zone');
        if (now.difficultyTier !== was.difficultyTier) changed.push('tier');
        if (now.hours !== was.hours) changed.push('hours');
        // A build read live (no editor yet) has nothing to compare
        if (was.build && now.build && now.build !== was.build) changed.push('build');
        if (result.balanceWeights) {
            const w = storedBalanceWeights();
            if (['xp', 'profit', 'dps'].some((k) => w[k] !== result.balanceWeights[k]))
                changed.push('Balanced weights');
        }
        return changed;
    }

    _refreshStale() {
        this._refreshBeltStale();
        const note = this._q('stale');
        if (!note) return;
        const changed = this._running ? [] : this._staleInputs(this._result);
        if (!this._running && this._budgetStale()) changed.push('budget');
        note.style.display = changed.length ? 'block' : 'none';
        note.textContent = changed.length
            ? `These figures are out of date: the ${changed.join(', ')} changed since the ranking ran. Rank again.`
            : '';
    }

    /** @returns {boolean} The Upgrade tab's "Re-sim close calls" is checked */
    _resimChecked() {
        return Boolean(this.host.panel?.querySelector('#mwi-csim-upgrade-resim')?.checked);
    }

    /** The cost line before a run: how many sims a combat ranking will take, or why it cannot run */
    _updateEstimate() {
        const estimate = this._q('estimate');
        if (!estimate || this._running) return;
        try {
            const gameData = this._payload();
            const dtos = this.host._editor?.getEditedDTOs?.();
            const dto = dtos ? Object.values(dtos)[this.host._upgradePlayerIndex()] : null;
            const { zoneHrid } = this.host._readUpgradeInputs();
            if (!dto) {
                estimate.textContent = 'Uses the build in Configure.';
                return;
            }
            const ready = combatRankingReadiness({ gameData, playerDTO: dto, zoneHrid });
            if (!ready.ok) {
                estimate.textContent = ready.message;
                return;
            }
            const { grade, setMode } = this._readControls();
            const lines = talismanLines(gameData.talismanModifierDetailMap, COMBAT_TALISMAN_TYPE);
            const { valued } = checkCombatLines(lines, ready.belt, gameData, grade || 6);
            const sims = estimateCombatRankingSims({
                lineCount: valued.length,
                specialCount: valued.filter(isSpecialLine).length,
                slots: ready.slots,
                hasCurrent: wornTalismans(dto.talismans, ready.slots).length > 0,
            });
            const resim = this._resimChecked() ? ', plus close-call re-sims' : '';
            const orbs = setMode === 'budget' ? ', then orb-cost solves' : '';
            estimate.textContent = `Up to ${sims} sims${resim}${orbs}, ${ready.slots} slot${ready.slots === 1 ? '' : 's'}, Talisman Power ${(ready.power * 100).toFixed(1)}%`;
        } catch (error) {
            console.error('[TalismanLineRanking] Estimate failed:', error);
            estimate.textContent = '';
        }
    }

    /**
     * The advisor's machinery a combat run is handed (the ranking's and the belt advisor's alike).
     * @returns {Object}
     */
    _simDeps() {
        return {
            buildGameDataPayload,
            runSimulation,
            computeMetrics,
            computeDeltas,
            rateDeltaNoisePct,
            significantDeltas,
            seedSimPriceCache,
            saleTaxRateOf,
            concurrency: analysisConcurrency,
        };
    }

    /** What a belt result was valued for, by the words the stale note uses */
    _beltInputs() {
        const now = this._currentInputs();
        return {
            character: now.characterId,
            player: `${now.playerIndex}:${now.playerHrid}`,
            zone: now.zoneHrid,
            tier: now.difficultyTier,
            hours: now.hours,
            build: now.build,
            // No editor: the build is the live character's, so its gear and slotted talismans are the inputs
            ...(now.build === null ? { live: this._liveGear() } : {}),
            // Every player of the roster: party members change the fight
            roster: this._rosterNow(),
            ...(this._q('metric')?.value === 'balanced' ? { 'Balanced weights': storedBalanceWeights() } : {}),
        };
    }

    /** @returns {string|null} The edited roster's fingerprint (null: no editor, the build is read live) */
    _rosterNow() {
        const dtos = this.host._editor?.getEditedDTOs?.();
        return dtos ? rosterFingerprint(Object.values(dtos)) : null;
    }

    /** @returns {Object} The live character's belt and slotted talismans (for a build read live) */
    _liveGear() {
        const belt = dataManager.getEquipment?.()?.get?.('/item_locations/belt') || null;
        return {
            belt: belt ? [belt.itemHrid, belt.enhancementLevel || 0] : null,
            talismans: dataManager.getSlottedTalismans?.() ?? null,
        };
    }

    _beltEstimateText() {
        const gameData = this._payload();
        const dtos = this.host._editor?.getEditedDTOs?.();
        const dto = dtos ? Object.values(dtos)[this.host._upgradePlayerIndex()] : null;
        if (!dto) return 'Uses the build in Configure.';
        const { zoneHrid } = this.host._readUpgradeInputs();
        const ready = combatRankingReadiness({ gameData, playerDTO: dto, zoneHrid });
        if (!ready.ok) return ready.message;
        if (wornTalismans(dto.talismans, ready.slots).length === 0) return 'No talisman is slotted on this build.';
        const count = beltCandidates(
            { hrid: ready.belt.hrid, enhancementLevel: ready.belt.enhancementLevel || 0 },
            gameData.itemDetailMap,
            gameData.enhancementLevelTotalBonusMultiplierTable
        ).length;
        return count === 0
            ? 'No larger belt or higher level to check.'
            : `Up to ${estimateBeltSims(count)} sims for ${count} candidate belts.`;
    }

    /**
     * The build the cores are valued for, now: the belt's power and slots and the talismans it wears (the roster the
     * belt check reads, so the picked player and the Configure edits are the same).
     * @returns {Promise<Object>}
     */
    async _coreContext() {
        if (this._staleInputs(this._result).length) {
            return {
                status: 'refused',
                message: 'The ranking is out of date for this gear. Rank again, then check the cores.',
            };
        }
        const { zoneHrid } = this.host._readUpgradeInputs();
        const playerIndex = this.host._upgradePlayerIndex();
        const { playerDTOs } = await this._loadRoster();
        const dto = playerDTOs?.[playerIndex] || null;
        const ready = combatRankingReadiness({ gameData: this._payload(), playerDTO: dto, zoneHrid });
        if (
            ready.ok &&
            this._result?.buildFingerprint &&
            this._result.buildFingerprint !== rosterFingerprint(playerDTOs)
        ) {
            return {
                status: 'refused',
                message: 'The ranking is out of date for this gear. Rank again, then check the cores.',
            };
        }
        if (!ready.ok) return { status: 'refused', message: ready.message };
        if (this._result?.playerHrid && dto.hrid !== this._result.playerHrid) {
            return {
                status: 'refused',
                message: 'The ranking was run for another player. Rank again, then check the cores.',
            };
        }
        return { talismans: wornTalismans(dto.talismans, ready.slots), power: ready.power, slots: ready.slots };
    }

    async _runBelts(current, metricKey) {
        const { zoneHrid, difficultyTier, hours } = this.host._readUpgradeInputs();
        const playerIndex = this.host._upgradePlayerIndex();
        const { playerDTOs, selfHrid } = await this._loadRoster();
        if (!current()) return null;
        const result = await runCombatBeltAdvisor(
            {
                playerDTOs,
                playerIndex,
                selfHrid,
                zoneHrid,
                difficultyTier,
                hours,
                communityBuffs: getCommunityBuffs(),
                metricKey,
                balanceWeights: storedBalanceWeights(),
            },
            ({ current: done, total, description }) => {
                if (!current() || this._aborted) return;
                this._progress(`${done} / ${total} · ${description}`);
            },
            this._simDeps(),
            { abortSignal: () => this._aborted || !current() }
        );
        if (!current()) return null;
        if (result.status !== 'refused') {
            const zone = buildGameDataPayload()?.actionDetailMap?.[zoneHrid];
            const playerName =
                this.host._editor?.getPlayerInfo?.()?.[playerIndex]?.name ||
                playerDTOs[playerIndex]?.name ||
                playerDTOs[playerIndex]?.hrid ||
                '';
            result.context = `${zone?.name || zoneHrid} T${difficultyTier}${playerName ? ` for ${playerName}` : ''}`;
            result.hours = hours;
        }
        return result;
    }

    async _loadRoster() {
        const edited = this.host._editor?.getEditedDTOs?.();
        if (edited) {
            return {
                playerDTOs: structuredClone(Object.values(edited)),
                selfHrid: this.host._editor.getSelfHrid?.() ?? null,
            };
        }
        const result = await buildAllPlayerDTOs();
        return { playerDTOs: result.players, selfHrid: result.selfHrid ?? null };
    }

    async _runRanking(current, orbs) {
        const { zoneHrid, difficultyTier, hours } = this.host._readUpgradeInputs();
        const playerIndex = this.host._upgradePlayerIndex();
        const { metricKey, grade, setMode, capGrade, budget } = this._readControls(solverOrbReference(orbs));
        const inputs = this._currentInputs();
        const resimCloseCalls = this._resimChecked();
        const { playerDTOs, selfHrid } = await this._loadRoster();
        if (!current()) return null;
        const buildNow = rosterFingerprint(playerDTOs);
        const result = await runCombatLineRanking(
            {
                playerDTOs,
                playerIndex,
                selfHrid,
                zoneHrid,
                difficultyTier,
                hours,
                communityBuffs: getCommunityBuffs(),
                grade,
                metricKey,
                resimCloseCalls,
                balanceWeights: storedBalanceWeights(),
                setMode,
                capGrade,
                budget,
            },
            ({ current: done, total, description }) => {
                if (!current() || this._aborted) return;
                this._progress(`${done} / ${total} · ${description}`);
            },
            {
                buildGameDataPayload,
                runSimulation,
                computeMetrics,
                computeDeltas,
                rateDeltaNoisePct,
                significantDeltas,
                seedSimPriceCache,
                saleTaxRateOf,
                concurrency: analysisConcurrency,
                resimCloseCallRows,
                orbs,
            },
            { abortSignal: () => this._aborted || !current() }
        );
        if (!current()) return null;
        const gameData = buildGameDataPayload();
        result.zoneName = gameData?.actionDetailMap?.[zoneHrid]?.name || zoneHrid;
        result.difficultyTier = difficultyTier;
        result.inputs = inputs;
        result.buildFingerprint = buildNow;
        result.hours = hours;
        result.dungeon = Boolean(gameData?.actionDetailMap?.[zoneHrid]?.combatZoneInfo?.isDungeon);
        result.playerName =
            this.host._editor?.getPlayerInfo?.()?.[playerIndex]?.name ||
            playerDTOs[playerIndex]?.name ||
            playerDTOs[playerIndex]?.hrid ||
            '';
        return result;
    }

    _headerParts(result, metric) {
        const gameData = dataManager.getInitClientData?.() || {};
        const beltName = result.belt
            ? `${gameData.itemDetailMap?.[result.belt.hrid]?.name || 'Talisman Belt'} +${result.belt.enhancementLevel || 0}`
            : '';
        let header =
            `<b>${escapeHtml(result.zoneName || '')}</b> T${result.difficultyTier}` +
            (result.playerName ? ` for <b>${escapeHtml(result.playerName)}</b>` : '') +
            ` · ${result.hours} h per sim · ranked by ${escapeHtml(metric.label)} at G${result.grade} · ` +
            `${escapeHtml(beltName)}, Talisman Power ${(result.power * 100).toFixed(1)}%, ${result.slots} slot${result.slots === 1 ? '' : 's'}`;
        if (result.status === 'done') {
            const resim =
                result.resim?.rounds > 0
                    ? ` (${result.resim.rows} close call${result.resim.rows === 1 ? '' : 's'} re-simmed up to ${result.resim.hours} h)`
                    : '';
            header +=
                ` · ${result.sims} sims${resim}, ` +
                (result.paired
                    ? 'one shared seed (each line is measured against the same fights).'
                    : 'shared seed off: every sim is an independent sample, so the error bars are wider.') +
                ' ± is 1.96 standard errors; gray rows are within noise.';
        }
        if (metric.balanced && result.balanceWeights) {
            const w = result.balanceWeights;
            header +=
                ` Balanced = weighted average of the % gains (XP ${w.xp} : Profit ${w.profit} : DPS ${w.dps}; profit as a share of the gold moving through the fight), less a third of a significant rise in deaths/hr (⚠). ` +
                'Its error bar adds the parts as if fully correlated, so it can only be wider than the truth.';
        }
        const parts = [`<div style="color:#bbb; font-size:11px; margin:2px 0 6px;">${header}</div>`];
        if (result.noise?.mostlyNoise) {
            const fix = result.dungeon
                ? 'More hours, or a zone instead of a dungeon (many more fights per hour), would separate them.'
                : 'More hours would separate them.';
            const resimHint =
                result.resim?.rounds > 0 ? '' : ' "Re-sim close calls" re-measures the lines the set depends on.';
            parts.push(
                `<div style="color:#ff9800; font-size:11px; margin-bottom:4px;">${escapeHtml(
                    `${result.noise.withinNoise} of ${result.noise.measured} lines are within noise: their order is mostly sampling luck. ${fix}${resimHint}`
                )}</div>`
            );
        }
        if ((metric.key === 'profit' || metric.balanced) && (result.unpriced?.length || 0) > 0) {
            parts.push(
                `<div style="color:#ff9800; font-size:11px; margin-bottom:4px;">Some prices are missing and are left out: profit figures are floors.</div>`
            );
        }
        return parts;
    }

    _setCheckLines(result, metric) {
        if (!result.combined) return [];
        const noise = result.combined.errPct;
        return [
            `Combined sim of the set: ${this._formatValue(result.combined.value, metric)} (${signedPct(result.combined.valuePct)}${Number.isFinite(noise) ? ` ±${noise.toFixed(2)}%` : ''})` +
                (result.combined.significant ? '.' : ', within noise.') +
                ' Lines interact, so the combined figure is the one to trust.',
        ];
    }
}
