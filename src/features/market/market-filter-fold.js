/**
 * Phone fold for the Market Listings filter rows.
 *
 * Two features each add a row under the game's Item Filter box: the sort row
 * (`market-sort.js`) and the Level / Class / Slot row (`market-filter.js`). On a phone
 * together they push the item grid hundreds of pixels down, so at the phone breakpoint
 * both collapse behind one small "Filters" toggle that sits beside the Item Filter input.
 *
 * Nothing is moved. The toggle is appended to the game's filter container and an attribute
 * on that same container drives a CSS rule (inside the phone media query, see
 * `market-mobile-layout.js`) that hides the two rows by id. Widening the window shows them
 * again without any script, and the toggle itself is `display: none` above the breakpoint.
 *
 * The rule that hides the rows also requires the toggle to be a child of the container
 * (`:has(> toggle)`), so a toggle the game re-render dropped can never leave the rows hidden
 * with no way to open them.
 *
 * A hidden filter must not be forgotten: the toggle reads the rows' selects and shows a bullet
 * whenever any is off its default (the first option of each).
 *
 * Both features call `syncMarketFold()` after they inject (including when their own guard finds
 * the row already present) and after they remove their row on disable. Calling it is idempotent.
 * The open/closed state lives in this module, so it survives the panel being redrawn; a fresh
 * page starts collapsed. A resize across the breakpoint is picked up on the next panel redraw
 * or `syncMarketFold()` call; the CSS alone already handles widening.
 */

import { MARKET_MOBILE_QUERY, ensureMarketMobileStyles, releaseMarketMobileStyles } from './market-mobile-layout.js';

export const FOLD_TOGGLE_ID = 'mwi-market-filters-toggle';
export const FOLD_ATTR = 'data-mwi-market-fold';

const CONTAINER_SELECTOR = 'div[class*="MarketplacePanel_itemFilterContainer"]';
const ROW_IDS = ['toolasha-market-sort', 'toolasha-market-filters'];

/** Whether the rows are shown. Kept here so a redraw of the panel does not reset it. */
let expanded = false;
/** The node the delegated `change` listener (capture phase, so it hears every select below) sits on. */
let changeHost = null;

/** @returns {boolean} True when the viewport is at phone width (false when matchMedia is missing) */
function isPhone() {
    return Boolean(window.matchMedia?.(MARKET_MOBILE_QUERY)?.matches);
}

/**
 * The fold's rows that currently sit beside a filter container.
 * @param {Element} container - The game's filter container
 * @returns {Element[]} The sort row and/or the Level/Class/Slot row
 */
function rowsBeside(container) {
    const parent = container.parentElement;
    if (!parent) return [];
    return Array.from(parent.children).filter((el) => ROW_IDS.includes(el.id));
}

/**
 * Whether any control in the rows is off its default (first option), i.e. hiding or reordering items.
 * @param {Element[]} rows - The rows to read
 * @returns {boolean} True when a sort mode or filter is active
 */
function anyActive(rows) {
    for (const row of rows) {
        for (const select of row.querySelectorAll('select')) {
            const first = select.options?.[0]?.value;
            if (first !== undefined && select.value !== first) return true;
        }
    }
    return false;
}

/** @param {Element} container - The filter container whose toggle to find */
function toggleOf(container) {
    return Array.from(container.children).find((el) => el.id === FOLD_TOGGLE_ID) || null;
}

/** Write the label, aria state and attribute from the current state. */
function paint(container, toggle) {
    const active = anyActive(rowsBeside(container));
    toggle.textContent = `Filters${active ? ' •' : ''} ${expanded ? '▴' : '▾'}`;
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.title = active ? 'Filters or sorting are active. Tap to show or hide the controls.' : 'Show or hide filters';
    if (active) toggle.setAttribute('data-active', '');
    else toggle.removeAttribute('data-active');
    const want = expanded ? 'open' : 'closed';
    if (container.getAttribute(FOLD_ATTR) !== want) container.setAttribute(FOLD_ATTR, want);
}

function onChange() {
    const container = document.querySelector(CONTAINER_SELECTOR);
    const toggle = container ? toggleOf(container) : null;
    if (container && toggle) paint(container, toggle);
}

function detachChange() {
    if (changeHost) changeHost.removeEventListener('change', onChange, true);
    changeHost = null;
}

/**
 * Build, refresh or remove the toggle to match the page: present only at phone width and while at
 * least one of the two rows exists beside the filter container.
 * @param {Element} [container] - The filter container; found in the document when omitted
 */
export function syncMarketFold(container = document.querySelector(CONTAINER_SELECTOR)) {
    const rows = container ? rowsBeside(container) : [];
    if (!container || !rows.length || !isPhone()) {
        removeMarketFold();
        return;
    }

    ensureMarketMobileStyles();

    // A toggle left in a container the game has since replaced is of no use to anyone
    for (const stray of document.querySelectorAll(`#${FOLD_TOGGLE_ID}`)) {
        if (stray.parentElement !== container) stray.remove();
    }

    let toggle = toggleOf(container);
    if (!toggle) {
        toggle = document.createElement('button');
        toggle.id = FOLD_TOGGLE_ID;
        toggle.type = 'button';
        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            expanded = !expanded;
            paint(container, toggle);
        });
        container.appendChild(toggle);
    }
    paint(container, toggle);

    const host = container.parentElement;
    if (changeHost !== host) {
        detachChange();
        host.addEventListener('change', onChange, true);
        changeHost = host;
    }
}

/**
 * Take the toggle, its attribute and its listener away and give the shared rules back.
 * The rows themselves are never touched, so they are simply visible again.
 */
export function removeMarketFold() {
    detachChange();
    document.querySelectorAll(`#${FOLD_TOGGLE_ID}`).forEach((el) => el.remove());
    document.querySelectorAll(`[${FOLD_ATTR}]`).forEach((el) => el.removeAttribute(FOLD_ATTR));
    releaseMarketMobileStyles();
}

/** Test hook: forget the in-memory open state, as a fresh page would. */
export function resetMarketFoldState() {
    expanded = false;
}
