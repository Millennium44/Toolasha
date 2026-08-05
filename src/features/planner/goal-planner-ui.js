/**
 * Goal Planner panel
 *
 * A list of what you are working towards, and the ordered steps to get there.
 *
 * The panel deliberately does no arithmetic. It collects a goal, hands it to
 * `goal-planner.js` with a context built from the live calculators, and draws
 * what comes back — so anything a number here disagrees with the rest of
 * Toolasha about is a bug in one calculator rather than a second opinion grown
 * inside a panel.
 *
 * ## Refresh is a button, not a timer
 *
 * Ranking every activity the character can do means running the profit
 * calculators a few hundred times. That is not something to do every five
 * seconds behind somebody's back, and it is not something whose answer changes
 * minute to minute. So the plan is computed on demand, the market age it was
 * priced at is printed next to the totals, and the last result is kept so the
 * panel has something to show the moment it opens.
 *
 * ## Steps that are already done stay on screen
 *
 * A plan re-costed after you bought the base item shows that step struck
 * through rather than one step shorter. Watching steps grey out is the progress
 * bar; a list that silently gets smaller is just a list you no longer trust.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { formatKMB, parseKMB, timeReadable } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry, saveOpenState, reopenIfLeftOpen } from '../../utils/panel-geometry.js';
import { planGoals, describeGoal, GOAL_TYPES } from './goal-planner.js';
import { buildPlannerContext, withHouseCosts } from './goal-planner-context.js';
import { loadGoals, addGoal, removeGoal, loadSnapshot, saveSnapshot } from './goal-planner-store.js';

const PANEL_ID = 'toolasha-goal-planner-panel';
const GEOMETRY_KEY = 'goalPlannerPanel';
const DEFAULT_PANEL = { width: 560, height: 620 };

const COLORS = {
    background: 'rgba(10, 12, 20, 0.97)',
    headerBg: 'rgba(18, 26, 40, 0.92)',
    border: 'rgba(120, 170, 255, 0.32)',
    hairline: 'rgba(255, 255, 255, 0.10)',
    card: 'rgba(255, 255, 255, 0.04)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.55)',
    accent: '#7fb0ff',
    good: '#7fd6a3',
    bad: '#f0776c',
    warn: '#ffb020',
};

/** Which step kind gets which mark, so a plan can be skimmed down its left edge */
const KIND_GLYPH = {
    earn: '⛏',
    acquire: '🛒',
    enhance: '✦',
    train: '📘',
    build: '🏠',
};

/**
 * Hours, said the way a plan says them.
 * @param {number|null} hours - Hours, or null when unknown
 * @returns {string} e.g. "3h 20m 00s", or "—"
 */
function duration(hours) {
    if (hours === null || !Number.isFinite(hours)) return '—';
    if (hours <= 0) return '0s';
    return timeReadable(Math.round(hours * 3600));
}

/**
 * Coins, signed the way a step means them.
 * @param {number} value - Coins; negative spends
 * @returns {string} e.g. "-12.5M"
 */
function signedCoins(value) {
    const rounded = Math.round(Number(value) || 0);
    if (rounded === 0) return '0';
    return `${rounded > 0 ? '+' : '-'}${formatKMB(Math.abs(rounded))}`;
}

/**
 * @param {string} text - Cell contents
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
    Object.assign(element.style, {
        background: 'rgba(255, 255, 255, 0.07)',
        border: `1px solid ${COLORS.border}`,
        borderRadius: '3px',
        color: COLORS.accent,
        cursor: 'pointer',
        fontSize: '11px',
        padding: '2px 8px',
        ...style,
    });
    element.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick(event);
    });
    return element;
}

/**
 * @param {Object} [attributes] - `value`, `placeholder`, `type`, `list`, `width`
 * @returns {HTMLInputElement} An input
 */
function input(attributes = {}) {
    const element = document.createElement('input');
    element.type = attributes.type || 'text';
    if (attributes.placeholder) element.placeholder = attributes.placeholder;
    if (attributes.value !== undefined) element.value = attributes.value;
    if (attributes.list) element.setAttribute('list', attributes.list);
    if (attributes.min !== undefined) element.min = String(attributes.min);
    if (attributes.max !== undefined) element.max = String(attributes.max);
    Object.assign(element.style, {
        background: 'rgba(0, 0, 0, 0.35)',
        border: `1px solid ${COLORS.hairline}`,
        borderRadius: '3px',
        color: COLORS.text,
        fontSize: '11px',
        padding: '2px 6px',
        width: attributes.width || '110px',
    });
    return element;
}

/**
 * @param {Array<{value: string, label: string}>} options - What can be chosen
 * @returns {HTMLSelectElement} A select
 */
function select(options) {
    const element = document.createElement('select');
    Object.assign(element.style, {
        background: 'rgba(0, 0, 0, 0.35)',
        border: `1px solid ${COLORS.hairline}`,
        borderRadius: '3px',
        color: COLORS.text,
        fontSize: '11px',
        padding: '2px 4px',
        maxWidth: '200px',
    });
    for (const option of options) {
        const child = document.createElement('option');
        child.value = option.value;
        child.textContent = option.label;
        element.appendChild(child);
    }
    return element;
}

class GoalPlannerPanel {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.statusEl = null;
        this.goals = [];
        this.plans = [];
        /** What the rate providers want said — a missing or stale combat snapshot, say */
        this.rateNotes = [];
        this.pricedAt = null;
        this.busy = false;
        this.formType = null;
        this.loaded = null;
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

    /** Feature-registry entry point: read the goals back and reopen if left open */
    async initialize() {
        await this.load();
        reopenIfLeftOpen(GEOMETRY_KEY, () => this.show({ remember: false }));
    }

    /** Feature-registry teardown */
    disable() {
        this._remove();
    }

    /**
     * Read the stored goals and the last plans, once per character.
     * @returns {Promise<void>}
     */
    async load() {
        this.goals = await loadGoals();
        const snapshot = await loadSnapshot();
        if (snapshot) {
            this.plans = snapshot.plans;
            this.pricedAt = snapshot.computedAt;
        }
        this._render();
    }

    /**
     * Re-cost every goal against the market as it stands now.
     *
     * The whole plan is recomputed rather than patched: a step is satisfied or
     * not by the character's present state, and the only way to know which is
     * to ask again. Steps that have become satisfied come back marked done.
     *
     * @returns {Promise<void>}
     */
    async refresh() {
        if (this.busy) return;
        this.busy = true;
        this._status('Pricing…');
        try {
            const context = await buildPlannerContext();
            await withHouseCosts(context, this.goals);
            this.plans = planGoals(this.goals, context);
            this.rateNotes = context.rateNotes || [];
            this.pricedAt = Date.now();
            await saveSnapshot(this.plans);
        } catch (error) {
            console.error('[GoalPlanner] Refreshing the plan failed:', error);
            this._status('Pricing failed — see the console.');
        } finally {
            this.busy = false;
            this._render();
        }
    }

    /**
     * Add a goal and immediately plan it.
     * @param {Object} raw - A goal from the creation form
     * @returns {Promise<void>}
     */
    async addGoal(raw) {
        this.goals = await addGoal(raw);
        this.formType = null;
        this._render();
        await this.refresh();
    }

    /**
     * Drop a goal and its plan.
     * @param {string} goalId - The goal's id
     * @returns {Promise<void>}
     */
    async removeGoal(goalId) {
        this.goals = await removeGoal(goalId);
        this.plans = this.plans.filter((plan) => plan.goalId !== goalId);
        await saveSnapshot(this.plans);
        this._render();
    }

    // -------------------------------------------------------------------------
    // Panel construction
    // -------------------------------------------------------------------------

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '120px',
            left: '90px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: `min(${DEFAULT_PANEL.width}px, 94vw)`,
            height: `min(${DEFAULT_PANEL.height}px, 82vh)`,
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
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
            minWidth: 400,
            minHeight: 240,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 400, height: 240 });

        this._render();
        // A panel opened before the goals came back from storage would show an
        // empty list and look like it had lost them
        if (!this.loaded) this.loaded = this.load();
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = span('Goal Planner', { fontWeight: 'bold', color: COLORS.accent });

        this.statusEl = span('', { color: COLORS.textDim, fontSize: '11px' });

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const refresh = button('Refresh', () => this.refresh());
        refresh.title = 'Re-price every plan against the market data loaded now.';

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

        this._status(
            this.busy
                ? 'Pricing…'
                : this.pricedAt
                  ? `priced ${new Date(this.pricedAt).toLocaleTimeString()}`
                  : 'not priced yet'
        );

        this.bodyEl.appendChild(this._addSection());

        // A rate that is missing or old is worth a line: a plan that ranks
        // gathering first because nobody has ever run an all-zones sim looks
        // exactly like a plan that ranks gathering first because it wins.
        for (const note of this.rateNotes || []) {
            this.bodyEl.appendChild(
                span(note, {
                    display: 'block',
                    color: COLORS.textDim,
                    fontSize: '11px',
                    marginTop: '6px',
                })
            );
        }

        if (!this.goals.length) {
            this.bodyEl.appendChild(
                span('No goals yet. Add one above and the planner will work out the order and the bill.', {
                    display: 'block',
                    color: COLORS.textDim,
                    marginTop: '10px',
                })
            );
            return;
        }

        const byGoal = new Map(this.plans.map((plan) => [plan.goalId, plan]));
        for (const goal of this.goals) {
            try {
                this.bodyEl.appendChild(this._goalCard(goal, byGoal.get(goal.id) || null));
            } catch (error) {
                console.error('[GoalPlanner] Drawing a goal failed:', error);
                this.bodyEl.appendChild(
                    span(`${describeGoal(goal)} could not be drawn.`, { display: 'block', color: COLORS.bad })
                );
            }
        }
    }

    /**
     * The add-a-goal strip, and the form for whichever type is being added.
     * @returns {HTMLElement} The section
     */
    _addSection() {
        const section = document.createElement('div');
        section.style.marginBottom = '10px';

        const strip = document.createElement('div');
        Object.assign(strip.style, { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' });
        strip.appendChild(span('Add goal:', { color: COLORS.textDim }));

        for (const [type, label] of Object.entries(GOAL_TYPES)) {
            const chip = button(label, () => {
                this.formType = this.formType === type ? null : type;
                this._render();
            });
            if (this.formType === type) {
                chip.style.background = 'rgba(127, 176, 255, 0.22)';
            }
            strip.appendChild(chip);
        }
        section.appendChild(strip);

        if (this.formType) {
            try {
                section.appendChild(this._form(this.formType));
            } catch (error) {
                console.error('[GoalPlanner] Drawing the goal form failed:', error);
                section.appendChild(span('The form could not be drawn.', { display: 'block', color: COLORS.bad }));
            }
        }

        return section;
    }

    /**
     * The creation form for one goal type.
     * @param {string} type - A key of GOAL_TYPES
     * @returns {HTMLElement} The form
     */
    _form(type) {
        const form = document.createElement('div');
        Object.assign(form.style, {
            display: 'flex',
            gap: '6px',
            alignItems: 'center',
            flexWrap: 'wrap',
            marginTop: '6px',
            padding: '6px 8px',
            background: COLORS.card,
            borderRadius: '4px',
        });

        const gameData = dataManager.getInitClientData?.() || {};

        if (type === 'gold') {
            const amount = input({ placeholder: '500M', width: '110px' });
            form.append(span('Coins:', { color: COLORS.textDim }), amount);
            form.appendChild(
                button('Add', () => {
                    const value = parseKMB(amount.value) || Number(amount.value);
                    this.addGoal({ type: 'gold', amount: value });
                })
            );
            return form;
        }

        if (type === 'equipment') {
            const items = Object.entries(gameData.itemDetailMap || {})
                .filter(([_hrid, detail]) => detail?.equipmentDetail)
                .map(([hrid, detail]) => ({ hrid, name: detail.name || hrid }))
                .sort((a, b) => a.name.localeCompare(b.name));

            const listId = 'toolasha-planner-items';
            const datalist = document.createElement('datalist');
            datalist.id = listId;
            for (const item of items) {
                const option = document.createElement('option');
                option.value = item.name;
                datalist.appendChild(option);
            }
            form.appendChild(datalist);

            const name = input({ placeholder: 'Sinister Cape', list: listId, width: '160px' });
            const level = input({ type: 'number', value: '10', min: 0, max: 20, width: '54px' });
            form.append(span('Item:', { color: COLORS.textDim }), name, span('+', { color: COLORS.textDim }), level);
            form.appendChild(
                button('Add', () => {
                    const match = items.find((item) => item.name.toLowerCase() === name.value.trim().toLowerCase());
                    if (!match) {
                        this._status('No item by that name.');
                        return;
                    }
                    this.addGoal({
                        type: 'equipment',
                        itemHrid: match.hrid,
                        enhancementLevel: Number(level.value),
                    });
                })
            );
            return form;
        }

        if (type === 'skill') {
            const skills = (dataManager.getSkills?.() || []).map((skill) => ({
                value: skill.skillHrid,
                label: skill.skillHrid
                    .split('/')
                    .pop()
                    .replace(/^./, (c) => c.toUpperCase()),
            }));
            const picker = select(skills.length ? skills : [{ value: '', label: 'No skills loaded' }]);
            const level = input({ type: 'number', value: '100', min: 1, max: 200, width: '58px' });
            form.append(
                span('Skill:', { color: COLORS.textDim }),
                picker,
                span('to', { color: COLORS.textDim }),
                level
            );
            form.appendChild(
                button('Add', () => {
                    if (!picker.value) return;
                    this.addGoal({ type: 'skill', skillHrid: picker.value, targetLevel: Number(level.value) });
                })
            );
            return form;
        }

        const rooms = Object.entries(gameData.houseRoomDetailMap || {})
            .map(([hrid, detail]) => ({ value: hrid, label: detail?.name || hrid.split('/').pop() }))
            .sort((a, b) => a.label.localeCompare(b.label));
        const picker = select(rooms.length ? rooms : [{ value: '', label: 'No rooms loaded' }]);
        const level = input({ type: 'number', value: '8', min: 1, max: 8, width: '54px' });
        form.append(span('Room:', { color: COLORS.textDim }), picker, span('to', { color: COLORS.textDim }), level);
        form.appendChild(
            button('Add', () => {
                if (!picker.value) return;
                this.addGoal({ type: 'house', roomHrid: picker.value, targetLevel: Number(level.value) });
            })
        );
        return form;
    }

    /**
     * One goal, with its plan below it.
     * @param {Object} goal - A normalised goal
     * @param {Object|null} plan - Its plan, when one has been computed
     * @returns {HTMLElement} The card
     */
    _goalCard(goal, plan) {
        const card = document.createElement('div');
        Object.assign(card.style, {
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '5px',
            padding: '7px 9px',
            marginBottom: '9px',
            background: COLORS.card,
        });

        const heading = document.createElement('div');
        Object.assign(heading.style, {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            borderBottom: `1px solid ${COLORS.hairline}`,
            paddingBottom: '4px',
            marginBottom: '5px',
        });

        const title = span(plan?.title || describeGoal(goal), { fontWeight: 'bold', color: COLORS.accent });
        heading.appendChild(title);

        if (plan) {
            const done = plan.satisfied || plan.totals.stepsDone === plan.totals.stepCount;
            heading.appendChild(
                span(done ? 'done' : `${plan.totals.stepsDone}/${plan.totals.stepCount} steps`, {
                    color: done ? COLORS.good : COLORS.textDim,
                    fontSize: '11px',
                })
            );
        }

        const spacer = document.createElement('div');
        spacer.style.flex = '1';
        heading.appendChild(spacer);
        heading.appendChild(
            button('✕', () => this.removeGoal(goal.id), {
                background: 'none',
                border: 'none',
                color: COLORS.textDim,
                padding: '0 2px',
            })
        );
        card.appendChild(heading);

        if (!plan) {
            card.appendChild(span('Not priced yet — press Refresh.', { display: 'block', color: COLORS.textDim }));
            return card;
        }

        for (const step of plan.steps) card.appendChild(this._stepRow(step));

        card.appendChild(this._totalsRow(plan));

        for (const warning of plan.confidence.warnings) {
            card.appendChild(span(`⚠ ${warning}`, { display: 'block', color: COLORS.warn, fontSize: '11px' }));
        }

        const note = span(plan.confidence.note, {
            display: 'block',
            color: COLORS.textDim,
            fontSize: '11px',
            marginTop: '3px',
        });
        card.appendChild(note);

        return card;
    }

    /**
     * One step of a plan.
     * @param {Object} step - A plan step
     * @returns {HTMLElement} The row
     */
    _stepRow(step) {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: '16px minmax(0, 1fr) 76px 92px',
            gap: '6px',
            alignItems: 'baseline',
            padding: '1px 0',
            opacity: step.done ? '0.5' : '1',
        });

        row.appendChild(span(KIND_GLYPH[step.kind] || '•', { color: COLORS.textDim }));

        const label = span(step.description, {
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            textDecoration: step.done ? 'line-through' : 'none',
        });
        label.title = step.description;
        row.appendChild(label);

        row.appendChild(
            span(step.done ? '' : signedCoins(step.goldDelta), {
                textAlign: 'right',
                color: step.goldDelta > 0 ? COLORS.good : step.goldDelta < 0 ? COLORS.bad : COLORS.textDim,
            })
        );
        row.appendChild(
            span(step.done ? 'done' : duration(step.timeHours), { textAlign: 'right', color: COLORS.textDim })
        );

        return row;
    }

    /**
     * The bottom line of one plan.
     * @param {Object} plan - A plan
     * @returns {HTMLElement} The row
     */
    _totalsRow(plan) {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: '16px minmax(0, 1fr) 76px 92px',
            gap: '6px',
            alignItems: 'baseline',
            borderTop: `1px solid ${COLORS.hairline}`,
            marginTop: '4px',
            paddingTop: '3px',
            fontWeight: 'bold',
        });

        row.appendChild(span(''));
        row.appendChild(span(plan.satisfied ? 'Already there' : 'Remaining'));
        row.appendChild(
            span(signedCoins(plan.totals.netGold), {
                textAlign: 'right',
                color: plan.totals.netGold >= 0 ? COLORS.good : COLORS.bad,
            })
        );
        row.appendChild(
            span(plan.totals.timeKnown ? duration(plan.totals.timeHours) : `${duration(plan.totals.timeHours)}+`, {
                textAlign: 'right',
            })
        );

        return row;
    }

    _remove() {
        this.detachDrag?.();
        this.detachDrag = null;
        this.detachResize?.();
        this.detachResize = null;

        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.bodyEl = null;
        this.statusEl = null;
    }
}

export const goalPlannerPanel = new GoalPlannerPanel();

export default goalPlannerPanel;
