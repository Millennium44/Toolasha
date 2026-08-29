/**
 * PFormance Panel
 * Floating panel displaying CPU performance metrics for Toolasha features
 * and DOM observer handlers.
 */

import config from '../../core/config.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { formatReport, reportData, gapsBetween, initTimeline, initSummary } from '../../utils/performance-report.js';
import { downloadFile } from '../../utils/csv-export.js';
import { performanceMonitor, scriptBuildLabel } from '../../utils/bundle-bridge.js';

function getPerformanceMonitor() {
    return performanceMonitor();
}

/**
 * Turn measuring on or off, if there is anything to turn.
 *
 * The monitor hangs off the global the script publishes, which is not there in
 * every context this panel can be opened from — and an assignment through
 * nothing takes the open or the close with it.
 *
 * @param {boolean} enabled - Whether to measure
 */
function setMonitorEnabled(enabled) {
    const monitor = getPerformanceMonitor();
    if (!monitor) return;
    monitor.enabled = enabled;
    // The stall ledger follows the rolling stats: what a player feels as a
    // hitch is recorded, attributed, and printed with the trace
    if (enabled) monitor.startStallWatch?.();
    else monitor.stopStallWatch?.();
}

const COLORS = {
    background: 'rgba(5, 5, 15, 0.95)',
    headerBg: 'rgba(15, 5, 35, 0.7)',
    border: 'rgba(0, 255, 234, 0.4)',
    borderDim: 'rgba(0, 255, 234, 0.2)',
    text: '#e0f7ff',
    textDim: 'rgba(224, 247, 255, 0.6)',
    accent: '#00ffe7',
    danger: '#ff0055',
    warning: '#ffaa00',
    success: '#00ff99',
};

class PFormancePanel {
    constructor() {
        this.panel = null;
        this.timerRegistry = createTimerRegistry();
        this.updateIntervalId = null;
        this.isDragging = false;
        this.isCollapsed = false;
        this.featureSectionCollapsed = false;
        this.domSectionCollapsed = false;
        this.activitySectionCollapsed = false;
        this.stallSectionCollapsed = false;
        this.startupCollapsed = false;
    }

    initialize() {
        // No-op — panel is created on-demand via show()
    }

    show() {
        if (this.isVisible()) {
            bringPanelToFront(this.panel);
            return;
        }
        setMonitorEnabled(true);
        this._createPanel();
        this._startUpdating();
    }

    /** @returns {boolean} Whether the panel is on screen right now */
    isVisible() {
        return Boolean(this.panel && document.body.contains(this.panel));
    }

    /** Close it */
    hide() {
        this._removePanel();
    }

    /**
     * Open if closed, close if open.
     *
     * The button in settings is one button, and a button that only ever opens
     * leaves the panel with no way back except its own ✕ — which is the half of
     * the pair a phone loses first.
     */
    toggle() {
        if (this.isVisible()) this.hide();
        else this.show();
    }

    disable() {
        this._removePanel();
    }

    _createPanel() {
        this.panel = document.createElement('div');
        this.panel.id = 'toolasha-pformance-panel';
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '80px',
            right: '80px',
            zIndex: String(config.Z_FLOATING_PANEL),
            // Clamped so the first open on a phone is not wider than the screen
            width: 'min(380px, 92vw)',
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(12px)',
            color: COLORS.text,
            fontSize: '13px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        this.panel.appendChild(this._createHeader());

        this.contentEl = document.createElement('div');
        this.contentEl.style.padding = '10px';
        this.contentEl.style.overflow = 'auto';
        this.contentEl.style.maxHeight = '500px';
        this.panel.appendChild(this.contentEl);

        this._makeDraggable();

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        this._updateContent();
    }

    _createHeader() {
        const header = document.createElement('div');
        header.className = 'pformance-header';
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: 'move',
            padding: '8px 12px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
        });
        this.headerEl = header;

        const title = document.createElement('span');
        title.textContent = 'PFormance';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;

        const buttons = document.createElement('div');
        buttons.style.display = 'flex';
        buttons.style.gap = '4px';

        const collapseBtn = this._headerButton(this.isCollapsed ? '▶' : '▼', () => {
            this.isCollapsed = !this.isCollapsed;
            collapseBtn.textContent = this.isCollapsed ? '▶' : '▼';
            this.contentEl.style.display = this.isCollapsed ? 'none' : '';
        });

        const copyBtn = this._headerButton('⧉', () => this._exportReport('clipboard'));
        copyBtn.title = 'Copy the startup trace — paste it to somebody who can read it';

        const saveBtn = this._headerButton('⭳', () => this._exportReport('file'));
        saveBtn.title = 'Save the startup trace as a file (text and JSON)';

        const closeBtn = this._headerButton('✕', () => this.hide());
        closeBtn.title = 'Close';

        this.copyButton = copyBtn;
        buttons.appendChild(copyBtn);
        buttons.appendChild(saveBtn);
        buttons.appendChild(collapseBtn);
        buttons.appendChild(closeBtn);

        header.appendChild(title);
        header.appendChild(buttons);
        return header;
    }

    _headerButton(text, onClick) {
        const btn = document.createElement('button');
        btn.textContent = text;
        Object.assign(btn.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '14px',
            padding: '2px 6px',
            borderRadius: '3px',
        });
        btn.addEventListener('mouseover', () => {
            btn.style.background = 'rgba(0, 255, 234, 0.15)';
        });
        btn.addEventListener('mouseout', () => {
            btn.style.background = 'none';
        });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    _makeDraggable() {
        let offsetX = 0;
        let offsetY = 0;

        const onPointerMove = (e) => {
            if (!this.isDragging) return;
            this.panel.style.left = `${e.clientX - offsetX}px`;
            this.panel.style.right = 'auto';
            this.panel.style.top = `${e.clientY - offsetY}px`;
        };

        const onPointerUp = () => {
            this.isDragging = false;
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerUp);
        };

        // Pointer events so a finger can drag it too; touch-action stops the
        // browser turning the drag into a scroll
        this.headerEl.style.touchAction = 'none';
        this.headerEl.addEventListener('pointerdown', (e) => {
            bringPanelToFront(this.panel);
            this.isDragging = true;
            const rect = this.panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
        });
    }

    _startUpdating() {
        if (this.updateIntervalId) return;
        this.updateIntervalId = setInterval(() => this._updateContent(), 1000);
        this.timerRegistry.registerInterval(this.updateIntervalId);
    }

    _stopUpdating() {
        if (this.updateIntervalId) {
            clearInterval(this.updateIntervalId);
            this.updateIntervalId = null;
        }
    }

    _removePanel() {
        this._stopUpdating();
        setMonitorEnabled(false);
        if (this.panel) {
            unregisterFloatingPanel(this.panel);
            this.panel.remove();
            this.panel = null;
            this.contentEl = null;
            this.headerEl = null;
        }
    }

    _updateContent() {
        if (!this.contentEl) return;
        const pm = getPerformanceMonitor();
        if (!pm) return;
        const allStats = pm.getAllStats();
        const snapshots = pm.getSnapshots();

        const initEntries = [];
        const domEntries = [];

        for (const [name, snap] of snapshots) {
            if (name.startsWith('init:') || name.startsWith('bg:')) {
                const background = name.startsWith('bg:');
                initEntries.push({
                    name: (background ? '⤵ ' : '') + name.slice(background ? 3 : 5),
                    totalMs: snap.duration,
                    startedAt: snap.startedAt ?? 0,
                    background,
                    parts: pm.getSpans(name),
                });
            }
        }

        // Everything else the rolling stats hold — traced timers, ws dispatch,
        // event fan-outs, the networth recalc — is the attribution the stall
        // ledger draws from, and worth seeing live for the same reason
        const activityEntries = [];
        for (const [name, stats] of allStats) {
            if (name.startsWith('dom:')) {
                domEntries.push({ name: name.slice(4), ...stats });
            } else if (!name.startsWith('init:') && !name.startsWith('bg:')) {
                activityEntries.push({ name, ...stats });
            }
        }

        const stallEntries = (pm.getStalls?.() || [])
            .slice(-12)
            .reverse()
            .map((stall) => ({
                stallMs: stall.duration,
                at: stall.sinceBoot,
                who: stall.suspects?.length
                    ? stall.suspects.map((suspect) => `${suspect.name} ${suspect.ms}ms`).join(', ')
                    : stall.recentEvents?.length
                      ? `after ${stall.recentEvents.join(', ')} (likely the game)`
                      : 'nothing instrumented',
            }));

        initEntries.sort((a, b) => b.totalMs - a.totalMs);
        domEntries.sort((a, b) => b.cpuPercent - a.cpuPercent);
        activityEntries.sort((a, b) => b.cpuPercent - a.cpuPercent);

        this.contentEl.innerHTML = '';
        this.contentEl.appendChild(this._createStartupSection(pm, snapshots));
        this.contentEl.appendChild(
            this._createSection('Feature Init', initEntries, this.featureSectionCollapsed, (v) => {
                this.featureSectionCollapsed = v;
            })
        );
        this.contentEl.appendChild(
            this._createSection('DOM Observers', domEntries, this.domSectionCollapsed, (v) => {
                this.domSectionCollapsed = v;
            })
        );
        this.contentEl.appendChild(
            this._createSection('Timers & Events', activityEntries, this.activitySectionCollapsed, (v) => {
                this.activitySectionCollapsed = v;
            })
        );
        this.contentEl.appendChild(
            this._createSection('Main-thread Stalls', stallEntries, this.stallSectionCollapsed, (v) => {
                this.stallSectionCollapsed = v;
            })
        );
    }

    /**
     * The startup itself: where the time went before anything was drawn.
     *
     * A list of feature durations cannot show waiting, and waiting is usually
     * most of a slow start — for IndexedDB to open, for the game's own data to
     * arrive. The marks are what make those stretches visible.
     * @private
     */
    _createStartupSection(pm, snapshots) {
        const marks = pm.getMarks();
        const timeline = initTimeline(snapshots);
        const summary = initSummary(timeline);
        const rows = [];

        for (const mark of marks) {
            rows.push({ name: mark.name, at: mark.at, kind: 'mark' });
        }
        for (const gap of gapsBetween(marks).slice(0, 3)) {
            if (gap.ms < 100) continue;
            rows.push({ name: `${gap.from} → ${gap.to}`, at: gap.ms, kind: 'gap' });
        }

        const section = document.createElement('div');
        section.style.marginBottom = '8px';

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            cursor: 'pointer',
            padding: '4px 6px',
            background: COLORS.headerBg,
            borderRadius: '4px',
            marginBottom: this.startupCollapsed ? '0' : '4px',
            userSelect: 'none',
        });
        const label = document.createElement('span');
        label.textContent = `${this.startupCollapsed ? '▶' : '▼'} Startup`;
        Object.assign(label.style, { fontWeight: 'bold', fontSize: '12px', color: COLORS.accent });
        const total = document.createElement('span');
        total.textContent = `${(summary.span / 1000).toFixed(1)}s`;
        Object.assign(total.style, { fontSize: '11px', color: COLORS.textDim });
        header.appendChild(label);
        header.appendChild(total);
        header.addEventListener('click', () => {
            this.startupCollapsed = !this.startupCollapsed;
            this._updateContent();
        });
        section.appendChild(header);
        if (this.startupCollapsed) return section;

        const blurb = document.createElement('div');
        blurb.textContent =
            `${(summary.blocking / 1000).toFixed(1)}s of features held the page up, ` +
            `${(summary.background / 1000).toFixed(1)}s ran after it drew`;
        Object.assign(blurb.style, { padding: '2px 6px', fontSize: '11px', color: COLORS.textDim });
        section.appendChild(blurb);

        const table = document.createElement('table');
        Object.assign(table.style, { width: '100%', borderCollapse: 'collapse', fontSize: '11px' });
        const tbody = document.createElement('tbody');
        for (const row of rows) {
            const tr = document.createElement('tr');
            if (row.kind === 'gap') tr.style.color = COLORS.warning;
            tr.appendChild(this._cell(row.kind === 'gap' ? `waited  ${row.name}` : row.name, 'left'));
            tr.appendChild(this._cell(`${(row.at / 1000).toFixed(2)}s`, 'right'));
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        section.appendChild(table);
        return section;
    }

    /**
     * Hand the whole trace over, as text a person can read.
     *
     * The panel is a live view; a trace is evidence. Copying beats a screenshot
     * because the two things that locate a slow start — when each feature began,
     * and what the page was waiting for between them — are numbers, not pictures.
     * @param {'clipboard'|'file'} destination - Where it goes
     * @private
     */
    async _exportReport(destination) {
        const pm = getPerformanceMonitor();
        if (!pm) return;

        const payload = {
            marks: pm.getMarks(),
            snapshots: pm.getSnapshots(),
            spans: pm.spans,
            stats: pm.getAllStats(),
            stalls: pm.getStalls?.() || [],
            worstStallMs: pm.getWorstStallMs?.() || 0,
            environment: {
                script: scriptBuildLabel() || 'unknown',
                cores: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 'unknown',
                agent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
                takenAt: new Date().toISOString(),
            },
        };
        const text = formatReport(payload);

        if (destination === 'file') {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
            downloadFile(`toolasha-startup-${stamp}.txt`, text);
            downloadFile(
                `toolasha-startup-${stamp}.json`,
                JSON.stringify(reportData(payload), null, 2),
                'application/json'
            );
            this._flash('saved');
            return;
        }

        try {
            await navigator.clipboard.writeText(text);
            this._flash('copied');
        } catch (error) {
            // A clipboard that refuses is not a reason to lose the trace
            console.error('[PFormance] Copying the trace failed:', error);
            console.log(text);
            this._flash('in console');
        }
    }

    /** @private */
    _flash(message) {
        if (!this.copyButton) return;
        const original = this.copyButton.textContent;
        this.copyButton.textContent = message;
        clearTimeout(this._flashTimer);
        this._flashTimer = setTimeout(() => {
            if (this.copyButton) this.copyButton.textContent = original;
        }, 1400);
    }

    _createSection(title, entries, collapsed, setCollapsed) {
        const section = document.createElement('div');
        section.style.marginBottom = '8px';

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: 'pointer',
            padding: '4px 6px',
            background: COLORS.headerBg,
            borderRadius: '4px',
            marginBottom: collapsed ? '0' : '4px',
            userSelect: 'none',
        });

        const label = document.createElement('span');
        label.textContent = `${collapsed ? '▶' : '▼'} ${title}`;
        label.style.fontWeight = 'bold';
        label.style.fontSize = '12px';
        label.style.color = COLORS.accent;

        const count = document.createElement('span');
        count.textContent = `${entries.length}`;
        count.style.fontSize = '11px';
        count.style.color = COLORS.textDim;

        header.appendChild(label);
        header.appendChild(count);
        header.addEventListener('click', () => {
            setCollapsed(!collapsed);
            this._updateContent();
        });

        section.appendChild(header);

        if (collapsed) return section;

        if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'No data';
            empty.style.padding = '4px 6px';
            empty.style.color = COLORS.textDim;
            empty.style.fontSize = '11px';
            section.appendChild(empty);
            return section;
        }

        const table = document.createElement('table');
        Object.assign(table.style, {
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '11px',
        });

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        const columns =
            title === 'Feature Init'
                ? ['Name', 'Started', 'Time (ms)']
                : title === 'Main-thread Stalls'
                  ? ['Suspects', 'At', 'Stall ms']
                  : ['Name', 'Calls/s', 'Total ms', 'CPU %'];

        for (const col of columns) {
            const th = document.createElement('th');
            th.textContent = col;
            Object.assign(th.style, {
                padding: '3px 5px',
                textAlign: col === 'Name' ? 'left' : 'right',
                borderBottom: `1px solid ${COLORS.borderDim}`,
                color: COLORS.textDim,
                fontWeight: 'normal',
            });
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const entry of entries) {
            const row = document.createElement('tr');

            if (title === 'Feature Init') {
                row.appendChild(this._cell(entry.name, 'left'));
                row.appendChild(this._cell((entry.startedAt / 1000).toFixed(1) + 's', 'right'));
                row.appendChild(this._cell(entry.totalMs.toFixed(1), 'right'));
                if (entry.background) row.style.color = COLORS.textDim;
            } else if (title === 'Main-thread Stalls') {
                row.appendChild(this._cell(entry.who, 'left'));
                row.appendChild(this._cell((entry.at / 1000).toFixed(1) + 's', 'right'));
                const stallCell = this._cell(String(entry.stallMs), 'right');
                if (entry.stallMs >= 100) stallCell.style.color = COLORS.danger;
                row.appendChild(stallCell);
            } else {
                const callsPerSec = (entry.calls / ((getPerformanceMonitor()?.windowMs || 5000) / 1000)).toFixed(1);
                row.appendChild(this._cell(entry.name, 'left'));
                row.appendChild(this._cell(callsPerSec, 'right'));
                row.appendChild(this._cell(entry.totalMs.toFixed(1), 'right'));
                row.appendChild(this._cpuCell(entry.cpuPercent));
            }

            tbody.appendChild(row);

            // What the six seconds were spent on, where anybody has said
            for (const part of entry.parts || []) {
                const partRow = document.createElement('tr');
                partRow.style.color = COLORS.textDim;
                partRow.appendChild(this._cell(`   └ ${part.part}`, 'left'));
                partRow.appendChild(this._cell('', 'right'));
                partRow.appendChild(this._cell(part.duration.toFixed(1), 'right'));
                tbody.appendChild(partRow);
            }
        }
        table.appendChild(tbody);
        section.appendChild(table);

        return section;
    }

    _cell(text, align) {
        const td = document.createElement('td');
        td.textContent = text;
        Object.assign(td.style, {
            padding: '2px 5px',
            textAlign: align,
            borderBottom: `1px solid ${COLORS.borderDim}`,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: align === 'left' ? '160px' : 'auto',
        });
        return td;
    }

    _cpuCell(percent) {
        const td = document.createElement('td');
        td.textContent = percent.toFixed(2) + '%';
        Object.assign(td.style, {
            padding: '2px 5px',
            textAlign: 'right',
            borderBottom: `1px solid ${COLORS.borderDim}`,
            fontWeight: 'bold',
        });

        if (percent > 5) {
            td.style.color = COLORS.danger;
        } else if (percent > 1) {
            td.style.color = COLORS.warning;
        } else {
            td.style.color = COLORS.success;
        }

        return td;
    }
}

const pformancePanel = new PFormancePanel();

export default pformancePanel;
