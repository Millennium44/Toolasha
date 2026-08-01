/**
 * Overlay Panel
 *
 * One floating panel that other features hang a row on.
 *
 * The point is that the panel knows nothing about what it shows. A feature that
 * wants a line on screen calls `registerRow` and hands over a function that draws
 * into a container; the shell owns everything else — where the panel sits, which
 * rows are on, what order they come in, and when to redraw. Adding the twentieth
 * row is then the same amount of work as the second, which is the only way a
 * panel of this shape stays maintainable.
 *
 * ## Adding a row
 *
 * ```js
 * import { registerRow } from '../ui/overlay-panel.js';
 *
 * registerRow({
 *     key: 'treasure',            // stable — it is the storage key for visibility and order
 *     name: 'Treasure',           // how it reads in the row picker
 *     render: (container) => {    // called on every refresh; draw the current state
 *         container.textContent = `${chestsOpened} chests`;
 *     },
 * });
 * ```
 *
 * Register at module scope, not inside `initialize`. Rows are collected in a
 * module-level list so registration order and feature start-up order do not have
 * to agree, and a row whose feature is switched off simply renders nothing.
 *
 * ## Redrawing
 *
 * Every visible row is redrawn on a timer rather than each feature pushing
 * updates. Rows show rates, elapsed times and counters that change on their own,
 * so a push model would need most rows to own a timer anyway — and a row that
 * forgot would silently show a stale number. `render` should be cheap and should
 * read state rather than compute it; anything expensive belongs behind a cache in
 * the feature that owns it.
 *
 * The shape is OPanel's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, clampToViewport } from '../../utils/floating-panel.js';

const STORAGE_KEY = 'overlayPanel';
const PANEL_ID = 'toolasha-overlay-panel';
const REFRESH_MS = 1000;

const COLORS = {
    background: 'rgba(8, 10, 20, 0.9)',
    headerBg: 'rgba(20, 24, 40, 0.85)',
    border: 'rgba(120, 160, 255, 0.3)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.5)',
    accent: '#9ec4ff',
};

/**
 * Rows, in registration order.
 *
 * Module-level so a feature can register while the shell is still asleep — the
 * alternative is every feature having to know whether the panel has started yet.
 * @type {Array<{key: string, name: string, render: Function, defaultVisible: boolean}>}
 */
const rows = [];

/**
 * Add a row to the overlay.
 *
 * Safe to call before the panel exists, and safe to call twice — a repeated key
 * replaces the earlier definition rather than drawing the row twice, so a feature
 * that re-initialises does not double up.
 *
 * @param {Object} row - Row definition
 * @param {string} row.key - Stable identifier, used as the storage key
 * @param {string} row.name - Label in the row picker
 * @param {Function} row.render - `(container: HTMLElement) => void`, called per refresh
 * @param {boolean} [row.defaultVisible] - Whether it starts on
 */
export function registerRow({ key, name, render, defaultVisible = true }) {
    if (!key || typeof render !== 'function') {
        console.error('[OverlayPanel] A row needs a key and a render function:', key);
        return;
    }

    const definition = { key, name: name || key, render, defaultVisible };
    const existing = rows.findIndex((row) => row.key === key);
    if (existing >= 0) rows[existing] = definition;
    else rows.push(definition);
}

/**
 * The registered rows, in the order they should be offered.
 * Exported for tests and for anything that wants to know what is available.
 * @returns {Array<Object>} Row definitions
 */
export function registeredRows() {
    return [...rows];
}

/**
 * Put saved settings and the rows that actually exist together.
 *
 * Kept pure so the awkward cases are testable: a row saved in the order but since
 * removed from the code, and a row added by an update that no saved order has
 * heard of. The first must not leave a hole and the second must not be lost at
 * the bottom of a list nobody knows to look at.
 *
 * @param {Array<Object>} available - Registered rows
 * @param {Object} saved - `{ visible: {key: bool}, order: string[] }`
 * @returns {Array<Object>} Rows to draw, in order, each with `visible`
 */
export function resolveRows(available, saved) {
    const order = saved?.order || [];
    const visible = saved?.visible || {};

    const known = new Map(available.map((row) => [row.key, row]));
    const ordered = [];

    for (const key of order) {
        const row = known.get(key);
        // A key left over from a row that no longer exists
        if (!row) continue;
        ordered.push(row);
        known.delete(key);
    }
    // Anything the saved order has not heard of is new, and goes at the end
    ordered.push(...known.values());

    return ordered.map((row) => ({
        ...row,
        visible: visible[row.key] ?? row.defaultVisible,
    }));
}

/**
 * Move a key one place through an order.
 *
 * Works on the full order rather than only the visible rows, so hiding a row and
 * showing it again does not quietly move it.
 *
 * @param {string[]} order - Current order
 * @param {string} key - What to move
 * @param {number} delta - -1 for up, 1 for down
 * @returns {string[]} A new order
 */
export function moveRow(order, key, delta) {
    const index = order.indexOf(key);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return order;

    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

class OverlayPanel {
    constructor() {
        this.isInitialized = false;
        this.settings = { visible: {}, order: [], position: null, open: false };
        this.panel = null;
        this.bodyEl = null;
        this.pickerEl = null;
        this.timerRegistry = createTimerRegistry();
        this.detachDrag = null;
        this.refreshId = null;
        this.containers = new Map();
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('overlayPanel')) return;
        this.isInitialized = true;

        const saved = await storage.getJSON(STORAGE_KEY, 'settings', null);
        if (saved) this.settings = { ...this.settings, ...saved };

        // Reopens itself where you left it — an overlay you have to summon after
        // every refresh is an overlay you stop using
        if (this.settings.open) this.show();
    }

    disable() {
        this._removePanel();
        this.isInitialized = false;
    }

    /** Open the panel, or raise it if it is already up */
    show() {
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._createPanel();
        this.settings.open = true;
        this._save();
    }

    /** Close the panel and remember that it was closed */
    hide() {
        this._removePanel();
        this.settings.open = false;
        this._save();
    }

    /** Open if closed, close if open */
    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    /** Redraw now, rather than waiting for the next tick */
    refresh() {
        this._renderBody();
    }

    _save() {
        storage.setJSON(STORAGE_KEY, this.settings, 'settings').catch((error) => {
            console.error('[OverlayPanel] Saving the layout failed:', error);
        });
    }

    _createPanel() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '120px',
            left: '20px',
            zIndex: String(config.Z_FLOATING_PANEL),
            minWidth: '220px',
            maxWidth: '420px',
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.55)',
            color: COLORS.text,
            fontSize: '13px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });
        this._restorePosition();

        this.panel.appendChild(this._createHeader());

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            padding: '6px 10px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '3px',
            overflow: 'auto',
            maxHeight: '70vh',
        });
        this.panel.appendChild(this.bodyEl);

        this.pickerEl = this._createPicker();
        this.panel.appendChild(this.pickerEl);

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        this._renderBody();
        this._startRefreshing();
    }

    _restorePosition() {
        const saved = this.settings.position;
        if (!saved) return;

        // Measured after mounting would be exact, but a panel that visibly jumps
        // on every page load is worse than a nominal size here
        const clamped = clampToViewport(
            saved,
            { width: 260, height: 120 },
            {
                width: window.innerWidth,
                height: window.innerHeight,
            }
        );
        if (!clamped) return;

        this.panel.style.left = `${clamped.left}px`;
        this.panel.style.top = `${clamped.top}px`;
        this.panel.style.right = 'auto';
    }

    _createHeader() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: 'move',
            padding: '5px 8px 5px 10px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            gap: '10px',
        });

        const title = document.createElement('span');
        title.textContent = 'Overlay';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;

        const buttons = document.createElement('div');
        buttons.style.display = 'flex';
        buttons.style.gap = '2px';

        const gearBtn = this._iconButton('⚙', 'Choose and reorder rows', () => {
            const hidden = this.pickerEl.style.display === 'none';
            this.pickerEl.style.display = hidden ? '' : 'none';
            if (hidden) this._renderPicker();
        });
        const closeBtn = this._iconButton('✕', 'Close', () => this.hide());

        buttons.appendChild(gearBtn);
        buttons.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(buttons);

        this.detachDrag = makeDraggable(this.panel, header, (position) => {
            this.settings.position = position;
            this._save();
        });
        return header;
    }

    /**
     * @param {string} text - Glyph
     * @param {string} title - Tooltip
     * @param {Function} onClick - Handler
     * @returns {HTMLButtonElement}
     */
    _iconButton(text, title, onClick) {
        const button = document.createElement('button');
        button.textContent = text;
        button.title = title;
        Object.assign(button.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '13px',
            lineHeight: '1',
            padding: '3px 5px',
            borderRadius: '3px',
        });
        button.addEventListener('mouseover', () => (button.style.background = 'rgba(158, 196, 255, 0.18)'));
        button.addEventListener('mouseout', () => (button.style.background = 'none'));
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    _createPicker() {
        const picker = document.createElement('div');
        Object.assign(picker.style, {
            display: 'none',
            padding: '6px 10px 8px',
            borderTop: `1px solid ${COLORS.border}`,
            background: 'rgba(0, 0, 0, 0.25)',
            fontSize: '12px',
        });
        return picker;
    }

    _renderPicker() {
        this.pickerEl.replaceChildren();

        const resolved = resolveRows(rows, this.settings);
        if (!resolved.length) {
            const empty = document.createElement('div');
            empty.style.color = COLORS.textDim;
            empty.textContent = 'No features have registered a row yet.';
            this.pickerEl.appendChild(empty);
            return;
        }

        // Reordering acts on the full order, so it has to exist before a row can
        // be moved — a fresh install has no saved order at all
        this.settings.order = resolved.map((row) => row.key);

        for (const row of resolved) {
            const line = document.createElement('label');
            Object.assign(line.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '2px 0',
                cursor: 'pointer',
            });

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = row.visible;
            checkbox.addEventListener('change', () => {
                this.settings.visible = { ...this.settings.visible, [row.key]: checkbox.checked };
                this._save();
                this._renderBody();
            });

            const name = document.createElement('span');
            name.textContent = row.name;
            name.style.flex = '1';

            const up = this._iconButton('▲', 'Move up', () => this._move(row.key, -1));
            const down = this._iconButton('▼', 'Move down', () => this._move(row.key, 1));
            up.style.fontSize = '9px';
            down.style.fontSize = '9px';

            line.appendChild(checkbox);
            line.appendChild(name);
            line.appendChild(up);
            line.appendChild(down);
            this.pickerEl.appendChild(line);
        }
    }

    /**
     * @param {string} key - Row to move
     * @param {number} delta - -1 up, 1 down
     */
    _move(key, delta) {
        const next = moveRow(this.settings.order, key, delta);
        if (next === this.settings.order) return;

        this.settings.order = next;
        this._save();
        this._renderPicker();
        this._renderBody();
    }

    _renderBody() {
        if (!this.bodyEl) return;

        const resolved = resolveRows(rows, this.settings).filter((row) => row.visible);
        if (!resolved.length) {
            this.containers.clear();
            this.bodyEl.replaceChildren();
            const empty = document.createElement('div');
            empty.style.color = COLORS.textDim;
            empty.textContent = rows.length ? 'Every row is switched off — see ⚙.' : 'Nothing to show yet.';
            this.bodyEl.appendChild(empty);
            return;
        }

        // Containers are kept between refreshes and only reordered, so a row that
        // draws something interactive is not rebuilt out from under the pointer
        // once a second
        const wanted = new Set(resolved.map((row) => row.key));
        for (const [key, container] of this.containers) {
            if (!wanted.has(key)) {
                container.remove();
                this.containers.delete(key);
            }
        }
        for (const [index, row] of resolved.entries()) {
            let container = this.containers.get(row.key);
            if (!container) {
                container = document.createElement('div');
                container.dataset.overlayRow = row.key;
                this.containers.set(row.key, container);
            }
            if (this.bodyEl.children[index] !== container) {
                this.bodyEl.insertBefore(container, this.bodyEl.children[index] || null);
            }

            try {
                row.render(container);
            } catch (error) {
                console.error(`[OverlayPanel] Row "${row.key}" failed to render:`, error);
                container.textContent = `${row.name}: unavailable`;
                container.style.color = COLORS.textDim;
            }
        }

        // Anything left is the placeholder from an earlier empty render
        while (this.bodyEl.children.length > resolved.length) {
            this.bodyEl.lastElementChild.remove();
        }
    }

    _startRefreshing() {
        if (this.refreshId) return;
        this.refreshId = setInterval(() => this._renderBody(), REFRESH_MS);
        this.timerRegistry.registerInterval(this.refreshId);
    }

    _removePanel() {
        if (this.refreshId) {
            clearInterval(this.refreshId);
            this.refreshId = null;
        }
        this.detachDrag?.();
        this.detachDrag = null;
        this.containers.clear();

        if (this.panel) {
            unregisterFloatingPanel(this.panel);
            this.panel.remove();
            this.panel = null;
            this.bodyEl = null;
            this.pickerEl = null;
        }
    }
}

const overlayPanel = new OverlayPanel();
export default overlayPanel;
