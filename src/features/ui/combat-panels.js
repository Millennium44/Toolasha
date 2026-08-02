/**
 * Combat panels
 *
 * The four combat tiles, opened up.
 *
 * Each of DPS, Deaths/hr, Drop Luck and Combat Revenue is one number on a tile,
 * and one number is the summary of something with parts. A DPS figure does not
 * say whether you are winning the exchange; a deaths-per-hour figure does not
 * say when the last one was; a luck percentile does not say how many coins the
 * verdict is about; a profit figure does not say which side of it moved.
 *
 * ## Why one module
 *
 * Four panels that read four existing collectors and do no arithmetic of their
 * own. They share a shell — header, body, drag, resize, remembered geometry —
 * because four copies of that is four places for a panel to open somewhere you
 * cannot reach it.
 *
 * Nothing here computes anything the tiles do not already compute. If a panel
 * and its tile ever disagree, the disagreement is in the collector.
 *
 * The panels correspond to DPs, IHurt, LYuck and HWhat from MWI Combat Suite by
 * Frotty (MIT) — see `third-party/mwi-combat-suite/` and
 * `docs/THIRD-PARTY-LICENSES.md`. The code is Toolasha's own.
 */

import config from '../../core/config.js';
import combatDPS from '../../features/combat/combat-dps.js';
import combatDropLuck, { formatOrdinal, describeLuck } from '../../features/combat/combat-drop-luck.js';
import combatStatsDataCollector from '../../features/combat-stats/combat-stats-data-collector.js';
import { formatWithSeparator, formatKMB, timeReadable } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry } from '../../utils/panel-geometry.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';

const REFRESH_MS = 2000;

const COLORS = {
    background: 'rgba(14, 16, 22, 0.97)',
    card: 'rgba(255, 255, 255, 0.04)',
    headerBg: 'rgba(24, 24, 34, 0.9)',
    border: 'rgba(150, 170, 255, 0.32)',
    hairline: 'rgba(255, 255, 255, 0.10)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.5)',
    accent: '#8fb4ff',
};

/**
 * The current player's slice of the combat statistics.
 * @returns {Object|null}
 */
function playerStats() {
    const data = combatStatsDataCollector.getLatestData?.();
    const player = data?.players?.find((entry) => entry.isCurrentPlayer);
    if (!player) return null;

    let duration = data.durationSeconds || 0;
    if (data.combatStartTime) {
        const elapsed = Date.now() / 1000 - new Date(data.combatStartTime).getTime() / 1000;
        if (elapsed > 0) duration = elapsed;
    }
    return { ...player, duration, encounters: data.totalEncounters || 0 };
}

/**
 * One panel, built from a function that fills its body.
 *
 * The shell is shared so a panel cannot open off-screen in one place and not
 * another, and so "remembered where I left it" is true of all four.
 */
class CombatPanel {
    /**
     * @param {Object} definition - What makes this panel itself
     * @param {string} definition.id - DOM id and geometry key
     * @param {string} definition.title - Header text
     * @param {{width: number, height: number}} definition.size - Opening size
     * @param {Function} definition.draw - `(body) => void`, called on every refresh
     */
    constructor({ id, title, size, draw }) {
        this.id = id;
        this.title = title;
        this.size = size;
        this.draw = draw;
        this.panel = null;
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
        clearInterval(this.refreshId);
        this.refreshId = null;
        this.detachDrag?.();
        this.detachResize?.();
        this.detachDrag = null;
        this.detachResize = null;

        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.bodyEl = null;
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = `toolasha-${this.id}-panel`;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '160px',
            left: '150px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: `${this.size.width}px`,
            height: `${this.size.height}px`,
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

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = document.createElement('span');
        title.textContent = this.title;
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;
        title.style.flex = '1';

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
        header.append(title, close);
        this.panel.appendChild(header);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '7px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.detachDrag = makeDraggable(this.panel, header, (position) => {
            saveGeometry(this.id, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: 300,
            minHeight: 180,
            onResize: (size) => saveGeometry(this.id, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, this.id, { width: 300, height: 180 });

        this._render();
        this.refreshId = setInterval(() => this._render(), REFRESH_MS);
    }

    _render() {
        if (!this.bodyEl) return;
        this.bodyEl.replaceChildren();

        // One panel that cannot be drawn says so rather than showing an empty
        // box, which reads as a feature that has nothing to report
        try {
            this.draw(this.bodyEl);
        } catch (error) {
            console.error(`[CombatPanels] ${this.title} could not be drawn:`, error);
            this.bodyEl.appendChild(note(`This could not be drawn: ${error.message}`, ROW_COLORS.bad));
        }
    }
}

/**
 * @param {string} text - What to say
 * @param {string} [color] - Ink
 * @returns {HTMLElement}
 */
function note(text, color = COLORS.textDim) {
    const element = document.createElement('div');
    element.textContent = text;
    element.style.color = color;
    return element;
}

/**
 * A labelled figure on its own line.
 *
 * @param {string} label - What it is
 * @param {string} value - What it says
 * @param {string} [color] - Ink for the value
 * @param {string} [title] - Tooltip
 * @returns {HTMLElement}
 */
function line(label, value, color = COLORS.text, title = '') {
    const element = document.createElement('div');
    Object.assign(element.style, { display: 'flex', gap: '8px', alignItems: 'baseline' });

    const name = document.createElement('span');
    name.textContent = label;
    name.style.color = COLORS.textDim;
    name.style.flex = '1';

    const figure = document.createElement('span');
    figure.textContent = value;
    figure.style.color = color;
    figure.style.whiteSpace = 'nowrap';

    if (title) element.title = title;
    element.append(name, figure);
    return element;
}

/**
 * A titled block.
 * @param {HTMLElement} body - Where it goes
 * @param {string} title - Heading
 * @returns {HTMLElement} The card, to append lines to
 */
function card(body, title) {
    const element = document.createElement('div');
    Object.assign(element.style, {
        background: COLORS.card,
        border: `1px solid ${COLORS.hairline}`,
        borderRadius: '6px',
        padding: '7px 9px',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
    });

    if (title) {
        const heading = document.createElement('div');
        heading.textContent = title;
        Object.assign(heading.style, { color: COLORS.accent, fontWeight: 'bold', marginBottom: '3px' });
        element.appendChild(heading);
    }
    body.appendChild(element);
    return element;
}

export const dpsPanel = new CombatPanel({
    id: 'dpsPanel',
    title: 'Damage',
    size: { width: 380, height: 320 },
    draw: (body) => {
        if (combatDPS.dps === null) {
            body.appendChild(note('Not enough of a fight measured yet.'));
            return;
        }

        const dealt = card(body, 'Dealt');
        dealt.append(
            line('Per second', formatWithSeparator(Math.round(combatDPS.dps)), ROW_COLORS.good),
            line('Total', formatKMB(combatDPS.damage), COLORS.text),
            line('Party size', String(combatDPS.partySize), COLORS.text),
            // Your own share is what a build change moves; the party's total is
            // mostly a statement about who else is in the party
            line(
                'Your share',
                combatDPS.partySize > 1
                    ? `${formatWithSeparator(Math.round(combatDPS.dps / combatDPS.partySize))}/s`
                    : 'all of it',
                ROW_COLORS.accent,
                'Damage divided evenly by party size — an estimate, since the game does not attribute hits.'
            )
        );

        const taken = card(body, 'Taken');
        taken.append(
            line('Per second', formatWithSeparator(Math.round(combatDPS.dtps ?? 0)), ROW_COLORS.bad),
            line('Total', formatKMB(combatDPS.taken), COLORS.text),
            // The ratio is the thing a health bar cannot tell you: whether you
            // are winning the exchange or merely surviving it
            line(
                'Exchange',
                combatDPS.dtps > 0 ? `${(combatDPS.dps / combatDPS.dtps).toFixed(1)}× in your favour` : 'untouched',
                ROW_COLORS.gold,
                'Damage dealt for every point taken.'
            )
        );

        const run = card(body, 'Run');
        run.append(line('Time fighting', timeReadable(Math.round(combatDPS.seconds)), COLORS.text));
        run.appendChild(
            note('Time fighting counts only the gaps between ticks of one fight, so idle time is not in it.')
        );
    },
});

export const deathsPanel = new CombatPanel({
    id: 'deathsPanel',
    title: 'Deaths',
    size: { width: 360, height: 280 },
    draw: (body) => {
        const stats = playerStats();
        if (!stats) {
            body.appendChild(note('No combat data yet.'));
            return;
        }

        const deaths = stats.deathCount || 0;
        const perHour = stats.duration > 0 ? (deaths / stats.duration) * 3600 : 0;

        const summary = card(body, 'This run');
        summary.append(
            line('Deaths', formatWithSeparator(deaths), deaths ? ROW_COLORS.bad : ROW_COLORS.good),
            line('Per hour', perHour ? perHour.toFixed(2) : '0', deaths ? ROW_COLORS.bad : ROW_COLORS.good),
            line('Run length', timeReadable(Math.round(stats.duration)), COLORS.text),
            line('Encounters', formatWithSeparator(stats.encounters), COLORS.text)
        );

        const rate = card(body, 'What that means');
        if (deaths > 0 && perHour > 0) {
            rate.append(
                line('One death every', timeReadable(Math.round(3600 / perHour)), ROW_COLORS.accent),
                line(
                    'Encounters per death',
                    stats.encounters ? formatWithSeparator(Math.round(stats.encounters / deaths)) : '—',
                    COLORS.text
                )
            );
        } else {
            rate.appendChild(note('No deaths this run — nothing to rate.'));
        }
        rate.appendChild(
            note('The game does not say what killed you, so this counts deaths rather than attributing them.')
        );
    },
});

export const dropLuckPanel = new CombatPanel({
    id: 'dropLuckPanel',
    title: 'Drop Luck',
    size: { width: 400, height: 300 },
    draw: (body) => {
        const result = combatDropLuck.lastResult;
        if (!result) {
            body.appendChild(note('No luck reading yet — it is computed when you return from combat.'));
            return;
        }

        const verdict = card(body, 'Verdict');
        verdict.append(
            line('Percentile', formatOrdinal(result.percentile), ROW_COLORS.accent),
            line('In words', describeLuck(result.percentile), COLORS.text)
        );

        const numbers = card(body, 'What it is about');
        const difference = (result.income || 0) - (result.expected || 0);
        numbers.append(
            line('Income', formatKMB(result.income), ROW_COLORS.good),
            line('Expected', formatKMB(result.expected), COLORS.text),
            // The percentile alone cannot say whether the verdict is about a
            // fortune or a rounding error
            line(
                'Difference',
                `${difference >= 0 ? '+' : ''}${formatKMB(difference)}`,
                difference >= 0 ? ROW_COLORS.good : ROW_COLORS.bad,
                'How many coins the verdict is actually about.'
            ),
            line('Battles', formatWithSeparator(result.battles), COLORS.text)
        );

        if (result.hasBonuses) {
            body.appendChild(
                note('Drop-rate bonuses were included in the expectation, so this is luck against your own setup.')
            );
        }
    },
});

export const profitPanel = new CombatPanel({
    id: 'profitPanel',
    title: 'Combat Profit',
    size: { width: 420, height: 380 },
    draw: (body) => {
        const stats = playerStats();
        if (!stats) {
            body.appendChild(note('No combat data yet.'));
            return;
        }

        // Both sides, because which one is honest depends on whether you intend
        // to sell into the bids or wait at the asks — and the gap between them
        // is frequently the whole profit
        for (const side of ['ask', 'bid']) {
            const block = card(body, side === 'ask' ? 'At ask (patient)' : 'At bid (immediate)');
            const income = stats.dailyIncome?.[side] ?? 0;
            const profit = stats.dailyProfit?.[side] ?? 0;
            const costs = income - profit;

            block.append(
                line('Income/day', formatKMB(income), ROW_COLORS.good),
                line('Costs/day', formatKMB(costs), ROW_COLORS.bad),
                line('Profit/day', formatKMB(profit), profit >= 0 ? ROW_COLORS.gold : ROW_COLORS.bad),
                line('Profit/hour', formatKMB(profit / 24), profit >= 0 ? ROW_COLORS.gold : ROW_COLORS.bad)
            );
        }

        const breakdown = card(body, 'What the costs are');
        breakdown.append(
            line('Consumables/day', formatKMB(stats.dailyConsumableCosts ?? 0), ROW_COLORS.bad),
            line('Keys/day', formatKMB(stats.dailyKeyCosts ?? 0), ROW_COLORS.bad),
            line('Run length', timeReadable(Math.round(stats.duration)), COLORS.text)
        );
        breakdown.appendChild(
            note('Daily figures are this run extrapolated, so a short run extrapolates its own noise.')
        );
    },
});
