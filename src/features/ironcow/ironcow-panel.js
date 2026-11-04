/**
 * Iron Bell Farming panel
 *
 * The plan an iron cow follows to farm gold for cowbells, and what that plan is
 * currently worth per hour, per day and per week of bells.
 *
 * The panel does no arithmetic of its own. The plan derives itself in
 * `ironcow-plan.js` from the character's own state; the loop is costed in
 * `starfruit-loop.js` out of the calculators the rest of the script already
 * uses. Anything a figure here disagrees with the action panel about is one
 * calculator being wrong, not a second opinion grown inside a panel.
 *
 * ## Refresh is a button
 *
 * Costing the loop runs the gathering calculator and the alchemy calculator
 * twice each, against game data and market prices that do not move minute to
 * minute. So it is computed on demand, the last result is kept so the panel has
 * something to show the moment it opens, and the time it was priced at is
 * printed beside the figures.
 *
 * ## It is shown to characters it is not for
 *
 * Gated by game mode would mean an alt on a standard account cannot read the
 * plan they are considering, and a panel that refuses to open looks broken. So
 * a non-iron-cow character gets the panel with a line at the top saying the
 * plan is written for an iron cow — and, more usefully, that the loop's gold is
 * costed on the assumption that nothing is sold, which is not the best a
 * standard character could do with the same fruit.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { formatKMB, formatPercentage, formatWithSeparator } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable, panelHeightCap } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry, saveOpenState, reopenIfLeftOpen } from '../../utils/panel-geometry.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { HOURS_PER_DAY } from '../../utils/profit-constants.js';
import { fitValueToBox } from '../../utils/wrap-long-value.js';
import { actionTimeDisplay } from '../../utils/bundle-bridge.js';
import { deriveStages, isIronCowMode, readCharacterState } from './ironcow-plan.js';
import {
    ASSUMED_OFFLINE_HOURS,
    affordableBatch,
    applyHoldings,
    balanceBatch,
    calculateStarfruitLoop,
    cowbellPricing,
    hoursForBells,
    fillBatch,
    loopWarnings,
    maxBatch,
    offlineWindow,
} from './starfruit-loop.js';
import { buildQueueSteps, startQueueWalk } from './ironcow-queue-walk.js';
import { batchStages, bellBudget, coinReserve, walkQueueCoins, withBatchStages } from './coin-reserve.js';
import {
    ESTIMATE_NOTE,
    UNQUOTED_NOTE,
    UNREADABLE_NOTE,
    keptNote,
    queueEndText,
    queuedLegCounts,
    reduceBatchByQueue,
    stoppedNote,
    summarizeCycle,
} from './ironbell-cycle.js';
import { onIronBellLive } from './ironbell-live.js';
import ironBellStrip from './ironcow-action-strip.js';
import {
    loadKeepBatchCash,
    setKeepBatchCash,
    loadOverrides,
    loadPlanCollapsed,
    loadSnapshot,
    saveSnapshot,
    setOverride,
    setPlanCollapsed,
} from './ironcow-store.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';
import ironCowRuntime from './ironcow-runtime.js';
import { GAME_COLORS, GAME_FRAME, styleGameButton } from '../../utils/game-look.js';
// Side effect only: registers the "Iron Bell next step" overlay tile. Imported
// here — rather than where the rest of the overlay's rows are wired in, a
// bundle this feature does not otherwise touch — so the tile exists wherever
// this panel does. The tile reads `ironcow-runtime.js`, not this module, so
// this import does not become a cycle.
import './ironcow-overlay-row.js';

const PANEL_ID = 'toolasha-ironcow-farm-panel';
// Display name changed to "Iron Bell Farming" — this key is kept as-is
// (ironCowFarmPanel) so it keeps reading the geometry an existing user already
// saved under it. Renaming it would orphan that saved position and size.
const GEOMETRY_KEY = 'ironCowFarmPanel';
const DEFAULT_PANEL = { width: 520, height: 620 };
/** How long a burst of coin or queue updates settles before the bells-you-can-buy lines redraw */
const LIVE_REDRAW_MS = 300;

/** The height a compact game button has, kept as its minimum so a long label can grow it */
const COMPACT_BUTTON_HEIGHT = 'calc(var(--button-height-normal, 1.875rem) - 0.375rem)';

const COLORS = {
    border: GAME_COLORS.border,
    hairline: 'rgba(255, 255, 255, 0.10)',
    card: 'rgba(255, 255, 255, 0.04)',
    text: GAME_COLORS.text,
    textDim: GAME_COLORS.textDim,
    good: '#7fd6a3',
    bad: '#f0776c',
    warn: '#ffb020',
};

/**
 * @param {string} text - Contents
 * @param {Object} [style] - Extra styles
 * @returns {HTMLElement} A span
 */
function span(text, style = {}) {
    const element = document.createElement('span');
    element.textContent = text;
    Object.assign(element.style, style);
    return element;
}

/**
 * A small control that looks like the rest of the panel.
 * @param {string} label - Button text
 * @param {Function} onClick - Click handler
 * @param {Object} [style] - Extra styles
 * @returns {HTMLElement} A button
 */
function button(label, onClick, style = {}) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    // A caller asking for no fill is asking for a bare glyph, which only shows a fill on hover
    styleGameButton(element, style.background === 'none' ? 'icon' : 'quiet', true);
    // A long label (the plan's summary) wraps and the button grows, rather than spilling out of a fixed height
    Object.assign(element.style, { height: 'auto', minHeight: COMPACT_BUTTON_HEIGHT }, style);
    element.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick(event);
    });
    return element;
}

/**
 * A small number box that looks like the rest of the panel.
 * @param {number|string} value - Starting value
 * @param {Function} onInput - Called with the raw string on every keystroke
 * @returns {HTMLInputElement} The box
 */
function numberBox(value, onInput) {
    const element = document.createElement('input');
    element.type = 'number';
    element.min = '0';
    element.value = String(value);
    Object.assign(element.style, {
        background: 'rgba(255, 255, 255, 0.06)',
        border: `1px solid ${COLORS.border}`,
        borderRadius: '3px',
        color: COLORS.text,
        fontSize: '11px',
        padding: '1px 4px',
        width: '84px',
    });
    element.addEventListener('input', () => onInput(element.value));
    return element;
}

/** The durations worth one press, in hours */
const QUEUE_PRESETS = [
    { label: '1 day', hours: 24 },
    { label: '1 week', hours: 168 },
    { label: '2 weeks', hours: 336 },
    { label: '30 days', hours: 720 },
];

/**
 * Not a game limit — the game states none for a queue's length. A typo guard well past any real plan (ten
 * years): the walk splits a leg into repeats of 100,000 actions, so an absurd finite duration like 1e12 days
 * would build billions of steps and hang the tab.
 */
const MAX_QUEUE_HOURS = 24 * 365 * 10;

/**
 * A titled block.
 * @param {string} title - Heading
 * @returns {HTMLElement} The card, to append rows to
 */
function card(title) {
    const element = document.createElement('div');
    Object.assign(element.style, {
        background: COLORS.card,
        border: `1px solid ${COLORS.hairline}`,
        borderRadius: '6px',
        padding: '7px 9px',
        marginBottom: '7px',
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
    });
    if (title) {
        const heading = span(title, { color: COLORS.text, fontWeight: 'bold', marginBottom: '2px' });
        element.appendChild(heading);
    }
    return element;
}

/**
 * A labelled figure on its own line.
 * @param {string} label - What it is
 * @param {string} value - What it says
 * @param {string} [color] - Ink for the value
 * @param {string} [title] - Tooltip
 * @returns {HTMLElement} The row
 */
function line(label, value, color = COLORS.text, title = '') {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '8px', alignItems: 'baseline' });
    const name = span(label, { color: COLORS.textDim, flex: '1 0 auto' });
    const figure = fitValueToBox(span(value, { color }), value);
    if (title) row.title = title;
    row.append(name, figure);
    return row;
}

/**
 * Coins, said the way this panel says them.
 * @param {number|null|undefined} value - Coins
 * @returns {string} e.g. "1.2M", or "—"
 */
function coins(value) {
    if (!Number.isFinite(value)) return '—';
    return formatKMB(Math.round(value));
}

/**
 * One decimal, and no trailing zero on a whole number.
 * @param {number} value - Hours, usually
 * @returns {string} e.g. "16", "7.8"
 */
function round1(value) {
    if (!Number.isFinite(value)) return '0';
    return String(Math.round(value * 10) / 10);
}

/**
 * Bells, which are small enough numbers to want in full.
 * @param {number|null|undefined} value - Bells
 * @returns {string} e.g. "1,204", or "—"
 */
function bells(value) {
    if (!Number.isFinite(value)) return '—';
    return formatWithSeparator(Math.round(value));
}

/**
 * What a folded plan says instead of its stages.
 *
 * Stage 6 is the loop itself and is never "done" — it is the thing the other
 * five stages unlock — so it is counted as ready or waiting rather than as a
 * sixth box to tick.
 *
 * @param {Array<Object>} stages - From `deriveStages`
 * @returns {string} e.g. "4 of 5 stages done · the loop is waiting"
 */
function planSummary(stages) {
    const gates = stages.filter((stage) => stage.id !== 'loop');
    if (!gates.length) return '';
    const done = gates.filter((stage) => stage.done).length;
    const loop = stages.find((stage) => stage.id === 'loop');
    const tail = loop ? ` · the loop is ${loop.ready ? 'ready' : 'waiting'}` : '';
    return `${done} of ${gates.length} stages done${tail}`;
}

class IronCowFarmPanel {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.statusEl = null;
        this._loop = null;
        this.pricedAt = null;
        this._overrides = {};
        // Today's appearance until the stored answer lands: the section opens,
        // and a character who shut it sees it shut a moment later rather than
        // everyone seeing it fold up on upgrade.
        this.planCollapsed = false;
        // The duration the queue helper is sizing for. The plan's assumed
        // window until `load()` asks for the real one — read there rather than
        // here because this runs at import, before any game data exists.
        this.batchHours = ASSUMED_OFFLINE_HOURS;
        /** Which unit the duration box is being typed in: 'h' or 'd' */
        this.batchUnit = 'h';
        /** True while the helper is sized by the Max button (all held fruit) rather than by a duration */
        this.queueMax = false;
        /**
         * What drives the numbers when Max is off: 'hours' keeps the queue busy for `batchHours` (held stock
         * first, forage for the rest); 'bells' sizes the least work that earns the bells typed, which can
         * finish sooner than the hours it was converted from
         */
        this.batchBasis = 'hours';
        /** Fruit Max may use, when "Largest I can run" cut it to what the gold on hand pays for; null for all */
        this.maxCap = null;
        /** Whether Bells you can buy now also keeps cash back for the helper's current batch */
        this.keepBatchCash = false;
        this.queueRefs = null;
        this.busy = false;
        this.loaded = null;
        // Bumped by disable() (a character switch or the feature going off): every pending load, costing
        // or stage tick belongs to the lifetime it started in and drops its result once that has ended,
        // even if the same character is current again (A -> B -> A)
        this._lifeGen = 0;
        // Bumped by each load() start, so overlapping loads are latest-wins
        this._loadGen = 0;
        // Per-field counts of the player's own edits; a load that read a field before an edit must not
        // publish its older value over it
        this._edits = { overrides: 0, planCollapsed: 0, batch: 0, keepCash: 0 };
        // The overlay tile opens the same panel this toggles, and reads the
        // loop and the overrides through the same runtime object this keeps
        // current below.
        ironCowRuntime.toggle = () => this.toggle();
    }

    /** @returns {Object|null} The last costed loop */
    get loop() {
        return this._loop;
    }

    /** @param {Object|null} value - The last costed loop */
    set loop(value) {
        this._loop = value;
        ironCowRuntime.loop = value;
    }

    /** @returns {Object} This character's manual stage ticks */
    get overrides() {
        return this._overrides;
    }

    /** @param {Object} value - This character's manual stage ticks */
    set overrides(value) {
        this._overrides = value;
        ironCowRuntime.overrides = value;
    }

    /**
     * Open the panel, or raise it if it is already up.
     * @param {Object} [options] - `remember: false` when reopening at start-up
     */
    show({ remember = true } = {}) {
        if (remember) saveOpenState(GEOMETRY_KEY, true);
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._create();
    }

    /**
     * Put the panel away.
     * @param {Object} [options] - `remember: false` to close without recording it
     */
    hide({ remember = true } = {}) {
        if (remember) saveOpenState(GEOMETRY_KEY, false);
        this._remove();
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    /** Feature-registry entry point: read the state back and reopen if left open */
    async initialize() {
        // The action-bar strip lives and dies with this feature: on here, off in disable()
        ironBellStrip.start();
        await this.load();
        reopenIfLeftOpen(GEOMETRY_KEY, () => this.show({ remember: false }));

        registerCommand({
            name: 'Iron Bell Farming',
            hint: 'The cowbell plan, and what it earns',
            run: () => this.toggle(),
        });
    }

    /** Feature-registry teardown */
    disable() {
        unregisterCommand('Iron Bell Farming');
        ironBellStrip.stop();
        // End this lifetime: whatever read or costing is still in flight must not publish into the
        // next character's state, and the next open must read afresh rather than reuse a stale promise
        this._lifeGen++;
        this._loadGen++;
        this.loaded = null;
        this.queueMax = false;
        this.batchBasis = 'hours';
        this.maxCap = null;
        this._remove();
    }

    /** @returns {{charId: *, life: number}} Who and which lifetime an async operation starts for */
    _owner() {
        return { charId: dataManager.getCurrentCharacterId(), life: this._lifeGen };
    }

    /**
     * @param {{charId: *, life: number}} owner - From `_owner()`
     * @returns {boolean} Whether that operation is still for the current character and lifetime
     */
    _owns(owner) {
        return owner.life === this._lifeGen && owner.charId === dataManager.getCurrentCharacterId();
    }

    /**
     * Read the stage ticks and the last costed loop.
     * @returns {Promise<void>}
     */
    async load() {
        const owner = this._owner();
        const gen = ++this._loadGen;
        // Every read lands in a local and is checked before anything is published, so a load that was
        // superseded (a newer load, a disable, a character switch) never touches this.* or the runtime
        const current = () => gen === this._loadGen && this._owns(owner);
        const stamps = { ...this._edits };
        const unedited = (field) => stamps[field] === this._edits[field];
        const overrides = await loadOverrides();
        if (!current()) return;
        // Unconditional: disable()/_remove() only tears down the DOM, not
        // this.loop/this.pricedAt, so on a character switch a character with
        // no snapshot of their own must still overwrite whatever the previous
        // character's numbers were — otherwise this character's panel (and
        // the overlay tile, which reads ironCowRuntime.loop) would keep
        // showing the departing character's costed gold/hour, bells/week,
        // and "costed <time>" as if they were this character's.
        const planCollapsed = await loadPlanCollapsed();
        if (!current()) return;
        const keepBatchCash = await loadKeepBatchCash();
        if (!current()) return;
        // Per character, like everything else here: the window a batch is sized
        // against is this character's, and a duration typed for the last one is
        // not an answer for this one.
        const window = offlineWindow();
        let snapshot = await loadSnapshot();
        if (!current()) return;
        // A snapshot costed when a loose cowbell price was still taken: its bell price and every
        // bell figure rest on a price nobody can buy at, so it waits for a fresh costing instead
        // The same goes for any snapshot from before bag prices were read off the book (no `quoted`):
        // an Iron Cow valuation setting could have stood in for the bag's price
        if (snapshot?.bellPricing && !('quoted' in snapshot.bellPricing)) snapshot = null;
        if (unedited('overrides')) this.overrides = overrides;
        if (unedited('planCollapsed')) this.planCollapsed = planCollapsed;
        // Written here unconditionally for a character with nothing stored, so the last one's switch
        // never carries over
        if (unedited('keepCash')) this.keepBatchCash = keepBatchCash;
        if (unedited('batch')) {
            if (window?.hours > 0) this.batchHours = window.hours;
            this.batchUnit = 'h';
            this.queueMax = false;
            this.batchBasis = 'hours';
            this.maxCap = null;
        }
        this.loop = snapshot;
        this.pricedAt = snapshot?.computedAt || null;
        this._render();
    }

    /**
     * Re-cost the loop against the character and the market as they stand now.
     * @returns {Promise<void>}
     */
    async refresh() {
        if (this.busy) return;
        // _create() fires load() without awaiting it (a floating panel opens
        // instantly, then fills in). Wait for that read to land first so it
        // can never resolve after this and clobber the freshly-costed loop
        // back to whatever (or nothing) was last on disk.
        const owner = this._owner();
        if (this.loaded) await this.loaded;
        // The wait can span a character switch; the work below is for whoever asked
        if (!this._owns(owner)) return;
        // Captured before the slow costing below: `calculateStarfruitLoop()`
        // runs the gathering and alchemy calculators against whatever game
        // data is loaded, which can take long enough for the player to switch
        // characters while it is in flight. `this.loop`/`saveSnapshot` both
        // resolve the *current* character at the moment they run — `loop` via
        // the `ironCowRuntime` setter, `saveSnapshot` via `characterKey()`
        // inside `writeScoped` — so without this guard a switch landing
        // mid-costing applies the departing character's freshly-priced loop
        // to the arriving character, in memory and in storage, clobbering
        // whatever `load()` had just correctly set up for them.
        this.busy = true;
        this._status('Costing…');
        try {
            const loop = await calculateStarfruitLoop();
            if (!this._owns(owner)) {
                // The character this costing was for is gone; their panel
                // already loaded its own state, and this stale result must
                // not overwrite it.
                return;
            }
            if (loop) {
                this.loop = loop;
                this.pricedAt = loop.computedAt || Date.now();
                await saveSnapshot(loop);
            } else {
                this._status('Nothing to cost — game data has not loaded.');
            }
        } catch (error) {
            console.error('[IronCow] Costing the loop failed:', error);
            this._status('Costing failed — see the console.');
        } finally {
            this.busy = false;
            this._render();
        }
    }

    /**
     * Turn one stage's manual tick on or off and redraw.
     * @param {string} stageId - Which stage
     * @param {boolean} ticked - On or off
     * @returns {Promise<void>}
     */
    async toggleStage(stageId, ticked) {
        this._edits.overrides++;
        const owner = this._owner();
        const overrides = await setOverride(stageId, ticked);
        // The store already refuses the write for a switched character; the in-memory map and the
        // overlay's runtime copy must refuse it too
        if (!this._owns(owner)) return;
        this.overrides = overrides;
        this._render();
    }

    /**
     * Fold the plan section away, or open it, and remember which.
     * @returns {Promise<void>}
     */
    async togglePlan() {
        this._edits.planCollapsed++;
        this.planCollapsed = !this.planCollapsed;
        // Drawn before the write: the fold is the player's own click and must
        // land at once, whatever storage does next.
        this._render();
        await setPlanCollapsed(this.planCollapsed);
    }

    /**
     * Turn "keep cash for the next set" on or off, redraw, and remember which.
     * @param {boolean} on - The new state
     * @returns {Promise<void>}
     */
    async setKeepCash(on) {
        this._edits.keepCash++;
        this.keepBatchCash = on === true;
        // The player's own click lands at once, whatever storage does next
        this._onLiveChange();
        await setKeepBatchCash(this.keepBatchCash);
    }

    // -------------------------------------------------------------------------
    // Panel construction
    // -------------------------------------------------------------------------

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '130px',
            left: '110px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: `min(${DEFAULT_PANEL.width}px, 94vw)`,
            height: panelHeightCap(DEFAULT_PANEL.height, 0.82),
            ...GAME_FRAME,
            color: COLORS.text,
            fontSize: '12px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        const header = this._header();
        this.panel.appendChild(header);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px 10px 12px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.detachDrag = makeDraggable(this.panel, header, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: 360,
            minHeight: 220,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 360, height: 220 });

        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header,
            body: this.bodyEl,
            panelKey: GEOMETRY_KEY,
            beforeEl: header.lastElementChild,
            accent: COLORS.text,
        });

        this._render();
        if (!this.loaded) this.loaded = this.load();

        // Coins spent, rows queued and a new bag price change what the bells-you-can-buy count must
        // be; redraw just those lines, a beat after a burst of updates settles
        this._liveHandler = () => {
            clearTimeout(this._liveTimer);
            this._liveTimer = setTimeout(() => this._onLiveChange(), LIVE_REDRAW_MS);
        };
        // (the strip under the action bar redraws on the same single subscription)
        this._offLive = onIronBellLive(this._liveHandler);
    }

    /** Redraw the bells-you-can-buy lines against the coins and queue as they stand now */
    _onLiveChange() {
        if (!this.affordableEl?.isConnected) return;
        this.affordableEl.replaceChildren(...this._affordableLines(this._safeState()));
    }

    _remove() {
        this._offLive?.();
        this._offLive = null;
        this._liveHandler = null;
        clearTimeout(this._liveTimer);
        this._liveTimer = null;
        this.affordableEl = null;
        this.detachDrag?.();
        this.detachResize?.();
        this.detachDrag = null;
        this.detachResize = null;
        this.minimizeCtl?.destroy();
        this.minimizeCtl = null;
        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.bodyEl = null;
        this.statusEl = null;
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = span('Iron Bell Farming', { fontWeight: 'bold', color: COLORS.text });
        this.statusEl = span('', { color: COLORS.textDim, fontSize: '11px' });

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const refresh = button('Refresh', () => this.refresh());
        refresh.title = 'Re-cost the loop against your rates and the market data loaded now.';

        const close = button('✕', () => this.hide(), {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            fontSize: '13px',
            padding: '2px 4px',
        });

        header.append(title, this.statusEl, spacer, refresh, close);
        return header;
    }

    /**
     * @param {string} text - What the header's status line says
     */
    _status(text) {
        if (this.statusEl) this.statusEl.textContent = text;
    }

    // -------------------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------------------

    _render() {
        if (!this.bodyEl) return;
        this.bodyEl.replaceChildren();
        // Rebuilt below, or left null when the helper does not draw
        this.queueRefs = null;

        if (!this.busy) {
            this._status(this.pricedAt ? `costed ${new Date(this.pricedAt).toLocaleTimeString()}` : 'not costed yet');
        }

        const state = this._safeState();
        const stages = state ? deriveStages(state, this.overrides) : [];

        // Kept for `_walkQueue()`, which runs from a button handler outside of
        // `_render()` and needs the same character state the queue card just
        // priced its batch against — the holdings the walk credits must be the
        // ones the player was shown, not whatever the character looks like by
        // the time they click.
        this._queueState = state;

        const sections = [
            () => this._modeNote(state),
            () => this._planCard(stages),
            () => this._loopCard(),
            () => this._bellsCard(state),
            () => this._queueCard(state),
            () => this._checksCard(state),
        ];
        for (const build of sections) this._section(build);
    }

    /**
     * Reading the character can throw if the game data is half-loaded, and a
     * plan that cannot be read should not take the loop figures with it.
     * @returns {Object|null} The character state, or null
     */
    _safeState() {
        try {
            return readCharacterState();
        } catch (error) {
            console.error('[IronCow] Reading the character failed:', error);
            return null;
        }
    }

    /**
     * Draw one section, or say which one could not be drawn.
     *
     * Without this the panel is all-or-nothing: one section that throws takes
     * every section after it, and half a panel reads as a missing feature
     * rather than as a bug.
     *
     * @param {Function} build - Returns the section's element, or null to skip it
     */
    _section(build) {
        try {
            const element = build();
            if (element) this.bodyEl.appendChild(element);
        } catch (error) {
            console.error('[IronCow] A section could not be drawn:', error);
            this.bodyEl.appendChild(
                span(`This section could not be drawn: ${error.message}`, { display: 'block', color: COLORS.bad })
            );
        }
    }

    /**
     * The line that says who the plan is for, when it is not for this character.
     * @param {Object|null} state - Character state
     * @returns {HTMLElement|null} A note, or nothing when this is an iron cow
     */
    _modeNote(state) {
        if (!state) {
            return span('Game data has not loaded yet, so the plan cannot be checked against this character.', {
                display: 'block',
                color: COLORS.warn,
                marginBottom: '7px',
            });
        }
        if (isIronCowMode(state.gameMode)) return null;

        const holder = card('');
        holder.appendChild(
            span(
                `This character is ${state.gameMode || 'not an iron cow'}. The plan below is written for one, and ` +
                    'the loop is costed on the iron cow rule that nothing is ever sold — all its gold comes out of ' +
                    'coinify. A character with market access can do better with the same fruit.',
                { color: COLORS.warn }
            )
        );
        return holder;
    }

    /**
     * The numbered plan, each stage answered against the character.
     *
     * Foldable, because once the stages are done the checklist is six settled
     * lines across the whole top of the panel and the figures below it are what
     * the player came for. Folded, the bar carries the count so it is still
     * saying something rather than sitting there as a lid.
     *
     * @param {Array<Object>} stages - From `deriveStages`
     * @returns {HTMLElement} The card
     */
    _planCard(stages) {
        const holder = card('');
        holder.appendChild(this._planHeader(stages));

        if (this.planCollapsed) return holder;

        if (!stages.length) {
            holder.appendChild(span('No character state to check the plan against yet.', { color: COLORS.textDim }));
            return holder;
        }

        for (const stage of stages) {
            holder.appendChild(this._stageRow(stage));
        }
        return holder;
    }

    /**
     * The plan's own title bar, which is also the control that folds it.
     * @param {Array<Object>} stages - From `deriveStages`
     * @returns {HTMLElement} The bar
     */
    _planHeader(stages) {
        const summary = this.planCollapsed ? planSummary(stages) : '';
        const label = `${this.planCollapsed ? '▸' : '▾'} The plan${summary ? ` — ${summary}` : ''}`;

        const bar = button(label, () => this.togglePlan(), {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            fontWeight: 'bold',
            fontSize: '12px',
            padding: '0',
            marginBottom: '2px',
            textAlign: 'left',
        });
        bar.title = this.planCollapsed ? 'Show the stages' : 'Fold the stages away';
        return bar;
    }

    /**
     * One stage: its mark, its title, and what it looked at.
     * @param {Object} stage - From `deriveStages`
     * @returns {HTMLElement} The row
     */
    _stageRow(stage) {
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', gap: '7px', alignItems: 'baseline', padding: '2px 0' });

        const isLoop = stage.id === 'loop';
        const mark = isLoop ? (stage.ready ? '▶' : '⋯') : stage.done ? '☑' : '☐';
        const markColor = isLoop
            ? stage.ready
                ? COLORS.good
                : COLORS.textDim
            : stage.done
              ? COLORS.good
              : COLORS.warn;

        // Only a stage the character's own state could not answer is tickable.
        // Ticking one it did answer would let the panel disagree with the game.
        const tickable = !isLoop && !stage.derived;
        const glyph = tickable
            ? button(mark, () => this.toggleStage(stage.id, !stage.done), {
                  background: 'none',
                  border: 'none',
                  color: markColor,
                  padding: '0',
                  fontSize: '12px',
              })
            : span(mark, { color: markColor });
        if (tickable) glyph.title = 'Nothing here can be measured — tick it yourself.';

        const text = document.createElement('div');
        text.style.flex = '1';

        const heading = span(`${stage.number}. ${stage.title}`, {
            display: 'block',
            color: stage.done ? COLORS.textDim : COLORS.text,
            textDecoration: stage.done ? 'line-through' : 'none',
        });
        text.appendChild(heading);

        const parts = (stage.parts || [])
            .map((part) =>
                part.level === undefined
                    ? `${part.done ? '✓' : '·'} ${part.label}`
                    : `${part.done ? '✓' : '·'} ${part.label} ${part.level}${part.target ? `/${part.target}` : ''}`
            )
            .join('   ');
        if (parts) text.appendChild(span(parts, { display: 'block', color: COLORS.textDim, fontSize: '11px' }));

        if (isLoop && !stage.ready && stage.blockedBy?.length) {
            text.appendChild(
                span(`Waiting on: ${stage.blockedBy.join(', ')}`, {
                    display: 'block',
                    color: COLORS.warn,
                    fontSize: '11px',
                })
            );
        }

        if (stage.detail) {
            text.appendChild(span(stage.detail, { display: 'block', color: COLORS.textDim, fontSize: '11px' }));
        }

        row.append(glyph, text);
        return row;
    }

    /**
     * What the loop earns, and where its time goes.
     * @returns {HTMLElement} The card
     */
    _loopCard() {
        const holder = card('The loop');
        const loop = this.loop;

        if (!loop) {
            holder.appendChild(span('Press Refresh to cost the loop.', { color: COLORS.textDim }));
            return holder;
        }
        if (loop.missing?.length) {
            holder.appendChild(
                span(`Could not cost ${loop.missing.join(', ')} — no market data for the calculator's input yet.`, {
                    color: COLORS.warn,
                })
            );
            return holder;
        }

        const name = loop.items?.starfruitName || 'Star Fruit';

        holder.append(
            line(
                'Gold / hour',
                coins(loop.goldPerHour),
                loop.goldPerHour > 0 ? COLORS.good : COLORS.bad,
                'All of it coinify output. Nothing in this loop is sold.'
            ),
            line('Gold / day', coins(loop.goldPerDay), COLORS.text, '24 hours of the loop, uninterrupted.'),
            line(`${name} / hour`, bells(loop.fruitPerHour), COLORS.text, 'Foraged, at your rates.'),
            line(
                'Essence per fruit',
                loop.essencePerFruit.toFixed(2),
                COLORS.text,
                `${loop.items?.essencePerDecompose ?? 0} on a success, at ` +
                    `${formatPercentage(loop.decomposeRate)} decompose success.`
            ),
            line(
                'Coins per fruit',
                coins(loop.netPerFruit),
                COLORS.text,
                `${coins(loop.goldInPerFruit)} coinified at ${formatPercentage(loop.coinifyRate)} success, ` +
                    `less ${coins(loop.goldOutPerFruit)} of decompose fee.`
            ),
            line(
                'Time per fruit',
                `${(loop.hoursPerFruit * 3600).toFixed(1)}s`,
                COLORS.textDim,
                'Forage, decompose and coinify all run from the same queue, one at a time.'
            ),
            line(
                'Split',
                `forage ${formatPercentage(loop.timeShare.forage, 0)} · ` +
                    `decompose ${formatPercentage(loop.timeShare.decompose, 0)} · ` +
                    `coinify ${formatPercentage(loop.timeShare.coinify, 0)}`,
                COLORS.textDim
            ),
            line('Alchemy fees / hour', coins(loop.alchemyFeePerHour), COLORS.bad, 'What the buffer is for.')
        );

        holder.appendChild(
            span(loop.basis?.note || '', {
                display: 'block',
                color: COLORS.textDim,
                fontSize: '11px',
                marginTop: '3px',
            })
        );
        return holder;
    }

    /**
     * What that gold buys in bells.
     * @param {Object|null} state - From `readCharacterState`, for the coins on hand
     * @returns {HTMLElement} The card
     */
    _bellsCard(state) {
        const holder = card('Cowbells');
        const loop = this.loop;

        // Its own box, priced off the live quote, so a coin, queue or price change can redraw just these
        // lines (see `_onLiveChange`) — drawn even when the costed snapshot had no bell price, so a bag
        // listed since can still bring the count up without a full Refresh
        const affordable = document.createElement('div');
        affordable.append(...this._affordableLines(state));
        this.affordableEl = affordable;

        const pricing = loop?.bellPricing || cowbellPricing();
        if (!pricing.price) {
            holder.appendChild(span('No market price for a cowbell yet.', { color: COLORS.warn }));
            holder.appendChild(affordable);
            return holder;
        }

        holder.appendChild(
            line(
                'Per bell',
                coins(pricing.price),
                COLORS.text,
                `A tenth of a bag of ten (${coins(pricing.bag * 10)} a bag). Priced at ${pricing.pricingMode}.`
            )
        );
        holder.appendChild(
            line('Buy them', 'in bags of ten', COLORS.good, 'The market sells cowbells only in bags of ten.')
        );
        holder.appendChild(affordable);

        if (!loop || loop.missing?.length || !loop.bells) {
            holder.appendChild(
                span('Cost the loop to see what it earns in bells.', {
                    display: 'block',
                    color: COLORS.textDim,
                    marginTop: '3px',
                })
            );
            return holder;
        }

        holder.append(
            line('Bells / hour', bells(loop.bells.perHour), COLORS.good),
            line('Bells / day', bells(loop.bells.perDay), COLORS.good, '24 hours of the loop.'),
            line('A week of this', `${bells(loop.bells.perWeek)} bells`, COLORS.good, '168 hours of the loop.')
        );

        const offline = offlineWindow();
        const dutyCycle = Math.min(1, offline.hours / 24);
        holder.appendChild(
            line(
                `Realistic / day (${offline.hours}h queued)`,
                bells(loop.bells.perDay * dutyCycle),
                COLORS.text,
                offline.assumed
                    ? 'Assumes you log in once a day and the queue runs dry after the offline window.'
                    : 'Your offline window, once a day.'
            )
        );

        holder.appendChild(
            span(`Pricing mode: ${loop.pricingMode}.`, {
                display: 'block',
                color: COLORS.textDim,
                fontSize: '11px',
                marginTop: '3px',
            })
        );
        return holder;
    }

    /**
     * How many bells the coins on hand buy now, keeping back what the queue
     * needs at its lowest point (see `coin-reserve.js`).
     * Priced off the live market quote, not the costed snapshot: this is a purchase to make now.
     * @param {Object|null} state - From `readCharacterState`
     * @returns {Array<HTMLElement>} Zero, one or two lines
     * @private
     */
    _affordableLines(state) {
        if (!state) return [];
        const pricing = cowbellPricing({ buyNow: true });
        const label = 'Bells you can buy now';
        // One answer for the panel and the action-bar strip: see `bellBudget`
        const walked = pricing.price && pricing.quoted ? walkQueueCoins(actionTimeDisplay()) : null;
        const own = bellBudget(walked, state.coins, pricing);
        if (own.status === 'noPrice') return [];
        const keepSwitch = this._keepCashSwitch();
        if (own.status === 'unquoted') return [line(label, '—', COLORS.textDim, UNQUOTED_NOTE), keepSwitch];
        if (own.status === 'unreadable') return [line(label, '—', COLORS.textDim, UNREADABLE_NOTE), keepSwitch];

        // With the switch on, the helper's current batch is walked behind the queue and the bells come out
        // of what is left after its lowest point too. Legs the game queue already holds are in the walk
        // once, so nothing is held back twice. Off, this is today's number.
        let budget = own;
        const nextSet = this.keepBatchCash ? this._nextSetStages(state) : null;
        if (nextSet?.stages?.length) {
            budget = bellBudget(withBatchStages(walked, nextSet.stages), state.coins, pricing);
        }
        const nextSetKept = Math.max(0, (budget.reserve || 0) - (own.reserve || 0));

        const { reserve, buffer, spenders, estimated, can } = budget;
        const approx = estimated ? '~' : '';
        const estimateNote = estimated ? ESTIMATE_NOTE : '';

        const value = `${bells(can.bells)} (${can.bags} bag${can.bags === 1 ? '' : 's'})`;
        const kept = keptNote(reserve, spenders, coins, buffer);
        const stopped = stoppedNote(budget.stoppedAt);
        // The price feed carries no depth: every bag is priced at the cheapest listing, so this is a
        // ceiling once that listing runs out, and the tooltip says so
        const route =
            ` Whole bags of ten, rounded down, all at the cheapest listing (${coins(pricing.price * 10)} a bag).` +
            ' If fewer bags are listed at that price, the rest cost more and you get fewer.';
        const title = `Out of your ${coins(state.coins)}. ${kept}${estimateNote}${stopped}${route}`;

        // "Kept for the queue" is the queue's own reserve, as before; the next set is its own line
        const ownApprox = own.estimated ? '~' : '';
        const lines = [
            line(label, `${approx}${value}`, can.bells > 0 ? COLORS.good : COLORS.textDim, title),
            line(
                'Kept for the queue',
                own.reserve > 0 ? `${ownApprox}${coins(own.reserve)}` : '0',
                COLORS.textDim,
                own.reserve > own.buffer
                    ? `For ${own.spenders.join(', ')}, plus a ${coins(own.buffer)} safety buffer.${estimateNote}`
                    : keptNote(own.reserve, own.spenders, coins, own.buffer)
            ),
        ];
        if (this.keepBatchCash) {
            lines.push(this._nextSetLine(nextSet, nextSetKept, can, own.can));
        }
        lines.push(keepSwitch);
        return lines;
    }

    /**
     * The helper's current batch as gold stages behind the game queue, for the reserve.
     * @param {Object|null} state - From `readCharacterState`
     * @returns {{stages: Array<Object>|null, reason: string}|null} Null when there is no batch to hold cash for;
     *   `stages` null with a reason when the batch's fee has no price
     * @private
     */
    _nextSetStages(state) {
        const loop = this.loop;
        if (!loop || loop.missing?.length) return null;
        const batch = this._batchFor(this.batchHours, state);
        if (!batch) return null;
        const stages = batchStages(loop, this._missing(batch).batch);
        return {
            stages,
            reason: stages ? '' : 'The decompose fee has no price yet, so nothing was held back for the next set.',
        };
    }

    /**
     * The visible line beside "Kept for the queue": what the current batch needs at its lowest point.
     * @param {{stages: Array<Object>|null, reason: string}|null} nextSet - From `_nextSetStages`
     * @param {number} kept - Coins held back beyond the queue's own reserve
     * @param {{bells: number}} can - The bells that can still be bought
     * @param {{bells: number}} ownCan - The bells the queue alone would leave to buy
     * @returns {HTMLElement} The line
     * @private
     */
    _nextSetLine(nextSet, kept, can, ownCan) {
        if (!nextSet) {
            return line(
                'Kept for the next set',
                '—',
                COLORS.textDim,
                'Cost the loop to size a batch to hold cash for.'
            );
        }
        if (!nextSet.stages) return line('Kept for the next set', '—', COLORS.warn, nextSet.reason);
        const title =
            'The most the current queue-helper batch dips below your gold (its decompose fees, which come ' +
            'before any coinify income), on top of the queue. Legs the game queue already holds are not ' +
            'counted twice.';
        const row = line('Kept for the next set', kept > 0 ? coins(kept) : '0', COLORS.textDim, title);
        if (!(kept > 0 && can.bells <= 0 && ownCan.bells > 0)) return row;
        // Visible, not only in a tooltip: a zero that the switch caused must say so
        const holder = document.createElement('div');
        holder.append(
            row,
            span(
                `No bells are spare because ${coins(kept)} is held back for the helper’s batch. Turn the switch off to ignore it.`,
                {
                    display: 'block',
                    color: COLORS.warn,
                    fontSize: '11px',
                }
            )
        );
        return holder;
    }

    /**
     * The switch for holding cash back for the helper's batch.
     * @returns {HTMLElement} A labeled checkbox
     * @private
     */
    _keepCashSwitch() {
        const label = document.createElement('label');
        Object.assign(label.style, {
            display: 'flex',
            gap: '6px',
            alignItems: 'center',
            fontSize: '11px',
            color: COLORS.textDim,
            marginTop: '2px',
        });
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = this.keepBatchCash;
        box.addEventListener('change', () => this.setKeepCash(box.checked));
        label.append(box, document.createTextNode('Also keep cash for the helper’s batch'));
        label.title =
            'Holds back the gold the batch below needs at its lowest point, so buying bells cannot starve it.';
        return label;
    }

    /**
     * How many of each action to queue, and a walk that puts you in front of
     * each one.
     *
     * The panel already told the player to queue all three actions and to cover
     * their offline window; this is that advice as three numbers they can type,
     * balanced so each leg eats what the leg before it grew. The duration and
     * the cowbell target are the same figure said two ways, and each fills the
     * other in.
     *
     * @param {Object|null} state - From `readCharacterState`, for what to credit
     * @returns {HTMLElement} The card
     */
    _queueCard(state) {
        const holder = card('Queue helper');
        const loop = this.loop;

        if (!loop || loop.missing?.length) {
            holder.appendChild(span('Cost the loop to size a batch.', { color: COLORS.textDim }));
            return holder;
        }

        const hasBellPrice = Number.isFinite(loop.bellPrice) && loop.bellPrice > 0;
        const batch = this._batchFor(this.batchHours, state);
        if (!batch) {
            holder.appendChild(span('This loop cannot be sized into a batch.', { color: COLORS.warn }));
            return holder;
        }

        // In Max the duration is an output (how long the held fruit keeps the queue busy); so it is for a bell
        // target. Only a typed duration is an input, and then the box shows what was asked.
        if (batch.max) this.batchHours = Math.min(MAX_QUEUE_HOURS, batch.hours);
        this.shownHours = this._shownHoursFor(batch);

        // Shown in the unit the select is on: shownHours is always hours, and the select remembers 'd'
        const shownDuration = this.batchUnit === 'd' ? this.shownHours / HOURS_PER_DAY : this.shownHours;
        const hoursBox = numberBox(round1(shownDuration), (raw) => this._setBatchHours(Number(raw), 'hours'));
        const unit = document.createElement('select');
        for (const [value, label] of [
            ['h', 'hours'],
            ['d', 'days'],
        ]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            unit.appendChild(option);
        }
        Object.assign(unit.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
        });
        unit.value = this.batchUnit || 'h';
        unit.addEventListener('change', () => {
            this._edits.batch++;
            this.batchUnit = unit.value;
            hoursBox.value = String(round1(this.batchUnit === 'd' ? this.shownHours / HOURS_PER_DAY : this.shownHours));
        });

        const durationRow = document.createElement('div');
        Object.assign(durationRow.style, { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' });
        durationRow.append(span('Queue for', { color: COLORS.textDim }), hoursBox, unit);
        for (const preset of QUEUE_PRESETS) {
            durationRow.appendChild(button(preset.label, () => this._setBatchHours(preset.hours, 'preset')));
        }
        // Max: every Star Fruit held, no foraging. Disabled (with the reason in view, since a title
        // does not show on a touch screen) when there is nothing for it to use.
        const maxInfo = maxBatch(loop, state);
        const maxButton = button('Max', () => this._setMax());
        maxButton.title = maxInfo.batch
            ? `Decompose all ${formatWithSeparator(maxInfo.batch.max.fruitHeld)} ${maxInfo.batch.max.fruitName} you ` +
              'hold, coinify the essence, and forage nothing.'
            : maxInfo.reason;
        maxButton.disabled = !maxInfo.batch;
        if (!maxInfo.batch) maxButton.style.opacity = '0.5';
        durationRow.appendChild(maxButton);
        holder.appendChild(durationRow);
        if (!maxInfo.batch) {
            holder.appendChild(
                span(`Max: ${maxInfo.reason}`, { display: 'block', color: COLORS.textDim, fontSize: '11px' })
            );
        }

        const bellsBox = numberBox(hasBellPrice ? Math.round(batch.bells || 0) : '', (raw) =>
            this._setBatchBells(Number(raw))
        );
        const bellsRow = document.createElement('div');
        Object.assign(bellsRow.style, { display: 'flex', gap: '6px', alignItems: 'center' });
        bellsRow.append(span('or bells', { color: COLORS.textDim }), bellsBox);
        holder.appendChild(bellsRow);

        if (!hasBellPrice) {
            // Never a blank box or a zero that reads as a real target: an empty
            // field the player can type into is a promise the panel cannot keep
            // without a price to convert at.
            bellsBox.disabled = true;
            bellsBox.value = '';
            bellsBox.placeholder = '—';
            bellsBox.style.opacity = '0.5';
            bellsBox.title = 'No market price for a cowbell yet.';
            holder.appendChild(
                span('No cowbell price yet, so a bell target cannot be worked back — the duration still can.', {
                    display: 'block',
                    color: COLORS.warn,
                    fontSize: '11px',
                })
            );
        }

        const counts = document.createElement('div');
        counts.style.marginTop = '3px';
        holder.appendChild(counts);

        const summary = span('', { display: 'block', color: COLORS.textDim, fontSize: '11px' });
        holder.appendChild(summary);

        const walk = button('Walk it', () => this._walkQueue());
        walk.style.marginTop = '4px';
        walk.style.alignSelf = 'flex-start';
        walk.title =
            'Opens each action in turn and types the count into the game\u2019s own box. ' +
            'It never presses anything — the press that queues each action is yours.';
        holder.appendChild(walk);

        this.queueRefs = { hoursBox, unit, bellsBox, counts, summary, walk, hasBellPrice };
        this._drawBatch(batch);
        return holder;
    }

    /**
     * Size a batch for a duration and credit what the character already holds
     * against it, so every caller — the card's own draw, a duration edit, the
     * walk button — sizes and walks the same figures.
     * @param {number} hours - How long the batch should keep the queue busy
     * @param {Object|null} [state] - From `readCharacterState`; defaults to the one the card
     *   was last drawn against
     * @returns {Object|null} The batch, holdings credited, or null when it cannot be sized
     * @private
     */
    _batchFor(hours, state = this._queueState) {
        if (this.queueMax) {
            const { batch: maxed } = maxBatch(this.loop, this._capFruit(state));
            if (maxed) return maxed;
            // The fruit Max was sized to is gone (or the loop changed): fall back to the duration path
            // rather than keep a Max that no longer describes anything
            this.queueMax = false;
        }
        if (this.batchBasis === 'hours') {
            // Fill the whole time asked: held stock first, forage for the rest. Null (items unresolved, a
            // rate missing) drops to the from-scratch sizing below, which says why when it credits nothing.
            const filled = fillBatch(this.loop, hours, state);
            if (filled) return filled;
        }
        const batch = balanceBatch(this.loop, hours);
        if (!batch) return null;
        return applyHoldings(batch, this.loop, state);
    }

    /**
     * Redraw the three counts and the summary, without rebuilding the fields the
     * player may be typing in.
     * @param {Object} batch - From `_batchFor`
     * @private
     */
    _drawBatch(batch) {
        const refs = this.queueRefs;
        if (!refs) return;
        const loop = this.loop;
        const fruit = loop?.items?.starfruitName || 'Star Fruit';
        const essence = loop?.items?.essenceName || 'essence';

        refs.counts.replaceChildren(
            line('Forage', formatWithSeparator(batch.forageActions), COLORS.good, `Grows the ${fruit}.`),
            line(
                'Decompose',
                formatWithSeparator(batch.decomposeActions),
                COLORS.good,
                batch.max
                    ? `Uses ${formatWithSeparator(Math.floor(batch.fruit))} of the ${fruit} you hold.`
                    : `Sized to the ${formatWithSeparator(Math.floor(batch.fruit))} ${fruit} the forage leg yields.`
            ),
            line(
                'Coinify',
                formatWithSeparator(batch.coinifyActions),
                COLORS.good,
                `Sized to the ${formatWithSeparator(Math.floor(batch.essence))} ${essence} the decompose leg yields, ` +
                    `${loop?.coinifyBulk || 1} to an action.`
            ),
            ...this._creditLines(batch)
        );

        const earns = batch.bells === null ? '' : ` · about ${bells(batch.bells)} bells`;
        const steps = buildQueueSteps(loop, batch);
        const presses = steps.length === 1 ? '1 press' : `${formatWithSeparator(steps.length)} presses`;
        // Stock on hand can shrink the batch well below the duration asked; say so
        // rather than leave a short figure next to a longer request unexplained.
        let shortened = '';
        if (batch.fill?.trimmed) {
            shortened = ` (not ${round1(batch.requestedHours)}h: what you hold already fills more than that, so only what fits is queued)`;
        } else if (
            !batch.fill &&
            !batch.max &&
            batch.credits?.length &&
            batch.requestedHours > 0 &&
            batch.hours < batch.requestedHours * 0.99
        ) {
            // Bell target: the least work that earns the bells, which finishes sooner than the hours they convert to
            shortened = ` (sooner than the ${round1(batch.requestedHours)}h these bells take from scratch: what you hold replaces the legs that would have made them)`;
        }
        refs.summary.textContent = `Keeps the queue busy about ${round1(batch.hours)}h${shortened}${earns} — ${presses}.`;

        if (refs.walk) {
            // Only what the game queue does not already hold is walked, and the button says what it leaves out
            const missing = this._missing(batch);
            const walkSteps = buildQueueSteps(loop, missing.batch);
            const walkPresses = walkSteps.length === 1 ? '1 press' : `${formatWithSeparator(walkSteps.length)} presses`;
            const notes = [
                ...(missing.skipped.length ? [`${missing.skipped.join(', ')} already queued`] : []),
                ...(missing.partial.length ? [`${missing.partial.join(', ')}: only the difference`] : []),
            ];
            const note = notes.length ? ` (${notes.join('; ')})` : '';
            refs.walk.textContent = steps.length
                ? walkSteps.length
                    ? `Walk it — ${walkPresses}${note}`
                    : `Nothing to walk${note}`
                : 'Walk it';
        }
        // The cash held back for the batch follows the batch
        if (this.keepBatchCash) this._onLiveChange();
    }

    /**
     * What the batch credited off the inventory, as lines under the counts —
     * shown, not folded silently into smaller numbers above, because a count
     * that changed for an unexplained reason is worse than a bigger one.
     * @param {Object} batch - From `_batchFor`
     * @returns {Array<HTMLElement>} Zero or more lines
     * @private
     */
    _creditLines(batch) {
        const lines = [];
        const dim = { display: 'block', color: COLORS.textDim, fontSize: '11px' };
        if (batch.fill) {
            const { fruitHeld, essenceHeld, scratchForage } = batch.fill;
            const fruitName = this.loop?.items?.starfruitName || 'Star Fruit';
            const essenceName = this.loop?.items?.essenceName || 'essence';
            if (fruitHeld > 0) {
                const saved = Math.max(0, scratchForage - batch.forageActions);
                lines.push(
                    span(
                        `You have ${formatWithSeparator(fruitHeld)} ${fruitName} — used first, ` +
                            `${formatWithSeparator(saved)} fewer forage actions.`,
                        dim
                    )
                );
            }
            if (essenceHeld > 0) {
                lines.push(span(`You have ${formatWithSeparator(essenceHeld)} ${essenceName} — coinified first.`, dim));
            }
        }
        lines.push(...this._goldLines(batch));
        if (batch.max) {
            const { fruitName, fruitHeld, leftoverFruit, essenceHeld } = batch.max;
            const left =
                leftoverFruit > 0 ? `, ${formatWithSeparator(leftoverFruit)} left over (under one decompose)` : '';
            const essence = essenceHeld > 0 ? ` plus ${formatWithSeparator(essenceHeld)} essence held` : '';
            lines.push(
                span(`Max: all ${formatWithSeparator(fruitHeld)} ${fruitName}${essence}, no foraging${left}.`, {
                    display: 'block',
                    color: COLORS.textDim,
                    fontSize: '11px',
                })
            );
        }
        for (const credit of batch.credits || []) {
            lines.push(
                span(
                    `You have ${formatWithSeparator(credit.amount)} ${credit.name} — ` +
                        `${formatWithSeparator(credit.actionsSaved)} fewer actions above.`,
                    { display: 'block', color: COLORS.textDim, fontSize: '11px' }
                )
            );
        }
        if (batch.holdingsNote) {
            lines.push(span(batch.holdingsNote, { display: 'block', color: COLORS.warn, fontSize: '11px' }));
        }
        return lines;
    }

    /**
     * Move the batch to a new duration and bring everything else with it.
     * @param {number} hours - The new duration, in hours
     * @param {'hours'|'bells'|'preset'} source - Which field the player touched
     * @private
     */
    _setBatchHours(hours, source) {
        if (!Number.isFinite(hours) || hours <= 0) return;
        this._edits.batch++;
        this.queueMax = false;
        this.maxCap = null;
        // Typed or pressed hours are the input (held stock first, forage for the rest); a bell target is
        // converted to hours and sized as the least work that earns it
        this.batchBasis = source === 'bells' ? 'bells' : 'hours';
        const inDays = source === 'hours' && this.batchUnit === 'd';
        this.batchHours = Math.min(MAX_QUEUE_HOURS, inDays ? hours * HOURS_PER_DAY : hours);

        const refs = this.queueRefs;
        // What is held is read again on every press: the card may have been drawn a while ago
        this._freshState();
        const batch = this._batchFor(this.batchHours);
        if (!refs || !batch) return;

        // The field the player is typing in is left alone; the other follows from the result.
        this.shownHours = this._shownHoursFor(batch);
        if (source !== 'hours') {
            refs.hoursBox.value = String(
                round1(this.batchUnit === 'd' ? this.shownHours / HOURS_PER_DAY : this.shownHours)
            );
        }
        if (source !== 'bells' && refs.hasBellPrice) {
            refs.bellsBox.value = String(Math.round(batch.bells || 0));
        }
        this._drawBatch(batch);
    }

    /**
     * Read the character again and keep it as the state the card sizes against.
     * @returns {Object|null} The fresh state, or null when it cannot be read (the old one is kept)
     * @private
     */
    _freshState() {
        const state = this._safeState();
        if (state) this._queueState = state;
        return state;
    }

    /**
     * The hours the duration box should show: what was asked when the duration is the input, the batch's own
     * figure when the output (Max, or a bell target).
     * @param {Object} batch - From `_batchFor`
     * @returns {number} Hours
     * @private
     */
    _shownHoursFor(batch) {
        const derived = this.queueMax || this.batchBasis === 'bells';
        return derived ? Math.min(MAX_QUEUE_HOURS, batch.hours) : this.batchHours;
    }

    /**
     * The gold a batch needs at its lowest point against the gold held, before any press, with the way out
     * when short. The decompose leg runs before any coinify income, so the queue stalls on fees if the gold
     * is not there up front.
     * @param {Object} batch - From `_batchFor`
     * @returns {Array<HTMLElement>} One or two lines
     * @private
     */
    _goldLines(batch) {
        const dim = { display: 'block', color: COLORS.textDim, fontSize: '11px' };
        const check = this._goldCheck(batch);
        // A fee with no price is unknown, never free
        if (!check.known) {
            return [span('Gold needed: unknown — the decompose fee has no price yet.', { ...dim, color: COLORS.warn })];
        }
        if (check.need <= 0) return [];
        const heldText = check.held === null ? 'your gold could not be read' : `you hold ${coins(check.held)}`;
        const onTop = check.queueNeed > 0 ? ` on top of the ${coins(check.queueNeed)} the queue already needs` : '';
        const unread = check.queueReadable
            ? ''
            : ' (the queue could not be read in full, so only this batch is counted)';
        if (check.short <= 0) {
            return [span(`Gold needed at its lowest point: ${coins(check.need)}${onTop}; ${heldText}.${unread}`, dim)];
        }
        const holder = document.createElement('div');
        holder.appendChild(
            span(
                `⚠ Needs ${coins(check.need)}${onTop} at its lowest point; ${heldText} — short by ` +
                    `${coins(check.short)}, so the queue would stall on gold.${unread}`,
                { ...dim, color: COLORS.warn }
            )
        );
        const largest = button('Largest I can run', () => this._runLargest());
        largest.style.marginTop = '2px';
        largest.title = 'Fills the helper with the largest batch your gold pays the decompose fees for.';
        holder.appendChild(largest);
        return [holder];
    }

    /**
     * Work a cowbell target back into a duration.
     * @param {number} target - Bells wanted
     * @private
     */
    _setBatchBells(target) {
        const hours = hoursForBells(this.loop, target);
        if (hours === null) return;
        this._setBatchHours(hours, 'bells');
    }

    /**
     * Size the helper to every Star Fruit held, from the inventory as it is right now (the card was
     * drawn against an older reading), and bring the duration and bell boxes with it.
     * @private
     */
    _setMax() {
        const state = this._safeState();
        const { batch, reason } = maxBatch(this.loop, state);
        if (!batch) {
            this.queueMax = false;
            this._render();
            this._status(`Max: ${reason}`);
            return;
        }
        this._edits.batch++;
        this.maxCap = null;
        this._queueState = state;
        this.queueMax = true;
        this.batchHours = Math.min(MAX_QUEUE_HOURS, batch.hours);
        this._syncFields(batch);
    }

    /**
     * Put the duration and bell boxes at the batch's own figures and redraw the counts.
     * @param {Object} batch - From `_batchFor` or `maxBatch`
     * @private
     */
    _syncFields(batch) {
        const refs = this.queueRefs;
        if (!refs) return;
        this.shownHours = this._shownHoursFor(batch);
        refs.hoursBox.value = String(
            round1(this.batchUnit === 'd' ? this.shownHours / HOURS_PER_DAY : this.shownHours)
        );
        if (refs.hasBellPrice) refs.bellsBox.value = String(Math.round(batch.bells || 0));
        this._drawBatch(batch);
    }

    /**
     * Hand the current batch to the guided walk.
     * @private
     */
    _walkQueue() {
        // The card was drawn some time ago: size against what is held and queued now, show the player
        // those figures, and walk exactly them
        const state = this._freshState();
        if (this.queueMax) {
            const { batch: fresh, reason } = maxBatch(this.loop, this._capFruit(state));
            if (!fresh) {
                this.queueMax = false;
                this._render();
                this._status(`Max no longer applies: ${reason}`);
                return;
            }
            this.batchHours = Math.min(MAX_QUEUE_HOURS, fresh.hours);
        }
        const batch = this._batchFor(this.batchHours);
        if (!batch) {
            this._status('Nothing to walk — cost the loop first.');
            return;
        }
        this._syncFields(batch);

        // Only what the game queue does not already hold
        const missing = this._missing(batch);
        if (!startQueueWalk(this.loop, missing.batch)) {
            this._status(
                missing.skipped.length
                    ? `Nothing to walk — ${missing.skipped.join(', ')} already queued.`
                    : 'Nothing to walk — cost the loop first.'
            );
        }
    }

    /**
     * The batch with what the game queue already holds taken off, by action and item.
     * @param {Object} batch - From `_batchFor`
     * @returns {{batch: Object, skipped: Array<string>, partial: Array<string>}}
     * @private
     */
    _missing(batch) {
        let actions = [];
        try {
            actions = dataManager.getCurrentActions?.() || [];
        } catch (error) {
            console.error('[IronCow] Reading the queue failed:', error);
        }
        return reduceBatchByQueue(batch, queuedLegCounts(actions, this.loop?.items));
    }

    /**
     * The state with the fruit Max may use cut to what "Largest I can run" allowed, if it did.
     * @param {Object|null} state - From `readCharacterState`
     * @returns {Object|null} The state, or a copy holding less fruit
     * @private
     */
    _capFruit(state) {
        if (!state || this.maxCap === null) return state;
        return { ...state, starfruitHeld: Math.min(state.starfruitHeld || 0, this.maxCap) };
    }

    /**
     * What the batch's legs cost in gold at the lowest point, against the gold held.
     *
     * The decompose fees come before any coinify income, so the lowest point is the fees of the legs the
     * walk would queue (the ones the game queue does not already hold), on top of the fees the queue
     * already needs. A fee with no price is unknown, never 0.
     *
     * @param {Object} batch - From `_batchFor`
     * @returns {{known: boolean, need: number, queueNeed: number, held: number|null, short: number,
     *   queueReadable: boolean, stages: Array<Object>|null, walked: Object|null, missing: Object}}
     * @private
     */
    _goldCheck(batch) {
        const missing = this._missing(batch);
        const stages = batchStages(this.loop, missing.batch);
        let walked = null;
        try {
            walked = walkQueueCoins(actionTimeDisplay());
        } catch (error) {
            console.error('[IronCow] Walking the queue failed:', error);
        }
        const queueNeed = walked ? coinReserve(walked.stages).reserve : 0;
        const need = stages ? coinReserve(stages).reserve : 0;
        const held = Number.isFinite(this._queueState?.coins) ? this._queueState.coins : null;
        const short = stages && held !== null ? Math.max(0, queueNeed + need - held) : 0;
        return {
            known: stages !== null,
            need,
            queueNeed,
            held,
            short,
            queueReadable: !!walked,
            stages,
            walked,
            missing,
        };
    }

    /**
     * "Largest I can run": fill the helper with the largest batch the gold on hand pays for, from the
     * inventory, queue and gold as they are right now.
     * @private
     */
    _runLargest() {
        const state = this._freshState();
        const batch = this._batchFor(this.batchHours, state);
        if (!batch) return;
        const check = this._goldCheck(batch);
        if (!check.known || check.held === null) {
            this._status('Cannot size to your gold — the decompose fee or your gold is unknown.');
            return;
        }
        const queuedDecompose = queuedLegCounts(dataManager.getCurrentActions?.() || [], this.loop?.items).decompose;
        const result = affordableBatch(this.loop, state, check.held - check.queueNeed, {
            max: this.queueMax,
            hours: this.batchHours,
            queuedDecompose: queuedDecompose.count,
        });
        if (!result.batch) {
            this._status(result.reason);
            return;
        }
        this._edits.batch++;
        if (this.queueMax) {
            this.maxCap = result.batch.fruit;
        } else {
            this.batchBasis = 'hours';
            this.batchHours = result.hours;
        }
        const resized = this._batchFor(this.batchHours, state);
        if (resized) this._syncFields(resized);
    }

    /**
     * When the queue runs out, from the same ledger walk the reserve reads, with what the bell balance
     * would be by then (an estimate).
     * @param {Object|null} state - Character state, for the coins on hand
     * @returns {{text: string, title: string}|null} Null when the queue cannot be read
     * @private
     */
    _queueEnd(state) {
        // The engine is not loaded until the actions bundle is: the walk then answers null
        const walked = walkQueueCoins(actionTimeDisplay());
        if (!walked) return null;
        const pricing = cowbellPricing({ buyNow: true });
        const bellPrice = pricing?.price && pricing.quoted ? pricing.price : null;
        const cycle = summarizeCycle(walked, { coins: state.coins, loopItems: this.loop?.items, bellPrice });
        return queueEndText(walked, cycle, { coins: state.coins, bellPrice });
    }

    /**
     * What is wrong with the loop as it is set up right now.
     * @param {Object|null} state - Character state
     * @returns {HTMLElement} The card
     */
    _checksCard(state) {
        const holder = card('Check');
        if (!state) {
            holder.appendChild(span('No character state to check.', { color: COLORS.textDim }));
            return holder;
        }

        holder.appendChild(line('Gold', coins(state.coins), state.coins > 0 ? COLORS.text : COLORS.bad));
        holder.appendChild(line('Queued actions', String(state.queueLength), COLORS.text));

        const end = this._queueEnd(state);
        if (end) {
            const row = span(end.text, { display: 'block', color: COLORS.textDim, fontSize: '11px', marginTop: '3px' });
            row.title = end.title;
            holder.appendChild(row);
        }

        for (const warning of loopWarnings(state, this.loop)) {
            holder.appendChild(
                span(`${warning.severity === 'warn' ? '⚠' : 'ℹ'} ${warning.text}`, {
                    display: 'block',
                    color: warning.severity === 'warn' ? COLORS.warn : COLORS.textDim,
                    fontSize: '11px',
                    marginTop: '3px',
                })
            );
            if (warning.id === 'queue' && this.loop && !this.loop.missing?.length) {
                // The walk skips legs the game queue already holds, so this fills only what is missing
                const missing = button('Walk what’s missing', () => this._walkQueue());
                missing.style.marginTop = '3px';
                missing.title = 'Starts the guided walk for the legs of the current batch that are not queued yet.';
                holder.appendChild(missing);
            }
        }
        return holder;
    }
}

export const ironCowFarmPanel = new IronCowFarmPanel();
export default ironCowFarmPanel;
