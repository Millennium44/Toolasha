/**
 * Account panel
 *
 * The whole account on one page: what it is worth, and who is still working.
 *
 * Everything drawn here is a *last known* figure — see `account-data.js` for
 * why there cannot be a live one — so every section carries the age of what it
 * is showing rather than presenting stored numbers as current. A networth from
 * three weeks ago is still worth having; a networth from three weeks ago
 * labelled as today's is not.
 *
 * Drawing is all this file does. The reading and the arithmetic are next door.
 */

import { formatRelativeTime, networthFormatter } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS, shortDuration } from '../../utils/overlay-format.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { accountReadFailure, cachedAccount, refreshAccount, windowChange } from './account-data.js';

const ACCENT = '#c9a0ff';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The account, asking for a fresh read whenever what we have has gone off.
 *
 * Fire and forget on purpose: the panel redraws on its own timer and the read
 * will have landed by then. Awaiting IndexedDB inside a draw is what leaves a
 * panel blank on its first frame.
 * @returns {Object|null} The account, or null until the first read lands
 */
function account() {
    refreshAccount();
    return cachedAccount();
}

/**
 * A coin figure, or a dash when there is not one.
 * @param {number|null} value - Coins
 * @returns {string}
 */
function coins(value) {
    return Number.isFinite(value) ? networthFormatter(value) : '—';
}

/**
 * A change, coloured by direction.
 * @param {{delta: number, percent: number|null}|null} change - From `windowChange`
 * @returns {{text: string, color: string}}
 */
function changeText(change) {
    if (!change) return { text: '—', color: ROW_COLORS.dim };
    const sign = change.delta > 0 ? '+' : '';
    const percent = change.percent === null ? '' : ` (${sign}${change.percent.toFixed(1)}%)`;
    const color = change.delta > 0 ? ROW_COLORS.good : change.delta < 0 ? ROW_COLORS.bad : ROW_COLORS.dim;
    return { text: `${sign}${coins(change.delta)}${percent}`, color };
}

/**
 * How a character's queue reads, given how long ago the snapshot was taken.
 * @param {Object} queue - From `queueState`
 * @returns {{text: string, color: string}}
 */
function queueText(queue) {
    if (queue.state === 'unknown') return { text: 'No queue snapshot', color: ROW_COLORS.dim };
    if (queue.stale) return { text: `Queue snapshot ${formatRelativeTime(queue.ageMs)} old`, color: ROW_COLORS.dim };
    if (queue.state === 'busy')
        return { text: `Busy ~${shortDuration(queue.remainingSeconds)}`, color: ROW_COLORS.good };
    if (queue.state === 'endless') return { text: 'Endless action', color: ROW_COLORS.good };
    return { text: 'Idle', color: ROW_COLORS.bad };
}

/**
 * A trend as bars, because the shape is the point rather than any one value.
 *
 * Deliberately not the networth history chart: that draws one character's
 * series with axes and tooltips, and what belongs beside a total is whether the
 * line has been going up.
 *
 * @param {Array<{total: number}>} points - Combined series, oldest first
 * @returns {HTMLElement|null} The sparkline, or null when there is no shape yet
 */
function sparkline(points) {
    if (!Array.isArray(points) || points.length < 3) return null;

    const recent = points.slice(-60);
    const values = recent.map((point) => point.total);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const span = high - low;

    const strip = document.createElement('div');
    Object.assign(strip.style, {
        display: 'flex',
        alignItems: 'flex-end',
        gap: '1px',
        height: '28px',
        marginTop: '4px',
    });

    for (const value of values) {
        const bar = document.createElement('div');
        // A flat line is drawn flat rather than as noise magnified to full height
        const height = span > 0 ? 12 + ((value - low) / span) * 88 : 50;
        Object.assign(bar.style, {
            flex: '1 1 0',
            minWidth: '1px',
            height: `${height}%`,
            background: ACCENT,
            opacity: '0.7',
            borderRadius: '1px',
        });
        strip.appendChild(bar);
    }

    return strip;
}

/**
 * The account total, its trend, and who makes it up.
 * @param {HTMLElement} body - Where it goes
 * @param {Object} data - The account
 */
function drawNetworth(body, data) {
    const counted = data.characters.filter((character) => Number.isFinite(character.networth));
    const total = counted.reduce((sum, character) => sum + character.networth, 0);

    const card = panelCard(body, 'Combined networth', ACCENT);
    card.appendChild(
        panelLine(
            `Total (${counted.length} of ${data.characters.length} characters)`,
            coins(total),
            ROW_COLORS.gold,
            'The sum of each character’s last recorded networth. A character with no networth history is not counted.'
        )
    );

    const day = changeText(windowChange(data.combined, DAY_MS, data.at));
    const week = changeText(windowChange(data.combined, 7 * DAY_MS, data.at));
    card.appendChild(panelLine('Last 24h', day.text, day.color));
    card.appendChild(panelLine('Last 7d', week.text, week.color));

    const trend = sparkline(data.combined);
    if (trend) card.appendChild(trend);
    else card.appendChild(panelNote('Not enough history for a trend yet.'));

    for (const character of counted) {
        const share = total > 0 ? ` · ${((character.networth / total) * 100).toFixed(0)}%` : '';
        card.appendChild(
            panelLine(
                character.isCurrent ? `${character.name} (here)` : character.name,
                `${coins(character.networth)}${share}`,
                character.isCurrent ? ROW_COLORS.accent : ROW_COLORS.neutral,
                character.networthAt ? `Recorded ${formatRelativeTime(data.at - character.networthAt)} ago` : ''
            )
        );
    }
}

/**
 * One line per character: what it was worth, when it was last played, and
 * whether it is still doing anything.
 * @param {HTMLElement} body - Where it goes
 * @param {Object} data - The account
 */
function drawCharacters(body, data) {
    const card = panelCard(body, 'Characters', ACCENT);

    for (const character of data.characters) {
        card.appendChild(
            panelLine(
                character.isCurrent ? `${character.name} (here)` : character.name,
                coins(character.networth),
                character.isCurrent ? ROW_COLORS.accent : ROW_COLORS.neutral,
                character.named ? '' : 'This character has not been played since names started being recorded.'
            )
        );

        const queue = queueText(character.queue);
        const seen = character.lastSeen ? formatRelativeTime(data.at - character.lastSeen) : 'never';
        const detail = document.createElement('div');
        detail.style.marginLeft = '10px';
        row(detail, [
            { text: `Last seen ${seen}`, color: ROW_COLORS.dim, ellipsis: true },
            { text: queue.text, color: queue.color, push: true },
        ]);
        card.appendChild(detail);
    }
}

export const accountPanel = createPanel({
    id: 'accountView',
    title: 'Account',
    size: { width: 420, height: 520 },
    accent: ACCENT,
    draw: (body) => {
        const data = account();
        if (!data) {
            // A panel that says "Reading…" forever is how a broken database
            // looks from here, and it is indistinguishable from a slow one
            const failure = accountReadFailure();
            body.appendChild(
                panelNote(
                    failure
                        ? `Could not read the account from storage: ${failure}. Reload the page; ` +
                              'Toolasha.debug.storage() in the console says more.'
                        : 'Reading the account…'
                )
            );
            return;
        }

        if (!data.characters.length) {
            body.appendChild(panelNote('No characters found in storage yet.'));
            return;
        }

        drawNetworth(body, data);
        drawCharacters(body, data);
        body.appendChild(panelNote(`Read ${formatRelativeTime(Date.now() - data.at)} ago from stored history.`));
        // Stale figures with no sign that the refresh behind them is failing is
        // the one thing worse than no figures
        if (accountReadFailure()) {
            body.appendChild(panelNote(`The last refresh failed (${accountReadFailure()}) — these figures are older.`));
        }
    },
});

/**
 * The overlay tile: the account total, and whoever has stopped.
 *
 * Registered from the feature's `initialize` rather than at module scope so a
 * switched-off feature leaves no tile and no command palette entry behind.
 */
export function registerAccountRow() {
    registerRow({
        key: 'accountView',
        name: 'Account',
        empty: 'No account history yet',
        defaultVisible: false,
        defaultSize: { width: 240, height: 30 },
        render: (container) => {
            const data = account();
            if (!data?.characters.length) return blank(container);

            const counted = data.characters.filter((character) => Number.isFinite(character.networth));
            if (!counted.length) return blank(container);

            const total = counted.reduce((sum, character) => sum + character.networth, 0);
            const idle = data.characters.filter(
                (character) => !character.isCurrent && character.queue.state === 'idle' && !character.queue.stale
            );

            row(container, [
                { text: `${data.characters.length}×`, color: ROW_COLORS.dim },
                { text: coins(total), color: ROW_COLORS.gold, bold: true },
                {
                    text: idle.length ? `${idle.length} idle` : 'all busy',
                    color: idle.length ? ROW_COLORS.bad : ROW_COLORS.good,
                    push: true,
                },
            ]);

            container.title =
                `Last known networth across ${counted.length} character(s).` +
                (idle.length ? `\nIdle: ${idle.map((character) => character.name).join(', ')}` : '') +
                '\nDouble-click for the whole account.';
        },
        onOpen: () => accountPanel.toggle(),
    });
}
