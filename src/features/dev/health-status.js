/**
 * What did not start, and everything needed to say why.
 *
 * The health pass has always run and has always been able to find nothing,
 * because no feature declared a `healthCheck` — so a failure to draw reached the
 * player as a thing that is simply missing, with the only evidence in a console
 * they are not looking at. This is the other end of that: the aggregate toast
 * leads here, and here leads to a report somebody can paste into a bug thread.
 *
 * The report reuses the startup trace rather than inventing a second format. A
 * feature that failed and the ten seconds the page spent waiting for IndexedDB
 * are usually the same story, and they are much easier to read together.
 */

import config from '../../core/config.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { formatReport, reportData } from '../../utils/performance-report.js';
import { showToast } from '../../utils/toast.js';

const PANEL_ID = 'toolasha-health-status';

const COLORS = {
    background: 'rgba(12, 8, 8, 0.96)',
    headerBg: 'rgba(40, 14, 14, 0.8)',
    border: 'rgba(255, 120, 120, 0.45)',
    borderDim: 'rgba(255, 120, 120, 0.2)',
    text: '#ffe6e6',
    textDim: 'rgba(255, 230, 230, 0.6)',
    accent: '#ff8a8a',
};

/**
 * The performance monitor, read off the global because this module is in a
 * different bundle from Core and only wants it when a panel is opened.
 * @returns {Object|null} The monitor, or null before Core has loaded
 */
function getPerformanceMonitor() {
    return window.Toolasha?.Core?.performanceMonitor || null;
}

/**
 * Everything a maintainer needs to reproduce a failed start, as pasteable text.
 *
 * Exported separately from the panel so the arithmetic-free parts of it — which
 * feature, which version, which browser — can be tested without a DOM.
 *
 * @param {Array<{key: string, name: string, reason: string}>} failures - Failed features
 * @returns {string} The report
 */
export function buildDiagnosticReport(failures = []) {
    const root = typeof window !== 'undefined' ? window.Toolasha : undefined;
    const agent = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';
    const monitor = getPerformanceMonitor();

    const lines = [];
    lines.push('Toolasha health report');
    lines.push('='.repeat(60));
    lines.push(`script: ${root?.version || 'unknown'}`);
    lines.push(`fork: ${root?.fork || 'unknown'}`);
    lines.push(`agent: ${agent}`);
    lines.push(`takenAt: ${new Date().toISOString()}`);
    lines.push('');

    lines.push(`Features that did not start (${failures.length})`);
    lines.push('-'.repeat(60));
    if (failures.length === 0) {
        lines.push('none');
    } else {
        for (const failure of failures) {
            lines.push(`- ${failure.name || failure.key} [${failure.key}]: ${failure.reason || 'unknown reason'}`);
        }
    }
    lines.push('');

    if (monitor) {
        lines.push(
            formatReport({
                marks: monitor.getMarks(),
                snapshots: monitor.getSnapshots(),
                spans: monitor.spans,
                stats: monitor.getAllStats(),
                environment: {
                    script: root?.version || 'unknown',
                    fork: root?.fork || 'unknown',
                    agent,
                },
            })
        );
    } else {
        lines.push('No startup trace was recorded.');
    }

    return lines.join('\n');
}

/**
 * The same thing as data, for anyone who would rather parse it.
 * @param {Array<Object>} failures - Failed features
 * @returns {Object} JSON-safe report
 */
export function diagnosticData(failures = []) {
    const root = typeof window !== 'undefined' ? window.Toolasha : undefined;
    const monitor = getPerformanceMonitor();
    return {
        script: root?.version || 'unknown',
        fork: root?.fork || 'unknown',
        agent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        takenAt: new Date().toISOString(),
        failures,
        startup: monitor
            ? reportData({
                  marks: monitor.getMarks(),
                  snapshots: monitor.getSnapshots(),
                  spans: monitor.spans,
                  stats: monitor.getAllStats(),
              })
            : null,
    };
}

class HealthStatusPanel {
    constructor() {
        this.panel = null;
        this.failures = [];
    }

    /**
     * Show the list of failures, replacing whatever was shown before.
     * @param {Array<{key: string, name: string, reason: string}>} failures - Failed features
     */
    show(failures = []) {
        this.failures = failures;
        this._removePanel();
        this._createPanel();
    }

    /** Close the panel, if it is up. */
    disable() {
        this._removePanel();
    }

    /** @private */
    _createPanel() {
        if (typeof document === 'undefined' || !document.body) return;

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        Object.assign(panel.style, {
            position: 'fixed',
            top: '80px',
            right: '80px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: 'min(460px, 94vw)',
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontFamily: "'Segoe UI', sans-serif",
            fontSize: '13px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        panel.appendChild(this._createHeader());
        panel.appendChild(this._createBody());
        panel.appendChild(this._createFooter());

        document.body.appendChild(panel);
        this.panel = panel;
        registerFloatingPanel(panel);
        bringPanelToFront(panel);
    }

    /** @private */
    _createHeader() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 12px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
        });

        const title = document.createElement('span');
        title.textContent = `Toolasha — ${this.failures.length} feature${this.failures.length === 1 ? '' : 's'} did not start`;
        Object.assign(title.style, { fontWeight: 'bold', color: COLORS.accent });

        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '✕';
        close.title = 'Close';
        Object.assign(close.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '14px',
            padding: '2px 6px',
        });
        close.addEventListener('click', () => this._removePanel());

        header.appendChild(title);
        header.appendChild(close);
        return header;
    }

    /** @private */
    _createBody() {
        const body = document.createElement('div');
        body.className = 'toolasha-health-list';
        Object.assign(body.style, { padding: '10px 12px', maxHeight: '320px', overflow: 'auto' });

        if (this.failures.length === 0) {
            const ok = document.createElement('div');
            ok.textContent = 'Everything reported healthy.';
            ok.style.color = COLORS.textDim;
            body.appendChild(ok);
            return body;
        }

        for (const failure of this.failures) {
            const row = document.createElement('div');
            Object.assign(row.style, {
                padding: '6px 0',
                borderBottom: `1px solid ${COLORS.borderDim}`,
            });

            const name = document.createElement('div');
            name.textContent = failure.name || failure.key;
            name.style.fontWeight = '600';

            const reason = document.createElement('div');
            reason.textContent = `${failure.key} — ${failure.reason || 'unknown reason'}`;
            Object.assign(reason.style, { color: COLORS.textDim, fontSize: '12px' });

            row.appendChild(name);
            row.appendChild(reason);
            body.appendChild(row);
        }

        const advice = document.createElement('div');
        advice.textContent =
            'Reopening the relevant game panel, or reloading the page, fixes most of these. ' +
            'If it keeps happening, send the report below.';
        Object.assign(advice.style, { color: COLORS.textDim, fontSize: '12px', marginTop: '8px' });
        body.appendChild(advice);

        return body;
    }

    /** @private */
    _createFooter() {
        const footer = document.createElement('div');
        Object.assign(footer.style, {
            display: 'flex',
            gap: '8px',
            justifyContent: 'flex-end',
            padding: '8px 12px',
            borderTop: `1px solid ${COLORS.borderDim}`,
        });

        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'toolasha-health-copy';
        copy.textContent = 'Copy diagnostic report';
        Object.assign(copy.style, {
            background: 'rgba(255, 120, 120, 0.15)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '4px',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '12px',
            padding: '5px 10px',
        });
        copy.addEventListener('click', () => this._copyReport(copy));

        footer.appendChild(copy);
        return footer;
    }

    /**
     * Put the report on the clipboard, and in the console if that is refused.
     * @param {HTMLElement} button - The button to flash confirmation on
     * @private
     */
    async _copyReport(button) {
        const text = buildDiagnosticReport(this.failures);
        const original = button.textContent;
        try {
            await navigator.clipboard.writeText(text);
            button.textContent = 'Copied';
        } catch (error) {
            // A clipboard that refuses is not a reason to lose the report
            console.error('[HealthStatus] Copying the report failed:', error);
            console.log(text);
            button.textContent = 'In console';
        }
        setTimeout(() => {
            button.textContent = original;
        }, 1600);
    }

    /** @private */
    _removePanel() {
        const existing = this.panel || (typeof document !== 'undefined' ? document.getElementById(PANEL_ID) : null);
        if (!existing) return;
        unregisterFloatingPanel(existing);
        existing.remove();
        this.panel = null;
    }
}

const healthStatusPanel = new HealthStatusPanel();

/**
 * Open the status view directly, without a toast in front of it.
 * @param {Array<{key: string, name: string, reason: string}>} failures - Failed features
 */
export function showHealthStatus(failures = []) {
    healthStatusPanel.show(failures);
}

/**
 * The whole surfacing step: one toast that leads to the list.
 *
 * Kept here rather than in the entrypoint so the wording, the urgency and the
 * follow-up stay together — a toast whose text promises details and whose action
 * opens something else is worse than no toast.
 *
 * @param {Array<{key: string, name: string, reason: string}>} failures - Failed features
 * @returns {Object|null} The toast handle, or null when there is nothing to say
 */
export function reportFailures(failures = []) {
    if (!failures.length) return null;
    const plural = failures.length === 1 ? '' : 's';
    return showToast(`${failures.length} Toolasha feature${plural} failed to start — click for details`, {
        kind: 'warn',
        // Stays up: a startup failure that fades after six seconds is a failure
        // nobody saw, which is the state this whole thing exists to end
        duration: 0,
        action: { label: 'Show which ones', onClick: () => healthStatusPanel.show(failures) },
    });
}

export default healthStatusPanel;
