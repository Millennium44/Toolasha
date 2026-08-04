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
 *     onOpen: () => panel.toggle(),             // optional — double-clicking the tile runs this
 * });
 * ```
 *
 * A row is a summary. `onOpen` is where the detail behind it lives, so the
 * overlay stays a glance and the full panel is one gesture away. It should
 * **toggle** rather than open: the same gesture that summoned a panel is the one
 * you reach for to dismiss it, and a double-click that only ever opens leaves
 * you hunting for the close button.
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
import { restoreGeometry, saveGeometry, clearGeometry, allGeometry } from '../../utils/panel-geometry.js';
import { registeredRows, resolveRows, moveRow } from '../../utils/overlay-rows.js';
import { fromOPanelConfig, toOPanelConfig } from '../../utils/opanel-config.js';
import { askChoice } from '../../utils/choice-dialog.js';
import {
    resolveLayout,
    autoGrid,
    compactColumns,
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

/** Marks the container the docked panel was put into, so the sheet can find it */
const DOCK_HOST_CLASS = 'toolasha-overlay-dock-host';
const DOCK_STYLE_ID = 'toolasha-overlay-dock';
const DOCK_HEIGHT = { min: 90, max: 900, default: 220 };
/** Never take so much of the column that the tab body has nowhere to draw */
const DOCK_MIN_BODY = 140;
/** Clear of the bottom of the window, so the panel's edge is not the screen's */
const DOCK_BOTTOM_GAP = 8;

/** Fired on `document` whenever the panel opens or closes */
export const VISIBILITY_EVENT = 'toolasha:overlay-visibility';

/**
 * What docking does to the character column.
 *
 * The column is a header strip and a tab body; adding a third child below them
 * would simply make the column taller and push the bottom of the inventory off
 * the screen. Turning it into a flex column instead makes the tab body the one
 * part that gives — it takes whatever height the docked panel leaves and scrolls
 * the rest, which is what "make the inventory smaller to accommodate" means.
 *
 * `min-height: 0` is what actually allows that: a flex item refuses to shrink
 * below its content without it, so the body would keep its full height and push
 * the panel out of view regardless of the flex factors.
 *
 * There is no height here. `max-height: 100%` was the obvious thing to write and
 * it does nothing: the column's own height is not definite, so a percentage of it
 * resolves to no constraint at all, and the column simply grew until the panel
 * hung off the bottom of the window. The height is measured against the window
 * instead — see `_fitDock`.
 */
const DOCK_CSS = `
    .${DOCK_HOST_CLASS} {
        display: flex !important;
        flex-direction: column !important;
        min-height: 0;
        overflow: hidden;
    }
    .${DOCK_HOST_CLASS} > [class*="TabsComponent_tabsContainer"] {
        flex: 0 0 auto;
    }
    .${DOCK_HOST_CLASS} > [class*="TabsComponent_tabPanelsContainer"] {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
    }
    #${PANEL_ID}[data-docked="true"] {
        flex: 0 0 auto;
    }
`;

const COLORS = {
    // Nearly opaque: at 0.9 the game's inventory grid read straight through the
    // tiles, and a figure you have to pick out of a background is not a glance
    background: 'rgba(8, 10, 20, 0.97)',
    headerBg: 'rgba(20, 24, 40, 0.85)',
    border: 'rgba(120, 160, 255, 0.3)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.5)',
    accent: '#9ec4ff',
    tileEdit: 'rgba(158, 196, 255, 0.28)',
    separator: 'rgba(158, 196, 255, 0.16)',
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
            separators: true,
            textScale: 100,
            open: false,
            /** In the character column rather than floating over the game */
            docked: false,
            // Null until the edge is dragged, and null means "as tall as the
            // tiles need". A fixed starting height is a guess about a layout it
            // has never seen, and a guess that is too small cuts the bottom row
            // of tiles in half the moment it docks
            dockHeightPx: null,
        };
        this.panel = null;
        /** The container the docked panel was put into, so it can be put back */
        this.dockHost = null;
        /** Re-measures the dock when the window changes shape */
        this.onWindowResize = null;
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
        /** The layout before the last bulk change, so it can be put back */
        this.undoState = null;
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
        this._announce();
    }

    /** Close the panel and remember that it was closed */
    hide() {
        this._removePanel();
        this.settings.open = false;
        this._save();
        this._announce();
    }

    /**
     * Say that the panel opened or closed.
     *
     * An event rather than a callback list, because the only listener is the tab
     * button that switches this — and a switch that does not change when the
     * panel is closed by its own ✕ is a switch you stop trusting.
     */
    _announce() {
        document.dispatchEvent(new CustomEvent(VISIBILITY_EVENT, { detail: { open: Boolean(this.panel) } }));
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
        // Asked for docked but the column has not rendered yet — a reload lands
        // here — so it opens floating rather than not at all, and the next open
        // finds the column
        const host = this.settings.docked ? this._findDockHost() : null;

        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            color: COLORS.text,
            fontSize: `${this._baseFontPx()}px`,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        this.panel.appendChild(this._createHeader(Boolean(host)));

        // The scroll container, so the canvas below can be as large as the tiles
        // need without the panel growing to match
        this.scrollEl = document.createElement('div');
        Object.assign(this.scrollEl.style, { flex: '1', overflow: 'auto', padding: '6px', minHeight: '0' });

        this.canvasEl = document.createElement('div');
        Object.assign(this.canvasEl.style, { position: 'relative', minHeight: '100%' });
        this.scrollEl.appendChild(this.canvasEl);
        this.panel.appendChild(this.scrollEl);

        this.pickerEl = this._createPicker();
        document.body.appendChild(this.pickerEl);

        if (host) this._placeDocked(host);
        else this._placeFloating();

        this._renderBody();
        // Again after drawing: how tall the tiles came out is the thing a docked
        // panel sizes itself to, and it is not known until they are laid out
        this._fitDock();
        this._startRefreshing();
    }

    /** Over the game, where it can be dragged anywhere and remembers where */
    _placeFloating() {
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '120px',
            left: '20px',
            // Z_HUD, not Z_FLOATING_PANEL: this one is always up, so it has to
            // sit *below* the game's own interactive UI rather than over the
            // tabs and buttons it happens to overlap
            zIndex: String(config.Z_HUD),
            // Clamped so the first open on a phone is not wider than the screen
            width: `min(${DEFAULT_PANEL.width}px, 92vw)`,
            height: `min(${DEFAULT_PANEL.height}px, 80vh)`,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.55)',
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        // Unlocked across a reload means the panel comes back mid-arrangement,
        // and it should come back raised rather than underneath the game
        this._refreshStacking();

        this.detachResize = makeResizable(this.panel, {
            minWidth: 220,
            minHeight: 120,
            onResize: (size) => {
                saveGeometry(GEOMETRY_KEY, size);
                this._renderBody();
                this._placePicker();
            },
        });
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 220, height: 120 }).then(() => this._renderBody());
    }

    /**
     * Below the character tabs, in the column's own flow.
     *
     * In flow rather than pinned over the column, so the game's own layout does
     * the work: the panel is a sibling of the tab body, and the sheet gives the
     * tab body the leftover height. Nothing has to measure anything, and the
     * arrangement survives the column being resized, the window changing, and
     * the combat panel's own height setting.
     *
     * @param {HTMLElement} host - The container holding the tabs and their body
     */
    _placeDocked(host) {
        if (!document.getElementById(DOCK_STYLE_ID)) {
            const style = document.createElement('style');
            style.id = DOCK_STYLE_ID;
            style.textContent = DOCK_CSS;
            document.head.appendChild(style);
        }

        Object.assign(this.panel.style, {
            position: 'relative',
            zIndex: 'auto',
            width: 'auto',
            height: `${this._dockHeight()}px`,
            minHeight: '0',
            marginTop: '4px',
            boxShadow: 'none',
        });
        this.panel.dataset.docked = 'true';

        host.classList.add(DOCK_HOST_CLASS);
        host.appendChild(this.panel);
        this.dockHost = host;
        this._fitDock();

        this.onWindowResize = () => this._fitDock();
        window.addEventListener('resize', this.onWindowResize);

        this.detachResize = this._makeDockResizable();
    }

    /**
     * Give the column a height it can actually divide up.
     *
     * The first attempt at this was a stylesheet saying `max-height: 100%`, which
     * silently does nothing — a percentage resolves against the parent's height,
     * the parent's height is not definite, so there is no constraint and the
     * column grows to fit its contents. That put the docked panel below the
     * bottom of the window with its tiles cut in half.
     *
     * So the height is measured against the one box that is always definite: the
     * window. From the column's own top to the bottom of the screen is exactly
     * what there is to share, and once the column has that as a real height, the
     * flex rules divide it — the panel takes what it asks for and the tab body
     * takes the rest and scrolls.
     *
     * The panel's request is trimmed to leave the tab body something to draw in.
     * A column is not always tall — a short window, a wrapped tab strip — and a
     * remembered 400px panel in a 300px column would otherwise leave an inventory
     * of nothing, which is worse than a shorter overlay.
     */
    _fitDock() {
        if (!this.dockHost || !this.panel) return;

        const top = this.dockHost.getBoundingClientRect().top;
        const available = Math.max(DOCK_HEIGHT.min + DOCK_MIN_BODY, window.innerHeight - top - DOCK_BOTTOM_GAP);
        const height = `${Math.round(available)}px`;
        if (this.dockHost.style.height !== height) this.dockHost.style.height = height;

        const asked = this.settings.dockHeightPx === null ? this._contentHeight() : this._dockHeight();
        const wanted = `${Math.round(Math.min(Math.max(DOCK_HEIGHT.min, asked), available - DOCK_MIN_BODY))}px`;
        if (this.panel.style.height !== wanted) this.panel.style.height = wanted;
    }

    /**
     * How tall the panel would have to be to show every tile.
     *
     * A fixed starting height is a guess about a layout it has never seen: the
     * tiles keep the arrangement they were given, and any arrangement taller than
     * the guess is cut off at the bottom the moment it docks. Following the tiles
     * cannot be wrong in that way. The edge is still there to drag once you have
     * an opinion, and dragging it is what fixes the height.
     *
     * @returns {number} Pixels, or the default before anything has been drawn
     */
    _contentHeight() {
        const content = Number.parseFloat(this.canvasEl?.style.height);
        if (!Number.isFinite(content) || content <= 0) return DOCK_HEIGHT.default;

        // Header, grab bar and borders: everything of the panel that is not the
        // scroller. Constant while the scroller flexes, so this cannot run away
        const chrome = this.panel.offsetHeight - (this.scrollEl?.clientHeight || 0);
        return content + Math.max(0, chrome) + 4;
    }

    /** How tall the panel may be dragged, given what the column has to give */
    _dockCeiling() {
        const host = this.dockHost?.getBoundingClientRect().height || 0;
        return Math.max(DOCK_HEIGHT.min, Math.min(DOCK_HEIGHT.max, host - DOCK_MIN_BODY));
    }

    /**
     * The container the docked panel goes into.
     *
     * Found through the character column's tab strip — the one with an Inventory
     * tab — because every tab strip in the game shares the same classes and only
     * this one has that. The strip's container and the body it switches are
     * siblings; their parent is what the panel joins.
     *
     * @returns {HTMLElement|null}
     */
    _findDockHost() {
        for (const list of document.querySelectorAll('[role="tablist"]')) {
            const inventory = [...list.querySelectorAll('[role="tab"]')].some(
                (tab) => tab.textContent.trim() === 'Inventory'
            );
            if (!inventory) continue;

            const container = list.closest('[class*="TabsComponent_tabsContainer"]');
            if (container?.parentElement) return container.parentElement;
        }
        return null;
    }

    /** The dragged-to dock height, kept inside what a column can actually give */
    _dockHeight() {
        const saved = Number(this.settings.dockHeightPx);
        if (!Number.isFinite(saved)) return DOCK_HEIGHT.default;
        return Math.min(DOCK_HEIGHT.max, Math.max(DOCK_HEIGHT.min, Math.round(saved)));
    }

    /**
     * A grab bar along the docked panel's top edge.
     *
     * Height only, and dragged from the top: the width is the column's to decide,
     * and the boundary being dragged is the one between this panel and the
     * inventory above it — so the bar belongs on that boundary rather than in a
     * corner. Dragging up gives the panel more and the inventory less.
     *
     * @returns {Function} Detach
     */
    _makeDockResizable() {
        const bar = document.createElement('div');
        bar.title = 'Drag to give the overlay more or less of the column';
        Object.assign(bar.style, {
            height: '5px',
            flex: '0 0 auto',
            cursor: 'ns-resize',
            background: COLORS.separator,
        });

        let startY = 0;
        let startHeight = 0;
        let resizing = false;

        const onMove = (event) => {
            if (!resizing) return;
            const wanted = startHeight - (event.clientY - startY);
            // Against what the column has, not an arbitrary maximum: dragged
            // past this the tab body would have nothing left to draw in
            this.panel.style.height = `${Math.min(this._dockCeiling(), Math.max(DOCK_HEIGHT.min, wanted))}px`;
        };
        const onUp = () => {
            if (!resizing) return;
            resizing = false;
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
            this.settings.dockHeightPx = Math.round(this.panel.getBoundingClientRect().height);
            this._save();
            this._renderBody();
            this._placePicker();
        };
        const onDown = (event) => {
            if (event.button !== 0) return;
            resizing = true;
            startY = event.clientY;
            startHeight = this.panel.getBoundingClientRect().height;
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
            event.preventDefault();
        };

        // Pointer events so a finger works too; mousedown never fires on a
        // touchscreen, and touch-action:none stops the browser claiming the
        // gesture for scrolling
        bar.style.touchAction = 'none';
        bar.addEventListener('pointerdown', onDown);
        this.panel.insertBefore(bar, this.panel.firstChild);

        return () => {
            bar.removeEventListener('pointerdown', onDown);
            onUp();
            bar.remove();
        };
    }

    /**
     * Move the panel between floating over the game and sitting in the column.
     *
     * Rebuilt rather than restyled: the two differ in how they are positioned,
     * sized, stacked and resized, and every tile's placement is redrawn from the
     * saved layout anyway — so there is nothing to preserve by editing in place
     * and a good deal to get wrong.
     */
    toggleDock() {
        this.settings.docked = !this.settings.docked;
        this._save();
        if (!this.panel) return;
        this._removePanel();
        this._createPanel();
    }

    /**
     * @param {boolean} docked - Whether this header belongs to a docked panel
     * @returns {HTMLElement}
     */
    _createHeader(docked = false) {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: docked ? 'default' : 'move',
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
            this._refreshStacking();
            this._renderBody();
        });
        this._refreshLockButton();

        const gearBtn = this._iconButton('⚙', 'Choose rows and arrange the layout', () => {
            const opening = !this.isPickerOpen;
            this.pickerEl.style.display = opening ? '' : 'none';
            if (opening) {
                this._renderPicker();
                this._placePicker();
            }
            this._refreshStacking();
        });
        const dockBtn = this._iconButton(
            docked ? '⇱' : '⇲',
            docked
                ? 'Float over the game, where it can be dragged anywhere'
                : 'Dock below the character tabs, giving the overlay its own space instead of covering the game',
            () => this.toggleDock()
        );
        const closeBtn = this._iconButton('✕', 'Close', () => this.hide());

        buttons.append(this.lockBtn, dockBtn, gearBtn, closeBtn);
        header.appendChild(title);
        header.appendChild(buttons);

        // A docked panel has nowhere to be dragged to — it is a row of the
        // column, and the only thing left to choose is how tall it is
        if (!docked) {
            this.detachDrag = makeDraggable(this.panel, header, (position) => {
                saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
                // It is anchored to the panel, so it has to come along
                this._placePicker();
            });
        }
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

    /**
     * The settings popover.
     *
     * Its own floating element rather than a section of the panel. Inside, it
     * took its height out of the tiles — opening the gear squashed the layout
     * you were opening the gear to arrange, which is the wrong way round.
     *
     * @returns {HTMLElement}
     */
    _createPicker() {
        const picker = document.createElement('div');
        Object.assign(picker.style, {
            display: 'none',
            position: 'fixed',
            // Deliberately summoned, unlike the panel it belongs to, so it is
            // allowed above the game UI for as long as it is open
            zIndex: String(config.Z_POPUP),
            padding: '8px 10px 9px',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            background: COLORS.background,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontSize: '12px',
            maxHeight: '50vh',
            overflow: 'auto',
        });
        return picker;
    }

    /** Whether the settings popover is up */
    get isPickerOpen() {
        return this.pickerEl && this.pickerEl.style.display !== 'none';
    }

    /**
     * Where the panel sits against the game's own interface.
     *
     * At rest it belongs underneath: it is always up, and a permanent readout
     * that covers the tabs and the ability bar is worse than one the game
     * occasionally covers. But while the settings are open or the layout is
     * unlocked it is not a readout, it is a thing being operated — and the
     * ability cooldowns counting down through the tile you are dragging make it
     * unusable. So it rises for exactly as long as it is being worked on.
     */
    _refreshStacking() {
        if (!this.panel) return;
        // A docked panel is not over anything to begin with — it has its own
        // space in the column, which is the point of docking it
        if (this.panel.dataset.docked === 'true') return;
        const inUse = this.isPickerOpen || !this.settings.locked;
        this.panel.style.zIndex = String(inUse ? config.Z_FLOATING_PANEL : config.Z_HUD);
    }

    /**
     * Put the popover above the panel, or below it when there is no room.
     *
     * Measured after it is drawn, because its height depends on how many rows
     * are registered — and the whole point of it being above is that it does not
     * cover the layout you are arranging.
     */
    _placePicker() {
        if (!this.isPickerOpen || !this.panel) return;

        const anchor = this.panel.getBoundingClientRect();
        this.pickerEl.style.width = `${Math.max(320, anchor.width)}px`;

        const self = this.pickerEl.getBoundingClientRect();
        const above = anchor.top - self.height - 6;

        this.pickerEl.style.left = `${Math.max(4, Math.min(anchor.left, window.innerWidth - self.width - 4))}px`;
        this.pickerEl.style.top =
            above >= 4 ? `${above}px` : `${Math.min(anchor.bottom + 6, window.innerHeight - self.height - 4)}px`;
    }

    _renderPicker() {
        // Reachable from a bulk change that a closed panel can still make
        if (!this.pickerEl) return;
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
    /**
     * One checkbox bound to a layout setting.
     *
     * @param {string} label - What it says
     * @param {string} key - The setting it sets
     * @param {Object} [options] - `{on, title}` — `on` reads the current value
     * @returns {HTMLElement}
     */
    _optionBox(label, key, { on, title } = {}) {
        const wrap = document.createElement('label');
        Object.assign(wrap.style, { display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' });
        if (title) wrap.title = title;

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = on ? on(this.settings) : Boolean(this.settings[key]);
        box.style.cursor = 'pointer';
        box.addEventListener('change', () => {
            this.settings[key] = box.checked;
            this._save();
            this._renderBody();
        });

        wrap.append(box, document.createTextNode(label));
        return wrap;
    }

    _layoutControls() {
        const controls = document.createElement('div');
        Object.assign(controls.style, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });

        controls.appendChild(this._optionBox(`Snap to ${GRID}px grid`, 'snapToGrid'));
        controls.appendChild(
            this._optionBox('Separators', 'separators', { on: (settings) => settings.separators !== false })
        );

        // How the luck tiles are drawn, kept beside the row list as OPanel
        // keeps them — somebody arranging an overlay is already looking here,
        // and would not think to open a settings dialog for it
        controls.appendChild(
            this._optionBox('Expected: only numbers', 'expectedOnlyNumbers', {
                title: 'Drop the names from Over Expected, leaving the percentages.',
            })
        );
        controls.appendChild(
            this._optionBox('Expected: only you', 'expectedOnlyPlayer', {
                title: 'Show only your own row in Over Expected, without the party or the total.',
            })
        );
        controls.appendChild(
            this._optionBox('Luck: only numbers', 'luckOnlyNumbers', {
                title: 'Drop the names from Drop Luck, leaving the percentages.',
            })
        );
        controls.appendChild(
            this._optionBox('Luck: only you', 'luckOnlyPlayer', {
                title: 'Show only your own row in Drop Luck, without the rest of the party.',
            })
        );

        const textSize = document.createElement('div');
        Object.assign(textSize.style, { display: 'inline-flex', alignItems: 'center', gap: '4px' });
        const smaller = this._textButton('−', 'Smaller text in every tile', () => this._stepTextScale(-ZOOM_STEP));
        const larger = this._textButton('+', 'Larger text in every tile', () => this._stepTextScale(ZOOM_STEP));

        const scaleLabel = document.createElement('span');
        scaleLabel.textContent = `Text ${clampZoom(this.settings.textScale ?? 100)}%`;
        scaleLabel.style.color = COLORS.textDim;
        scaleLabel.style.minWidth = '62px';

        textSize.append(scaleLabel, smaller, larger);
        controls.appendChild(textSize);

        const autogrid = this._textButton('Autogrid', 'Repack every tile from the top left, in order', () =>
            this._autoGrid()
        );
        const importBtn = this._textButton(
            'Import layout',
            'Read a layout from an OPanel or Toolasha overlay file',
            () => this._importLayout()
        );
        const exportBtn = this._textButton('Export layout', 'Write this layout to a file OPanel can also read', () =>
            this._exportLayout()
        );

        const reset = this._textButton('Reset layout', 'Forget every position, size and text scale', () =>
            this._resetLayout()
        );
        reset.style.color = '#ff9d9d';
        reset.style.marginLeft = 'auto';

        // Only there when there is something to take back, so it never reads as
        // a button that does nothing
        const undo = this.undoState
            ? this._textButton(`Undo ${this.undoState.what}`, 'Put the layout back to before that', () => this._undo())
            : null;
        if (undo) undo.style.color = COLORS.accent;

        const hint = document.createElement('div');
        hint.textContent = this.settings.locked
            ? 'Unlock (🔒) to drag tiles, resize them, and set each one’s text size.'
            : 'Drag a tile to move it, its corner to resize it, and hover it for − and + to size its text.';
        Object.assign(hint.style, { color: COLORS.textDim, flexBasis: '100%', marginTop: '2px' });

        controls.append(autogrid, importBtn, exportBtn, ...(undo ? [undo] : []), reset, hint);
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

    /**
     * Keep the layout as it stands, so the next bulk change can be taken back.
     *
     * Autogrid, Reset and Import each throw away an arrangement that may have
     * taken a while to get right, and none of them can be judged until after it
     * has happened — you press Autogrid to find out what Autogrid does.
     *
     * @param {string} what - What is about to happen, for the button's label
     */
    _snapshot(what) {
        this.undoState = {
            what,
            positions: { ...this.settings.positions },
            sizes: { ...this.settings.sizes },
            zoom: { ...this.settings.zoom },
            textScale: this.settings.textScale,
        };
    }

    /** Put the layout back to before the last bulk change */
    _undo() {
        if (!this.undoState) return;

        const { positions, sizes, zoom, textScale } = this.undoState;
        this.settings = { ...this.settings, positions, sizes, zoom, textScale };
        this.undoState = null;
        this._save();
        if (this.panel) this.panel.style.fontSize = `${this._baseFontPx()}px`;
        this._renderBody();
        this._renderPicker();
        this._placePicker();
    }

    /** Repack every visible tile against the top left */
    _autoGrid() {
        this._snapshot('Autogrid');
        const laid = this._layout();
        const positions = { ...this.settings.positions };
        for (const { key, x, y } of autoGrid(laid, this._canvasWidth(), this.settings.snapToGrid ? GRID : 1)) {
            positions[key] = { x, y };
        }
        this.settings.positions = positions;
        this._save();
        this._renderBody();
        this._renderPicker();
        this._placePicker();
    }

    /** Forget every position, size and zoom, and the panel's own geometry with them */
    _resetLayout() {
        this._snapshot('Reset');
        this.settings.positions = {};
        this.settings.sizes = {};
        this.settings.zoom = {};
        this.settings.textScale = 100;
        this._save();
        clearGeometry(GEOMETRY_KEY);
        this.panel.style.width = `${DEFAULT_PANEL.width}px`;
        this.panel.style.height = `${DEFAULT_PANEL.height}px`;
        this.panel.style.fontSize = `${this._baseFontPx()}px`;
        this._renderBody();
        this._renderPicker();
        this._placePicker();
    }

    /**
     * Write this layout to a file.
     *
     * In OPanel's shape rather than in one of our own, because a format only
     * this script can read is a format that strands the layout here. Rows OPanel
     * has no name for are left out — see `utils/opanel-config.js`.
     */
    async _exportLayout() {
        try {
            const geometry = (await allGeometry())[GEOMETRY_KEY] || null;
            const file = toOPanelConfig(this.settings, geometry);
            const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });

            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `toolasha-overlay-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            URL.revokeObjectURL(link.href);
        } catch (error) {
            console.error('[OverlayPanel] Exporting the layout failed:', error);
            window.alert('Could not write the layout file.');
        }
    }

    /** Read a layout from an OPanel file, or from one of ours */
    _importLayout() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';

        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;

            try {
                const read = fromOPanelConfig(JSON.parse(await file.text()));
                if (!read) {
                    window.alert('That file is not an OPanel or Toolasha overlay layout.');
                    return;
                }

                const rows = read.settings.order.length;
                const missing = read.unknown.length
                    ? `\n\n${read.unknown.length} row${read.unknown.length === 1 ? '' : 's'} in that file ` +
                      `${read.unknown.length === 1 ? 'has' : 'have'} no equivalent here and will be left out:\n` +
                      read.unknown.join(', ')
                    : '';

                const answer = await askChoice({
                    title: 'Import overlay layout',
                    message: `Replace this layout with ${rows} row${rows === 1 ? '' : 's'} from the file.${missing}`,
                    choices: [
                        { value: 'import', label: 'Replace layout', tone: 'primary' },
                        { value: null, label: 'Cancel' },
                    ],
                });
                if (!answer) return;

                this._snapshot('Import');

                // A file this overlay wrote already holds this overlay's own
                // coordinates, measured against this overlay's own tiles. There
                // is nothing to correct, and correcting it anyway is what turned
                // an export and a re-import on the *same character* into a
                // different layout: growing sizes to fit and then repacking the
                // columns moves tiles that were exactly where they were put.
                // Refitting is for OPanel's files, whose sizes measure OPanel's
                // rendering rather than ours.
                if (read.native) {
                    this.settings = { ...this.settings, ...read.settings };
                } else {
                    this.settings = { ...this.settings, ...read.settings, sizes: this._fitSizes(read.settings.sizes) };

                    // Laid out against the width the file asks for, not the width
                    // the panel happens to be. Using the current width clamps every
                    // tile that sits beyond the right edge back inside it, which
                    // drops a second column on top of the first — and settling then
                    // stacks the collision into one very tall column. The panel is
                    // resized to fit a moment later, so the width it is about to
                    // have is the honest one to lay out against.
                    const laidWidth = this._importWidth(this.settings);
                    const laid = resolveLayout(
                        resolveRows(registeredRows(), this.settings).filter((row) => row.visible),
                        this.settings,
                        laidWidth
                    );

                    // OPanel measured those tiles against OPanel's rendering, and
                    // the same rows drawn here are not the same size — so they are
                    // grown to fit and then settled, which resolves the collisions
                    // that causes and closes the gaps it leaves
                    const positions = { ...this.settings.positions };
                    for (const { key, x, y } of compactColumns(laid, laidWidth)) positions[key] = { x, y };
                    this.settings.positions = positions;
                }

                this._save();

                // The frame came sized for OPanel's tiles too, so it is grown to
                // whatever ours actually need. Left smaller, the imported layout
                // arrives half below the fold, which reads as tiles that failed
                // to import rather than as a panel that needs dragging. Our own
                // file needs none of that — it was written from a frame that
                // already fitted, so it is restored as it was written.
                const geometry = read.geometry || {};
                if (read.native) {
                    if (Object.keys(geometry).length) await saveGeometry(GEOMETRY_KEY, geometry);
                } else {
                    const width = this._importWidth(this.settings);
                    const bounds = contentBounds(
                        resolveLayout(
                            resolveRows(registeredRows(), this.settings).filter((row) => row.visible),
                            this.settings,
                            width
                        )
                    );
                    await saveGeometry(GEOMETRY_KEY, {
                        ...geometry,
                        width: Math.max(geometry.width || 0, bounds.width + 30),
                        height: Math.max(geometry.height || 0, bounds.height + 80),
                    });
                }
                await restoreGeometry(this.panel, GEOMETRY_KEY, { width: 220, height: 120 });

                this._refreshLockButton();
                this._refreshStacking();
                this._renderPicker();
                this._renderBody();
                this._placePicker();
            } catch (error) {
                console.error('[OverlayPanel] Importing the layout failed:', error);
                window.alert('Could not read that file.');
            }
        });
        input.click();
    }

    /**
     * How wide the canvas has to be for an imported layout to fit.
     *
     * Taken from the layout rather than from the panel, because on import the
     * panel is still whatever size it was before — and laying a 560-wide layout
     * out against a 470-wide canvas does not scroll, it *clamps*, folding the
     * right-hand column onto the left one.
     *
     * @param {Object} settings - Settings holding the imported positions and sizes
     * @returns {number} Canvas width
     */
    _importWidth(settings) {
        let needed = 0;
        for (const [key, position] of Object.entries(settings.positions || {})) {
            const size = settings.sizes?.[key];
            if (size?.width > 0) needed = Math.max(needed, (position?.x || 0) + size.width);
        }
        return Math.max(this._canvasWidth(), needed);
    }

    /**
     * An imported layout's tile sizes, never smaller than the row needs.
     *
     * A size in an OPanel file is a measurement of OPanel's own rendering. Ours
     * is not the same rendering — different labels, different spacing — so a
     * tile imported verbatim clips the row it is supposed to hold, which is what
     * turned an imported layout into a wall of half-words.
     *
     * The larger of the two, rather than ours outright: a tile someone
     * deliberately made roomy stays roomy.
     *
     * @param {Object} imported - `{ [key]: {width, height} }` from the file
     * @returns {Object} The same, grown where it was too small
     */
    _fitSizes(imported) {
        const sizes = { ...imported };
        for (const row of registeredRows()) {
            const wanted = row.defaultSize;
            const theirs = sizes[row.key];
            if (!wanted || !theirs) continue;

            sizes[row.key] = {
                width: Math.max(theirs.width, wanted.width),
                height: Math.max(theirs.height, wanted.height),
            };
        }
        return sizes;
    }

    /**
     * The panel's base text size.
     *
     * Every tile's own zoom is a percentage of this, so the global control
     * scales the whole panel while leaving the differences between tiles intact
     * — a tile you made 130% stays half again as large as its neighbours.
     *
     * @returns {number} Pixels
     */
    _baseFontPx() {
        return (13 * clampZoom(this.settings.textScale ?? 100)) / 100;
    }

    /**
     * Change the base text size for every tile at once.
     * @param {number} delta - Percentage points
     */
    _stepTextScale(delta) {
        const next = clampZoom((this.settings.textScale ?? 100) + delta);
        if (next === this.settings.textScale) return;

        this.settings.textScale = next;
        this._save();
        if (this.panel) this.panel.style.fontSize = `${this._baseFontPx()}px`;
        this._renderPicker();
        this._placePicker();
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
                // While unlocked a finger drag must not become a scroll; locked
                // again, the panel's own scrolling comes back
                touchAction: this.isEditable ? 'none' : '',
                // Editing shows the tile's own outline; otherwise a rule under
                // each one, which is what gives a column of tiles the ruled look
                // rather than a floating jumble
                border: this.isEditable ? `1px dashed ${COLORS.tileEdit}` : '1px solid transparent',
                borderBottom:
                    this.isEditable || this.settings.separators === false ? undefined : `1px solid ${COLORS.separator}`,
            });
            tile._grip.style.display = this.isEditable ? '' : 'none';
            if (!this.isEditable) tile._zoom.style.display = 'none';

            try {
                row.render(tile._content);
                this._fillEmptyTile(tile._content, row);
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
     * Say something in a tile that drew nothing.
     *
     * A blank tile looks broken rather than idle. You cannot tell a feature
     * that has nothing to report from one that has fallen over, and on an
     * overlay of a dozen tiles the empty ones are exactly the ones your eye
     * keeps returning to — there is nothing there to finish reading.
     *
     * The row says what it would rather say; naming itself is the fallback,
     * which at least identifies which tile is which while the layout is being
     * arranged.
     *
     * @param {HTMLElement} content - The tile's content element
     * @param {Object} row - The resolved row
     */
    _fillEmptyTile(content, row) {
        // An icon is content even with no text beside it — a tile showing only
        // a coin has drawn what it meant to
        if (content.textContent.trim() || content.querySelector('svg, img')) return;

        const note = document.createElement('div');
        note.textContent = row.empty || `No ${row.name.toLowerCase()} data`;
        Object.assign(note.style, {
            color: COLORS.textDim,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
        });

        content.replaceChildren(note);
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
            padding: '1px 4px',
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
            width: '12px',
            height: '12px',
            cursor: 'nwse-resize',
            // Above the − and + buttons. They sit bottom left and a tile can be
            // forty pixels wide, at which point two buttons reach the corner and
            // cover the one control that would let you make the tile bigger
            // again — the tile becomes stuck at the size that caused it.
            zIndex: '3',
            // Its own backdrop, because on a small tile it is now drawn over a
            // button and a bare triangle on top of one reads as neither
            background:
                'linear-gradient(135deg, transparent 0 50%, rgba(158, 196, 255, 0.75) 50%), rgba(8, 10, 20, 0.85)',
            borderBottomRightRadius: '3px',
            display: 'none',
        });
        tile.appendChild(grip);
        tile._grip = grip;

        this._attachTileDrag(tile, row.key);
        this._attachTileResize(tile, grip, row.key);

        const zoomControl = this._tileZoomControl(tile, row.key);
        tile.appendChild(zoomControl);
        tile._zoom = zoomControl;

        if (row.onOpen) {
            tile.title = `Double-click to open or close ${row.name}`;
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

        const onPointerMove = (event) => {
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

        const onPointerUp = () => {
            if (!dragging) return;
            dragging = false;
            this.interacting = false;
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerUp);

            this.settings.positions = {
                ...this.settings.positions,
                [key]: { x: parseFloat(tile.style.left), y: parseFloat(tile.style.top) },
            };
            this._save();
            this._renderBody();
        };

        // Pointer events so a finger can arrange tiles too; touch-action stays
        // default while locked so the panel still scrolls — the drag only ever
        // starts while the layout is unlocked
        tile.addEventListener('pointerdown', (event) => {
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
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
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

        const onPointerMove = (event) => {
            if (!resizing) return;
            const step = this.settings.snapToGrid ? GRID : 1;
            tile.style.width = `${Math.max(MIN_TILE.width, snap(startWidth + event.clientX - startX, step))}px`;
            tile.style.height = `${Math.max(MIN_TILE.height, snap(startHeight + event.clientY - startY, step))}px`;
        };

        const onPointerUp = () => {
            if (!resizing) return;
            resizing = false;
            this.interacting = false;
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerUp);

            this.settings.sizes = {
                ...this.settings.sizes,
                [key]: { width: tile.offsetWidth, height: tile.offsetHeight },
            };
            this._save();
            this._renderBody();
        };

        // Pointer events so a finger works too; the grip only shows while the
        // layout is unlocked, so it can opt out of scrolling outright
        grip.style.touchAction = 'none';
        grip.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            resizing = true;
            this.interacting = true;
            startX = event.clientX;
            startY = event.clientY;
            startWidth = tile.offsetWidth;
            startHeight = tile.offsetHeight;
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
            event.preventDefault();
            event.stopPropagation();
        });
    }

    /**
     * The − and + a tile shows while the layout is unlocked.
     *
     * Buttons rather than Ctrl+scroll, which is what this was: Ctrl+wheel is the
     * browser's own page-zoom gesture, and a page that zooms when you meant to
     * resize one tile is worse than no shortcut at all. Buttons are also
     * findable, where a modifier gesture has to be told to you.
     *
     * Only while unlocked, and only on hover — the rest of the time a tile is
     * something you read, and two buttons sitting on top of the figure are two
     * buttons in the way.
     *
     * @param {HTMLElement} tile - The tile
     * @param {string} key - Row key
     * @returns {HTMLElement} The control, hidden until hovered
     */
    _tileZoomControl(tile, key) {
        const holder = document.createElement('div');
        Object.assign(holder.style, {
            position: 'absolute',
            // Bottom left: top right is where a tile's value sits. The resize
            // grip is bottom right and is drawn above these, so on a tile too
            // narrow to hold both it is the corner that wins.
            left: '1px',
            bottom: '1px',
            display: 'none',
            gap: '1px',
            background: 'rgba(8, 10, 20, 0.9)',
            borderRadius: '3px',
            zIndex: '1',
            // Never under the grip where there is room to avoid it
            maxWidth: 'calc(100% - 14px)',
        });

        const step = (delta) => {
            const current = this.settings.zoom?.[key] ?? 100;
            const next = clampZoom(current + delta);
            if (next === current) return;

            this.settings.zoom = { ...this.settings.zoom, [key]: next };
            this._save();
            this._renderBody();
        };

        for (const [label, delta] of [
            ['−', -ZOOM_STEP],
            ['+', ZOOM_STEP],
        ]) {
            const button = document.createElement('button');
            button.textContent = label;
            button.title = `${label === '+' ? 'Larger' : 'Smaller'} text in this tile`;
            Object.assign(button.style, {
                background: 'rgba(255, 255, 255, 0.1)',
                border: `1px solid ${COLORS.border}`,
                borderRadius: '3px',
                color: COLORS.text,
                cursor: 'pointer',
                fontSize: '11px',
                lineHeight: '1',
                padding: '2px 5px',
            });
            button.addEventListener('mousedown', (event) => event.stopPropagation());
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                step(delta);
            });
            holder.appendChild(button);
        }

        // Shown on hover, but only when there is something to hover for
        tile.addEventListener('mouseenter', () => {
            if (this.isEditable) holder.style.display = 'flex';
        });
        tile.addEventListener('mouseleave', () => (holder.style.display = 'none'));

        return holder;
    }

    /**
     * Put the docked panel back after React has rebuilt the column.
     *
     * Switching tabs re-renders the column, which drops both the panel and the
     * class the sheet keys off. Cheap enough to check on every tick, and the
     * alternative — a MutationObserver on a container that churns on every
     * combat tick — costs more than the check it would be avoiding.
     */
    _ensureDocked() {
        if (!this.panel || this.panel.dataset.docked !== 'true') return;

        if (this.panel.isConnected && this.dockHost?.isConnected) {
            this.dockHost.classList.add(DOCK_HOST_CLASS);
            return;
        }
        const host = this._findDockHost();
        if (!host) return;

        host.classList.add(DOCK_HOST_CLASS);
        host.appendChild(this.panel);
        this.dockHost = host;
        this._fitDock();
    }

    _startRefreshing() {
        if (this.refreshId) return;
        this.refreshId = setInterval(() => {
            this._ensureDocked();
            this._renderBody();
            this._fitDock();
        }, REFRESH_MS);
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

        this.pickerEl?.remove();
        this.pickerEl = null;

        if (this.onWindowResize) {
            window.removeEventListener('resize', this.onWindowResize);
            this.onWindowResize = null;
        }

        // Left behind, the column keeps a flex layout and a measured height with
        // nothing to fill them
        if (this.dockHost) {
            this.dockHost.classList.remove(DOCK_HOST_CLASS);
            this.dockHost.style.height = '';
        }
        this.dockHost = null;

        if (this.panel) {
            unregisterFloatingPanel(this.panel);
            this.panel.remove();
            this.panel = null;
            this.canvasEl = null;
            this.scrollEl = null;
        }
    }
}

const overlayPanel = new OverlayPanel();
export default overlayPanel;
