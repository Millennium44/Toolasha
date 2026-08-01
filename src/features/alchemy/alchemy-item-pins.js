/**
 * Alchemy Item Pins
 *
 * Pin the items you alchemize to the front of the picker, per action.
 *
 * The picker lists everything you own in whatever order the game keeps it, and
 * the handful of items anyone actually feeds it are scattered through that. The
 * alternative to pinning is typing the same filter every time — which works,
 * and is exactly the sort of thing worth not having to do twice a day.
 *
 * Per action, because the same item means different things in each: what is
 * worth coinifying is rarely what is worth decomposing, and a single shared
 * list would be the union of four unrelated shortlists.
 *
 * Pins reorder, they do not exempt. A pinned item that does not match what you
 * typed in the filter stays hidden — the filter has to keep meaning what it
 * says, or it stops being usable for finding anything else.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import domObserver from '../../core/dom-observer.js';
import { findAlchemizeMenu, activeAlchemyAction, menuTiles, tileItemHrid } from './alchemy-item-selector.js';

const STORAGE_KEY = 'alchemyItemPins';
const STYLE_ID = 'mwi-alchemy-pins-style';
const PIN_CLASS = 'mwi-alchemy-pin';
const PINNED_CLASS = 'mwi-alchemy-pinned';
/** Marks the element the pin is mounted on, which is not always the tile */
const TILE_CLASS = 'mwi-alchemy-tile';

/**
 * Add or remove an item from one action's pins.
 *
 * Newly pinned items go to the end rather than the front: the order is the one
 * you built, and having each new pin displace the one you use most would make
 * the list rearrange itself every time you added to it.
 *
 * @param {Object} pins - { [action]: itemHrid[] }
 * @param {string} action - Alchemy action
 * @param {string} itemHrid - Item
 * @returns {Object} New pins
 */
export function togglePin(pins, action, itemHrid) {
    if (!action || !itemHrid) return pins || {};

    const current = (pins || {})[action] || [];
    const next = current.includes(itemHrid) ? current.filter((hrid) => hrid !== itemHrid) : [...current, itemHrid];

    return { ...pins, [action]: next };
}

/**
 * The order tiles should appear in: pinned first, in pin order, then everything
 * else exactly as it was.
 *
 * Tiles the filter has hidden are ordered along with the rest rather than
 * skipped. A hidden tile takes up no room, so putting it at the front changes
 * nothing about what you see — and checking each tile's computed style to find
 * out would cost a layout pass on every keystroke to achieve the same result.
 *
 * @param {HTMLElement[]} tiles - Tiles in their current order
 * @param {string[]} pinned - Pinned item hrids, in pin order
 * @param {Function} hridOf - Reads a tile's item hrid
 * @returns {HTMLElement[]} The tiles, reordered
 */
export function orderTiles(tiles, pinned, hridOf) {
    const list = tiles || [];
    const rank = new Map((pinned || []).map((hrid, index) => [hrid, index]));

    const front = [];
    const rest = [];
    for (const tile of list) {
        const hrid = hridOf(tile);
        if (rank.has(hrid)) front.push(tile);
        else rest.push(tile);
    }
    front.sort((a, b) => rank.get(hridOf(a)) - rank.get(hridOf(b)));

    return [...front, ...rest];
}

/**
 * Whether two tile orders are the same, so an unchanged menu can be left alone.
 * Reordering the DOM is itself a mutation, and a watcher that reacted to its own
 * writes would never stop.
 * @param {HTMLElement[]} a - One order
 * @param {HTMLElement[]} b - Another
 * @returns {boolean}
 */
export function sameOrder(a, b) {
    return a.length === b.length && a.every((tile, index) => tile === b[index]);
}

const CSS = `
    .${PIN_CLASS} {
        position: absolute;
        top: 0;
        right: 0;
        z-index: 5;
        width: 15px;
        height: 15px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 0 4px 0 4px;
        background: rgba(10, 14, 22, 0.75);
        color: #9ec4ff;
        font-size: 9px;
        line-height: 1;
        cursor: pointer;
        padding: 0;
        opacity: 0;
        transition: opacity 0.1s;
    }
    .${TILE_CLASS}:hover .${PIN_CLASS} { opacity: 1; }
    .${PIN_CLASS}:hover { color: #fff; background: rgba(77, 151, 255, 0.9); }
    .${PINNED_CLASS} .${PIN_CLASS} { opacity: 1; color: #ffcf5c; }
    .${PINNED_CLASS} { outline: 1px solid rgba(255, 207, 92, 0.55); outline-offset: -1px; border-radius: 4px; }
    .${TILE_CLASS} { position: relative; }
`;

class AlchemyItemPins {
    constructor() {
        this.isInitialized = false;
        this.pins = {};
        this.unregister = null;
        this.applying = false;
        this.styleEl = null;
        this.menuObserver = null;
        this.watchedMenu = null;
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('alchemyItemPins')) return;
        this.isInitialized = true;

        this.pins = (await storage.getJSON(STORAGE_KEY, 'settings', {})) || {};

        this.styleEl = document.createElement('style');
        this.styleEl.id = STYLE_ID;
        this.styleEl.textContent = CSS;
        document.head.appendChild(this.styleEl);

        this.unregister = domObserver.onClass('AlchemyItemPins', 'ItemSelector_menu', () => this.apply());
        this.apply();
    }

    disable() {
        this.unregister?.();
        this.unregister = null;
        this.menuObserver?.disconnect();
        this.menuObserver = null;
        this.watchedMenu = null;
        this.styleEl?.remove();
        this.styleEl = null;
        document.querySelectorAll(`.${PIN_CLASS}`).forEach((el) => el.remove());
        document.querySelectorAll(`.${PINNED_CLASS}`).forEach((el) => el.classList.remove(PINNED_CLASS));
        document.querySelectorAll(`.${TILE_CLASS}`).forEach((el) => el.classList.remove(TILE_CLASS));
        this.isInitialized = false;
    }

    /**
     * Watch the open menu's contents.
     *
     * Typing in the filter box replaces the tiles inside the menu without
     * replacing the menu itself, so a watcher that only sees the menu appear
     * decorates it once and then never again — the pins vanish on the first
     * keystroke and never come back.
     *
     * @param {HTMLElement} menu - The open menu
     */
    watchMenu(menu) {
        if (this.watchedMenu === menu && this.menuObserver) return;

        this.menuObserver?.disconnect();
        this.watchedMenu = menu;
        // Children only. Decoration writes classes and titles, and reacting to
        // those would be reacting to itself.
        this.menuObserver = new MutationObserver(() => this.apply());
        this.menuObserver.observe(menu, { childList: true, subtree: true });
    }

    /** Put the pins for the open action at the front of the open menu */
    apply() {
        if (this.applying) return;

        const menu = findAlchemizeMenu();
        if (!menu) {
            this.menuObserver?.disconnect();
            this.menuObserver = null;
            this.watchedMenu = null;
            return;
        }
        this.watchMenu(menu);

        const action = activeAlchemyAction();
        if (!action) return;

        const { grid, tiles } = menuTiles(menu);
        if (!grid || !tiles.length) return;

        const pinned = this.pins[action] || [];
        const desired = orderTiles(tiles, pinned, tileItemHrid);

        this.applying = true;
        try {
            for (const tile of tiles) this.decorateTile(tile, action, pinned);
            if (sameOrder(tiles, desired)) return;

            // Anchored on the first tile so anything else sharing the grid —
            // the Remove button sits ahead of them — keeps its place
            const marker = document.createComment('mwi-pins');
            grid.insertBefore(marker, tiles[0]);
            const fragment = document.createDocumentFragment();
            for (const tile of desired) fragment.appendChild(tile);
            grid.insertBefore(fragment, marker);
            marker.remove();
        } finally {
            this.applying = false;
        }
    }

    /**
     * Give a tile its pin button and mark it if pinned.
     * @param {HTMLElement} tile - Item tile
     * @param {string} action - Alchemy action the menu is open for
     * @param {string[]} pinned - Pinned hrids for that action
     */
    decorateTile(tile, action, pinned) {
        const itemHrid = tileItemHrid(tile);
        if (!itemHrid) return;

        const isPinned = pinned.includes(itemHrid);
        // The pin hangs off whichever element the grid can actually move, which
        // is a wrapper around the tile rather than the tile itself — so the
        // hover rule is keyed to a class of ours rather than the game's
        tile.classList.add(TILE_CLASS);
        tile.classList.toggle(PINNED_CLASS, isPinned);

        let button = tile.querySelector(`.${PIN_CLASS}`);
        if (!button) {
            button = document.createElement('button');
            button.className = PIN_CLASS;
            button.type = 'button';
            // Capture phase and both handlers: the tile itself selects the item
            // on click, and a pin that also picked the item would be unusable
            button.addEventListener('mousedown', (event) => event.stopPropagation());
            button.addEventListener(
                'click',
                (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.toggle(tile);
                },
                true
            );
            tile.appendChild(button);
        }
        // Written only when it would actually change. Assigning the same text
        // still replaces the node, which the menu watcher would see as the menu
        // changing, which would decorate again — forever.
        if (button.textContent !== '📌') button.textContent = '📌';
        const title = isPinned ? `Unpin from ${action}` : `Pin to the front of ${action}`;
        if (button.title !== title) button.title = title;
        if (button.dataset.mwiPinAction !== action) button.dataset.mwiPinAction = action;
    }

    /**
     * Pin or unpin the item a tile stands for.
     * @param {HTMLElement} tile - Item tile
     */
    toggle(tile) {
        const itemHrid = tileItemHrid(tile);
        const action = tile.querySelector(`.${PIN_CLASS}`)?.dataset.mwiPinAction || activeAlchemyAction();
        if (!itemHrid || !action) return;

        this.pins = togglePin(this.pins, action, itemHrid);
        this.apply();
        storage.setJSON(STORAGE_KEY, this.pins, 'settings').catch((error) => {
            console.error('[AlchemyItemPins] Saving pins failed:', error);
        });
    }
}

const alchemyItemPins = new AlchemyItemPins();
export default alchemyItemPins;
