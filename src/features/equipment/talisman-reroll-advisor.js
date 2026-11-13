/**
 * Talisman reroll advisor
 *
 * Test server only. In the game's talisman window the player picks a target — up to four wanted lines, each a
 * modifier type and a minimum grade — and the advisor shows the next move (which orb, whether to lock a line with
 * a Binding Orb, or whether to keep or use a pending roll) and how many of each orb the best strategy spends on
 * average from here. The strategy itself comes from utils/talisman-reroll-solver.js, which states its method and
 * limits.
 *
 * Orbs are compared on one scale: market prices when every orb has a live listing, otherwise the game's own item
 * value (`sellPrice`). A coin cost is shown only when every orb the strategy uses has a market price; the tester
 * shop's prices are never used.
 *
 * The window is found by the game's CSS module class names (TalismanModal_*), and the talisman by the `talisman`
 * prop of the window's React component (what the window itself shows), never from translated text.
 *
 * The advised game control is outlined, and "Do next step" presses it: one game action per click, through the
 * window's React handlers (talisman-step-controls.js), then nothing until the talisman changes or 5 s pass.
 *
 * Nothing here runs on a live server: `initialize` returns at once and nothing is registered.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import {
    advisedElements,
    clearMarks,
    confirmDialogOpen,
    findWindowComponent,
    inventoryCount,
    itemFor,
    markElements,
    performStep,
    pressReroll,
    rerollReady,
    scanControls,
} from './talisman-step-controls.js';
import { isTestServer } from '../../utils/game-server.js';
import { coinCost, orbWeights, roundWeights } from '../../utils/talisman-orb-weights.js';
import { advise, buildProblem, meetsTarget, solveSteps, REROLL_MODES } from '../../utils/talisman-reroll-solver.js';

const MODAL_CLASS = 'TalismanModal_talismanModal';
const FOOTER_SELECTOR = '[class*="TalismanModal_footer"]';
const PANEL_CLASS = 'toolasha-reroll-advisor';
const RENDER_DEBOUNCE_MS = 80;
const SLICE_MS = 12;
const MAX_WANTED = 4;
const CACHE_LIMIT = 3;

/** The assumptions a player should know about, shown in the panel's help */
export const ADVISOR_HELP = [
    'Measured on the test server: grade odds of Reforging, Reshaping and Mutation (1,288 lines; a cap cuts the ' +
        'same curve); type odds follow the game data weights (2,088 lines); Attunement 65/20/15 (81 rolls: G3 lines ' +
        'down 69 / same 19 / up 12); Focus ×5 (100 rolls focused on Armor gave Armor in 33%, 36.9% predicted, grades ' +
        'kept).',
    'Binding Orb, measured: a lock costs one Binding Orb, moving the lock to another line costs one more, and ' +
        'unlocking is free.',
    'Approximations: junk types are lumped by their average weight, and the order in which Focus draws the lines ' +
        'is unknown. A talisman never holds one type twice (the game keys its lines by type).',
    'Assumed, not measured: Exchange shuffles the unlocked grades uniformly.',
    'Measured: lines from creating a talisman and from cores roll G1-G3 only, whatever the core (396 lines: 57 / 28 / ' +
        '15%, the Reforging curve cut at G3). This advice does not plan adding lines: it uses the lines the talisman has now. ' +
        'The Core advisor (Combat Sim Upgrade tab, Skilling Optimizer Talismans) values the next line of a worn talisman against its cores.',
    'Orbs are weighed by market price when every orb has a live listing, otherwise by the game item value; a coin ' +
        'cost is shown only when every orb the strategy uses has a market price.',
    'Do next step does one game action per click (choosing the orb in the picker first when needed) and then waits ' +
        'for the talisman to change; it never continues on its own.',
];

// The orb scale is shared with the Combat Sim's talisman line ranking (utils/talisman-orb-weights.js)
export { orbWeights, coinCost, roundWeights };

function option(text, value) {
    const el = document.createElement('option');
    el.textContent = text;
    el.value = value;
    return el;
}

function formatCount(value) {
    if (value >= 100) return String(Math.round(value));
    if (value >= 10) return value.toFixed(1).replace(/\.0$/, '');
    return value.toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
}

function formatCoins(value) {
    if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
    return String(Math.round(value));
}

/**
 * The lines of text the panel shows for an advice (or a problem that could not be built).
 * @param {Object} result - {build, advice, scale, prices, mutationUsed}
 * @param {Object} names - {item(hrid), modifier(hrid), lineCount}
 * @returns {{move: string, detail: string[]}}
 */
export function describeAdvice(result, names) {
    const { build, advice } = result;
    const item = names.item;
    const mod = names.modifier;
    if (build.status === 'noTarget') return { move: 'Pick up to four lines you want.', detail: [] };
    if (build.status === 'empty') return { move: 'This talisman has no lines yet.', detail: [] };
    if (build.status === 'noData') return { move: 'The game data for talismans has not loaded.', detail: [] };
    if (build.status === 'noOrbs') return { move: 'The game data lists no reroll orbs.', detail: [] };
    if (build.status === 'impossible') {
        const reasons = {
            duplicate: `Each type can be wanted once: ${mod(build.hrid)} is picked twice.`,
            notInPool: `${mod(build.hrid)} cannot roll on this talisman type.`,
            gradeAboveCap: `${mod(build.hrid)}: grades only go up to G6.`,
            needsMoreLines: `The talisman has ${names.lineCount} line(s); add lines with talisman cores first (the Core advisor in the Talismans sections says whether the next line is worth it).`,
        };
        return { move: `Not reachable. ${reasons[build.reason] || ''}`.trim(), detail: [] };
    }
    if (!advice) return { move: 'Working out the best strategy…', detail: [] };

    let move;
    switch (advice.status) {
        case 'met':
            move = 'Target met. Nothing to do.';
            break;
        case 'accept':
            move = advice.met ? 'Use New Roll: it meets the target.' : 'Use New Roll: it is closer to the target.';
            break;
        case 'discard':
            move = 'Keep Current: the new roll is not better.';
            break;
        case 'move': {
            const next = advice.move;
            if (next.kind === 'lock') move = `Next: lock ${mod(next.modifierHrid)} with a ${item(next.itemHrid)}.`;
            else if (next.kind === 'unlock') move = 'Next: unlock the locked line (free).';
            else {
                move = `Next: ${item(next.itemHrid)}.`;
                if (next.mode === REROLL_MODES.typesOnly && next.focusHrids?.length) {
                    move += ` Focus on ${next.focusHrids.map(mod).join(', ')}.`;
                }
            }
            break;
        }
        case 'unreachable':
            move = 'Not reachable from here with the orbs in the game data.';
            break;
        default:
            move = 'Could not read this talisman.';
    }

    const detail = [];
    const more = (other) => Math.round(((other - advice.value) / advice.value) * 100);
    if (advice.status === 'move' && advice.move.kind === 'unlock' && advice.stayLockedValue > advice.value) {
        detail.push(`Keeping the lock is expected to cost ${more(advice.stayLockedValue)}% more.`);
    }
    if (advice.status === 'move' && advice.lockFirst?.value > advice.value) {
        detail.push(
            `Locking ${mod(advice.lockFirst.modifierHrid)} first is expected to cost ${more(advice.lockFirst.value)}% more.`
        );
    }
    const counts = advice.counts || {};
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length > 0 && advice.status !== 'met') {
        detail.push(`Expected from here: ${entries.map(([hrid, n]) => `${formatCount(n)} ${item(hrid)}`).join(', ')}`);
        const coins = coinCost(counts, result.prices);
        if (coins !== null) detail.push(`About ${formatCoins(coins)} coins at market prices.`);
        else detail.push('No coin cost: not every orb used has a market listing.');
        if (result.scale !== 'market') {
            detail.push(
                result.scale === 'itemValue'
                    ? 'Orbs weighed by the game item value.'
                    : 'Orbs weighed as one each (no prices or item values).'
            );
        }
    }
    // Solver notes only matter while there is something left to do
    const met = advice.status === 'met' || (advice.status === 'accept' && advice.met);
    if (met) return { move, detail };
    if (result.updating) detail.push('Updating for new prices…');
    if (result.mutationUsed === false) detail.push('Target too large to weigh the Mutation Orb; it is left out.');
    if (result.gradeClamped) {
        detail.push(
            `Target too large to track every grade: grades above G${result.clampGrade} count as G${result.clampGrade}, ` +
                'so Attunement may look dearer than it is.'
        );
    }
    return { move, detail };
}

/**
 * The `talisman` prop of the window's React component.
 * @param {Element} modal
 * @returns {Object|null}
 */
function talismanFromModal(modal) {
    return findWindowComponent(modal).talisman;
}

/** What identifies the talisman's lines, to tell when a press took effect */
function snapshotOf(talisman) {
    return JSON.stringify([talisman.modifiers, talisman.pendingModifiers, talisman.lockedModifierHrid]);
}

const PRESS_TIMEOUT_MS = 5000;
/** After the game's confirm dialog closes with no change, how long to wait for the server before calling it refused */
const CONFIRM_GRACE_MS = 3000;
const PRESS_TICK_MS = 250;
/** Frames to wait for the game to enable Reroll after the orb is chosen */
const REROLL_WAIT_TRIES = 10;
const REROLL_WAIT_MS = 50;
const CONFIRM_TEXT = "Confirm in the game's dialog";
const REFUSED_TEXT = 'No response — the game may have refused this (rerolls are blocked in combat)';

class TalismanRerollAdvisor {
    constructor() {
        this.initialized = false;
        this.unregisterObserver = null;
        this.modalObserver = null;
        this.watchedModal = null;
        this.renderTimer = null;
        this.sliceTimer = null;
        this.targets = new Map();
        this.solutions = new Map();
        this.latest = new Map();
        this.running = null;
        this.panel = null;
        this.panelTalismanKey = null;
        this._handlers = {};
        // "Do next step": the context of the last drawn advice, the press in flight, and the status line
        this.stepContext = null;
        this.pressing = null;
        this.stepStatus = '';
    }

    initialize() {
        if (this.initialized) return;
        if (!isTestServer()) return;
        if (!config.getSetting('talismanRerollAdvisor')) return;

        this._handlers = {
            talismans_updated: () => this.schedule(),
            // Bought or used orbs change what the step button can do
            items_updated: () => this.schedule(),
            character_switching: () => this.clear(),
        };
        for (const [event, handler] of Object.entries(this._handlers)) dataManager.on(event, handler);
        this.unregisterObserver = domObserver.onClass('TalismanRerollAdvisor', MODAL_CLASS, (node) => this.watch(node));
        this.initialized = true;

        const open = document.querySelector(`[class*="${MODAL_CLASS}"]`);
        if (open) this.watch(open);
    }

    watch(modal) {
        if (!this.initialized || !modal) return;
        if (this.watchedModal === modal) {
            this.schedule();
            return;
        }
        this.unwatch();
        this.watchedModal = modal;
        this.modalObserver = new MutationObserver((mutations) => {
            // Changes inside our own panel are not a reason to draw again
            if (mutations.every((m) => this.panel && this.panel.contains(m.target))) return;
            this.schedule();
        });
        this.modalObserver.observe(modal, { childList: true, subtree: true, characterData: true });
        this.schedule();
    }

    /**
     * A closed window: stop watching it and stop the solve it asked for (solved results stay cached).
     * @returns {boolean} true when the watched window has left the document
     */
    dropClosedWindow() {
        if (!this.watchedModal || this.watchedModal.isConnected) return false;
        this.unwatch();
        this.cancelSolve();
        this.cancelPress();
        clearMarks();
        this.stepContext = null;
        this.panel = null;
        this.panelTalismanKey = null;
        return true;
    }

    /** Forget a press in flight; nothing more is ever sent for it */
    cancelPress() {
        if (this.pressing?.timer) clearTimeout(this.pressing.timer);
        this.pressing = null;
    }

    cancelSolve() {
        if (this.sliceTimer) {
            clearTimeout(this.sliceTimer);
            this.sliceTimer = null;
        }
        this.running = null;
    }

    unwatch() {
        if (this.modalObserver) {
            this.modalObserver.disconnect();
            this.modalObserver = null;
        }
        this.watchedModal = null;
    }

    schedule() {
        if (!this.initialized) return;
        if (this.dropClosedWindow()) return;
        if (this.renderTimer) clearTimeout(this.renderTimer);
        const characterId = dataManager.getCurrentCharacterId?.();
        this.renderTimer = setTimeout(() => {
            this.renderTimer = null;
            if (dataManager.getCurrentCharacterId?.() !== characterId) return;
            this.render();
        }, RENDER_DEBOUNCE_MS);
    }

    /**
     * The talisman in the open window: the window's own prop, so the advice always matches what the window shows
     * (a pending roll included), even if a talismans_updated message were missed.
     */
    currentTalisman(modal) {
        return talismanFromModal(modal);
    }

    targetKey(talisman) {
        return `${dataManager.getCurrentCharacterId?.() ?? ''}:${talisman.id}`;
    }

    /**
     * Aim the advisor at a target for one of the character's talismans, from outside the window (the Combat Sim's
     * "Aim for this"). The target shows when that talisman's window is next open, or at once if it is open now.
     * @param {number|string} talismanId
     * @param {Array<{hrid: string, minGrade: number}>} targets
     * @returns {boolean} false when the advisor is not running (off, or not the test server), or the talisman is not
     *   one of the current character's
     */
    aimAt(talismanId, targets) {
        if (!this.initialized || talismanId === undefined || talismanId === null) return false;
        // Only one of this character's own talismans: a target for anyone else's is never kept
        const owned = dataManager.getCharacterTalismans?.() || [];
        if (!owned.some((t) => String(t?.id) === String(talismanId))) return false;
        const talisman = { id: talismanId };
        // A panel already drawn for this talisman is built again, so its rows show the new target
        if (this.panelTalismanKey === this.targetKey(talisman)) {
            this.panel?.remove();
            this.panel = null;
            this.panelTalismanKey = null;
        }
        this.setTargets(
            talisman,
            (Array.isArray(targets) ? targets : []).map((t) => ({
                hrid: t?.hrid,
                minGrade: Math.floor(t?.minGrade) || 1,
            }))
        );
        return true;
    }

    getTargets(talisman) {
        return this.targets.get(this.targetKey(talisman)) || [];
    }

    setTargets(talisman, targets) {
        this.targets.set(this.targetKey(talisman), targets.filter((t) => t.hrid).slice(0, MAX_WANTED));
        // A new target: a press in flight belongs to the old one
        this.cancelPress();
        this.stepStatus = '';
        this.schedule();
    }

    render() {
        if (!this.initialized) return;
        const modal = this.watchedModal;
        if (!modal || this.dropClosedWindow()) {
            this.unwatch();
            return;
        }
        try {
            const component = findWindowComponent(modal);
            const talisman = component.talisman;
            const initData = dataManager.getInitClientData?.();
            if (!talisman || !initData?.talismanInfo) {
                this.panel?.remove();
                clearMarks();
                return;
            }
            this.ensurePanel(modal, talisman, initData);
            this.update(talisman, initData, { modal, instance: component.instance });
        } catch (error) {
            console.error('[TalismanRerollAdvisor] Drawing the advice failed:', error);
        }
    }

    ensurePanel(modal, talisman, initData) {
        const key = this.targetKey(talisman);
        if (this.panel && this.panel.isConnected && modal.contains(this.panel) && this.panelTalismanKey === key) return;
        if (this.panelTalismanKey !== key) {
            // Another talisman: a press in flight belongs to the old one
            this.cancelPress();
            this.stepStatus = '';
        }
        this.panel?.remove();
        const panel = document.createElement('div');
        panel.className = PANEL_CLASS;
        panel.style.cssText =
            'margin:8px 0;padding:8px;border:1px solid rgba(255,255,255,0.2);border-radius:6px;font-size:13px';
        const title = document.createElement('div');
        title.textContent = 'Reroll advisor (Toolasha, test server)';
        title.style.fontWeight = 'bold';
        panel.appendChild(title);

        const typeOptions = Object.values(initData.talismanModifierDetailMap || {})
            .filter((d) => d.talismanTypeHrid === talisman.talismanTypeHrid)
            .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
        const maxGrade = Number(initData.talismanInfo.maxGrade) || 6;
        const rows = [];
        const readRows = () =>
            rows.map(([typeSelect, gradeSelect]) => ({ hrid: typeSelect.value, minGrade: Number(gradeSelect.value) }));
        const fillRows = (targets) => {
            rows.forEach(([typeSelect, gradeSelect], i) => {
                typeSelect.value = targets[i]?.hrid || '';
                gradeSelect.value = String(targets[i]?.minGrade || 1);
            });
        };
        for (let i = 0; i < MAX_WANTED; i++) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:6px;margin-top:4px';
            const typeSelect = document.createElement('select');
            typeSelect.className = `${PANEL_CLASS}-type`;
            typeSelect.style.flex = '1';
            typeSelect.appendChild(option('(none)', ''));
            for (const detail of typeOptions) typeSelect.appendChild(option(detail.name || detail.hrid, detail.hrid));
            const gradeSelect = document.createElement('select');
            gradeSelect.className = `${PANEL_CLASS}-grade`;
            for (let g = 1; g <= maxGrade; g++) gradeSelect.appendChild(option(`G${g}+`, String(g)));
            const onChange = () => this.setTargets(talisman, readRows());
            typeSelect.addEventListener('change', onChange);
            gradeSelect.addEventListener('change', onChange);
            row.append(typeSelect, gradeSelect);
            panel.appendChild(row);
            rows.push([typeSelect, gradeSelect]);
        }

        const buttons = document.createElement('div');
        buttons.style.cssText = 'display:flex;gap:6px;margin-top:6px';
        const useCurrent = document.createElement('button');
        useCurrent.type = 'button';
        useCurrent.className = `${PANEL_CLASS}-use-current`;
        useCurrent.textContent = 'Use current lines';
        useCurrent.addEventListener('click', () => {
            const latest = this.currentTalisman(modal) || talisman;
            const targets = (latest.modifiers || [])
                .slice(0, MAX_WANTED)
                .map((mod) => ({ hrid: mod.hrid, minGrade: mod.grade }));
            fillRows(targets);
            this.setTargets(talisman, targets);
        });
        const clearButton = document.createElement('button');
        clearButton.type = 'button';
        clearButton.className = `${PANEL_CLASS}-clear`;
        clearButton.textContent = 'Clear';
        clearButton.addEventListener('click', () => {
            fillRows([]);
            this.setTargets(talisman, []);
        });
        buttons.append(useCurrent, clearButton);
        panel.appendChild(buttons);

        const move = document.createElement('div');
        move.className = `${PANEL_CLASS}-move`;
        move.style.cssText = 'margin-top:6px;font-weight:bold';
        const detail = document.createElement('div');
        detail.className = `${PANEL_CLASS}-detail`;
        detail.style.cssText = 'opacity:0.85;white-space:pre-line';
        panel.append(move, detail);

        const step = document.createElement('div');
        step.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:6px';
        const doButton = document.createElement('button');
        doButton.type = 'button';
        doButton.className = `${PANEL_CLASS}-do`;
        doButton.textContent = 'Do next step';
        doButton.style.display = 'none';
        doButton.addEventListener('click', () => this.doNextStep());
        const status = document.createElement('span');
        status.className = `${PANEL_CLASS}-status`;
        status.style.opacity = '0.85';
        step.append(doButton, status);
        panel.appendChild(step);

        const help = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'How this works';
        help.appendChild(summary);
        for (const line of ADVISOR_HELP) {
            const p = document.createElement('p');
            p.style.margin = '4px 0';
            p.textContent = line;
            help.appendChild(p);
        }
        panel.appendChild(help);

        fillRows(this.getTargets(talisman));
        const footer = modal.querySelector(FOOTER_SELECTOR);
        if (footer && footer.parentNode) footer.parentNode.insertBefore(panel, footer);
        else modal.appendChild(panel);
        this.panel = panel;
        this.panelTalismanKey = key;
    }

    /** Work out (or look up) the advice and write it, touching the DOM only when the text changes */
    update(talisman, initData, window = {}) {
        const targets = this.getTargets(talisman);
        const info = initData.talismanInfo;
        const { weights: exactWeights, prices, scale } = orbWeights(info, initData.itemDetailMap);
        // Two significant figures: a market tick does not start a new solve
        const weights = roundWeights(exactWeights);
        const build = buildProblem({
            talismanTypeHrid: talisman.talismanTypeHrid,
            lineCount: (talisman.modifiers || []).length,
            targets,
            info,
            modifierDetailMap: initData.talismanModifierDetailMap,
            weights,
        });
        const result = {
            build,
            advice: null,
            scale,
            prices,
            mutationUsed: true,
            gradeClamped: build.status === 'ok' ? build.problem.gradeClamped : false,
            clampGrade: build.status === 'ok' ? build.problem.G : 0,
        };

        // Hard rules first, on the raw lines, whatever the solver says
        const pending = Array.isArray(talisman.pendingModifiers) && talisman.pendingModifiers.length > 0;
        if (build.status === 'ok' && pending && meetsTarget(talisman.pendingModifiers, targets)) {
            result.advice = { status: 'accept', met: true, counts: {} };
        } else if (build.status === 'ok' && meetsTarget(talisman.modifiers, targets)) {
            result.advice = pending ? { status: 'discard', counts: {} } : { status: 'met', counts: {} };
        } else if (build.status === 'ok') {
            const shape = JSON.stringify([talisman.talismanTypeHrid, build.problem.n, targets]);
            const key = JSON.stringify([shape, weights]);
            let solution = this.solutions.get(key);
            if (!solution) {
                this.startSolve(key, shape, build.problem);
                // Until the new prices are solved, the last solution for this target stands, marked as updating
                solution = this.latest.get(shape);
                result.updating = !!solution;
            }
            if (solution) {
                result.advice = advise(solution, talisman, targets);
                result.mutationUsed = solution.mutationUsed;
            }
        }

        const names = {
            item: (hrid) => initData.itemDetailMap?.[hrid]?.name || hrid,
            modifier: (hrid) => initData.talismanModifierDetailMap?.[hrid]?.name || hrid,
            lineCount: (talisman.modifiers || []).length,
        };
        const text = describeAdvice(result, names);
        const moveEl = this.panel?.querySelector(`.${PANEL_CLASS}-move`);
        const detailEl = this.panel?.querySelector(`.${PANEL_CLASS}-detail`);
        const detailText = text.detail.join('\n');
        if (moveEl && moveEl.textContent !== text.move) moveEl.textContent = text.move;
        if (detailEl && detailEl.textContent !== detailText) detailEl.textContent = detailText;
        this.updateStep(talisman, result.advice, names, window);
    }

    /**
     * The highlight and the "Do next step" button for the advice just drawn. A press in flight ends here when the
     * talisman it was made on has changed.
     */
    updateStep(talisman, advice, names, { modal = null, instance = null } = {}) {
        const key = this.targetKey(talisman);
        const snapshot = snapshotOf(talisman);
        const changed = this.lastSeen?.key === key && this.lastSeen.snapshot !== snapshot;
        this.lastSeen = { key, snapshot };
        if (this.pressing && this.pressing.key === key && this.pressing.snapshot !== snapshot) {
            this.stepStatus = this.pressing.label ? `Done — ${this.pressing.label}.` : '';
            this.cancelPress();
        } else if (changed) {
            // The talisman moved on (a manual press, another tab): an old step message no longer applies
            this.stepStatus = '';
        }
        const actionable =
            !!advice && (advice.status === 'move' || advice.status === 'accept' || advice.status === 'discard');
        this.stepContext = actionable ? { key, snapshot, advice, names, modal, instance } : null;

        // The highlight, redrawn from scratch every time
        if (actionable && modal && instance)
            markElements(advisedElements(advice, scanControls(modal, instance), instance));
        else clearMarks();
        this.refreshStepUi();
    }

    /** Button state and status line, from the current context and press */
    refreshStepUi() {
        const button = this.panel?.querySelector(`.${PANEL_CLASS}-do`);
        const status = this.panel?.querySelector(`.${PANEL_CLASS}-status`);
        if (!button || !status) return;
        const context = this.stepContext;
        let text = this.stepStatus;
        let disabled = !!this.pressing;
        if (!context) {
            button.style.display = 'none';
        } else {
            button.style.display = '';
            const item = itemFor(context.advice);
            if (!this.pressing && item && inventoryCount(context.instance, item) === 0) {
                disabled = true;
                text = `No ${context.names.item(item)} in inventory`;
            }
            if (this.pressing) text = this.pressing.confirming ? CONFIRM_TEXT : 'Waiting for the game…';
        }
        if (button.disabled !== disabled) button.disabled = disabled;
        if (status.textContent !== text) status.textContent = text;
    }

    /** One press: exactly one game action, never repeated, never continued on its own */
    doNextStep() {
        if (this.pressing || !this.stepContext || !this.initialized) return;
        const context = this.stepContext;
        // Taken before anything is sent, so a second click in the same instant finds a press in flight
        const pressing = { key: context.key, snapshot: context.snapshot, label: '', timer: null };
        this.pressing = pressing;
        this.refreshStepUi();
        // Out of our own click's dispatch: the game's handlers (and any dialog they open) never see our click
        pressing.timer = setTimeout(() => this.settle(pressing, context, () => performStep(context)), 0);
    }

    /** Act on what a press attempt returned: wait for Reroll to enable, wait for the game, or report */
    settle(pressing, context, attempt, tries = 0) {
        if (this.pressing !== pressing) return; // dropped: target, talisman or window changed
        let outcome;
        try {
            outcome = attempt();
        } catch (error) {
            console.error('[TalismanRerollAdvisor] Doing the next step failed:', error);
            outcome = { status: 'notFound', message: 'Could not do this step; press the marked game button yourself.' };
        }
        if (outcome.status === 'awaitReroll') {
            const wait = pressing.rerollWait || { before: outcome.before ?? null, wasSelected: !!outcome.wasSelected };
            pressing.rerollWait = wait;
            if (tries >= REROLL_WAIT_TRIES) {
                // Enabled but the handler never changed: the game may keep one handler; press it anyway
                outcome = pressReroll(context);
                if (outcome.status !== 'sent') {
                    this.pressing = null;
                    this.stepStatus = outcome.message || '';
                    this.refreshStepUi();
                    return;
                }
            } else {
                pressing.timer = setTimeout(
                    () => this.settle(pressing, context, () => this.rerollAttempt(context, wait), tries + 1),
                    REROLL_WAIT_MS
                );
                this.refreshStepUi();
                return;
            }
        }
        if (outcome.status === 'sent') {
            pressing.label = outcome.label;
            pressing.sentAt = Date.now();
            this.stepStatus = '';
            this.watchPress(pressing, context);
        } else {
            this.pressing = null;
            this.stepStatus = outcome.message || '';
        }
        this.refreshStepUi();
    }

    /** A later look at the Reroll button: not yet re-rendered with the chosen orb waits another frame */
    rerollAttempt(context, wait) {
        const state = rerollReady(context, wait);
        if (state === 'waiting') return { status: 'awaitReroll' };
        // 'missing' and 'ready' alike: pressReroll re-finds the live button and says what it found
        return pressReroll(context);
    }

    /**
     * Wait for the game's answer. While the game's own confirm dialog is open there is no timeout; once it closes
     * (or if none opened) a press with no change to the talisman is reported as refused.
     */
    watchPress(pressing, { modal, instance }) {
        let quietSince = Date.now();
        // The window's own controls, once: a dialog holding one of them is the window's, not a game confirm
        const controls = modal && instance ? scanControls(modal, instance) : {};
        const own = [controls.reroll, controls.useNew, controls.keep, controls.unlock, controls.picker];
        const tick = () => {
            if (this.pressing !== pressing) return;
            const confirming = confirmDialogOpen(modal, own);
            if (confirming) {
                quietSince = Date.now();
                pressing.confirming = true;
            } else if (pressing.confirming) {
                pressing.confirming = false;
                quietSince = Date.now();
            }
            const limit = pressing.sawConfirm || confirming ? CONFIRM_GRACE_MS : PRESS_TIMEOUT_MS;
            if (confirming) pressing.sawConfirm = true;
            if (!confirming && Date.now() - quietSince >= limit) {
                this.pressing = null;
                this.stepStatus = REFUSED_TEXT;
                this.refreshStepUi();
                return;
            }
            this.refreshStepUi();
            pressing.timer = setTimeout(tick, PRESS_TICK_MS);
        };
        pressing.timer = setTimeout(tick, PRESS_TICK_MS);
    }

    /** Solve in slices so the window stays responsive; a newer request replaces an older one */
    startSolve(key, shape, problem) {
        if (this.running?.key === key) return;
        if (this.sliceTimer) clearTimeout(this.sliceTimer);
        const runner = solveSteps(problem);
        const job = { key, runner };
        this.running = job;
        const slice = () => {
            this.sliceTimer = null;
            if (this.running !== job || !this.initialized) return;
            const started = Date.now();
            try {
                let step = runner.next();
                while (!step.done && Date.now() - started < SLICE_MS) step = runner.next();
                if (step.done) {
                    this.running = null;
                    if (this.solutions.size >= CACHE_LIMIT) this.solutions.delete(this.solutions.keys().next().value);
                    this.solutions.set(key, step.value);
                    this.latest.delete(shape);
                    if (this.latest.size >= CACHE_LIMIT) this.latest.delete(this.latest.keys().next().value);
                    this.latest.set(shape, step.value);
                    this.schedule();
                    return;
                }
            } catch (error) {
                console.error('[TalismanRerollAdvisor] Solving failed:', error);
                this.running = null;
                return;
            }
            this.sliceTimer = setTimeout(slice, 0);
        };
        this.sliceTimer = setTimeout(slice, 0);
    }

    /** Take the panel out and forget work in progress (targets are kept for the session) */
    clear() {
        if (this.renderTimer) {
            clearTimeout(this.renderTimer);
            this.renderTimer = null;
        }
        if (this.sliceTimer) {
            clearTimeout(this.sliceTimer);
            this.sliceTimer = null;
        }
        this.running = null;
        this.cancelPress();
        this.stepContext = null;
        this.lastSeen = null;
        this.stepStatus = '';
        clearMarks();
        for (const el of document.querySelectorAll(`.${PANEL_CLASS}`)) el.remove();
        this.panel = null;
        this.panelTalismanKey = null;
    }

    disable() {
        try {
            for (const [event, handler] of Object.entries(this._handlers)) dataManager.off(event, handler);
            this._handlers = {};
            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }
            this.unwatch();
            this.clear();
        } catch (error) {
            console.error('[TalismanRerollAdvisor] Disable failed part-way:', error);
        } finally {
            this.solutions = new Map();
            this.latest = new Map();
            this.targets = new Map();
            this.initialized = false;
        }
    }
}

const talismanRerollAdvisor = new TalismanRerollAdvisor();

/**
 * Hand the reroll advisor a target for a talisman (see {@link TalismanRerollAdvisor#aimAt}). Another bundle reaches
 * the same singleton through `Toolasha.UI.talismanRerollAdvisor.aimAt`.
 * @param {number|string} talismanId
 * @param {Array<{hrid: string, minGrade: number}>} targets
 * @returns {boolean}
 */
export function setRerollTarget(talismanId, targets) {
    return talismanRerollAdvisor.aimAt(talismanId, targets);
}

export default talismanRerollAdvisor;
