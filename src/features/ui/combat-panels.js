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
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import combatDPS from '../../features/combat/combat-dps.js';
import combatStatsDataCollector from '../../features/combat-stats/combat-stats-data-collector.js';
import { calculatePlayerStats } from '../../features/combat-stats/combat-stats-calculator.js';
import {
    damageBreakdown,
    actionLabel,
    isFilteringNonDamaging,
    setFilterNonDamaging,
    resetDamageTracker,
} from '../../features/combat/damage-tracker.js';
import { formatWithSeparator, formatKMB, timeReadable } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry } from '../../utils/panel-geometry.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';
import { getItemPrices } from '../../utils/market-data.js';

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
function runSeconds(data) {
    let duration = data?.durationSeconds || 0;
    if (data?.combatStartTime) {
        const elapsed = Date.now() / 1000 - new Date(data.combatStartTime).getTime() / 1000;
        if (elapsed > 0) duration = elapsed;
    }
    return duration;
}

/**
 * The current player's statistics, costed.
 *
 * Through `calculatePlayerStats`, which is where `dailyIncome`, `dailyProfit`
 * and the cost figures are produced — the raw player carries none of them. The
 * Profit panel first shipped reading the raw player and showed a column of
 * zeroes for it, which is what a missing field looks like when every branch
 * defaults to nought.
 *
 * @returns {Object|null}
 */
function playerStats() {
    const data = combatStatsDataCollector.getLatestData?.();
    const player = data?.players?.find((entry) => entry.isCurrentPlayer);
    if (!player) return null;

    const duration = runSeconds(data);
    return { ...calculatePlayerStats(player, duration), duration, encounters: data.totalEncounters || 0 };
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
     * @param {Function} [definition.controls] - `(bar) => void`, header buttons,
     *   redrawn with the body so a toggle shows the state it is actually in
     */
    constructor({ id, title, size, minSize, draw, controls }) {
        this.id = id;
        this.title = title;
        this.size = size;
        // A table has a width below which it is no longer a table, and a panel
        // remembers whatever it was last dragged to — including a width set
        // before it held a table at all
        this.minSize = minSize || { width: 300, height: 180 };
        this.draw = draw;
        this.controls = controls;
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
        // Between the title and the close button, as HWhat has them
        this.controlsEl = document.createElement('div');
        Object.assign(this.controlsEl.style, { display: 'flex', gap: '4px', marginRight: '6px' });
        // The bar is part of the header, which drags — a button that drags the
        // panel instead of pressing is a button that reads as broken
        this.controlsEl.addEventListener('mousedown', (event) => event.stopPropagation());

        header.append(title, this.controlsEl, close);
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
            minWidth: this.minSize.width,
            minHeight: this.minSize.height,
            onResize: (size) => saveGeometry(this.id, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, this.id, this.minSize);

        // A remembered width from before this panel held a table is a width the
        // table cannot be read at, and nothing else would ever widen it again
        if (parseFloat(this.panel.style.width) < this.minSize.width) {
            this.panel.style.width = `${this.size.width}px`;
        }

        this._render();
        this.refreshId = setInterval(() => this._render(), REFRESH_MS);
    }

    /** Redraw now rather than on the next tick, after a control is pressed */
    refresh() {
        this._render();
    }

    _render() {
        if (!this.bodyEl) return;
        this.bodyEl.replaceChildren();

        if (this.controls && this.controlsEl) {
            this.controlsEl.replaceChildren();
            try {
                this.controls(this.controlsEl);
            } catch (error) {
                console.error(`[CombatPanels] ${this.title} controls could not be drawn:`, error);
            }
        }

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

/**
 * Which rows are open, kept between redraws.
 *
 * In the DOM it would be lost every two seconds when the panel repaints, which
 * is a row that closes itself while you are reading it.
 */
const expandedRows = new Set();

/**
 * The table's columns, proportional rather than fixed.
 *
 * Fixed pixels add up to more than a panel somebody has narrowed, and the
 * column that pays for it is the first one — so the name, which is the only
 * cell you cannot infer from context, becomes "Mi…". Proportions share the
 * squeeze out instead, and the minimums stop any column collapsing to nothing.
 */
const DPS_COLUMNS =
    'minmax(72px, 1.7fr) minmax(38px, 0.7fr) minmax(74px, 1.35fr) ' +
    'minmax(32px, 0.55fr) minmax(62px, 1.05fr) minmax(58px, 1fr) minmax(58px, 1fr)';

/**
 * One line of the damage table.
 *
 * A grid rather than a flex row: the columns have to line up between the player
 * row and the ability rows underneath it, and a table that does not line up is
 * a table you read one cell at a time.
 *
 * @param {Array<{text: string, color?: string, bold?: boolean, align?: string}>} cells - Seven of them
 * @param {Object} [options] - `{dim, indent}`
 * @returns {HTMLElement}
 */
function dpsRow(cells, { dim = false, indent = 0 } = {}) {
    const row = document.createElement('div');
    Object.assign(row.style, {
        display: 'grid',
        gridTemplateColumns: DPS_COLUMNS,
        gap: '4px',
        alignItems: 'center',
        padding: '2px 0',
        fontSize: dim ? '10.5px' : '11.5px',
        // Digits of one width, so a column of figures reads as a column rather
        // than as a ragged edge that shifts every time a number changes
        fontVariantNumeric: 'tabular-nums',
    });

    cells.forEach((cell, index) => {
        const span = document.createElement('span');
        span.textContent = cell.text;
        // A cell that has been ellipsised is still worth reading, and the name
        // column is the one that truncates first and matters most
        span.title = cell.text;
        Object.assign(span.style, {
            color: cell.color || (dim ? COLORS.textDim : COLORS.text),
            fontWeight: cell.bold ? 'bold' : 'normal',
            textAlign: index === 0 ? 'left' : 'right',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            paddingLeft: index === 0 ? `${indent}px` : '0',
        });
        row.appendChild(span);
    });
    return row;
}

/**
 * A count with its share of the attempts, as MCS writes them: `193 (78.8%)`.
 *
 * The bare count says nothing without the attempts it came from, and the bare
 * percentage hides how few swings it was computed over.
 *
 * @param {number} count - How many
 * @param {number} outOf - Of how many
 * @returns {string}
 */
function countAndShare(count, outOf) {
    if (!(outOf > 0)) return formatWithSeparator(count);
    return `${formatWithSeparator(count)} (${((count / outOf) * 100).toFixed(1)}%)`;
}

/**
 * DPs' second reading of the same run: what the corpses say.
 *
 * The table measures attributed hits, and attribution has holes — a bleed, a
 * tick before the counters were known, a fight where two people cast together.
 * The health bars do not: a monster is dead or it is not, and its bar was worth
 * exactly what it was worth. So the same run gets a second figure that cannot
 * drift, and where the two disagree the difference is what attribution missed.
 *
 * It is quoted twice, as DPs quotes it. Against **battle time** it says how
 * hard the party hits; against **total time** it says what the run actually
 * produced, and the gap between them is time spent walking rather than
 * fighting. No rotation fixes that gap — a zone with a shorter respawn does.
 *
 * @param {Object} breakdown - From `damageBreakdown`
 * @returns {HTMLElement}
 */
function enemyHealthCard(breakdown) {
    const holder = document.createElement('div');
    Object.assign(holder.style, {
        border: `1px solid ${ROW_COLORS.gold}`,
        borderRadius: '6px',
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        background: 'rgba(255, 214, 102, 0.04)',
    });

    const killed = breakdown.enemies.filter((enemy) => enemy.kills > 0 && enemy.maxHP > 0);

    const title = document.createElement('div');
    title.textContent = 'DPS based off enemy HPs';
    Object.assign(title.style, { color: ROW_COLORS.gold, fontWeight: 'bold' });

    if (!killed.length) {
        holder.append(title, note('Nothing has died yet, so there are no health bars to count.'));
        return holder;
    }

    const health = killed.reduce((sum, enemy) => sum + enemy.kills * enemy.maxHP, 0);
    const kills = killed.reduce((sum, enemy) => sum + enemy.kills, 0);
    const battleTime = breakdown.seconds;
    const totalTime = Math.max(breakdown.logging, battleTime);

    const totalDPS = totalTime > 0 ? health / totalTime : null;
    const battleDPS = battleTime > 0 ? health / battleTime : null;

    // Title on the left, the three figures on the right, as DPs arranges them —
    // the caption under each is what makes three similar numbers legible
    const heading = document.createElement('div');
    Object.assign(heading.style, {
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: '10px',
        flexWrap: 'wrap',
    });
    const figures = document.createElement('div');
    Object.assign(figures.style, { display: 'flex', gap: '14px', marginLeft: 'auto' });
    figures.append(
        bigFigure(totalDPS, 'total time DPS', ROW_COLORS.gold),
        bigFigure(battleDPS, 'battle time DPS', ROW_COLORS.gold),
        bigFigure(
            totalDPS === null || battleDPS === null ? null : battleDPS - totalDPS,
            'DPS loss between battles',
            ROW_COLORS.bad
        )
    );
    heading.append(title, figures);
    holder.appendChild(heading);
    holder.appendChild(note('Based on enemy max HP only.'));

    // One strip rather than four rows: they are the inputs to the figures
    // above, and a column of labels reads as if they were findings themselves
    const strip = document.createElement('div');
    Object.assign(strip.style, {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 16px',
        fontSize: '11px',
        color: COLORS.textDim,
        borderTop: `1px solid ${COLORS.hairline}`,
        paddingTop: '5px',
    });
    strip.append(
        statPair('Time logging', timeReadable(Math.round(totalTime)), ROW_COLORS.good),
        statPair('Time in battle', timeReadable(Math.round(battleTime)), ROW_COLORS.good),
        statPair('Total health destroyed', formatKMB(health), ROW_COLORS.good),
        statPair('Total enemies killed', formatWithSeparator(kills), COLORS.text)
    );
    holder.appendChild(strip);

    // Two to a row, each its own tile, as DPs draws them. A flat list of four
    // similar sentences is read one at a time; a grid is read at a glance.
    const grid = document.createElement('div');
    Object.assign(grid.style, {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: '6px',
    });
    for (const enemy of killed) grid.appendChild(enemyTile(enemy));
    holder.appendChild(grid);

    holder.appendChild(
        note(
            'Counted from full health bars rather than from attributed hits, so it does not drift where ' +
                'attribution cannot see — a bleed, or a tick before the counters were known.'
        )
    );
    return holder;
}

/**
 * One of the three headline figures, with the caption that tells them apart.
 *
 * @param {number|null} value - The figure
 * @param {string} caption - What it is
 * @param {string} color - Ink
 * @returns {HTMLElement}
 */
function bigFigure(value, caption, color) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { textAlign: 'right' });

    const figure = document.createElement('div');
    figure.textContent = value === null ? '—' : value.toFixed(1);
    Object.assign(figure.style, { color, fontSize: '17px', fontWeight: 'bold', lineHeight: '1.2' });

    const label = document.createElement('div');
    label.textContent = caption;
    Object.assign(label.style, { color: COLORS.textDim, fontSize: '10px', fontStyle: 'italic' });

    wrap.append(figure, label);
    return wrap;
}

/**
 * A label and its figure, side by side, for the strip under the headline.
 *
 * @param {string} label - What it is
 * @param {string} value - The figure
 * @param {string} color - Ink for the figure
 * @returns {HTMLElement}
 */
function statPair(label, value, color) {
    const wrap = document.createElement('span');
    const name = document.createElement('span');
    name.textContent = `${label}: `;
    const figure = document.createElement('span');
    figure.textContent = value;
    figure.style.color = color;
    figure.style.fontWeight = 'bold';
    wrap.append(name, figure);
    return wrap;
}

/**
 * What one kind of monster contributed, as its own tile.
 *
 * Named and priced, because "fifty kills" is a different run depending on
 * whether they were rats or bosses.
 *
 * @param {Object} enemy - From `damageBreakdown`
 * @returns {HTMLElement}
 */
function enemyTile(enemy) {
    const tile = document.createElement('div');
    Object.assign(tile.style, {
        borderLeft: `3px solid ${ROW_COLORS.bad}`,
        borderRadius: '4px',
        background: 'rgba(248, 113, 113, 0.08)',
        padding: '4px 8px',
    });

    const name = document.createElement('div');
    name.textContent = enemy.name;
    Object.assign(name.style, { color: ROW_COLORS.bad, fontWeight: 'bold', fontSize: '11.5px' });

    const sum = document.createElement('div');
    sum.textContent =
        `${formatWithSeparator(enemy.kills)} kills × ${formatKMB(enemy.maxHP)} HP = ` +
        `${formatKMB(enemy.kills * enemy.maxHP)}`;
    Object.assign(sum.style, { color: COLORS.textDim, fontSize: '10.5px' });

    tile.append(name, sum);
    return tile;
}

export const dpsPanel = new CombatPanel({
    id: 'dpsPanel',
    title: 'DPs',
    size: { width: 620, height: 460 },
    minSize: { width: 460, height: 220 },
    controls: (bar) => {
        // The two buttons DPs carries in its header, where it carries them
        bar.appendChild(
            toggleButton(
                `Filter Nondamage: ${isFilteringNonDamaging() ? 'Enabled' : 'Off'}`,
                isFilteringNonDamaging(),
                () => {
                    setFilterNonDamaging(!isFilteringNonDamaging());
                    dpsPanel.refresh();
                }
            )
        );
        bar.appendChild(
            toggleButton('Reset', false, () => {
                resetDamageTracker();
                dpsPanel.refresh();
            })
        );
    },
    draw: (body) => {
        const breakdown = damageBreakdown();
        const partyDamage = breakdown.players.reduce((sum, player) => sum + player.damage, 0);

        // The header line DPs leads with: the one figure, and what it was
        // computed from, before any of the breakdown
        const heading = document.createElement('div');
        Object.assign(heading.style, {
            display: 'flex',
            gap: '10px',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            paddingBottom: '4px',
            borderBottom: `1px solid ${COLORS.hairline}`,
        });
        const dpsFigure = document.createElement('span');
        dpsFigure.textContent = `DPS ${Number.isFinite(combatDPS.dps) ? combatDPS.dps.toFixed(1) : '—'}`;
        Object.assign(dpsFigure.style, { color: ROW_COLORS.gold, fontWeight: 'bold', fontSize: '14px' });
        heading.append(
            dpsFigure,
            piece(`Total Damage: ${formatKMB(partyDamage)}`, COLORS.textDim),
            piece(timeReadable(Math.round(breakdown.seconds)), COLORS.textDim)
        );
        body.appendChild(heading);

        if (!breakdown.players.length) {
            body.appendChild(
                note('No attributed hits yet. Damage is credited by whose mana fell, so it needs a cast to start.')
            );
            return;
        }

        const header = dpsRow(
            [
                { text: 'Character / Ability' },
                { text: 'DPS' },
                { text: 'Damage' },
                { text: 'Atks' },
                { text: 'Hit' },
                { text: 'Crit' },
                { text: 'Miss' },
            ],
            { dim: true }
        );
        header.style.borderBottom = `1px solid ${COLORS.hairline}`;
        header.style.color = COLORS.textDim;
        body.appendChild(header);

        for (const player of breakdown.players) {
            const open = expandedRows.has(player.index);
            const swings = player.hits + player.misses;

            const row = dpsRow([
                { text: `${open ? '▼' : '▶'}  ${player.name}`, color: ROW_COLORS.accent, bold: true },
                {
                    text: player.dps === null ? '—' : String(Math.round(player.dps)),
                    color: ROW_COLORS.good,
                    bold: true,
                },
                // The bare figure, as DPs shows it on a character row. The share
                // of a party total is on the rows underneath, where it says
                // something; on the only player in a solo run it says 100%.
                { text: formatKMB(player.damage), color: ROW_COLORS.good },
                { text: formatWithSeparator(swings) },
                { text: countAndShare(player.hits, swings), color: ROW_COLORS.good },
                { text: countAndShare(player.crits, player.hits), color: ROW_COLORS.gold },
                { text: countAndShare(player.misses, swings), color: ROW_COLORS.bad },
            ]);
            row.style.cursor = 'pointer';
            row.title = 'Click for the per-ability breakdown.';
            row.addEventListener('click', () => {
                if (open) expandedRows.delete(player.index);
                else expandedRows.add(player.index);
                dpsPanel.refresh();
            });
            body.appendChild(row);

            if (!open) continue;

            for (const ability of player.abilities) {
                const attempts = ability.hits + ability.misses;
                const abilityShare = player.damage > 0 ? (ability.damage / player.damage) * 100 : 0;
                body.appendChild(
                    dpsRow(
                        [
                            { text: `• ${actionLabel(ability.action)}` },
                            {
                                text: breakdown.seconds > 0 ? (ability.damage / breakdown.seconds).toFixed(1) : '—',
                                color: ROW_COLORS.good,
                            },
                            {
                                text: `${formatKMB(ability.damage)} (${abilityShare.toFixed(1)}%)`,
                                color: ROW_COLORS.good,
                            },
                            { text: formatWithSeparator(attempts) },
                            { text: countAndShare(ability.hits, attempts), color: ROW_COLORS.good },
                            { text: countAndShare(ability.crits, ability.hits), color: ROW_COLORS.gold },
                            { text: countAndShare(ability.misses, attempts), color: ROW_COLORS.bad },
                        ],
                        { dim: true, indent: 14 }
                    )
                );
            }

            // Under the player who fought them, as DPs nests them: collapsing a
            // player takes their enemies with them. A party's enemy rows at the
            // top level would average two people's fights into neither.
            for (const enemy of player.enemies || []) {
                const enemyKey = `enemy:${player.index}:${enemy.name}`;
                const enemyOpen = expandedRows.has(enemyKey);
                const enemySwings = enemy.hits + enemy.misses;
                const enemyShare = player.damage > 0 ? (enemy.damage / player.damage) * 100 : 0;

                const enemyRow = dpsRow(
                    [
                        { text: `${enemyOpen ? '▼' : '▶'}  ${enemy.name}`, color: ROW_COLORS.bad, bold: true },
                        { text: Number.isFinite(enemy.dps) ? enemy.dps.toFixed(1) : '—', color: ROW_COLORS.good },
                        { text: `${formatKMB(enemy.damage)} (${enemyShare.toFixed(1)}%)`, color: ROW_COLORS.good },
                        { text: formatWithSeparator(enemySwings) },
                        { text: countAndShare(enemy.hits, enemySwings), color: ROW_COLORS.good },
                        { text: countAndShare(enemy.crits, enemy.hits), color: ROW_COLORS.gold },
                        { text: countAndShare(enemy.misses, enemySwings), color: ROW_COLORS.bad },
                    ],
                    { indent: 10 }
                );
                enemyRow.style.cursor = 'pointer';
                enemyRow.title = 'Click for what was used against it.';
                enemyRow.addEventListener('click', () => {
                    if (enemyOpen) expandedRows.delete(enemyKey);
                    else expandedRows.add(enemyKey);
                    dpsPanel.refresh();
                });
                body.appendChild(enemyRow);

                if (!enemyOpen) continue;

                // The question an enemy row raises: is it tanky, or is the
                // wrong thing being pointed at it
                for (const ability of enemy.abilities || []) {
                    const attempts = ability.hits + ability.misses;
                    const abilityShare = enemy.damage > 0 ? (ability.damage / enemy.damage) * 100 : 0;
                    body.appendChild(
                        dpsRow(
                            [
                                { text: `• ${actionLabel(ability.action)}` },
                                {
                                    text: breakdown.seconds > 0 ? (ability.damage / breakdown.seconds).toFixed(1) : '—',
                                    color: ROW_COLORS.good,
                                },
                                {
                                    text: `${formatKMB(ability.damage)} (${abilityShare.toFixed(1)}%)`,
                                    color: ROW_COLORS.good,
                                },
                                { text: formatWithSeparator(attempts) },
                                { text: countAndShare(ability.hits, attempts), color: ROW_COLORS.good },
                                { text: countAndShare(ability.crits, ability.hits), color: ROW_COLORS.gold },
                                { text: countAndShare(ability.misses, attempts), color: ROW_COLORS.bad },
                            ],
                            { dim: true, indent: 24 }
                        )
                    );
                }
            }
        }

        body.appendChild(enemyHealthCard(breakdown));

        // The exchange, which the table cannot show: a party doing well on
        // paper is still losing if it is taking more than it deals
        const exchange = card(body, 'Party');
        exchange.append(
            line('Taken per second', formatWithSeparator(Math.round(combatDPS.dtps ?? 0)), ROW_COLORS.bad),
            line(
                'Exchange',
                combatDPS.dtps > 0 ? `${(combatDPS.dps / combatDPS.dtps).toFixed(1)}× in your favour` : 'untouched',
                ROW_COLORS.gold
            ),
            line('Time fighting', timeReadable(Math.round(combatDPS.seconds)), COLORS.text)
        );

        body.appendChild(
            note(
                'Attribution comes from whose mana fell on each tick, which is the only join the game offers. ' +
                    'A tick where two players cast at once credits the last one seen.'
            )
        );
    },
});

export const deathsPanel = new CombatPanel({
    id: 'deathsPanel',
    title: 'Deaths',
    size: { width: 380, height: 300 },
    draw: (body) => {
        const data = combatStatsDataCollector.getLatestData?.();
        const players = data?.players || [];
        if (!players.length) {
            body.appendChild(note('No combat data yet.'));
            return;
        }

        const duration = runSeconds(data);
        const total = players.reduce((sum, player) => sum + (player.deathCount || 0), 0);

        const summary = card(body, 'Session');
        summary.append(
            line('Elapsed', timeReadable(Math.round(duration)), COLORS.text),
            line('Party deaths', formatWithSeparator(total), total ? ROW_COLORS.bad : ROW_COLORS.good),
            line(
                'Party deaths/hr',
                duration > 0 ? ((total / duration) * 3600).toFixed(1) : '0.0',
                total ? ROW_COLORS.bad : ROW_COLORS.good
            )
        );

        // Per player, which is what IHurt is for: a party figure says the group
        // is dying and not who, and "who" is the whole question when one member
        // is under-geared for the zone
        const perPlayer = card(body, 'Per player');
        for (const player of players) {
            const deaths = player.deathCount || 0;
            const perHour = duration > 0 ? (deaths / duration) * 3600 : 0;
            perPlayer.appendChild(
                line(
                    player.name || player.characterName || 'Unknown',
                    `${formatWithSeparator(deaths)}  ·  ${perHour.toFixed(1)}/hr`,
                    deaths ? ROW_COLORS.bad : ROW_COLORS.good,
                    player.isCurrentPlayer ? 'You' : ''
                )
            );
        }

        perPlayer.appendChild(
            note('The game reports that a death happened, not what caused it, so these are counts rather than causes.')
        );
    },
});

/**
 * How the profit is being read: which case, and what is subtracted.
 *
 * HWhat keeps the same three settings, because the cases are not equally
 * interesting to everybody — somebody who sells into bids and buys from asks
 * is always reading the Lazy line and never the other three.
 *
 * Persisted rather than held for the session. The overlay tile follows these
 * now, and a tile that silently reverts to a different reading of profit every
 * time the page reloads is worse than one that never followed at all.
 */
const PROFIT_SETTINGS_KEY = 'combatProfitView';

const profitView = { mode: 'mid', costsOn: true, taxOn: false };

storage
    .getJSON(PROFIT_SETTINGS_KEY, 'settings', null)
    .then((saved) => {
        if (saved) Object.assign(profitView, saved);
    })
    .catch((error) => console.error('[CombatPanels] Reading the profit view failed:', error));

/**
 * Remember how profit is being read, and redraw what follows it.
 */
function saveProfitView() {
    storage
        .setJSON(PROFIT_SETTINGS_KEY, { ...profitView }, 'settings')
        .catch((error) => console.error('[CombatPanels] Saving the profit view failed:', error));
    profitPanel.refresh();
}

/**
 * A profit box in HWhat's shape: the case, the figure, the rule, the sum.
 *
 * The arithmetic line is the part worth copying. "55.6M/day" is a conclusion,
 * and `67.6M - 12.0M = 55.6M` is the same conclusion with its working shown —
 * which is what tells you whether a bad number is a revenue problem or a cost
 * problem without opening anything else.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} scenario - `{title, colour, equation, revenue, cost}`
 * @returns {HTMLElement}
 */
function profitBox(body, scenario, tax = 0) {
    const value = scenario.revenue - (profitView.costsOn ? scenario.cost : 0) - tax;
    const colour = value >= 0 ? scenario.colour : ROW_COLORS.bad;

    const block = card(body);
    block.style.borderLeft = `3px solid ${colour}`;

    const heading = document.createElement('div');
    heading.textContent = scenario.shorthand ? `${scenario.title}  (${scenario.shorthand})` : scenario.title;
    Object.assign(heading.style, { color: colour, fontWeight: 'bold' });

    const figure = document.createElement('div');
    figure.textContent = `${formatKMB(value)} coin/day`;
    Object.assign(figure.style, { color: colour, fontSize: '17px', fontWeight: 'bold', lineHeight: '1.3' });

    const rule = document.createElement('div');
    rule.textContent =
        (profitView.costsOn ? scenario.equation : scenario.equation.split(' - ')[0]) + (tax ? ' - Tax' : '');
    Object.assign(rule.style, { color: COLORS.textDim, fontSize: '11px' });

    const terms = [formatKMB(scenario.revenue)];
    if (profitView.costsOn) terms.push(formatKMB(scenario.cost));
    if (tax) terms.push(formatKMB(tax));

    const sum = document.createElement('div');
    sum.textContent = terms.length > 1 ? `${terms.join(' - ')} = ${formatKMB(value)}` : terms[0];
    Object.assign(sum.style, {
        color: colour,
        opacity: '0.75',
        fontSize: '11px',
        fontFamily: 'monospace',
        marginTop: '2px',
    });

    block.append(heading, figure, rule, sum);
    return block;
}

/**
 * A header toggle, in HWhat's pill shape.
 *
 * @param {string} label - What it says
 * @param {boolean} on - Whether it reads as engaged
 * @param {Function} onClick - What pressing it does
 * @returns {HTMLElement}
 */
function toggleButton(label, on, onClick) {
    const button = document.createElement('button');
    button.textContent = label;
    Object.assign(button.style, {
        background: on ? 'rgba(143, 180, 255, 0.22)' : 'rgba(255, 255, 255, 0.05)',
        border: `1px solid ${on ? COLORS.accent : COLORS.hairline}`,
        borderRadius: '4px',
        color: on ? COLORS.accent : COLORS.textDim,
        cursor: 'pointer',
        fontSize: '11px',
        padding: '2px 8px',
        whiteSpace: 'nowrap',
    });
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
    });
    return button;
}

/**
 * The three cases, each a revenue side and a cost side.
 *
 * They are not "at ask" and "at bid": you sell and buy on opposite sides of the
 * book, so each case mixes one side of each.
 *
 * @param {Object} stats - From `playerStats`
 * @returns {Array<Object>}
 */
function profitCases(stats) {
    const revenue = { ask: stats.dailyIncome?.ask ?? 0, bid: stats.dailyIncome?.bid ?? 0 };
    const cost = {
        ask:
            (stats.dailyConsumableCosts?.ask ?? stats.dailyConsumableCosts ?? 0) +
            (stats.dailyKeyCosts?.ask ?? stats.dailyKeyCosts ?? 0),
        bid:
            (stats.dailyConsumableCosts?.bid ?? stats.dailyConsumableCosts ?? 0) +
            (stats.dailyKeyCosts?.bid ?? stats.dailyKeyCosts ?? 0),
    };

    // All four ways round the book, each once. Lazy, Mid and Patient are the
    // three worth a name; Ask - Ask is the fourth corner — everything at the
    // asking price, which is the optimistic reading and the one HWhat shows
    // last.
    return [
        {
            key: 'lazy',
            title: 'Lazy Profit',
            shorthand: 'Bid - Ask',
            colour: ROW_COLORS.good,
            equation: 'Revenue (Bid) - Cost (Ask)',
            revenue: revenue.bid,
            cost: cost.ask,
        },
        {
            key: 'mid',
            title: 'Mid Profit',
            shorthand: 'Bid - Bid',
            colour: ROW_COLORS.accent,
            equation: 'Revenue (Bid) - Cost (Bid)',
            revenue: revenue.bid,
            cost: cost.bid,
        },
        {
            key: 'patient',
            title: 'Patient Profit',
            shorthand: 'Ask - Bid',
            colour: ROW_COLORS.gold,
            equation: 'Revenue (Ask) - Cost (Bid)',
            revenue: revenue.ask,
            cost: cost.bid,
        },
        {
            key: 'askask',
            title: 'Ask - Ask',
            shorthand: '',
            colour: '#c79ae8',
            equation: 'Revenue (Ask) - Cost (Ask)',
            revenue: revenue.ask,
            cost: cost.ask,
        },
    ];
}

/**
 * How the overlay tile should read profit, given stats it has already computed.
 *
 * The tile used to be hard-wired to bid revenue less every cost, which is one
 * of four readings and not the one somebody who has chosen Patient in the panel
 * is thinking in. Rather than have the tile guess, the panel says: the case
 * that is selected, with the tax in it if the tax is on.
 *
 * Takes the caller's stats rather than fetching its own, so the tile keeps its
 * own cache and nothing is priced twice per tick.
 *
 * @param {Object} stats - From `calculatePlayerStats`
 * @returns {{title: string, revenue: number, cost: number, tax: number, profit: number}|null}
 */
export function combatProfitView(stats) {
    if (!stats) return null;

    const cases = profitCases(stats);
    const headline = cases.find((scenario) => scenario.key === profitView.mode) || cases[1];
    const cost = profitView.costsOn ? headline.cost : 0;
    const tax = profitView.taxOn ? cowbellTax().perDay : 0;

    return { title: headline.title, revenue: headline.revenue, cost, tax, profit: headline.revenue - cost - tax };
}

export const profitPanel = new CombatPanel({
    id: 'profitPanel',
    title: 'Combat Profit',
    size: { width: 440, height: 470 },
    controls: (bar) => {
        const stats = playerStats();
        if (!stats) return;

        bar.appendChild(
            toggleButton(profitView.costsOn ? 'Costs On' : 'Costs Off', profitView.costsOn, () => {
                profitView.costsOn = !profitView.costsOn;
                saveProfitView();
            })
        );

        // The MooPass is a real weekly cost, and a profit figure that ignores it
        // is a profit figure that has not paid the rent
        bar.appendChild(
            toggleButton(profitView.taxOn ? 'Tax On' : 'Tax Off', profitView.taxOn, () => {
                profitView.taxOn = !profitView.taxOn;
                saveProfitView();
            })
        );

        // Cycles rather than three buttons: the header is narrow and the three
        // cases are an order, not a set
        const cases = profitCases(stats);
        const index = Math.max(
            0,
            cases.findIndex((scenario) => scenario.key === profitView.mode)
        );
        bar.appendChild(
            toggleButton(cases[index].title.split(' ')[0], true, () => {
                profitView.mode = cases[(index + 1) % cases.length].key;
                saveProfitView();
            })
        );
    },
    draw: (body) => {
        const stats = playerStats();
        if (!stats) {
            body.appendChild(note('No combat data yet.'));
            return;
        }

        const cases = profitCases(stats);
        const headline = cases.find((scenario) => scenario.key === profitView.mode) || cases[1];
        const tax = profitView.taxOn ? cowbellTax().perDay : 0;

        // The header sum HWhat carries: revenue, cost and what is left, in one
        // line, so the panel answers its own question before it is scrolled
        const summary = card(body);
        summary.style.borderLeft = `3px solid ${headline.colour}`;
        const total = headline.revenue - (profitView.costsOn ? headline.cost : 0) - tax;
        const equation = document.createElement('div');
        Object.assign(equation.style, { fontSize: '14px', fontWeight: 'bold' });
        equation.appendChild(piece(formatKMB(headline.revenue), ROW_COLORS.good));
        if (tax) {
            equation.append(piece(' - ', COLORS.textDim), piece(formatKMB(tax), '#e8b4d8'));
        }
        if (profitView.costsOn) {
            equation.append(piece(' - ', COLORS.textDim), piece(formatKMB(headline.cost), ROW_COLORS.bad));
        }
        if (tax || profitView.costsOn) equation.appendChild(piece(' = ', COLORS.textDim));
        equation.appendChild(piece(`${formatKMB(total)}/day`, ROW_COLORS.gold));
        summary.append(equation, note(`${headline.title} · ${formatKMB(total / 24)}/hr`));

        for (const scenario of cases) profitBox(body, scenario, tax);

        const spread = card(body, 'Difference');
        // Patient against lazy: the tax is in both, so it cancels
        const best = cases[2].revenue - (profitView.costsOn ? cases[2].cost : 0);
        const worst = cases[0].revenue - (profitView.costsOn ? cases[0].cost : 0);
        spread.append(
            line('Patient over lazy', formatKMB(best - worst), ROW_COLORS.gold),
            line('Consumables/day', formatKMB(cases[0].cost), ROW_COLORS.bad),
            line('Run length', timeReadable(Math.round(stats.duration)), COLORS.text)
        );
        spread.appendChild(
            note('How much the same run is worth for being patient with the order book rather than taking the spread.')
        );

        body.appendChild(taxCard(stats));
    },
});

/**
 * One coloured span of the header sum.
 * @param {string} text - What it says
 * @param {string} color - Ink
 * @returns {HTMLElement}
 */
function piece(text, color) {
    const span = document.createElement('span');
    span.textContent = text;
    span.style.color = color;
    return span;
}

/** A week of membership, in bags of ten cowbells, as the game charges it */
const BAGS_PER_WEEK = 25;
const COWBELL_BAG = '/items/bag_of_10_cowbells';
const COWBELL = '/items/cowbell';
const COWBELLS_PER_BAG = 10;

/**
 * What the weekly tax still costs, given what is already in the bag.
 *
 * Not the price of twenty-five bags. Cowbells accumulate — from dailies, from
 * drops, from bags bought and not yet spent — and a figure that ignores the
 * hundred and twenty you are already holding overstates the tax by half and
 * makes a run look like it is not covering something it comfortably covers.
 * Loose cowbells and bagged ones are the same thing at ten to one.
 *
 * @returns {{perWeek: number, perDay: number, bagsNeeded: number, bagPrice: number}}
 */
function cowbellTax() {
    const bagPrice = getItemPrices(COWBELL_BAG)?.ask || 0;

    let held = 0;
    for (const item of dataManager.getInventory?.() || []) {
        if (item.itemHrid === COWBELL) held += item.count || 0;
        else if (item.itemHrid === COWBELL_BAG) held += (item.count || 0) * COWBELLS_PER_BAG;
    }

    const owed = Math.max(0, BAGS_PER_WEEK * COWBELLS_PER_BAG - held);
    const bagsNeeded = Math.ceil(owed / COWBELLS_PER_BAG);
    const perWeek = bagPrice * bagsNeeded;

    return { perWeek, perDay: perWeek / 7, bagsNeeded, bagPrice };
}

/**
 * What the tax costs, and whether this run pays it.
 *
 * The figure worth having is not the price of a bag but whether the run covers
 * it: a profit that does not clear the weekly tax is not profit, it is a slower
 * way of running down.
 *
 * @param {Object} stats - From `playerStats`
 * @returns {HTMLElement}
 */
function taxCard(stats) {
    const holder = document.createElement('div');
    const block = card(holder, profitView.taxOn ? 'Paying the Tax' : 'Pay the Tax');

    const tax = cowbellTax();
    if (!tax.bagPrice) {
        block.appendChild(note('No market price for a Bag of 10 Cowbells yet.'));
        return holder;
    }

    const profit = stats.dailyProfit?.bid ?? 0;

    block.append(
        line(
            'Per week',
            `${formatKMB(tax.perWeek)}  (${tax.bagsNeeded} of ${BAGS_PER_WEEK} bags)`,
            ROW_COLORS.bad,
            'Twenty-five bags a week, less the cowbells you are already holding.'
        ),
        line('Per day', formatKMB(tax.perDay), ROW_COLORS.bad),
        line(
            'This run covers it',
            profit >= tax.perDay ? 'yes' : 'no',
            profit >= tax.perDay ? ROW_COLORS.good : ROW_COLORS.bad,
            'Daily profit at bid against the daily cost of the weekly tax.'
        )
    );
    if (profit > 0) {
        block.appendChild(line('Days of profit per week of tax', (tax.perWeek / profit).toFixed(1), ROW_COLORS.accent));
    }
    if (!profitView.taxOn) {
        block.appendChild(note('Not counted against the figures above — press Tax in the header to include it.'));
    }
    return holder;
}
