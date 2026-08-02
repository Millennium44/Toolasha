/**
 * Ability Book panel
 *
 * Every ability at once: what its next level costs in books, and which of them
 * is the cheapest thing you could buy right now.
 *
 * The Item Dictionary already answers this for one ability — the one whose book
 * you happen to be looking at. That is the wrong shape for the question people
 * actually ask, which is not "what does this cost" but "what should I buy". You
 * cannot answer the second by opening the first eighteen times.
 *
 * ## Cheapest is not nearest
 *
 * The ability closest to its next level is rarely the cheapest to level. Books
 * differ in the experience they grant and by orders of magnitude in price, so
 * the ability two hundred experience from a level can cost more than one four
 * thousand away. The panel sorts by cost for that reason, and the overlay row
 * carries the winner.
 *
 * An unpriced book is **unknown, not free**. Treating a missing price as zero
 * would make whatever nobody is selling win every time, which is precisely
 * backwards. Those rows say so and are excluded from the cheapest.
 *
 * The arithmetic is in `utils/ability-books.js`, shared with the dictionary
 * calculator so the two cannot disagree about the same number.
 *
 * The panel is BRead's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { getItemPrices } from '../../utils/market-data.js';
import { formatWithSeparator, formatKMB } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry } from '../../utils/panel-geometry.js';
import { itemIcon, linkToMarketplace, ROW_COLORS } from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { abilityPlan, cheapestNextLevel, planTotals, bookItemFor } from '../../utils/ability-books.js';

const PANEL_ID = 'toolasha-ability-book-panel';
const GEOMETRY_KEY = 'abilityBookPanel';
const DEFAULT_PANEL = { width: 560, height: 560 };
const REFRESH_MS = 5000;

const COLORS = {
    background: 'rgba(14, 16, 22, 0.97)',
    card: 'rgba(255, 255, 255, 0.04)',
    headerBg: 'rgba(28, 24, 34, 0.9)',
    border: 'rgba(190, 170, 255, 0.32)',
    hairline: 'rgba(255, 255, 255, 0.10)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.5)',
    accent: '#b9a4ff',
};

/** The level every ability is being aimed at, when one is set */
let sharedTarget = null;

/**
 * An ability's readable name.
 * @param {string} abilityHrid - e.g. `/abilities/quick_shot`
 * @returns {string}
 */
function abilityName(abilityHrid) {
    const detail = dataManager.getInitClientData?.()?.abilityDetailMap?.[abilityHrid];
    if (detail?.name) return detail.name;

    return String(abilityHrid || '')
        .split('/')
        .pop()
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * A plan for every ability the character has.
 *
 * Exported because the overlay row reads it while the panel is closed, and
 * because a disagreement between the row and the panel would be here.
 *
 * @param {number|null} [targetLevel] - A level beyond the next one
 * @returns {Array<Object>} From `abilityPlan`, cheapest first
 */
export function abilityPlans(targetLevel = sharedTarget) {
    const data = dataManager.getInitClientData?.();
    const table = data?.levelExperienceTable;
    if (!table) return [];

    const plans = [];
    for (const ability of equippedAbilities()) {
        if (!ability?.abilityHrid) continue;

        const itemHrid = bookItemFor(ability.abilityHrid);
        const perBookExperience = data?.itemDetailMap?.[itemHrid]?.abilityBookDetail?.experienceGain;

        const plan = abilityPlan({
            ability,
            perBookExperience,
            bookPrice: getItemPrices(itemHrid)?.ask || 0,
            table,
            targetLevel,
        });
        if (plan) plans.push({ ...plan, name: abilityName(ability.abilityHrid) });
    }

    // Cheapest first, and the ones with no price last rather than first — they
    // are the least informative rows, not the most attractive
    return plans.sort((a, b) => {
        if (a.costToNext === null) return b.costToNext === null ? a.name.localeCompare(b.name) : 1;
        if (b.costToNext === null) return -1;
        return a.costToNext - b.costToNext;
    });
}

/**
 * The abilities actually in your kit, with their level and experience.
 *
 * Two sources, and both are needed. `combatUnit.combatAbilities` is the live
 * equipped state — the five slots — and is the only place that says which
 * abilities are in use rather than merely owned. `characterAbilities` is the
 * only place that carries experience, which is what "how far to the next level"
 * turns on. Neither alone answers the question.
 *
 * Not `getInitClientData()`, which is static game data: it has an
 * `abilityDetailMap` describing every ability in the game and nothing about
 * yours. Reading the character out of it is how this panel first shipped
 * showing an empty list.
 *
 * @returns {Array<{abilityHrid: string, level: number, experience: number}>}
 */
export function equippedAbilities() {
    const character = dataManager.characterData;
    const equipped = character?.combatUnit?.combatAbilities || [];
    const owned = character?.characterAbilities || [];

    const abilities = [];
    for (const slot of equipped) {
        if (!slot?.abilityHrid) continue;

        const known = owned.find((entry) => entry.abilityHrid === slot.abilityHrid);
        abilities.push({
            abilityHrid: slot.abilityHrid,
            level: known?.level ?? slot.level ?? 0,
            // Without the experience the level is a floor, not a position: every
            // ability would read as freshly levelled and every plan would be
            // the full cost of a level
            experience: known?.experience ?? 0,
        });
    }
    return abilities;
}

class AbilityBookPanel {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.refreshId = null;
    }

    show() {
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._create();
    }

    hide() {
        this._remove();
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '150px',
            left: '130px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: `${DEFAULT_PANEL.width}px`,
            height: `${DEFAULT_PANEL.height}px`,
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

        this.headerEl = this._header();
        this.panel.appendChild(this.headerEl);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.detachDrag = makeDraggable(this.panel, this.headerEl, (position) => {
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
        this.refreshId = setInterval(() => this._refresh(), REFRESH_MS);
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = document.createElement('span');
        title.textContent = 'Ability Books';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;

        this.headerBest = document.createElement('span');
        this.headerBest.style.color = ROW_COLORS.good;

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const close = document.createElement('button');
        close.textContent = '✕';
        Object.assign(close.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '13px',
            padding: '2px 4px',
        });
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            this.hide();
        });

        header.append(title, this.headerBest, spacer, close);
        return header;
    }

    /** The periodic redraw, which leaves a field being typed into alone */
    _refresh() {
        const active = document.activeElement;
        if (this.panel?.contains(active) && active.tagName === 'INPUT') return;
        this._render();
    }

    _render() {
        if (!this.bodyEl) return;

        const plans = abilityPlans();
        const best = cheapestNextLevel(plans);
        this.headerBest.textContent = best ? `${best.name}: ${formatKMB(best.costToNext)}` : '';
        this.headerBest.title = 'The cheapest next ability level you could buy right now.';

        this.bodyEl.replaceChildren();
        for (const build of [() => this._targetBar(plans), () => this._table(plans)]) {
            // One section that cannot be drawn must not take the other with it
            try {
                this.bodyEl.appendChild(build());
            } catch (error) {
                console.error('[AbilityBooks] A section could not be drawn:', error);
                const failed = this._note(`This section could not be drawn: ${error.message}`);
                failed.style.color = ROW_COLORS.bad;
                this.bodyEl.appendChild(failed);
            }
        }
    }

    /**
     * One target level for every ability, and what the lot would cost.
     * @param {Array<Object>} plans - From `abilityPlans`
     * @returns {HTMLElement}
     */
    _targetBar(plans) {
        const card = this._card();
        Object.assign(card.style, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });

        const label = this._label('Take everything to level');

        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.value = sharedTarget === null ? '' : String(sharedTarget);
        input.placeholder = 'next';
        Object.assign(input.style, {
            width: '68px',
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
            padding: '2px 3px',
            textAlign: 'right',
        });
        input.addEventListener('change', () => {
            const parsed = Math.round(Number(input.value));
            sharedTarget = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
            this._render();
        });
        // A level typed here should not also be a game hotkey
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') input.blur();
            event.stopPropagation();
        });

        const field = sharedTarget ? 'costToTarget' : 'costToNext';
        const totals = planTotals(plans, field);

        const summary = document.createElement('span');
        summary.append(
            this._value(`${formatWithSeparator(totals.books)} books`, ROW_COLORS.dim),
            document.createTextNode(' · '),
            this._value(formatKMB(totals.cost), ROW_COLORS.gold)
        );
        // A total that quietly excludes rows is a lower bound wearing a total's
        // clothes, so the count of what it could not price is said out loud
        if (totals.unpriced) {
            const missing = this._value(` (+${totals.unpriced} unpriced)`, ROW_COLORS.bad);
            missing.title = 'Books with no market price, which cannot be included in the total.';
            summary.appendChild(missing);
        }

        card.append(label, input, summary);
        return card;
    }

    /**
     * @param {Array<Object>} plans - From `abilityPlans`
     * @returns {HTMLElement}
     */
    _table(plans) {
        const card = this._card();

        const heading = this._row();
        heading.style.color = COLORS.textDim;
        heading.style.borderBottom = `1px solid ${COLORS.hairline}`;
        heading.style.paddingBottom = '3px';
        heading.append(
            document.createElement('span'),
            this._left('Ability'),
            this._cell('Level'),
            this._cell('Books'),
            this._cell('Cost'),
            this._cell(sharedTarget ? `To ${sharedTarget}` : '')
        );
        card.appendChild(heading);

        if (!plans.length) {
            card.appendChild(this._note('No abilities learned yet.'));
            return card;
        }

        for (const plan of plans) card.appendChild(this._planRow(plan));
        return card;
    }

    /**
     * @param {Object} plan - One ability's plan
     * @returns {HTMLElement}
     */
    _planRow(plan) {
        const line = this._row();
        line.style.padding = '2px 0';

        const icon = itemIcon(plan.itemHrid, 20);
        linkToMarketplace(icon, plan.itemHrid, navigateToMarketplace);

        const name = document.createElement('span');
        name.textContent = plan.name;
        Object.assign(name.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
        linkToMarketplace(name, plan.itemHrid, navigateToMarketplace);
        // An ability never learned reads differently from one at level 1, since
        // its first book buys the ability rather than a level
        if (plan.level === 0) {
            name.style.color = COLORS.textDim;
            name.title = 'Not learned — the first book teaches the ability rather than levelling it.';
        }

        const level = this._cell(plan.level === 0 ? '—' : String(plan.level));
        const books = this._cell(plan.booksToNext === null ? '—' : formatWithSeparator(plan.booksToNext));

        const cost = this._cell(plan.costToNext === null ? 'no price' : formatKMB(plan.costToNext));
        cost.style.color = plan.costToNext === null ? ROW_COLORS.bad : ROW_COLORS.gold;
        cost.title =
            plan.costToNext === null
                ? 'Nobody is selling this book, so its cost is unknown rather than nothing.'
                : `${formatWithSeparator(plan.booksToNext)} books at ${formatWithSeparator(plan.bookPrice)} each.`;

        const target = this._cell(
            plan.booksToTarget === null
                ? ''
                : `${formatWithSeparator(plan.booksToTarget)} · ${plan.costToTarget === null ? '—' : formatKMB(plan.costToTarget)}`
        );
        target.style.color = COLORS.textDim;

        line.append(icon, name, level, books, cost, target);
        return line;
    }

    _card() {
        const card = document.createElement('div');
        Object.assign(card.style, {
            background: COLORS.card,
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '6px',
            padding: '7px 9px',
        });
        return card;
    }

    _row() {
        const line = document.createElement('div');
        Object.assign(line.style, {
            display: 'grid',
            gridTemplateColumns: '22px minmax(0, 1fr) 50px 62px 80px 116px',
            gap: '6px',
            alignItems: 'center',
        });
        return line;
    }

    _cell(text) {
        const cell = document.createElement('span');
        cell.textContent = text;
        cell.style.textAlign = 'right';
        cell.style.whiteSpace = 'nowrap';
        return cell;
    }

    _left(text) {
        const cell = document.createElement('span');
        cell.textContent = text;
        return cell;
    }

    _label(text) {
        const label = document.createElement('span');
        label.textContent = text;
        label.style.color = COLORS.textDim;
        return label;
    }

    _value(text, color) {
        const value = document.createElement('span');
        value.textContent = text;
        if (color) value.style.color = color;
        return value;
    }

    _note(text) {
        const note = document.createElement('div');
        note.textContent = text;
        note.style.color = COLORS.textDim;
        return note;
    }

    _remove() {
        clearInterval(this.refreshId);
        this.refreshId = null;
        this.detachDrag?.();
        this.detachDrag = null;
        this.detachResize?.();
        this.detachResize = null;

        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.bodyEl = null;
    }
}

export const abilityBookPanel = new AbilityBookPanel();
