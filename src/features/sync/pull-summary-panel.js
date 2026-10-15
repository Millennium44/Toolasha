/**
 * The last pull, store by store.
 *
 * The toast has room for one line; this is where the line's figures are broken
 * down — which store each count came from, and for every folded record the key
 * and the merge registration that folded it. Opened from the pull toast's
 * action and from the command palette, and empty until a pull has run in this
 * session, because that is exactly as long as the summary exists.
 */

import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';
import { scriptBuildLabel } from '../../utils/bundle-bridge.js';
import { buildPullReport } from './pull-report.js';
import { UNCHANGED_UNKNOWN, lastPullSummary, formatPullSummaryLine } from './pull-summary.js';

/** How many written-whole keys a store card names before counting the rest */
const MAX_NAMED_WHOLE = 30;

/** One shell, created on first open and reused. */
let panel = null;

/** How long the button says "Copied" */
const COPIED_MS = 2000;

/** When the last copy succeeded, ms; the panel redraws every few seconds and must keep the label */
let copiedAt = 0;

/** The report text, shown for selecting when the clipboard refused it; null otherwise */
let fallbackText = null;

/**
 * The report for the last pull, as this page would write it.
 * @returns {string} Plain text
 */
export function currentPullReport() {
    return buildPullReport(lastPullSummary(), {
        version: scriptBuildLabel(),
        host: globalThis.location?.hostname || null,
    });
}

/**
 * Write the report to the clipboard, or fall back to a selectable box.
 * Called inside the click handler: the clipboard needs the user gesture.
 * @param {HTMLElement} [body] - Panel body to redraw into on the outcome
 * @returns {Promise<boolean>} True when the clipboard took it
 */
export async function copyPullReport(body) {
    const text = currentPullReport();
    try {
        await navigator.clipboard.writeText(text);
        copiedAt = Date.now();
        fallbackText = null;
        return true;
    } catch (error) {
        console.warn('[Sync] Could not copy the pull report:', error);
        fallbackText = text;
        return false;
    } finally {
        if (body) redraw(body);
    }
}

/**
 * Clear a body and draw again.
 * @param {HTMLElement} body - The panel's body
 * @returns {void}
 */
function redraw(body) {
    body.textContent = '';
    draw(body);
}

/**
 * The copy button, and the textarea when the clipboard refused.
 * @param {HTMLElement} body - The panel's body
 * @param {HTMLElement} card - Card to put them in
 * @returns {void}
 */
function drawReportControls(body, card) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toolasha-pull-report-copy';
    button.textContent = Date.now() - copiedAt < COPIED_MS ? 'Copied' : 'Copy report';
    button.style.cssText = 'margin-top:6px;padding:4px 10px;cursor:pointer;';
    button.title = 'Copies key names and counts only, no saved values.';
    button.addEventListener('click', () => {
        copyPullReport(body);
    });
    card.appendChild(button);
    if (fallbackText !== null) {
        card.appendChild(panelNote('Copy was blocked. Select the text below and copy it by hand.'));
        const area = document.createElement('textarea');
        area.className = 'toolasha-pull-report-text';
        area.readOnly = true;
        area.value = fallbackText;
        area.style.cssText = 'width:100%;height:120px;margin-top:4px;';
        area.addEventListener('focus', () => area.select());
        card.appendChild(area);
    }
}

/**
 * Draw the summary into the panel body.
 * @param {HTMLElement} body - The panel's scrolling body
 * @returns {void}
 */
function draw(body) {
    const summary = lastPullSummary();
    if (!summary) {
        body.appendChild(panelNote('No pull has run in this session. This is cleared on a character switch.'));
        return;
    }

    const head = panelCard(body, 'This pull');
    head.appendChild(panelLine('Summary', formatPullSummaryLine(summary)));
    if (summary.at) head.appendChild(panelLine('Applied', summary.at));
    drawReportControls(body, head);
    head.appendChild(
        summary.unchanged === null || summary.unchanged === undefined
            ? panelLine('Unchanged', 'unknown', ROW_COLORS.dim, `Unchanged records are ${UNCHANGED_UNKNOWN}.`)
            : panelLine(
                  'Unchanged',
                  String(summary.unchanged),
                  ROW_COLORS.dim,
                  'Records this device already held with the downloaded value. They were not written.'
              )
    );

    for (const store of summary.stores) {
        const card = panelCard(body, store.store);
        card.appendChild(panelLine('Combined', String(store.combined)));
        card.appendChild(
            panelLine(
                'Written whole',
                store.writtenWhole === null ? 'unknown' : String(store.writtenWhole),
                store.writtenWhole === null ? undefined : ROW_COLORS.good,
                store.writtenWhole === null
                    ? 'This store reported no key count — the import skipped it as unknown to this database.'
                    : 'Records the payload wrote over this device’s copy, folds excluded.'
            )
        );
        card.appendChild(
            panelLine(
                'Held',
                String(store.held),
                store.held ? ROW_COLORS.bad : undefined,
                'Kept this device’s copy because it could not be read. The downloaded entries are still ' +
                    'waiting on the next pull.'
            )
        );
        if (store.overwritten) {
            card.appendChild(
                panelLine(
                    'Overwritten',
                    String(store.overwritten),
                    ROW_COLORS.bad,
                    'The fold threw, so the downloaded copy was taken whole — this device’s entries for ' +
                        'these records are gone.'
                )
            );
        }
        card.appendChild(
            store.unchanged === null || store.unchanged === undefined
                ? panelLine('Unchanged', 'unknown', undefined, UNCHANGED_UNKNOWN)
                : panelLine('Unchanged', String(store.unchanged), undefined, 'Already the same here; not written.')
        );

        for (const record of store.combinedRecords) {
            card.appendChild(panelNote(`· ${record.key}${record.label ? ` — ${record.label}` : ''}`));
        }
        // A first pull writes hundreds of keys; the ones worth naming are the few of a settled pull
        const whole = store.wholeRecords || [];
        for (const record of whole.slice(0, MAX_NAMED_WHOLE)) {
            card.appendChild(panelNote(`· ${record.key} — written whole`));
        }
        if (whole.length > MAX_NAMED_WHOLE) {
            card.appendChild(panelNote(`· …and ${whole.length - MAX_NAMED_WHOLE} more written whole`));
        }
    }
}

/**
 * Show the panel, creating it on first use.
 * @returns {void}
 */
export function openPullSummaryPanel() {
    if (!panel) {
        panel = createPanel({
            id: 'sync-pull-summary',
            title: 'Last sync pull',
            size: { width: 400, height: 340 },
            draw,
            refreshMs: 5000,
        });
    }
    panel.show();
}

/**
 * Tear the panel down, for the feature's own cleanup.
 * @returns {void}
 */
export function closePullSummaryPanel() {
    panel?.hide?.();
}

export default { openPullSummaryPanel, closePullSummaryPanel };
