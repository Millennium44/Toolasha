/**
 * Net worth movers panel: the items behind one reading's change, opened from the history chart.
 *
 * Shows the ten items that moved the total most since the nearest earlier reading that has an item map,
 * each with the reason (units held, price per unit, or both), and one row for everything else so the list
 * adds up to the change. Every way it can end says so in words; see networth-movers.js for the data.
 */

import dataManager from '../../core/data-manager.js';
import networthMovers from './networth-movers.js';
import { networthFormatter, formatDateTime } from '../../utils/formatters.js';
import { itemIcon } from '../../utils/overlay-format.js';
import { GAME_COLORS, GAME_FRAME, styleGameButton } from '../../utils/game-look.js';
import { PANEL_Z_CAP } from '../../utils/panel-z-index.js';
import { markToolashaSurface } from '../../utils/surface-marker.js';

export const MOVERS_PANEL_ID = 'mwi-nw-movers-panel';

const KIND_PREFIX = { s: 'Sell listing: ', b: 'Buy listing: ', k: 'Ability book: ' };

const signed = (value) => `${value > 0 ? '+' : value < 0 ? '-' : ''}${networthFormatter(Math.abs(value))}`;
const tone = (value) => (value > 0 ? GAME_COLORS.good : value < 0 ? GAME_COLORS.bad : GAME_COLORS.textDim);
const units = (value) => networthFormatter(Math.round(value));

/**
 * The name a row shows, by item data (a hrid is the identity; the text is only the label).
 * @param {{kind: string, hrid: string, level: number}} change - A diff row
 * @returns {string} Label with the listing kind and enhancement level
 */
export function rowLabel(change) {
    const name = dataManager.getItemDetails?.(change.hrid)?.name || String(change.hrid).replace('/items/', '');
    return `${KIND_PREFIX[change.kind] || ''}${name}${change.level > 0 ? ` +${change.level}` : ''}`;
}

/**
 * The lines that say why a row moved.
 * @param {Object} change - A diff row from diffRecords
 * @returns {string[]} One short line each
 */
export function explainChange(change) {
    const lines = [];
    const count = `${units(change.countBefore ?? 0)} to ${units(change.countAfter ?? 0)}`;
    const each = `${networthFormatter(change.unitBefore ?? 0)} to ${networthFormatter(change.unitAfter ?? 0)} each`;
    switch (change.cause) {
        case 'gained':
            lines.push(`New: ${units(change.countAfter)} held, none before`);
            break;
        case 'lost':
            lines.push(`Gone: ${units(change.countBefore)} held before, none now`);
            break;
        case 'quantity':
            lines.push(`Quantity: ${count}`);
            break;
        case 'price':
            if (change.countBefore === change.countAfter && change.unitBefore !== null) {
                lines.push(`Price: ${each}, same quantity`);
            } else lines.push(`Value changed: ${networthFormatter(change.delta)}`);
            break;
        case 'both':
            lines.push(`Quantity: ${count}`);
            lines.push(`Price: ${each}`);
            break;
        case 'unpriced': {
            const same = change.countBefore === change.countAfter ? ' Holdings did not change.' : '';
            lines.push(
                change.unpricedAfter && change.unpricedBefore
                    ? 'Not valued in either reading (no price, or its net worth setting is off)'
                    : change.unpricedAfter
                      ? `Not valued in the later reading (no price, or its net worth setting was turned off), so it counts as 0 there.${same}`
                      : `Not valued in the earlier reading (no price, or its net worth setting, such as including this token, was off), so it counted as 0 there.${same}`
            );
            break;
        }
        default:
            break;
    }
    if (change.partialBefore || change.partialAfter) lines.push('Valued on a partial bill, so a floor');
    return lines;
}

function el(tag, css, text) {
    const node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text != null) node.textContent = text;
    return node;
}

/**
 * The body of the panel for one result of {@link networthMovers.detailFor}.
 * @param {Object} result - What detailFor returned
 * @returns {HTMLElement} The content
 */
export function renderMoversResult(result) {
    const body = el('div', 'display:flex;flex-direction:column;gap:6px;');
    const note = (text) => body.appendChild(el('div', `color:${GAME_COLORS.textDim};line-height:1.4;`, text));

    if (result.state === 'no-map') {
        note(
            'No item detail for this reading. Detail is kept for the last 24 readings and for readings that ' +
                'moved the total by 1% or 100M or more (with the reading before them); older readings, and ' +
                'readings taken before this was added, have none.'
        );
        return body;
    }
    if (result.state === 'no-previous') {
        note(
            'This is the first reading with item detail for this character, so there is nothing to compare it with yet.'
        );
        return body;
    }
    if (result.state === 'unreadable') {
        note('The item detail could not be read from storage.');
        return body;
    }
    if (result.state === 'stale') {
        note('The character changed while this was loading.');
        return body;
    }

    body.appendChild(
        el(
            'div',
            `color:${GAME_COLORS.text};`,
            `Since ${formatDateTime(new Date(result.since), { includeSeconds: false })}: ${signed(result.totalDelta)}`
        )
    );

    if (result.pricing?.changed) {
        const { before, after } = result.pricing;
        const ic = (side) => (side.ic ? `, Iron Cow ${side.ic}` : '');
        body.appendChild(
            el(
                'div',
                `color:${GAME_COLORS.textDim};line-height:1.4;`,
                `Pricing differed between these readings (${before.pm}${ic(before)} to ${after.pm}${ic(after)}, ` +
                    `value source ${before.vs} to ${after.vs}), so price changes below include that, not only the market.`
            )
        );
    }

    if (result.state === 'unchanged') {
        note('Nothing changed between these two readings.');
        return body;
    }

    for (const change of result.top) {
        const row = el(
            'div',
            `display:flex;gap:8px;align-items:flex-start;border-top:1px solid ${GAME_COLORS.border};padding-top:6px;`
        );
        row.dataset.hrid = change.hrid;
        row.appendChild(itemIcon(change.hrid, 22));
        const text = el('div', 'flex:1 1 auto;min-width:0;');
        text.appendChild(el('div', `color:${GAME_COLORS.text};overflow-wrap:anywhere;`, rowLabel(change)));
        for (const line of explainChange(change)) {
            text.appendChild(el('div', `color:${GAME_COLORS.textDim};font-size:11px;`, line));
        }
        row.appendChild(text);
        row.appendChild(el('div', `flex:0 0 auto;font-weight:600;color:${tone(change.delta)};`, signed(change.delta)));
        body.appendChild(row);
    }
    if (result.top.length === 0) note('No single item moved; the change is in the figures below.');

    const rest = result.rest;
    const parts = [];
    if (rest.otherItems > 0)
        parts.push(`${rest.otherItems} other item${rest.otherItems === 1 ? '' : 's'} ${signed(rest.otherItemsDelta)}`);
    if (rest.house) parts.push(`houses ${signed(rest.house)}`);
    if (rest.abilities) parts.push(`abilities ${signed(rest.abilities)}`);
    if (rest.shrines) parts.push(`guild shrines ${signed(rest.shrines)}`);
    if (rest.excluded) parts.push(`excluded items ${signed(rest.excluded)}`);
    if (Math.abs(rest.remainder) >= 1) parts.push(`rounding ${signed(rest.remainder)}`);
    const restRow = el(
        'div',
        `display:flex;gap:8px;align-items:flex-start;border-top:1px solid ${GAME_COLORS.border};padding-top:6px;`
    );
    restRow.dataset.rest = 'true';
    const restText = el('div', 'flex:1 1 auto;min-width:0;');
    restText.appendChild(el('div', `color:${GAME_COLORS.text};`, 'Everything else'));
    restText.appendChild(
        el(
            'div',
            `color:${GAME_COLORS.textDim};font-size:11px;`,
            parts.length ? parts.join(', ') : 'Nothing else moved'
        )
    );
    restRow.appendChild(restText);
    restRow.appendChild(el('div', `flex:0 0 auto;font-weight:600;color:${tone(rest.delta)};`, signed(rest.delta)));
    body.appendChild(restRow);

    if (result.truncated) {
        note(
            'To bound the stored size, one of these readings left out its smallest items, so tiny stacks may show as new or gone.'
        );
    }
    return body;
}

/**
 * Open the panel near a click and fill it once the maps are read.
 * @param {Object} params - Inputs
 * @param {{t: number, total: number}} params.snapshot - The chart point
 * @param {{x: number, y: number}} params.at - Where to open, in viewport pixels
 * @param {Function} [params.onClose] - Called once when the panel goes away
 * @returns {{close: Function, element: HTMLElement, done: Promise<void>}} Handle
 */
export function openMoversPanel({ snapshot, at, onClose }) {
    document.getElementById(MOVERS_PANEL_ID)?.remove();

    const panel = el('div');
    panel.id = MOVERS_PANEL_ID;
    Object.assign(panel.style, GAME_FRAME);
    Object.assign(panel.style, {
        position: 'fixed',
        zIndex: String(PANEL_Z_CAP),
        width: 'min(420px, calc(100vw - 16px))',
        maxHeight: '70vh',
        overflowY: 'auto',
        padding: '10px 12px',
        fontSize: '12px',
        color: GAME_COLORS.text,
        boxSizing: 'border-box',
    });

    const header = el(
        'div',
        'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;'
    );
    header.appendChild(
        el('div', 'font-weight:600;', `What moved: ${formatDateTime(new Date(snapshot.t), { includeSeconds: false })}`)
    );
    const closeBtn = styleGameButton(el('button', null, 'Close'), 'quiet', true);
    closeBtn.type = 'button';
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const content = el('div', null);
    content.appendChild(el('div', `color:${GAME_COLORS.textDim};`, 'Reading item detail...'));
    panel.appendChild(content);

    const width = Math.min(420, window.innerWidth - 16);
    panel.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight * 0.3))}px`;

    markToolashaSurface(panel, 'popover');
    document.body.appendChild(panel);

    let closed = false;
    let outside = null;
    let timer = null;
    const close = () => {
        if (closed) return;
        closed = true;
        if (timer !== null) clearTimeout(timer);
        if (outside) document.removeEventListener('mousedown', outside);
        panel.remove();
        onClose?.();
    };
    closeBtn.addEventListener('click', close);
    timer = setTimeout(() => {
        timer = null;
        if (closed) return;
        outside = (event) => {
            if (!panel.contains(event.target)) close();
        };
        document.addEventListener('mousedown', outside);
    }, 0);

    const done = (async () => {
        const result = await networthMovers.detailFor(snapshot.t);
        if (closed) return;
        content.replaceChildren(renderMoversResult(result));
    })();

    return { close, element: panel, done };
}
