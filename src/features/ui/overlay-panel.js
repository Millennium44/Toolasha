/**
 * Overlay Panel
 *
 * One floating panel that other features hang a tile on.
 *
 * The point is that the panel knows nothing about what it shows. A feature that
 * wants a line on screen calls `registerRow` and hands over a function that draws
 * into a container; the shell owns everything else — where the panel sits, which
 * rows are on, where each one is placed, and when to redraw. Adding the twentieth
 * row is then the same amount of work as the second, which is the only way a
 * panel of this shape stays maintainable.
 *
 * ## Why a canvas and not a list
 *
 * Rows are placed freely rather than stacked. A stack forces one ordering
 * decision — what goes above what — when the question you actually want to
 * answer is what sits *beside* what: revenue next to profit, luck next to
 * expectation, so a glance reads a comparison instead of a column. Each tile
 * carries its own position, size and text scale, and the panel remembers all of
 * it. The layout arithmetic lives in `utils/overlay-layout.js`.
 *
 * ## Adding a row
 *
 * ```js
 * import { registerRow } from '../../utils/overlay-rows.js';
 *
 * registerRow({
 *     key: 'treasure',            // stable — it is the storage key for everything about the tile
 *     name: 'Treasure',           // how it reads in the row picker
 *     render: (container) => {    // called on every refresh; draw the current state
 *         container.textContent = `${chestsOpened} chests`;
 *     },
 *     defaultSize: { width: 160, height: 30 },  // optional — the row knows how much it draws
 *     onOpen: () => panel.show(),               // optional — double-clicking the tile opens this
 * });
 * ```
 *
 * A row is a summary. `onOpen` is where the detail behind it lives, so the
 * overlay stays a glance and the full panel is one gesture away.
 *
 * Register at module scope, not inside `initialize`. The list lives in
 * `utils/overlay-rows.js` rather than here — see that file for why the bundle
 * layout forces it — so registration order and feature start-up order do not
 * have to agree, and a row whose feature is off simply renders nothing.
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
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry, clearGeometry } from '../../utils/panel-geometry.js';
import { registeredRows, resolveRows, moveRow } from '../../utils/overlay-rows.js';
import {
    resolveLayout,
    autoGrid,
    contentBounds,
    clampTile,
    clampZoom,
    snap,
    GRID,
    MIN_TILE,
} from '../../utils/overlay-layout.js';

const STORAGE_KEY = 'overlayPanel';
const GEOMETRY_KEY = 'overlayPanel';
const PANEL_ID = 'toolasha-overlay-panel';
const REFRESH_MS = 1000;
const DEFAULT_PANEL = { width: 480, height: 320 };
const ZOOM_STEP = 10;

const COLORS = {
    background: 'rgba(8, 10, 20, 0.9)',
    headerBg: 'rgba(20, 24, 40, 0.85)',
    border: 'rgba(120, 160, 255, 0.3)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.5)',
    accent: '#9ec4ff',
    tileEdit: 'rgba(158, 196, 255, 0.28)',
};

class OverlayPanel {
    constructor() {
        this.isInitialized = false;
        this.settings = {
            visible: {},
            order: [],
            positions: {},
            sizes: {},
            zoom: {},
            locked: true,
            snapToGrid: true,
            open: false,
        };
        this.panel = null;
        this.canvasEl = null;
        this.pickerEl = null;
        this.timerRegistry = createTimerRegistry();
        this.detachDrag = null;
        this.detachResize = null;
        this.refreshId = null;
        this.tiles = new Map();
        this.lockBtn = null;
        /** True while a tile is being dragged or resized, so refreshes hold off */
        this.interacting = false;
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

    /** Whether tiles can currently be moved and resized */
    get isEditable() {
        return !this.settings.locked;
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
            width: `${DEFAULT_PANEL.width}px`,
            height: `${DEFAULT_PANEL.height}px`,
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

        this.panel.appendChild(this._createHeader());

        // The scroll container, so the canvas below can be as large as the tiles
        // need without the panel growing to match
        this.scrollEl = document.createElement('div');
        Object.assign(this.scrollEl.style, { flex: '1', overflow: 'auto', padding: '6px' });

        this.canvasEl = document.createElement('div');
        Object.assign(this.canvasEl.style, { position: 'relative', minHeight: '100%' });
        this.scrollEl.appendChild(this.canvasEl);
        this.panel.appendChild(this.scrollEl);

        this.pickerEl = this._createPicker();
        this.panel.appendChild(this.pickerEl);

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);

        this.detachResize = makeResizable(this.panel, {
            minWidth: 220,
            minHeight: 120,
            onResize: (size) => {
                saveGeometry(GEOMETRY_KEY, size);
                this._renderBody();
            },
        });
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 220, height: 120 }).then(() => this._renderBody());

        this._renderBody();
        this._startRefreshing();
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
            flex: '0 0 auto',
        });

        const title = document.createElement('span');
        title.textContent = 'Overlay';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;

        const buttons = document.createElement('div');
        buttons.style.display = 'flex';
        buttons.style.gap = '2px';

        // Locked by default, and prominent, because an unlocked overlay is one
        // where every click on a tile risks nudging the layout
        this.lockBtn = this._iconButton('', '', () => {
            this.settings.locked = !this.settings.locked;
            this._save();
            this._refreshLockButton();
            this._renderBody();
        });
        this._refreshLockButton();

        const gearBtn = this._iconButton('⚙', 'Choose rows and arrange the layout', () => {
            const hidden = this.pickerEl.style.display === 'none';
            this.pickerEl.style.display = hidden ? '' : 'none';
            if (hidden) this._renderPicker();
        });
        const closeBtn = this._iconButton('✕', 'Close', () => this.hide());

        buttons.append(this.lockBtn, gearBtn, closeBtn);
        header.appendChild(title);
        header.appendChild(buttons);

        this.detachDrag = makeDraggable(this.panel, header, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        return header;
    }

    _refreshLockButton() {
        if (!this.lockBtn) return;
        const locked = this.settings.locked;
        this.lockBtn.textContent = locked ? '🔒' : '🔓';
        this.lockBtn.title = locked ? 'Layout locked — click to move and resize tiles' : 'Click to lock the layout';
        this.lockBtn.style.background = locked ? 'none' : COLORS.tileEdit;
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
            padding: '7px 8px 8px',
            borderTop: `1px solid ${COLORS.border}`,
            background: 'rgba(0, 0, 0, 0.3)',
            fontSize: '12px',
            flex: '0 0 auto',
            maxHeight: '45%',
            overflow: 'auto',
        });
        return picker;
    }

    _renderPicker() {
        this.pickerEl.replaceChildren();

        const resolved = resolveRows(registeredRows(), this.settings);
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

        // Chips that wrap, rather than one row per line. Fifteen rows as a
        // vertical list is a panel of scrollbar; as chips it is four lines.
        const chips = document.createElement('div');
        Object.assign(chips.style, { display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '8px' });
        for (const row of resolved) chips.appendChild(this._rowChip(row));
        this.pickerEl.appendChild(chips);

        this.pickerEl.appendChild(this._layoutControls());
    }

    /**
     * One row's on/off chip, with the ordering controls it needs.
     * @param {Object} row - Resolved row
     * @returns {HTMLElement}
     */
    _rowChip(row) {
        const chip = document.createElement('label');
        Object.assign(chip.style, {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            padding: '3px 7px',
            borderRadius: '4px',
            border: `1px solid ${COLORS.border}`,
            background: row.visible ? 'rgba(158, 196, 255, 0.12)' : 'rgba(255, 255, 255, 0.04)',
            cursor: 'pointer',
        });

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = row.visible;
        checkbox.style.cursor = 'pointer';
        checkbox.addEventListener('change', () => {
            this.settings.visible = { ...this.settings.visible, [row.key]: checkbox.checked };
            this._save();
            this._renderPicker();
            this._renderBody();
        });

        const name = document.createElement('span');
        name.textContent = row.name;
        if (!row.visible) name.style.color = COLORS.textDim;

        // Order still matters: it is what Autogrid packs by, and what a new row
        // is placed after
        const up = this._iconButton('◀', 'Earlier in the layout order', () => this._move(row.key, -1));
        const down = this._iconButton('▶', 'Later in the layout order', () => this._move(row.key, 1));
        for (const button of [up, down]) {
            button.style.fontSize = '8px';
            button.style.padding = '2px 1px';
            button.style.color = COLORS.textDim;
        }

        chip.append(checkbox, name, up, down);
        return chip;
    }

    /** Snap, Autogrid and Reset — everything that acts on the layout as a whole */
    _layoutControls() {
        const controls = document.createElement('div');
        Object.assign(controls.style, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });

        const snapLabel = document.createElement('label');
        Object.assign(snapLabel.style, { display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' });
        const snapBox = document.createElement('input');
        snapBox.type = 'checkbox';
        snapBox.checked = this.settings.snapToGrid;
        snapBox.style.cursor = 'pointer';
        snapBox.addEventListener('change', () => {
            this.settings.snapToGrid = snapBox.checked;
            this._save();
        });
        snapLabel.append(snapBox, document.createTextNode(`Snap to ${GRID}px grid`));
        controls.appendChild(snapLabel);

        const autogrid = this._textButton('Autogrid', 'Repack every tile from the top left, in order', () =>
            this._autoGrid()
        );
        const reset = this._textButton('Reset layout', 'Forget every position, size and text scale', () =>
            this._resetLayout()
        );
        reset.style.color = '#ff9d9d';
        reset.style.marginLeft = 'auto';

        const hint = document.createElement('div');
        hint.textContent = this.settings.locked
            ? 'Unlock (🔒) to drag tiles. Ctrl+scroll a tile to resize its text.'
            : 'Drag tiles to move, corner to resize, Ctrl+scroll to resize text.';
        Object.assign(hint.style, { color: COLORS.textDim, flexBasis: '100%', marginTop: '2px' });

        controls.append(autogrid, reset, hint);
        return controls;
    }

    /**
     * @param {string} text - Label
     * @param {string} title - Tooltip
     * @param {Function} onClick - Handler
     * @returns {HTMLButtonElement}
     */
    _textButton(text, title, onClick) {
        const button = document.createElement('button');
        button.textContent = text;
        button.title = title;
        Object.assign(button.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '3px 8px',
        });
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    /**
     * @param {string} key - Row to move
     * @param {number} delta - -1 earlier, 1 later
     */
    _move(key, delta) {
        const next = moveRow(this.settings.order, key, delta);
        if (next === this.settings.order) return;

        this.settings.order = next;
        this._save();
        this._renderPicker();
    }

    /** Repack every visible tile against the top left */
    _autoGrid() {
        const laid = this._layout();
        const positions = { ...this.settings.positions };
        for (const { key, x, y } of autoGrid(laid, this._canvasWidth(), this.settings.snapToGrid ? GRID : 1)) {
            positions[key] = { x, y };
        }
        this.settings.positions = positions;
        this._save();
        this._renderBody();
    }

    /** Forget every position, size and zoom, and the panel's own geometry with them */
    _resetLayout() {
        this.settings.positions = {};
        this.settings.sizes = {};
        this.settings.zoom = {};
        this._save();
        clearGeometry(GEOMETRY_KEY);
        this.panel.style.width = `${DEFAULT_PANEL.width}px`;
        this.panel.style.height = `${DEFAULT_PANEL.height}px`;
        this._renderBody();
        this._renderPicker();
    }

    /** Usable width inside the scroller, less the scrollbar */
    _canvasWidth() {
        return Math.max(120, (this.scrollEl?.clientWidth || DEFAULT_PANEL.width) - 12);
    }

    /** The visible rows, placed */
    _layout() {
        const visible = resolveRows(registeredRows(), this.settings).filter((row) => row.visible);
        return resolveLayout(visible, this.settings, this._canvasWidth());
    }

    _renderBody() {
        if (!this.canvasEl) return;
        // A refresh rewrites every tile's position and size from the saved
        // layout, which mid-drag means the tile snapping back under the pointer
        // one second in. Nothing needs redrawing while a gesture is in progress
        // anyway.
        if (this.interacting) return;

        const laid = this._layout();
        if (!laid.length) {
            this.tiles.clear();
            this.canvasEl.replaceChildren();
            const empty = document.createElement('div');
            empty.style.color = COLORS.textDim;
            empty.textContent = registeredRows().length ? 'Every row is switched off — see ⚙.' : 'Nothing to show yet.';
            this.canvasEl.appendChild(empty);
            return;
        }

        const wanted = new Set(laid.map((row) => row.key));
        for (const [key, tile] of this.tiles) {
            if (!wanted.has(key)) {
                tile.remove();
                this.tiles.delete(key);
            }
        }
        // The placeholder from an earlier empty render
        for (const child of [...this.canvasEl.children]) {
            if (!child.dataset.overlayRow) child.remove();
        }

        for (const row of laid) {
            const tile = this._tileFor(row);
            Object.assign(tile.style, {
                left: `${row.x}px`,
                top: `${row.y}px`,
                width: `${row.width}px`,
                height: `${row.height}px`,
                fontSize: `${row.zoom}%`,
                cursor: this.isEditable ? 'move' : row.onOpen ? 'pointer' : 'default',
                border: this.isEditable ? `1px dashed ${COLORS.tileEdit}` : '1px solid transparent',
            });
            tile._grip.style.display = this.isEditable ? '' : 'none';

            try {
                row.render(tile._content);
            } catch (error) {
                console.error(`[OverlayPanel] Row "${row.key}" failed to render:`, error);
                tile._content.textContent = `${row.name}: unavailable`;
                tile._content.style.color = COLORS.textDim;
            }
        }

        const bounds = contentBounds(laid);
        this.canvasEl.style.width = `${bounds.width}px`;
        this.canvasEl.style.height = `${bounds.height}px`;
    }

    /**
     * The tile for a row, made once and kept.
     *
     * Tiles survive refreshes rather than being rebuilt, because a row that draws
     * something interactive should not be replaced out from under the pointer
     * once a second — and because the drag listeners would otherwise stack up at
     * the same rate.
     *
     * @param {Object} row - Laid-out row
     * @returns {HTMLElement} The tile
     */
    _tileFor(row) {
        const existing = this.tiles.get(row.key);
        if (existing) return existing;

        const tile = document.createElement('div');
        tile.dataset.overlayRow = row.key;
        Object.assign(tile.style, {
            position: 'absolute',
            boxSizing: 'border-box',
            overflow: 'hidden',
            borderRadius: '3px',
            padding: '0 1px',
        });

        const content = document.createElement('div');
        Object.assign(content.style, { width: '100%', height: '100%', overflow: 'hidden' });
        tile.appendChild(content);
        tile._content = content;

        const grip = document.createElement('div');
        Object.assign(grip.style, {
            position: 'absolute',
            right: '0',
            bottom: '0',
            width: '10px',
            height: '10px',
            cursor: 'nwse-resize',
            background: 'linear-gradient(135deg, transparent 0 50%, rgba(158, 196, 255, 0.6) 50%)',
            display: 'none',
        });
        tile.appendChild(grip);
        tile._grip = grip;

        this._attachTileDrag(tile, row.key);
        this._attachTileResize(tile, grip, row.key);
        this._attachTileZoom(tile, row.key);

        if (row.onOpen) {
            tile.title = `Double-click to open ${row.name}`;
            tile.addEventListener('dblclick', () => {
                try {
                    row.onOpen();
                } catch (error) {
                    console.error(`[OverlayPanel] Opening "${row.key}" failed:`, error);
                }
            });
        }

        this.canvasEl.appendChild(tile);
        this.tiles.set(row.key, tile);
        return tile;
    }

    /**
     * @param {HTMLElement} tile - The tile
     * @param {string} key - Row key
     */
    _attachTileDrag(tile, key) {
        let startX = 0;
        let startY = 0;
        let originX = 0;
        let originY = 0;
        let dragging = false;

        const onMouseMove = (event) => {
            if (!dragging) return;
            const step = this.settings.snapToGrid ? GRID : 1;
            const wanted = {
                x: snap(originX + event.clientX - startX, step),
                y: snap(originY + event.clientY - startY, step),
            };
            const held = clampTile(
                wanted,
                { width: tile.offsetWidth, height: tile.offsetHeight },
                {
                    width: this._canvasWidth(),
                }
            );
            tile.style.left = `${held.x}px`;
            tile.style.top = `${held.y}px`;
        };

        const onMouseUp = () => {
            if (!dragging) return;
            dragging = false;
            this.interacting = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            this.settings.positions = {
                ...this.settings.positions,
                [key]: { x: parseFloat(tile.style.left), y: parseFloat(tile.style.top) },
            };
            this._save();
            this._renderBody();
        };

        tile.addEventListener('mousedown', (event) => {
            // Locked is the normal state, where a tile is something you read and
            // click rather than something you move
            if (!this.isEditable || event.button !== 0) return;
            if (event.target === tile._grip || event.target.closest('button, input, select, a')) return;

            dragging = true;
            this.interacting = true;
            startX = event.clientX;
            startY = event.clientY;
            originX = parseFloat(tile.style.left) || 0;
            originY = parseFloat(tile.style.top) || 0;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            event.preventDefault();
        });
    }

    /**
     * @param {HTMLElement} tile - The tile
     * @param {HTMLElement} grip - Its corner
     * @param {string} key - Row key
     */
    _attachTileResize(tile, grip, key) {
        let startX = 0;
        let startY = 0;
        let startWidth = 0;
        let startHeight = 0;
        let resizing = false;

        const onMouseMove = (event) => {
            if (!resizing) return;
            const step = this.settings.snapToGrid ? GRID : 1;
            tile.style.width = `${Math.max(MIN_TILE.width, snap(startWidth + event.clientX - startX, step))}px`;
            tile.style.height = `${Math.max(MIN_TILE.height, snap(startHeight + event.clientY - startY, step))}px`;
        };

        const onMouseUp = () => {
            if (!resizing) return;
            resizing = false;
            this.interacting = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            this.settings.sizes = {
                ...this.settings.sizes,
                [key]: { width: tile.offsetWidth, height: tile.offsetHeight },
            };
            this._save();
            this._renderBody();
        };

        grip.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return;
            resizing = true;
            this.interacting = true;
            startX = event.clientX;
            startY = event.clientY;
            startWidth = tile.offsetWidth;
            startHeight = tile.offsetHeight;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            event.preventDefault();
            event.stopPropagation();
        });
    }

    /**
     * Ctrl+scroll to change how large a tile draws.
     *
     * Tiles hold wildly different amounts — a timer is four characters and combat
     * revenue is three lines of figures — so one text size for the panel means
     * either a cramped tile or a wasteful one. Requiring Ctrl leaves a plain
     * scroll to the panel, which still has to scroll.
     *
     * @param {HTMLElement} tile - The tile
     * @param {string} key - Row key
     */
    _attachTileZoom(tile, key) {
        tile.addEventListener(
            'wheel',
            (event) => {
                if (!event.ctrlKey) return;
                event.preventDefault();
                event.stopPropagation();

                const current = this.settings.zoom?.[key] ?? 100;
                const next = clampZoom(current + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
                if (next === current) return;

                this.settings.zoom = { ...this.settings.zoom, [key]: next };
                this._save();
                this._renderBody();
            },
            { passive: false }
        );
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
        this.detachResize?.();
        this.detachResize = null;
        this.tiles.clear();

        if (this.panel) {
            unregisterFloatingPanel(this.panel);
            this.panel.remove();
            this.panel = null;
            this.canvasEl = null;
            this.scrollEl = null;
            this.pickerEl = null;
        }
    }
}

const overlayPanel = new OverlayPanel();
export default overlayPanel;
