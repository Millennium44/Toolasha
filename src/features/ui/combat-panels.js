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
import combatStatsDataCollector from '../../features/combat-stats/combat-stats-data-collector.js';
import { calculatePlayerStats } from '../../features/combat-stats/combat-stats-calculator.js';
import {
    damageBreakdown,
    actionLabel,
    isFilteringNonDamaging,
    setFilterNonDamaging,
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
    constructor({ id, title, size, draw, controls }) {
        this.id = id;
        this.title = title;
        this.size = size;
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

export const dpsPanel = new CombatPanel({
    id: 'dpsPanel',
    title: 'Damage',
    size: { width: 440, height: 400 },
    draw: (body) => {
        const breakdown = damageBreakdown();

        const totals = card(body, 'Party');
        totals.append(
            line(
                'Per second',
                combatDPS.dps === null ? 'measuring…' : formatWithSeparator(Math.round(combatDPS.dps)),
                ROW_COLORS.good
            ),
            line('Taken per second', formatWithSeparator(Math.round(combatDPS.dtps ?? 0)), ROW_COLORS.bad),
            // The ratio a health bar cannot give you: whether you are winning
            // the exchange or merely surviving it
            line(
                'Exchange',
                combatDPS.dtps > 0 ? `${(combatDPS.dps / combatDPS.dtps).toFixed(1)}× in your favour` : 'untouched',
                ROW_COLORS.gold
            ),
            line('Time fighting', timeReadable(Math.round(combatDPS.seconds)), COLORS.text)
        );

        // The filter MCS has, and for its reason: a hit landing while nobody is
        // casting is usually a lingering effect, and counting it inflates
        // whatever is next in the rotation
        const toggle = document.createElement('button');
        toggle.textContent = `Filter non-damaging: ${isFilteringNonDamaging() ? 'on' : 'off'}`;
        toggle.dataset.filterToggle = 'true';
        Object.assign(toggle.style, {
            background: 'rgba(255, 255, 255, 0.08)',
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '3px',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '2px 8px',
            marginTop: '4px',
            alignSelf: 'flex-start',
        });
        toggle.addEventListener('click', () => {
            setFilterNonDamaging(!isFilteringNonDamaging());
            dpsPanel._render();
        });
        totals.appendChild(toggle);

        if (!breakdown.players.length) {
            body.appendChild(
                note('No attributed hits yet. Damage is credited by whose mana fell, so it needs a cast to start.')
            );
            return;
        }

        for (const player of breakdown.players) {
            const block = card(body, player.name);
            block.append(
                line('Damage', formatKMB(player.damage), ROW_COLORS.gold),
                line(
                    'Per second',
                    player.dps === null ? 'measuring…' : formatWithSeparator(Math.round(player.dps)),
                    player.dps === null ? COLORS.textDim : ROW_COLORS.good
                ),
                // Null rather than zero: no swings is not a 0% hit rate
                line(
                    'Accuracy',
                    player.accuracy === null ? '—' : `${(player.accuracy * 100).toFixed(1)}%`,
                    COLORS.text,
                    `${formatWithSeparator(player.hits)} hits, ${formatWithSeparator(player.misses)} misses.`
                ),
                line(
                    'Crit rate',
                    player.critRate === null ? '—' : `${(player.critRate * 100).toFixed(1)}%`,
                    ROW_COLORS.accent,
                    `${formatWithSeparator(player.crits)} crits.`
                )
            );

            for (const ability of player.abilities) {
                const share = player.damage > 0 ? (ability.damage / player.damage) * 100 : 0;
                block.appendChild(
                    line(
                        `  ${actionLabel(ability.action)}`,
                        `${formatKMB(ability.damage)}  ·  ${share.toFixed(0)}%`,
                        COLORS.textDim,
                        `${formatWithSeparator(ability.hits)} hits, ${formatWithSeparator(ability.crits)} crits, ` +
                            `${formatWithSeparator(ability.misses)} misses.`
                    )
                );
            }
        }

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
 * Which case the headline reads as, remembered between openings.
 *
 * HWhat keeps one too, because the three cases are not equally interesting to
 * everybody: somebody who sells into bids and buys from asks is always reading
 * the Lazy line and never the other two.
 */
let profitMode = 'mid';

/** Whether costs are subtracted at all, as HWhat's Costs On does */
let costsOn = true;

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
function profitBox(body, scenario) {
    const value = scenario.revenue - (costsOn ? scenario.cost : 0);
    const colour = value >= 0 ? scenario.colour : ROW_COLORS.bad;

    const block = card(body);
    block.style.borderLeft = `3px solid ${colour}`;

    const heading = document.createElement('div');
    heading.textContent = scenario.title;
    Object.assign(heading.style, { color: colour, fontWeight: 'bold' });

    const figure = document.createElement('div');
    figure.textContent = `${formatKMB(value)} coin/day`;
    Object.assign(figure.style, { color: colour, fontSize: '17px', fontWeight: 'bold', lineHeight: '1.3' });

    const rule = document.createElement('div');
    rule.textContent = costsOn ? scenario.equation : scenario.equation.split(' - ')[0];
    Object.assign(rule.style, { color: COLORS.textDim, fontSize: '11px' });

    const sum = document.createElement('div');
    sum.textContent = costsOn
        ? `${formatKMB(scenario.revenue)} - ${formatKMB(scenario.cost)} = ${formatKMB(value)}`
        : `${formatKMB(scenario.revenue)}`;
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

    return [
        {
            key: 'lazy',
            title: 'Lazy Profit',
            colour: ROW_COLORS.good,
            equation: 'Revenue (Bid) - Cost (Ask)',
            revenue: revenue.bid,
            cost: cost.ask,
        },
        {
            key: 'mid',
            title: 'Mid Profit',
            colour: ROW_COLORS.accent,
            equation: 'Revenue (Bid) - Cost (Bid)',
            revenue: revenue.bid,
            cost: cost.bid,
        },
        {
            key: 'patient',
            title: 'Patient Profit',
            colour: ROW_COLORS.gold,
            equation: 'Revenue (Ask) - Cost (Bid)',
            revenue: revenue.ask,
            cost: cost.bid,
        },
    ];
}

export const profitPanel = new CombatPanel({
    id: 'profitPanel',
    title: 'Combat Profit',
    size: { width: 440, height: 470 },
    controls: (bar) => {
        const stats = playerStats();
        if (!stats) return;

        bar.appendChild(
            toggleButton(costsOn ? 'Costs On' : 'Costs Off', costsOn, () => {
                costsOn = !costsOn;
                profitPanel.refresh();
            })
        );

        // Cycles rather than three buttons: the header is narrow and the three
        // cases are an order, not a set
        const cases = profitCases(stats);
        const index = Math.max(
            0,
            cases.findIndex((scenario) => scenario.key === profitMode)
        );
        bar.appendChild(
            toggleButton(cases[index].title.split(' ')[0], true, () => {
                profitMode = cases[(index + 1) % cases.length].key;
                profitPanel.refresh();
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
        const headline = cases.find((scenario) => scenario.key === profitMode) || cases[1];

        // The header sum HWhat carries: revenue, cost and what is left, in one
        // line, so the panel answers its own question before it is scrolled
        const summary = card(body);
        summary.style.borderLeft = `3px solid ${headline.colour}`;
        const total = headline.revenue - (costsOn ? headline.cost : 0);
        const equation = document.createElement('div');
        Object.assign(equation.style, { fontSize: '14px', fontWeight: 'bold' });
        equation.append(
            piece(formatKMB(headline.revenue), ROW_COLORS.good),
            piece(costsOn ? ' - ' : ' ', COLORS.textDim),
            piece(costsOn ? formatKMB(headline.cost) : '', ROW_COLORS.bad),
            piece(costsOn ? ' = ' : '', COLORS.textDim),
            piece(`${formatKMB(total)}/day`, ROW_COLORS.gold)
        );
        summary.append(equation, note(`${headline.title} · ${formatKMB(total / 24)}/hr`));

        for (const scenario of cases) profitBox(body, scenario);

        const spread = card(body, 'Difference');
        const best = cases[2].revenue - (costsOn ? cases[2].cost : 0);
        const worst = cases[0].revenue - (costsOn ? cases[0].cost : 0);
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
    const block = card(holder, 'Pay the Tax');

    const bagPrice = getItemPrices(COWBELL_BAG)?.ask || 0;
    if (!bagPrice) {
        block.appendChild(note('No market price for a Bag of 10 Cowbells yet.'));
        return holder;
    }

    const perWeek = bagPrice * BAGS_PER_WEEK;
    const perDay = perWeek / 7;
    const profit = stats.dailyProfit?.bid ?? 0;

    block.append(
        line('Per week', `${formatKMB(perWeek)}  (${BAGS_PER_WEEK} bags)`, ROW_COLORS.bad),
        line('Per day', formatKMB(perDay), ROW_COLORS.bad),
        line(
            'This run covers it',
            profit >= perDay ? 'yes' : 'no',
            profit >= perDay ? ROW_COLORS.good : ROW_COLORS.bad,
            'Daily profit at bid against the daily cost of the weekly tax.'
        )
    );
    if (profit > 0) {
        block.appendChild(line('Days of profit per week of tax', (perWeek / profit).toFixed(1), ROW_COLORS.accent));
    }
    return holder;
}
