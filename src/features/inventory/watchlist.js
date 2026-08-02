/**
 * Watchlist
 *
 * A list of items you care about, what you hold, and what it is worth.
 *
 * Inventory Value already says what the whole bag is worth, which is a number
 * you cannot act on — it moves when anything moves. The question behind this one
 * is narrower and answerable: *these thirty things, how many have I got, what
 * are they worth, and which of them should I not be selling on the market.*
 *
 * ## Building the list is the feature
 *
 * Adding thirty items one at a time is thirty clicks and a wiki tab, and nobody
 * does it twice. So a whole zone's drop table goes on with one tick, read from
 * the game's own data — both drop tables of every ordinary spawn and every boss,
 * or the reward table if it is a dungeon. Chests work the same way. Items can
 * still be added one at a time, and those are never removed by un-ticking
 * anything.
 *
 * ## The vendor warning
 *
 * A market bid below what the vendor pays flat is not a price, it is a trap, and
 * a list that reports it as the item's value quietly advises the worse of two
 * sales. Those rows show the vendor price and say so. Toolasha already made this
 * comparison inside the bulk-sell flow; here it stands as a property of the item
 * rather than as a step in selling one.
 *
 * The set algebra is in `utils/watchlist.js` and the drop-table walking in
 * `utils/drop-sources.js`, both with tests. This module reads the game, draws
 * the panel, and does no arithmetic of its own.
 *
 * The panel is NTally's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { getItemPrices } from '../../utils/market-data.js';
import { formatWithSeparator, formatKMB } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry } from '../../utils/panel-geometry.js';
import { itemIcon, linkToMarketplace, row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { getItemHridFromName } from '../../utils/game-lookups.js';
import {
    addToWatchlist,
    removeFromWatchlist,
    removeSource,
    valueWatchlist,
    watchlistTotals,
    sortRows,
    listedCounts,
} from '../../utils/watchlist.js';
import { combatZones, zoneDrops, openableItems, openableDrops } from '../../utils/drop-sources.js';
import { registerRow } from '../../utils/overlay-rows.js';
import inventoryBadgeManager from './inventory-badge-manager.js';
import domObserver from '../../core/dom-observer.js';

const PANEL_ID = 'toolasha-watchlist-panel';
const GEOMETRY_KEY = 'watchlistPanel';
const STORAGE_KEY = 'watchlist';
const DEFAULT_PANEL = { width: 560, height: 640 };
const REFRESH_MS = 5000;
const DOT_CLASS = 'toolasha-watchlist-dot';
const MENU_BUTTON_CLASS = 'toolasha-watchlist-track';
const MENU_BUTTON_SETTING = 'watchlist_menuButton';

const COLORS = {
    background: 'rgba(14, 16, 22, 0.97)',
    card: 'rgba(255, 255, 255, 0.04)',
    headerBg: 'rgba(20, 30, 24, 0.9)',
    border: 'rgba(120, 210, 150, 0.32)',
    hairline: 'rgba(255, 255, 255, 0.10)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.5)',
    accent: '#7fd6a3',
};

/**
 * What the list is and which sets built it.
 *
 * At module scope and persisted, because the overlay row and the inventory dot
 * both read it while the panel is closed — which is most of the time.
 */
const state = { entries: [], zones: {}, chests: {}, sortBy: 'value', direction: 'desc' };

storage
    .getJSON(STORAGE_KEY, 'settings', null)
    .then((saved) => {
        if (!saved) return;
        Object.assign(state, saved);
        // A list restored from storage has to reach the dot, which by then has
        // already drawn nothing on every item
        inventoryBadgeManager.invalidateCache?.();
    })
    .catch((error) => console.error('[Watchlist] Loading the saved list failed:', error));

/** Write the list back, without making anybody wait for it */
function persist() {
    storage
        .setJSON(STORAGE_KEY, { ...state }, 'settings')
        .catch((error) => console.error('[Watchlist] Saving the list failed:', error));
}

/**
 * Whether an item is on the list.
 *
 * Exported because it is what the inventory dot asks, and because "is this
 * tracked" is a reasonable thing for anything else to want to know.
 *
 * @param {string} itemHrid - The item
 * @returns {boolean}
 */
export function isWatched(itemHrid) {
    return state.entries.some((entry) => entry.hrid === itemHrid);
}

/** @returns {Array<Object>} The raw list */
export function watchlistEntries() {
    return [...state.entries];
}

/**
 * Put one item on the list by hand.
 *
 * By hand means no set owns it, so un-ticking every zone and chest leaves it
 * exactly where it is.
 *
 * @param {string} itemHrid - The item
 * @param {string} [name] - Its display name
 */
export function watchItem(itemHrid, name) {
    state.entries = addToWatchlist(state.entries, [{ hrid: itemHrid, name: name || nameOf(itemHrid) }], null);
    persist();
}

/**
 * Take one item off, whichever set put it there.
 * @param {string} itemHrid - The item
 */
export function unwatchItem(itemHrid) {
    state.entries = removeFromWatchlist(state.entries, itemHrid);
    persist();
}

/**
 * Empty the list, and untick every set.
 *
 * Both, because they are one thing: leaving the sets ticked would leave every
 * checkbox claiming to have put rows on a list with no rows on it, and the next
 * tick of that box would do nothing visible.
 *
 * One tick can add thirty rows, so undoing a mess has to be one gesture too.
 */
export function clearWatchlist() {
    state.entries = [];
    state.zones = {};
    state.chests = {};
    persist();
    inventoryBadgeManager.invalidateCache?.();
}

/**
 * @param {string} itemHrid - The item
 * @returns {string} Its name, or something readable from the hrid
 */
function nameOf(itemHrid) {
    return dataManager.getItemDetails?.(itemHrid)?.name || String(itemHrid).replace('/items/', '').replace(/_/g, ' ');
}

/**
 * How many of an item the character holds, across every stack.
 *
 * Summed rather than taken from the first match: the same item at different
 * enhancement levels is several inventory entries, and reporting one of them is
 * reporting a number that is right for nothing.
 *
 * @param {string} itemHrid - The item
 * @returns {number}
 */
function heldCount(itemHrid) {
    let total = 0;
    for (const entry of dataManager.getInventory?.() || []) {
        if (entry?.itemHrid === itemHrid) total += entry.count || 0;
    }
    return total;
}

/**
 * What the vendor pays flat for an item.
 * @param {string} itemHrid - The item
 * @returns {number}
 */
function vendorPriceOf(itemHrid) {
    return dataManager.getItemDetails?.(itemHrid)?.sellPrice || 0;
}

/**
 * Every row, priced and counted.
 * @returns {Array<Object>} From `valueWatchlist`, sorted
 */
export function watchlistRows() {
    // Built once per pass rather than per row: it is a walk of every listing,
    // and there are more rows than listings
    const listed = listedCounts(
        dataManager.getCharacterData?.()?.myMarketListings || dataManager.characterData?.myMarketListings
    );

    const rows = valueWatchlist(state.entries, {
        quantityOf: heldCount,
        pricesFor: (hrid) => getItemPrices(hrid),
        vendorOf: vendorPriceOf,
        listedOf: (hrid) => listed[hrid],
    });
    return sortRows(rows, state.sortBy, state.direction);
}

/**
 * Tick or untick a set, adding or re-homing its items.
 *
 * @param {string} kind - `zones` or `chests`
 * @param {string} id - Which set
 * @param {boolean} on - Ticked or not
 */
function toggleSet(kind, id, on) {
    const source = `${kind}:${id}`;

    if (on) {
        state[kind][id] = true;
        state.entries = addToWatchlist(state.entries, contentsOf(kind, id), source);
    } else {
        delete state[kind][id];
        // Everything still ticked, so an item two sets share is re-homed rather
        // than lost — the reason this is not a filter
        const stillOn = [];
        for (const other of ['zones', 'chests']) {
            for (const otherId of Object.keys(state[other])) {
                stillOn.push({ id: `${other}:${otherId}`, hrids: contentsOf(other, otherId).map((item) => item.hrid) });
            }
        }
        state.entries = removeSource(state.entries, source, stillOn);
    }
    persist();
    inventoryBadgeManager.invalidateCache?.();
}

/**
 * @param {string} kind - `zones` or `chests`
 * @param {string} id - Which set
 * @returns {Array<{hrid: string, name: string}>}
 */
function contentsOf(kind, id) {
    const data = dataManager.getInitClientData?.();
    if (!data) return [];

    return kind === 'zones' ? zoneDrops(id, data) : openableDrops(id, data);
}

class WatchlistPanel {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.refreshId = null;
        this.collapsed = { zones: true, chests: true };
    }

    show() {
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._create();
    }

    hide() {
        this._remove();
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '140px',
            left: '110px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: `${DEFAULT_PANEL.width}px`,
            height: `${DEFAULT_PANEL.height}px`,
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontSize: '12px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        this.headerEl = this._header();
        this.panel.appendChild(this.headerEl);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.detachDrag = makeDraggable(this.panel, this.headerEl, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: 380,
            minHeight: 240,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 380, height: 240 });

        this._render();
        this.refreshId = setInterval(() => this._render(), REFRESH_MS);
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = document.createElement('span');
        title.textContent = 'Watchlist';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;

        this.headerCount = document.createElement('span');
        this.headerCount.style.color = COLORS.textDim;

        this.headerTotal = document.createElement('span');
        this.headerTotal.style.color = ROW_COLORS.gold;

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const close = document.createElement('button');
        close.textContent = '✕';
        Object.assign(close.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '13px',
            padding: '2px 4px',
        });
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            this.hide();
        });

        header.append(title, this.headerCount, this.headerTotal, spacer, close);
        return header;
    }

    _render() {
        if (!this.bodyEl) return;

        const rows = watchlistRows();
        const totals = watchlistTotals(rows);

        this.headerCount.textContent = `${totals.held} / ${totals.items}`;
        this.headerCount.title = 'How many of the tracked items you hold any of.';
        this.headerTotal.textContent = `${formatKMB(totals.ask)} ask · ${formatKMB(totals.bid)} bid`;

        this.bodyEl.replaceChildren();
        for (const build of [
            () => this._sets('zones', 'Zones', combatZones(dataManager.getInitClientData?.()?.actionDetailMap)),
            () => this._sets('chests', 'Chests', openableItems(dataManager.getInitClientData?.())),
            () => this._table(rows),
            () => this._options(),
        ]) {
            // One section that cannot be drawn must not take the others with it
            try {
                this.bodyEl.appendChild(build());
            } catch (error) {
                console.error('[Watchlist] A section could not be drawn:', error);
                const failed = this._note(`This section could not be drawn: ${error.message}`);
                failed.style.color = ROW_COLORS.bad;
                this.bodyEl.appendChild(failed);
            }
        }
    }

    /**
     * The switches that belong to this panel rather than to a set.
     *
     * The Track button is here as well as on the settings page because this is
     * where you are when you decide you want it — and it is the same setting,
     * not a copy, so the two can never disagree.
     *
     * @returns {HTMLElement}
     */
    _options() {
        const card = this._card();

        const label = document.createElement('label');
        Object.assign(label.style, { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' });

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.menuButton = 'true';
        box.checked = Boolean(config.getSetting(MENU_BUTTON_SETTING));
        box.addEventListener('change', () => config.setSetting(MENU_BUTTON_SETTING, box.checked));

        const text = document.createElement('span');
        text.textContent = 'Track button in the item menu';
        text.title =
            'Adds Track / Untrack beside Sell when you click an inventory item. Off by default, because it ' +
            'changes a menu you open for other reasons.';

        label.append(box, text);
        card.appendChild(label);
        return card;
    }

    /**
     * The tick boxes for one kind of set.
     *
     * @param {string} kind - `zones` or `chests`
     * @param {string} title - Heading
     * @param {Array<{id: string, name: string, isDungeon?: boolean}>} available - What can be ticked
     * @returns {HTMLElement}
     */
    _sets(kind, title, available) {
        const card = this._card();
        const on = Object.keys(state[kind]).length;

        const heading = document.createElement('div');
        Object.assign(heading.style, {
            color: COLORS.accent,
            fontWeight: 'bold',
            cursor: 'pointer',
            userSelect: 'none',
        });
        heading.textContent = `${this.collapsed[kind] ? '▶' : '▼'} ${title}${on ? ` — ${on} on` : ''}`;
        heading.addEventListener('click', () => {
            this.collapsed[kind] = !this.collapsed[kind];
            this._render();
        });
        card.appendChild(heading);

        if (this.collapsed[kind]) return card;
        if (!available.length) {
            card.appendChild(this._note('Nothing loaded yet.'));
            return card;
        }

        const grid = document.createElement('div');
        Object.assign(grid.style, {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))',
            gap: '2px 8px',
            marginTop: '5px',
        });

        for (const set of available) {
            const label = document.createElement('label');
            Object.assign(label.style, { display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' });

            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = Boolean(state[kind][set.id]);
            box.addEventListener('change', () => {
                toggleSet(kind, set.id, box.checked);
                this._render();
            });

            const name = document.createElement('span');
            name.textContent = set.name;
            name.style.overflow = 'hidden';
            name.style.textOverflow = 'ellipsis';
            name.style.whiteSpace = 'nowrap';
            if (set.isDungeon) {
                name.style.color = ROW_COLORS.accent;
                name.title = 'A dungeon — its drops come from the completion reward table, not from its monsters.';
            }

            label.append(box, name);
            grid.appendChild(label);
        }
        card.appendChild(grid);
        return card;
    }

    /**
     * @param {Array<Object>} rows - From `watchlistRows`
     * @returns {HTMLElement}
     */
    _table(rows) {
        const card = this._card();

        const heading = this._row();
        heading.style.color = COLORS.textDim;
        heading.style.borderBottom = `1px solid ${COLORS.hairline}`;
        heading.style.paddingBottom = '3px';

        const clear = document.createElement('button');
        clear.textContent = '⌫';
        Object.assign(clear.style, {
            background: 'none',
            border: 'none',
            color: COLORS.textDim,
            cursor: 'pointer',
            padding: '0 2px',
        });
        clear.title = 'Empty the list and untick every set';
        clear.dataset.clearAll = 'true';
        clear.addEventListener('click', () => {
            clearWatchlist();
            this._render();
        });

        heading.append(
            document.createElement('span'),
            this._sortHeader('Item', 'name'),
            this._cell('Held'),
            this._cell('Unit'),
            this._sortHeader('Value', 'value', 'right'),
            rows.length ? clear : document.createElement('span')
        );
        card.appendChild(heading);

        if (!rows.length) {
            card.appendChild(this._note('Nothing tracked yet — tick a zone or a chest above.'));
            return card;
        }

        for (const item of rows) card.appendChild(this._itemRow(item));
        return card;
    }

    /**
     * @param {Object} item - One priced row
     * @returns {HTMLElement}
     */
    _itemRow(item) {
        const line = this._row();
        line.style.padding = '2px 0';

        const icon = itemIcon(item.hrid, 20);
        linkToMarketplace(icon, item.hrid, navigateToMarketplace);
        // Nothing held is still a row worth having — it is the part of the
        // collection you have not got — but it should not look like the rest
        if (!item.quantity) icon.style.filter = 'grayscale(100%)';
        icon.style.opacity = item.quantity ? '1' : '0.4';

        const name = document.createElement('span');
        name.textContent = item.name;
        Object.assign(name.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
        linkToMarketplace(name, item.hrid, navigateToMarketplace);
        if (!item.quantity) name.style.color = COLORS.textDim;

        const held = this._cell(item.quantity ? formatWithSeparator(item.quantity) : '—');
        held.style.color = item.quantity ? COLORS.text : COLORS.textDim;
        // Where they are matters: on the market is "wait", in the bag is "done",
        // and a single number cannot tell you which
        if (item.listed || item.unclaimed) {
            held.style.color = ROW_COLORS.accent;
            const parts = [`${formatWithSeparator(item.held)} in the bag`];
            if (item.listed) parts.push(`${formatWithSeparator(item.listed)} listed for sale`);
            if (item.unclaimed) parts.push(`${formatWithSeparator(item.unclaimed)} unclaimed on the market`);
            held.title = parts.join(', ');
            held.textContent = `${formatWithSeparator(item.quantity)}*`;
        }

        const unit = this._cell(this._unitText(item));
        unit.style.color = item.flag ? ROW_COLORS.bad : COLORS.textDim;
        if (item.flag) unit.title = FLAG_MEANING[item.flag];

        const value = this._cell(`${formatKMB(item.totalAsk)} · ${formatKMB(item.totalBid)}`);
        value.style.color = ROW_COLORS.gold;
        value.title = `${formatWithSeparator(item.totalAsk)} at ask, ${formatWithSeparator(item.totalBid)} at bid.`;

        const remove = document.createElement('button');
        remove.textContent = '✕';
        // Marked, because the header's close button is also an ✕ and "the first
        // button on the panel" is the wrong one
        remove.dataset.removeItem = item.hrid;
        Object.assign(remove.style, {
            background: 'none',
            border: 'none',
            color: COLORS.textDim,
            cursor: 'pointer',
            padding: '0 2px',
        });
        remove.title = 'Take this off the list';
        remove.addEventListener('click', () => {
            unwatchItem(item.hrid);
            inventoryBadgeManager.invalidateCache?.();
            this._render();
        });

        line.append(icon, name, held, unit, value, remove);
        return line;
    }

    /**
     * The unit price, saying when the market is not where to sell.
     * @param {Object} item - One priced row
     * @returns {string}
     */
    _unitText(item) {
        const ask = formatKMB(item.ask);
        if (item.flag === 'no-market') return `${ask} · ${formatKMB(item.bid)} vendor`;
        if (item.flag === 'below-vendor') return `${ask} · ⚠ ${formatKMB(item.bid)} vendor`;
        if (item.flag === 'equals-vendor') return `${ask} · ${formatKMB(item.bid)} vend`;

        return `${ask} · ${formatKMB(item.bid)}`;
    }

    /**
     * @param {string} text - Column label
     * @param {string} by - What it sorts on
     * @param {string} [align] - Text alignment
     * @returns {HTMLElement}
     */
    _sortHeader(text, by, align = 'left') {
        const header = document.createElement('span');
        const active = state.sortBy === by;
        header.textContent = active ? `${text} ${state.direction === 'asc' ? '▲' : '▼'}` : text;
        Object.assign(header.style, { cursor: 'pointer', textAlign: align, userSelect: 'none' });
        if (active) header.style.color = COLORS.accent;

        header.addEventListener('click', () => {
            if (state.sortBy === by) state.direction = state.direction === 'asc' ? 'desc' : 'asc';
            else {
                state.sortBy = by;
                // Names read best from A, values from the top
                state.direction = by === 'name' ? 'asc' : 'desc';
            }
            persist();
            this._render();
        });
        return header;
    }

    _card() {
        const card = document.createElement('div');
        Object.assign(card.style, {
            background: COLORS.card,
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '6px',
            padding: '7px 9px',
        });
        return card;
    }

    _row() {
        const line = document.createElement('div');
        Object.assign(line.style, {
            display: 'grid',
            gridTemplateColumns: '22px minmax(0, 1fr) 62px 128px 132px 18px',
            gap: '6px',
            alignItems: 'center',
        });
        return line;
    }

    _cell(text) {
        const cell = document.createElement('span');
        cell.textContent = text;
        cell.style.textAlign = 'right';
        cell.style.whiteSpace = 'nowrap';
        return cell;
    }

    _note(text) {
        const note = document.createElement('div');
        note.textContent = text;
        note.style.color = COLORS.textDim;
        return note;
    }

    _remove() {
        clearInterval(this.refreshId);
        this.refreshId = null;
        this.detachDrag?.();
        this.detachDrag = null;
        this.detachResize?.();
        this.detachResize = null;

        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.bodyEl = null;
    }
}

/**
 * An item's hrid from the name on its tile, remembered.
 *
 * The lookup walks the whole item map, and the dot asks it once per tile on
 * every inventory render. Names do not change, so asking twice is waste — and at
 * a few hundred tiles against a few thousand items it is the kind of waste that
 * shows up as the inventory tab stuttering.
 */
const hridByName = new Map();

/**
 * @param {string} name - Display name from the tile's `aria-label`
 * @returns {string|null}
 */
function hridForName(name) {
    if (hridByName.has(name)) return hridByName.get(name);

    const hrid = getItemHridFromName(name);
    // Cached only once the item map has loaded, or the first inventory render
    // of a session poisons the cache with nulls that never expire
    if (hrid) hridByName.set(name, hrid);
    return hrid;
}

/** What each flag means, said once rather than at every call site */
const FLAG_MEANING = {
    'below-vendor': 'The market bid is below what the vendor pays. Sell this to the vendor.',
    'equals-vendor': 'The market bid matches the vendor price, so either sale is the same.',
    'no-market': 'No market price — this is what the vendor pays.',
};

export const watchlistPanel = new WatchlistPanel();

/**
 * The dot on tracked items in the inventory grid.
 *
 * The point of a watchlist is knowing what is on it while you are looking at
 * your inventory, not while you are looking at the list — a list you have to
 * open to consult is a list you consult twice and then forget.
 *
 * @param {HTMLElement} itemElem - One inventory tile
 */
function markTrackedItem(itemElem) {
    const existing = itemElem.querySelector(`.${DOT_CLASS}`);

    const name = itemElem.querySelector('svg')?.getAttribute('aria-label');
    const hrid = name && hridForName(name);
    if (!hrid || !isWatched(hrid)) {
        existing?.remove();
        return;
    }
    if (existing) return;

    // The dot is positioned against the tile, and a tile the game left static
    // would push it to whatever ancestor is positioned — usually the whole
    // inventory panel, so every dot lands in the same corner
    if (getComputedStyle(itemElem).position === 'static') itemElem.style.position = 'relative';

    const dot = document.createElement('div');
    dot.className = DOT_CLASS;
    Object.assign(dot.style, {
        position: 'absolute',
        top: '2px',
        left: '2px',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: COLORS.accent,
        boxShadow: `0 0 3px ${COLORS.accent}`,
        pointerEvents: 'none',
        zIndex: '12',
    });
    itemElem.appendChild(dot);
}

/**
 * The Track button in the game's own item menu.
 *
 * Off by default, and deliberately: this adds a button to a menu you open for
 * other reasons, next to Sell. Somebody who never uses the watchlist should not
 * find their item menu rearranged by a feature they did not ask for, and a
 * misclick there is a sale.
 *
 * The switch lives in one place — the setting — and both the settings page and
 * the panel's own checkbox write to it. `onSettingChange` does the rest, so
 * flipping it from either surface attaches or detaches the observer immediately
 * rather than at the next reload.
 */
let detachMenuObserver = null;

/**
 * Put a Track button on one item menu.
 * @param {HTMLElement} actionMenu - The game's `Item_actionMenu` popup
 */
function injectTrackButton(actionMenu) {
    if (actionMenu.querySelector(`.${MENU_BUTTON_CLASS}`)) return;

    const itemName = actionMenu.querySelector('[class*="Item_name"]')?.textContent?.trim();
    const hrid = itemName && hridForName(itemName);
    if (!hrid) return;

    const button = document.createElement('button');
    // The game's own button classes, taken from a button already in this menu,
    // so it does not look like something bolted on
    const sibling = actionMenu.querySelector('button');
    if (sibling) button.className = sibling.className;
    button.classList.add(MENU_BUTTON_CLASS);

    const label = () => {
        button.textContent = isWatched(hrid) ? 'Untrack' : 'Track';
    };
    label();

    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (isWatched(hrid)) unwatchItem(hrid);
        else watchItem(hrid, itemName);

        label();
        inventoryBadgeManager.invalidateCache?.();
        // The panel may be open behind the menu, and a list that does not
        // change when you press Track looks like a button that does nothing
        if (watchlistPanel.panel) watchlistPanel._render();
    });

    actionMenu.appendChild(button);
}

/** Start watching for item menus, if the setting says to */
function applyMenuButtonSetting() {
    const wanted = config.getSetting(MENU_BUTTON_SETTING);

    if (wanted && !detachMenuObserver) {
        detachMenuObserver = domObserver.onClass('WatchlistTrackButton', 'Item_actionMenu', injectTrackButton);
    } else if (!wanted && detachMenuObserver) {
        detachMenuObserver();
        detachMenuObserver = null;
        document.querySelectorAll(`.${MENU_BUTTON_CLASS}`).forEach((button) => button.remove());
    }
}

export default {
    name: 'Watchlist',
    initialize: () => {
        inventoryBadgeManager.registerProvider('watchlist-dot', markTrackedItem, 150);
        applyMenuButtonSetting();
        config.onSettingChange(MENU_BUTTON_SETTING, applyMenuButtonSetting);
    },
    cleanup: () => {
        inventoryBadgeManager.unregisterProvider('watchlist-dot');
        document.querySelectorAll(`.${DOT_CLASS}`).forEach((dot) => dot.remove());
        detachMenuObserver?.();
        detachMenuObserver = null;
        document.querySelectorAll(`.${MENU_BUTTON_CLASS}`).forEach((button) => button.remove());
        watchlistPanel.hide();
    },
};

registerRow({
    key: 'watchlist',
    name: 'Watchlist',
    defaultSize: { width: 230, height: 30 },
    render: (container) => {
        const rows = watchlistRows();
        if (!rows.length) return blank(container);

        const totals = watchlistTotals(rows);
        const flagged = rows.filter((item) => item.flag === 'below-vendor').length;

        row(container, [
            { text: 'Watch', color: ROW_COLORS.dim },
            { text: `${totals.held}/${totals.items}`, color: COLORS.accent, bold: true },
            { text: formatKMB(totals.ask), color: ROW_COLORS.gold, push: true },
            // The one thing on this list that is a call to action rather than a
            // figure, so it earns the space when there is any
            flagged ? { text: `⚠ ${flagged}`, color: ROW_COLORS.bad } : null,
        ]);
        container.title =
            `${totals.held} of ${totals.items} tracked items held, worth ${formatWithSeparator(Math.round(totals.ask))} at ask.` +
            (flagged ? `\n${flagged} would sell for more to the vendor than to the market.` : '');
    },
    onOpen: () => watchlistPanel.toggle(),
});
