/**
 * Notices panel
 *
 * The one place the notice log is readable.
 *
 * Digest mode and quiet hours both work by *not* showing you something at the
 * moment it happened, and neither is defensible without somewhere to go and
 * look. So this is the other half of those features rather than a nicety: an
 * overlay tile that counts what you have not read, and a panel behind it that
 * lists the notices themselves, newest first, with the category and subject
 * that the digest line only counted.
 *
 * Registering an overlay row also puts "Notices" in the command palette, which
 * builds its list from the registered rows — so the panel has a keyboard route
 * without this file knowing the palette exists.
 *
 * Everything drawn here is already in memory: the log loads once per character
 * and is appended to synchronously, so a redraw is a slice and a reverse. The
 * panel is on a slow refresh because nothing on it moves except the ages.
 */

import { createPanel, panelCard, panelNote } from '../../utils/simple-panel.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { categoryLabel } from './notice-policy.js';
import {
    loadNoticeLog,
    readNotices,
    noticeCount,
    unreadNoticeCount,
    markNoticesSeen,
    clearNotices,
    MAX_ENTRIES,
} from './notice-log.js';

/** Panel id, which is also its geometry key */
export const PANEL_ID = 'noticeLog';

/** How many notices the panel draws; the log holds more but nobody reads past this */
export const VISIBLE_LIMIT = 60;

/** Ages are the only thing that moves on this panel */
const REFRESH_MS = 30_000;

/**
 * A timestamp as a short local time.
 * @param {number} at - Epoch ms
 * @returns {string} e.g. `14:07`
 */
export function noticeTime(at) {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return '--:--';
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * The day a notice belongs to, as a heading.
 * @param {number} at - Epoch ms
 * @param {number} [now] - Clock, injectable for tests
 * @returns {string} `Today`, `Yesterday`, or a date
 */
export function noticeDay(at, now = Date.now()) {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return 'Unknown';

    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    if (date.getTime() >= midnight.getTime()) return 'Today';
    if (date.getTime() >= midnight.getTime() - 86_400_000) return 'Yesterday';
    return date.toLocaleDateString();
}

/**
 * Draw one notice.
 * @param {HTMLElement} card - Where it goes
 * @param {Object} entry - A log entry
 * @returns {HTMLElement} The row
 */
function drawNotice(card, entry) {
    const row = document.createElement('div');
    row.className = 'toolasha-notice-row';
    row.dataset.noticeCategory = entry.category;
    row.dataset.noticeUrgency = entry.urgency;
    Object.assign(row.style, { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '1px 0' });

    const when = document.createElement('span');
    when.textContent = noticeTime(entry.at);
    Object.assign(when.style, { color: ROW_COLORS.dim, whiteSpace: 'nowrap' });

    const where = document.createElement('span');
    where.textContent = categoryLabel(entry.category);
    Object.assign(where.style, {
        color: entry.urgency === 'critical' ? ROW_COLORS.gold : ROW_COLORS.accent,
        whiteSpace: 'nowrap',
    });

    const text = document.createElement('span');
    // The subject is usually already inside the message; showing it again would
    // be noise, so it only earns its place when the message does not carry it
    const subject = entry.subject && !entry.text.includes(entry.subject) ? `${entry.subject} — ` : '';
    text.textContent = `${subject}${entry.text}`;
    Object.assign(text.style, { color: ROW_COLORS.neutral, flex: '1' });

    // A notice that reached no channel at all is the one failure this feature
    // can see and nothing else can — permission refused, or the page not yet
    // drawn. Marked rather than hidden
    if (!entry.channels?.length) {
        row.title = 'This one reached no channel when it happened';
        text.style.color = ROW_COLORS.dim;
    } else if (entry.channels.includes('digest')) {
        row.title = 'Batched into a digest summary';
    }

    row.append(when, where, text);
    card.appendChild(row);
    return row;
}

/**
 * A button that reads as part of the panel.
 * @param {string} label - What it says
 * @param {Function} onClick - What it does
 * @returns {HTMLElement} The button
 */
function panelButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    Object.assign(button.style, {
        background: 'rgba(255, 255, 255, 0.06)',
        border: '1px solid rgba(255, 255, 255, 0.14)',
        borderRadius: '5px',
        color: ROW_COLORS.neutral,
        cursor: 'pointer',
        font: 'inherit',
        padding: '3px 9px',
    });
    button.addEventListener('click', onClick);
    return button;
}

/**
 * Fill the panel body.
 * @param {HTMLElement} body - The panel's body
 * @returns {void}
 */
function draw(body) {
    const entries = readNotices(VISIBLE_LIMIT);

    if (entries.length === 0) {
        body.appendChild(panelNote('Nothing has been announced yet.'));
        return;
    }

    let day = '';
    let card = null;
    for (const entry of entries) {
        const heading = noticeDay(entry.at);
        if (heading !== day) {
            day = heading;
            card = panelCard(body, heading, ROW_COLORS.accent);
        }
        drawNotice(card, entry);
    }

    const footer = document.createElement('div');
    Object.assign(footer.style, { display: 'flex', gap: '8px', alignItems: 'center', paddingTop: '6px' });

    const total = noticeCount();
    const count = document.createElement('span');
    count.textContent = `${total} kept${total >= MAX_ENTRIES ? ' (the oldest fall off)' : ''}`;
    Object.assign(count.style, { color: ROW_COLORS.dim, flex: '1' });

    footer.append(
        count,
        panelButton('Clear', async () => {
            await clearNotices();
            noticePanel.render();
        })
    );
    body.appendChild(footer);
}

export const noticePanel = createPanel({
    id: PANEL_ID,
    title: 'Notices',
    size: { width: 420, height: 320 },
    accent: '#9ec4ff',
    refreshMs: REFRESH_MS,
    draw,
});

// Opening the panel is reading it, so the unread count is what the tile shows
// and the panel is what clears it. Wrapped rather than folded into `draw`,
// because the timed refresh calls `draw` too and a count that resets itself
// every thirty seconds is not a count
const shellShow = noticePanel.show;
noticePanel.show = (options) => {
    markNoticesSeen();
    return shellShow(options);
};

registerRow({
    key: 'noticeLog',
    name: 'Notices',
    empty: 'No notices',
    defaultVisible: false,
    defaultSize: { width: 200, height: 30 },
    render: (container) => {
        const unread = unreadNoticeCount();
        const line = document.createElement('div');
        line.textContent = unread === 0 ? `${noticeCount()} logged` : `${unread} unread`;
        line.style.color = unread === 0 ? ROW_COLORS.dim : ROW_COLORS.gold;
        container.appendChild(line);
    },
    onOpen: () => noticePanel.toggle(),
});

export default {
    name: 'Notice Log',
    initialize: async () => {
        // The log is read once per character. Nothing else awaits it: appends
        // work against the in-memory array from the first notice onwards, and
        // the load merges what was persisted underneath them
        await loadNoticeLog();
    },
    cleanup: () => {
        noticePanel.hide?.({ remember: false });
    },
};
