/**
 * Enhancement Session overlay row
 *
 * What the enhancement you are in the middle of has cost so far.
 *
 * The enhancement UI is a floating panel that only exists while you are on the
 * enhancing screen, and enhancing is the one activity where the screen you have
 * to watch and the figure you care about are the same screen — so the moment
 * you go and do something else, the session is still running and there is
 * nowhere to see it. That is what this tile is for.
 *
 * ## Nothing is computed here
 *
 * The tracker owns the session and updates it from the websocket; every figure
 * below is read off `getCurrentSession()` as it stands. A row redrawn once a
 * second may not do arithmetic over an attempt history, and does not need to —
 * the counters are kept as attempts land.
 *
 * A finished session keeps drawing until it is cleared, which is deliberate:
 * the last thing you want to know about an enhancement is what the whole of it
 * cost, and a tile that blanked the instant the target landed would take that
 * away at exactly the wrong moment. `state` carries the difference and the
 * tooltip says it.
 */

import { registerRow } from '../../utils/overlay-rows.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { formatLargeNumber, formatWithSeparator } from '../../utils/formatters.js';
import enhancementTracker from './enhancement-tracker.js';
import { SessionState, getOverallSuccessRate } from './enhancement-session.js';
import enhancementUI from './enhancement-ui.js';

/**
 * The session the tracker is on, if there is one.
 * @returns {Object|null} A session, or null
 */
function currentSession() {
    try {
        return enhancementTracker.getCurrentSession?.() || null;
    } catch (error) {
        console.error('[EnhancementSessionRow] Reading the current session failed:', error);
        return null;
    }
}

registerRow({
    key: 'enhancementSession',
    name: 'Enhancement Session',
    empty: 'No enhancement session',
    // Off by default: most characters are not enhancing most of the time, and
    // its class already hides it when idle — this keeps it out of the ⚙ list's
    // "already on" half as well
    defaultVisible: false,
    defaultSize: { width: 220, height: 30 },
    render: (container) => {
        const session = currentSession();
        if (!session) return blank(container);

        const attempts = session.totalAttempts || 0;
        const spent = session.totalCost || 0;
        const level = Number.isFinite(session.currentLevel) ? session.currentLevel : session.startLevel;
        const done = session.state !== SessionState.TRACKING;

        row(container, [
            { icon: session.itemHrid, size: 18 },
            // The level in hand, then the one being worked towards — the whole
            // point of a session is the distance between them
            {
                text: `+${level}→${session.targetLevel}`,
                color: done ? ROW_COLORS.dim : ROW_COLORS.gold,
                bold: true,
            },
            // Counted rather than abbreviated: attempt counts are small enough
            // to read, and "1.2K" hides the difference between 1,180 and 1,240
            { text: formatWithSeparator(attempts), color: ROW_COLORS.neutral, push: true },
            { text: formatLargeNumber(Math.round(spent)), color: ROW_COLORS.gold },
        ]);

        container.title =
            `${session.itemName || session.itemHrid} +${session.startLevel} → +${session.targetLevel}.\n` +
            `${formatWithSeparator(attempts)} attempts, ` +
            `${(session.totalSuccesses || 0).toLocaleString()} of them successful ` +
            `(${getOverallSuccessRate(session).toFixed(1)}%).\n` +
            `${Math.round(spent).toLocaleString()} spent so far.` +
            (done ? '\nThis session has finished; the figures are its totals.' : '') +
            '\nDouble-click for the enhancement panel.';
    },
    // The panel behind it is the same session in full, level by level
    onOpen: () => enhancementUI.toggle(),
});
