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
    CHIP_BUTTON_STYLE,
    SELECT_STYLE,
    TalismanRankingSectionBase,
    makeOrbSolver,
    signedPct,
    solverOrbReference,
    talismanRankingAvailableFor,
} from '../talismans/talisman-ranking-view.js';
import { setOptionsFor, talismanLimits } from '../../utils/talisman-line-sets.js';
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
    rankingMetric,
    rebuildCombatLineRanking,
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
    encounters: 'combatSim_talismanBalanceEncounters',
    deaths: 'combatSim_talismanBalanceDeaths',
};

const WEIGHTS_TIP =
    'Balanced weights: how much each % gain counts in the Balanced score (kept in Settings). A higher weight makes that metric matter more.';
const WEIGHT_TIPS = {
    xp: 'Weight of the EXP/hr % gain in the Balanced score.',
    profit: 'Weight of the Profit/hr % gain in the Balanced score.',
    dps: 'Weight of the DPS % gain in the Balanced score.',
    encounters: 'Weight of the Encounters/hr % gain in the Balanced score. 0 leaves it out.',
    deaths: 'Weight of the Deaths/hr % change in the Balanced score: a rise counts against, a fall counts for. 0 leaves it out and keeps the automatic penalty for a clear rise in deaths; above 0 it replaces that penalty. From a baseline of zero deaths, any deaths count as +100%.',
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
 * What the whole roster is, for telling a ranking's fight from the fight now: each player's whole build (gear and the
 * triggers on it, talismans, food, drinks, abilities, levels, house rooms, buffs; party members change the fight, so
 * the rows measured against it). `ignoreTalismansOf` leaves one player's talismans out: the ranking measures a line
 * against that player with their talismans off, so only the rest of the roster must match.
 * @param {Array<Object>|null} dtos
 * @param {string|null} [ignoreTalismansOf] - A player hrid
 * @returns {string}
 */
function rosterFingerprint(dtos, ignoreTalismansOf = null) {
    return JSON.stringify(
        (dtos || []).map((dto) => (dto?.hrid === ignoreTalismansOf ? { ...dto, talismans: null } : (dto ?? null)))
    );
}

/**
 * What the last finished ranking cost per simulated hour of work, this session only (memory; nothing is stored).
 * Wall seconds over sims times hours per sim, so lanes and overheads are in it.
 */
const sessionRate = { secPerSimByHours: new Map() };

/**
 * Wall seconds one sim of `hours` should take, from the session's finished ranking runs: the run at the same hours,
 * else the nearest hours scaled in proportion. A sim has a fixed cost besides the hours, so a 2 h run does not
 * price a 10 h one by scaling.
 * @param {number} hours
 * @returns {number|null}
 */
export function estimatedSecPerSim(hours) {
    let best = null;
    for (const [h, secPerSim] of sessionRate.secPerSimByHours) {
        if (h === hours) return secPerSim;
        if (!best || Math.abs(h - hours) < Math.abs(best.h - hours)) best = { h, secPerSim };
    }
    return best ? (best.secPerSim * hours) / best.h : null;
}

/** Forget the session's measured rates (tests) */
export function resetSessionRate() {
    sessionRate.secPerSimByHours.clear();
}

/**
 * A length of time for the progress line: seconds under a minute, else whole minutes (rounded up).
 * @param {number} seconds
 * @returns {string}
 */
export function durationText(seconds) {
    const s = Math.max(1, Math.ceil(seconds));
    return s < 60 ? `${s} s` : `${Math.ceil(s / 60)} min`;
}

/**
 * Time left in a run from the sims finished so far. Counted from the baseline's end (it runs alone, the lines in
 * lanes): until one sim has finished after it, nothing is said. While fewer have finished than there are lanes, the
 * lanes are taken to be full, so the first wave is not read as one lane's speed. A total that grows (close-call
 * rounds) lengthens the estimate on the next report.
 * @param {Object} p
 * @param {number} p.done - Sims finished, the baseline included
 * @param {number} p.total
 * @param {number} p.baseDone - `done` when the baseline finished
 * @param {number} p.sinceBaseMs - Wall time since then
 * @param {number} p.lanes
 * @returns {string} "about N min left", or '' while it cannot tell
 */
export function etaLeftText({ done, total, baseDone, sinceBaseMs, lanes }) {
    const finished = done - baseDone;
    const remaining = total - done;
    if (finished < 1 || remaining <= 0 || !(sinceBaseMs > 0)) return '';
    const parallel = Math.max(finished, Math.min(Math.max(1, lanes), finished + remaining));
    return `about ${durationText((remaining / parallel) * (sinceBaseMs / 1000))} left`;
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
                ${input('xp', 'XP')} ${input('profit', 'Profit')} ${input('dps', 'DPS')} ${input('encounters', 'Enc.')} ${input('deaths', 'Deaths')}
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
        // The controls a drawn result was made with: it says which of them a rebuild covers and which need a new Rank
        for (const role of ['metric', 'grade', 'set-mode', 'cap']) {
            this._on(this._q(role), 'change', () => this._refreshStale());
        }
        this._on(this._q('stale'), 'click', (e) => {
            if (e.target.closest?.('[data-role="rebuild"]')) this._onRebuild();
        });
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

    /** Start the clock a run's time estimate reads */
    _etaStart() {
        this._eta = { startedAt: Date.now(), baseAt: null, baseDone: 1 };
    }

    /** The progress line: `done / total · what`, with the time left once the baseline and a line are done */
    _etaProgress(done, total, description) {
        const eta = this._eta;
        if (eta && eta.baseAt === null && done >= 1) {
            eta.baseAt = Date.now();
            eta.baseDone = done;
        }
        const left = eta?.baseAt
            ? etaLeftText({
                  done,
                  total,
                  baseDone: eta.baseDone,
                  sinceBaseMs: Date.now() - eta.baseAt,
                  lanes: analysisConcurrency(),
              })
            : '';
        this._progress(`${done} / ${total} · ${description}${left ? ` · ${left}` : ''}`);
    }

    /**
     * Remember what a finished ranking cost per sim at its hours, for the next estimate line. Only a run whose sims
     * all ran at the run's hours counts: close-call re-sims run at 2x and 4x, so dividing their wall time by sims at
     * the base hours would inflate the rate. The wall time covers lanes.
     */
    _etaRemember(result, hours) {
        const sims = result?.sims;
        if (result?.resim?.rounds > 0) return;
        const seconds = this._eta ? (Date.now() - this._eta.startedAt) / 1000 : 0;
        if (sims > 0 && hours > 0 && seconds > 0) sessionRate.secPerSimByHours.set(hours, seconds / sims);
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
            buffs: this._buffsNow(),
        };
    }

    /** @returns {string|null} The community buffs the sims would run with, as text */
    _buffsNow() {
        try {
            return JSON.stringify(getCommunityBuffs() ?? null);
        } catch {
            return null;
        }
    }

    /**
     * Which of a result's inputs no longer match the controls AND need a new ranking: the fights it simulated (player,
     * zone, tier, hours, the build and the party) and the grade it simulated at. The Rank by, Balanced weights, Set,
     * Cap and Budget controls are not here: a finished ranking is scored and planned again from its saved
     * measurements (see `_rebuildInputs`).
     * @param {Object} result
     * @returns {string[]}
     */
    _staleInputs(result) {
        const was = result?.inputs;
        if (!was) return [];
        const now = this._currentInputs();
        const changed = [];
        if (was.characterId !== undefined && now.characterId !== was.characterId) changed.push('character');
        if (now.playerIndex !== was.playerIndex || now.playerHrid !== was.playerHrid) changed.push('player');
        if (now.zoneHrid !== was.zoneHrid) changed.push('zone');
        if (now.difficultyTier !== was.difficultyTier) changed.push('tier');
        if (now.hours !== was.hours) changed.push('hours');
        // A build read live (no editor yet) has nothing to compare
        if (was.build && now.build && now.build !== was.build) changed.push('build');
        if (was.buffs !== undefined && was.buffs !== null && now.buffs !== was.buffs) changed.push('community buffs');
        // The other players of the roster are part of the fight too
        const roster = this._rosterNow();
        if (result.buildFingerprint && roster && roster !== result.buildFingerprint && !changed.includes('build')) {
            changed.push('party');
        }
        const grade = this._readControls().grade;
        if (result.grade && grade > 0 && grade !== result.grade) changed.push('grade');
        return changed;
    }

    /**
     * Which controls a finished ranking can follow without new line sims: Rank by and the Balanced weights (the rows
     * are scored again), Set, Cap and Budget (the set is planned again). Only for a finished ranking that kept its
     * measurements.
     * @param {Object} result
     * @returns {{changed: string[], rescore: boolean}} `rescore`: the metric or the weights are among them
     */
    _rebuildInputs(result) {
        if (!result || result.status !== 'done' || !result.rebuild) return { changed: [], rescore: false };
        const controls = this._readControls();
        const changed = [];
        let rescore = false;
        if (controls.metricKey && controls.metricKey !== result.metricKey) {
            changed.push('Rank by');
            rescore = true;
        } else if (result.balanceWeights) {
            const w = storedBalanceWeights();
            if (Object.keys(w).some((k) => w[k] !== (result.balanceWeights[k] ?? 0))) {
                changed.push('Balanced weights');
                rescore = true;
            }
        }
        const { maxGrade } = talismanLimits(dataManager.getInitClientData?.()?.talismanInfo);
        const want = setOptionsFor(controls.setMode, {
            simGrade: result.grade,
            capGrade: Math.min(maxGrade, controls.capGrade),
        });
        if (want.mode !== result.setMode) changed.push('Set');
        else if (want.mode !== 'ideal' && want.grade !== result.setGrade) changed.push('Cap');
        if (this._budgetStale()) changed.push('Budget');
        return { changed, rescore };
    }

    /**
     * For a result that cannot be rebuilt (stopped, refused): the weights and budget it was made with, which only a
     * new Rank can follow.
     * @param {Object|null} result
     * @returns {string[]}
     */
    _unrebuildableStale(result) {
        if (!result || (result.status === 'done' && result.rebuild)) return [];
        const changed = [];
        if (result.balanceWeights) {
            const w = storedBalanceWeights();
            if (Object.keys(w).some((k) => w[k] !== (result.balanceWeights[k] ?? 0))) changed.push('Balanced weights');
        }
        if (this._budgetStale()) changed.push('budget');
        return changed;
    }

    _refreshStale() {
        this._refreshBeltStale();
        const note = this._q('stale');
        if (!note) return;
        const forced = this._running
            ? []
            : [...this._staleInputs(this._result), ...this._unrebuildableStale(this._result)];
        const { changed, rescore } =
            this._running || forced.length ? { changed: [], rescore: false } : this._rebuildInputs(this._result);
        note.textContent = '';
        note.style.display = forced.length || changed.length ? 'block' : 'none';
        if (forced.length) {
            note.textContent =
                `These figures are out of date: the ${forced.join(', ')} changed since the ranking ran. Rank again.` +
                (forced.includes('build')
                    ? ' (The build includes the worn talismans, so a set applied in Configure counts.)'
                    : '');
        } else if (changed.length) {
            note.append(
                `The ${changed.join(', ')} changed since the ranking ran. ` +
                    (rescore
                        ? 'The saved line measurements can be scored again and the set rebuilt, with no new line sims '
                        : 'The set can be rebuilt from the saved line measurements, with no new line sims ') +
                    '(one sim if the set comes out different). Rank again for the exact picture. '
            );
            const button = document.createElement('button');
            button.dataset.role = 'rebuild';
            button.style.cssText = CHIP_BUTTON_STYLE;
            button.textContent = rescore ? 'Re-score and rebuild set' : 'Rebuild set';
            button.title = rescore
                ? 'Scores every measured line again by the new metric (or weights), plans the set again, and checks it with one combined sim if it differs from the one simulated. The close-call re-sims and the copies shortlist stay as the first run chose them.'
                : 'Plans the set again from the measured lines for the new Set, Cap or Budget, and checks it with one combined sim if it differs from the one simulated.';
            note.appendChild(button);
        }
    }

    /**
     * Score the finished ranking again and rebuild its set from the saved line measurements, for the controls as they
     * stand. A run like any other (one at a time, Stop works); a stopped or refused rebuild keeps the previous ranking.
     */
    _onRebuild() {
        if (this._running) return;
        const previous = this._result;
        if (!previous || previous.status !== 'done' || !previous.rebuild) return;
        const forced = this._staleInputs(previous);
        if (forced.length) {
            this._notice(`The ${forced.join(', ')} changed since the ranking ran: Rank again.`);
            return;
        }
        const typed = this._readControls();
        if (typed.setMode === 'budget' && typed.budgetError) {
            this._syncBudget();
            this._notice(typed.budgetError);
            return;
        }
        return this._guardedRun(
            async (current) => {
                if (!this._orbs) this._orbs = makeOrbSolver(() => this._aborted || !current());
                const orbs = this._orbs;
                if (orbs) {
                    // The solver kept the previous run's stop test, which reads as stopped now
                    orbs.abortSignal = () => this._aborted || !current();
                    orbs.cancelled = false;
                    orbs.solves = 0;
                    orbs.limited = false;
                    orbs.onSolve = (solves, max) => {
                        if (current()) this._progress(`Rebuild: orb solve ${solves} (at most ${max})`);
                    };
                }
                const ref = solverOrbReference(orbs);
                const started = this._budgetState(ref);
                const controls = this._readControls(ref);
                this._progress('Rebuild: scoring the saved measurements…');
                const next = await rebuildCombatLineRanking(
                    previous,
                    {
                        metricKey: controls.metricKey,
                        balanceWeights: storedBalanceWeights(),
                        setMode: controls.setMode,
                        capGrade: controls.capGrade,
                        budget: controls.budget,
                    },
                    ({ description }) => {
                        if (!current() || this._aborted) return;
                        // The one combined sim: about a sim's share of the last ranking, if there was one
                        // One sim alone takes about a lane-amortized sim times the lanes
                        const perSim = estimatedSecPerSim(previous.hours);
                        const left =
                            perSim && /checking/.test(description)
                                ? ` · about ${durationText(perSim * analysisConcurrency())}`
                                : '';
                        this._progress(`${description}${left}`);
                    },
                    { ...this._simDeps(), orbs },
                    { abortSignal: () => this._aborted || !current() }
                );
                if (orbs) orbs.onSolve = null;
                if (!current()) return;
                if (this._result !== previous) {
                    this._notice('The ranking changed while rebuilding. Press the button again.');
                    return;
                }
                if (next.status === 'refused') {
                    this._notice(next.message);
                    return;
                }
                if (next.status === 'stopped') {
                    this._notice(
                        `Rebuild stopped${next.cancelledElsewhere ? ' (another simulation cancelled it)' : ''}: the ranking above is unchanged.`
                    );
                    return;
                }
                if (next.setMode === 'budget') {
                    next.budgetCoins = started.ok ? started.coins : typed.budgetCoins;
                    next.budgetOrbName = ref?.name || 'Reforging Orb';
                } else {
                    delete next.budgetCoins;
                    delete next.budgetOrbName;
                }
                next.rankingId = ++this._rankSeq;
                // The core advisor reads the rows: only a re-score changes what they say
                next.rowsId = next.rebuilt?.rescored ? next.rankingId : (previous.rowsId ?? previous.rankingId);
                this._result = next;
                // Improve mine's options were worked out from the old rows and set mode; the cores from the old scores
                this._improve = null;
                this._renderImprove();
                if (next.rebuilt?.rescored) {
                    this._core = null;
                    this._renderCores();
                }
                this._render(next);
            },
            { refuse: (text) => this._notice(text) }
        );
    }

    /** The Recommended set box's "Use in Configure" button */
    _setButtonsHtml(result) {
        if (!result.set) return '';
        const who = result.playerName || 'this player';
        const title =
            `Writes this set into the Belt rows of ${who}'s seat in the Configure tab, replacing the talismans in every ` +
            'belt slot (a slot the set leaves empty is emptied). Refused when the seat now holds someone else, or the ' +
            'zone, tier, hours, grade, party or gear changed since the ranking ran. Nothing is changed in the game.';
        return (
            `<button data-role="use-configure" style="${CHIP_BUTTON_STYLE} margin-top:4px;" title="${escapeHtml(title)}">Use in Configure</button> ` +
            '<span data-role="use-configure-note" style="color:#ff9800; font-size:11px;"></span> '
        );
    }

    /**
     * Whether the build in Configure is still the one ranked, apart from the ranked player's own talismans (writing a
     * set over them is the point, and doing it twice is fine).
     * @param {Object} result
     * @returns {string[]} What changed, empty when the set may be written
     */
    _configureBlockers(result) {
        const stale = this._staleInputs(result);
        const blockers = stale.filter((k) => k !== 'build');
        if (stale.includes('build')) {
            const strip = (text) => {
                try {
                    const dto = JSON.parse(text);
                    delete dto.talismans;
                    return JSON.stringify(dto);
                } catch {
                    return null;
                }
            };
            const now = this._currentInputs().build;
            const was = result.inputs?.build;
            const dtos = this.host._editor?.getEditedDTOs?.();
            const sameBuild = strip(now) !== null && strip(now) === strip(was);
            const sameParty =
                !result.rosterWithoutTalismans ||
                !dtos ||
                rosterFingerprint(Object.values(dtos), result.playerHrid) === result.rosterWithoutTalismans;
            if (!sameBuild) blockers.push('gear or build');
            if (!sameParty) blockers.push('party');
        }
        return blockers;
    }

    /** Put the set in the Configure editor, for the seat the ranking was run for */
    _onUseInConfigure(button) {
        const note = button.parentElement?.querySelector('[data-role="use-configure-note"]');
        const say = (text) => {
            if (note) note.textContent = text;
        };
        const result = this._result;
        if (!result?.set) return;
        if (this._running) {
            say('Wait for the run to finish.');
            return;
        }
        const editor = this.host._editor;
        if (typeof editor?.applyTalismans !== 'function' || !editor.getEditedDTOs?.()) {
            say('The Configure tab has no build loaded to write to. Open it first.');
            return;
        }
        const who = result.playerName || 'The ranked player';
        // A seat label (`player2`) is not a person: Configure can load someone else into it, so the seat must still
        // exist, hold the same name, and every other input of the ranking must still match
        if (!result.playerHrid || !editor.getEditedDTOs()[result.playerHrid]) {
            say(`${who} is no longer in the Configure roster, so nothing was written.`);
            return;
        }
        const seatName = editor.getPlayerInfo?.()?.find((p) => p.hrid === result.playerHrid)?.name;
        if (seatName && result.playerName && seatName !== result.playerName) {
            say(`That seat in Configure now holds ${seatName}, not ${who}, so nothing was written. Rank again.`);
            return;
        }
        const blockers = this._configureBlockers(result);
        if (blockers.length) {
            say(`The ${blockers.join(', ')} changed since the ranking ran, so nothing was written. Rank again.`);
            return;
        }
        const outcome = editor.applyTalismans(result.playerHrid, structuredClone(result.set.talismans));
        if (!outcome.ok) {
            say(
                outcome.reason === 'no_belt'
                    ? `${who} wears no Talisman Belt in Configure now, so nothing was written.`
                    : outcome.reason === 'too_many_slots'
                      ? `${who}'s belt has ${outcome.slots} slot${outcome.slots === 1 ? '' : 's'}, fewer than this set uses. Rank again.`
                      : `${who} is no longer in the Configure roster, so nothing was written.`
            );
            return;
        }
        this._refreshStale();
        say(
            `Written to ${who}'s Belt rows in Configure. The ranking now reads as out of date: the worn talismans are part of the build it measured, so Rank again to compare "Your talismans now".`
        );
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
            const { hours } = this.host._readUpgradeInputs();
            const perSim = hours > 0 ? estimatedSecPerSim(hours) : null;
            const time = perSim ? `, roughly ${durationText(sims * perSim)} (from the last run)` : '';
            estimate.textContent = `Up to ${sims} sims${resim}${orbs}${time}, ${ready.slots} slot${ready.slots === 1 ? '' : 's'}, Talisman Power ${(ready.power * 100).toFixed(1)}%`;
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
        this._etaStart();
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
                this._etaProgress(done, total, description);
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
        this._etaStart();
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
                this._etaProgress(done, total, description);
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
        if (result.status === 'done') this._etaRemember(result, hours);
        const gameData = buildGameDataPayload();
        result.zoneName = gameData?.actionDetailMap?.[zoneHrid]?.name || zoneHrid;
        result.difficultyTier = difficultyTier;
        result.inputs = inputs;
        result.buildFingerprint = buildNow;
        result.rosterWithoutTalismans = rosterFingerprint(playerDTOs, playerDTOs[playerIndex]?.hrid ?? null);
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
            const extra =
                (w.encounters > 0 ? ` : Encounters ${w.encounters}` : '') +
                (w.deaths > 0 ? ` : Deaths ${w.deaths}` : '');
            header +=
                ` Balanced = weighted average of the % gains (XP ${w.xp} : Profit ${w.profit} : DPS ${w.dps}${extra}; profit as a share of the gold moving through the fight)` +
                (w.deaths > 0
                    ? ', less the % rise in deaths/hr at its weight (a fall adds; from zero deaths any deaths count +100%). '
                    : ', less a third of a significant rise in deaths/hr (⚠). ') +
                'Its error bar adds the parts as if fully correlated, so it can only be wider than the truth.';
        }
        const parts = [`<div style="color:#bbb; font-size:11px; margin:2px 0 6px;">${header}</div>`];
        if (result.rebuilt) {
            const r = result.rebuilt;
            const ranBy = rankingMetric(r.ranWith?.metricKey).label;
            let line =
                `Rebuilt from the saved line measurements${r.rescored ? ` (scored again by ${metric.label})` : ''}: ` +
                (r.simmed ? 'the new set was checked with one more sim.' : 'no new sims.');
            if (r.metricDiffers) {
                line +=
                    ` The ${result.resim?.rounds > 0 ? "lines near the set's cut line were re-simmed, and the leading lines" : 'leading lines'} ran ` +
                    `${result.resim?.rounds > 0 ? '' : 'in the shortlist '}with a copy in every slot, ` +
                    `under ${ranBy}, so another metric may have chosen others. Rank again for the exact picture.`;
            }
            if (!r.metricDiffers && r.setDiffers && result.resim?.rounds > 0) {
                line +=
                    " The lines near the set's cut line were re-simmed around the set settings of the run (mode and cap), " +
                    'so a different set may have chosen others. Rank again for the exact picture.';
            }
            parts.push(`<div style="color:#bbb; font-size:11px; margin-bottom:4px;">${escapeHtml(line)}</div>`);
        }
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
