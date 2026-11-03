/**
 * Scroll chips
 *
 * A compact row of toggles in the action panel, one per scroll that applies to the panel's
 * action type (placed by `scroll-chips-panel.js`). A chip edits the same selection the resolver
 * reads for that action type (the active loadout's list, else the default), so what the chip
 * shows, what the Loadouts popup shows and what the figures are computed from are one piece of
 * state.
 *
 * Each chip also shows how many of that scroll the character owns, and a Plan control that
 * opens the Scroll Planner with that scroll selected. The chip and the planner name the same
 * item: a chip's `seal_of_*` sprite is the item `/items/seal_of_*`, which is what the planner
 * lists (the game's "Scroll of ..." items, formerly Seals). Plan only opens the planner's window;
 * it never opens a scroll, and the player still presses Open themselves.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { scrollPlannerInstance, scrollSimulator } from '../../utils/bundle-bridge.js';
import { formatWithSeparator } from '../../utils/formatters.js';
import bundledScrollSimulator from '../combat/scroll-simulator.js';
import { getOwnedCount } from '../inventory/scroll-planner/scroll-planner-logic.js';
import {
    SCROLL_BUFF_ITEMS,
    SCROLL_BUFF_LABELS,
    SCROLL_BUFF_ORDER,
    SELECTION_CHANGED_EVENT,
} from '../../utils/scroll-buff-values.js';

export const SCROLL_CHIPS_CLASS = 'mwi-scroll-chips';

/** How long after the planner's setting changes its module has certainly started or stopped */
const PLANNER_SETTLE_MS = 300;

/**
 * The action types whose panel figures take part in the simulation: the profit display and the
 * speed and XP figures arm it for the gathering and production skills. A chip anywhere else would
 * change nothing on screen.
 */
export const SIMULATED_ACTION_TYPES = [
    '/action_types/foraging',
    '/action_types/woodcutting',
    '/action_types/milking',
    '/action_types/brewing',
    '/action_types/cooking',
    '/action_types/cheesesmithing',
    '/action_types/crafting',
    '/action_types/tailoring',
];

/**
 * Scroll buff types usable in an action type, in display order.
 * Read from the game's personal buff table; with no table, nothing is offered.
 * @param {string} actionTypeHrid
 * @returns {string[]} Buff type hrids
 */
export function getApplicableScrollBuffs(actionTypeHrid) {
    const details = dataManager.getInitClientData()?.personalBuffTypeDetailMap;
    if (!details || !actionTypeHrid) return [];
    const applicable = new Set();
    for (const detail of Object.values(details)) {
        const typeHrid = detail?.buff?.typeHrid;
        if (typeHrid && detail.usableInActionTypeMap?.[actionTypeHrid]) applicable.add(typeHrid);
    }
    return SCROLL_BUFF_ORDER.filter((hrid) => applicable.has(hrid));
}

/**
 * A scroll's short name ("Efficiency"), the way a chip shows it.
 * @param {string} buffTypeHrid
 * @returns {string}
 */
export function shortScrollName(buffTypeHrid) {
    return (SCROLL_BUFF_LABELS[buffTypeHrid] ?? buffTypeHrid).replace(/^Scroll of /, '').replace(/ \(.*\)$/, '');
}

/**
 * The scrolls a figure drawn for this action type is simulating right now: armed, and better than
 * what is really active. Meant to be called while the simulation is armed (during a calculation).
 * @param {string} actionTypeHrid
 * @returns {string[]} Short names, in chip order
 */
export function getSimulatedScrollNames(actionTypeHrid) {
    return SCROLL_BUFF_ORDER.filter((hrid) => dataManager.isBuffBeingSimulated?.(actionTypeHrid, hrid)).map(
        shortScrollName
    );
}

/**
 * The inventory item a scroll buff comes from.
 * @param {string} buffTypeHrid
 * @returns {string|null} e.g. `/items/seal_of_gourmet`
 */
export function scrollItemHrid(buffTypeHrid) {
    const suffix = SCROLL_BUFF_ITEMS[buffTypeHrid];
    return suffix ? `/items/${suffix}` : null;
}

/**
 * How many of an item the character owns, the way the Scroll Planner counts them.
 * @param {string|null} itemHrid
 * @returns {number|null} null while the inventory is not loaded (which is not the same as owning none)
 */
export function getOwnedScrolls(itemHrid) {
    const items = dataManager.characterItems;
    if (!itemHrid || !Array.isArray(items)) return null;
    return getOwnedCount(items, itemHrid);
}

/** The items sprite's url, from any item icon already on the page ('' when there is none) */
function itemsSpriteUrl() {
    const el = document.querySelector('use[href*="items_sprite"]');
    return el ? el.getAttribute('href').split('#')[0] : '';
}

/**
 * The Scroll Planner, when it is running. It is another bundle's object and its module exists
 * whether or not its setting is on, so both the setting and the planner itself are asked.
 * @returns {Object|null}
 */
function runningPlanner() {
    if (!config.getSetting('scrollPlanner')) return null;
    const planner = scrollPlannerInstance();
    return planner && typeof planner.openWithSelection === 'function' && planner.isRunning?.() ? planner : null;
}

function simulator() {
    return scrollSimulator() || bundledScrollSimulator;
}

function chipTitle(buffTypeHrid, isOn, selection, owned) {
    const label = SCROLL_BUFF_LABELS[buffTypeHrid] ?? buffTypeHrid;
    const target = selection.scope === 'loadout' ? `this loadout (${selection.loadoutName})` : 'the default selection';
    const ownedText = owned === null ? 'Owned: not loaded yet.' : `Owned: ${formatWithSeparator(owned)}.`;
    return (
        `${label}. ${ownedText} ${isOn ? 'Simulated' : 'Not simulated'}: this only changes Toolasha's ` +
        `figures (speed, XP, profit). The scroll is not activated, and the game's own Duration and Outputs do not ` +
        `change. Click to ${isOn ? 'remove it from' : 'add it to'} ${target}.`
    );
}

function paintChip(chip, isOn, selection, owned) {
    chip.dataset.on = isOn ? 'true' : 'false';
    chip.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    chip.title = chipTitle(chip.dataset.buff, isOn, selection, owned);
    chip.style.opacity = isOn ? '1' : '0.55';
    chip.style.borderColor = isOn ? config.COLOR_ACCENT : 'rgba(255,255,255,0.25)';
    // Dashed when on: a what-if, not a scroll that is really running
    chip.style.borderStyle = isOn ? 'dashed' : 'solid';
    chip.style.background = isOn ? 'rgba(255,255,255,0.1)' : 'transparent';
}

/**
 * Show one scroll's chip state, owned count and Plan control. The count is empty while the
 * inventory is not loaded and 0 once it is and none is owned. With none owned there is nothing to
 * plan, so Plan is disabled; with the planner not running it is hidden.
 * @param {HTMLElement} group - One scroll's chip and Plan control
 * @param {{set: Set<string>, scope: string, loadoutName: string|null}} selection - The resolved selection
 */
function paintGroup(group, selection) {
    const chip = group.querySelector('button[data-buff]');
    const countEl = group.querySelector('.mwi-scroll-chip-owned');
    const plan = group.querySelector('button[data-plan]');
    const owned = getOwnedScrolls(group.dataset.item);
    const text = owned === null ? '' : `×${formatWithSeparator(owned)}`;
    if (countEl.textContent !== text) countEl.textContent = text;
    paintChip(chip, selection.set.has(chip.dataset.buff), selection, owned);
    if (!plan) return;
    plan.style.display = runningPlanner() ? 'inline-flex' : 'none';
    const none = owned === 0;
    plan.disabled = none;
    plan.style.opacity = none ? '0.4' : '1';
    plan.title = none
        ? 'You own none of this scroll, so there is nothing to plan.'
        : 'Open the Scroll Planner with this scroll selected. Nothing is opened until you press Open yourself.';
}

/**
 * Rows that redraw on a selection change, held weakly: the game removes an action panel without
 * telling anyone, and a strong reference from `document` would keep every closed panel (and its
 * redraw closure) alive. One shared listener walks the live rows; a collected row drops out.
 */
const liveRows = new Set();
const rowRedraws = new WeakMap();
let sharedListenerInstalled = false;

function onAnySelectionChanged() {
    for (const ref of [...liveRows]) {
        const row = ref.deref();
        if (!row) {
            liveRows.delete(ref);
            continue;
        }
        if (row.isConnected) rowRedraws.get(row)?.();
    }
}

/**
 * Have `row` call `redraw` when the scroll selection changes. Returns the undo.
 * @param {HTMLElement} row - The chip row
 * @param {() => void} redraw - Queues the panel's redraw
 * @returns {() => void} Stop listening
 */
function watchSelection(row, redraw) {
    if (!sharedListenerInstalled) {
        document.addEventListener(SELECTION_CHANGED_EVENT, onAnySelectionChanged);
        sharedListenerInstalled = true;
    }
    const ref = new WeakRef(row);
    liveRows.add(ref);
    rowRedraws.set(row, redraw);
    return () => {
        liveRows.delete(ref);
        rowRedraws.delete(row);
    };
}

/**
 * Rows whose owned counts (and Plan control) follow the inventory and the planner, held weakly
 * like the selection watchers: one `items_updated` listener on the data manager and one
 * `scrollPlanner` setting listener while any row is live, none otherwise.
 */
const ownedRows = new Set();
const ownedRefreshers = new WeakMap();
let itemsListener = null;
let plannerSettingUndo = null;
let plannerSettleTimer = null;

function stopItemsListener() {
    if (itemsListener) {
        dataManager.off?.('items_updated', itemsListener);
        itemsListener = null;
    }
    plannerSettingUndo?.();
    plannerSettingUndo = null;
    if (plannerSettleTimer !== null) {
        clearTimeout(plannerSettleTimer);
        plannerSettleTimer = null;
    }
}

/**
 * The planner's setting changed. The planner itself starts or stops a moment later (the registry
 * does it after the change), so the Plan controls are repainted now and once more after that.
 */
function onPlannerSettingChanged() {
    onItemsChanged();
    if (plannerSettleTimer !== null) clearTimeout(plannerSettleTimer);
    plannerSettleTimer = setTimeout(() => {
        plannerSettleTimer = null;
        onItemsChanged();
    }, PLANNER_SETTLE_MS);
}

function onItemsChanged() {
    for (const ref of [...ownedRows]) {
        const row = ref.deref();
        if (!row || !row.isConnected) {
            ownedRows.delete(ref);
            continue;
        }
        ownedRefreshers.get(row)?.();
    }
    if (ownedRows.size === 0) stopItemsListener();
}

/**
 * Have `row` refresh its owned counts when the inventory changes. Returns the undo.
 * @param {HTMLElement} row
 * @param {() => void} refresh
 * @returns {() => void}
 */
function watchOwned(row, refresh) {
    if (!itemsListener) {
        itemsListener = onItemsChanged;
        dataManager.on?.('items_updated', itemsListener);
        plannerSettingUndo = config.onSettingChange?.('scrollPlanner', onPlannerSettingChanged) ?? null;
    }
    const ref = new WeakRef(row);
    ownedRows.add(ref);
    ownedRefreshers.set(row, refresh);
    return () => {
        ownedRows.delete(ref);
        ownedRefreshers.delete(row);
        if (ownedRows.size === 0) stopItemsListener();
    };
}

/**
 * Redraw a profit section when the scroll selection or the simulation switch changes, so the
 * figures follow the chips (which live outside the section). Held weakly, like the chip rows.
 * One redraw per burst.
 * @param {HTMLElement} element - The profit section's content
 * @param {() => (void|Promise<void>)} redraw - Re-runs the panel's display
 * @returns {() => void} Stop watching
 */
export function watchForScrollChanges(element, redraw) {
    let queued = false;
    return watchSelection(element, () => {
        if (queued) return;
        queued = true;
        queueMicrotask(async () => {
            queued = false;
            if (!element.isConnected) return;
            try {
                await redraw();
            } catch (error) {
                console.error('[ScrollChips] Redraw after a scroll change failed:', error);
            }
        });
    });
}

/**
 * Build the chip row for an action type.
 * @param {Object} options
 * @param {string} options.actionTypeHrid - The panel's action type
 * @param {() => (void|Promise<void>)} options.onChange - Redraws the row after a toggle was saved or the
 *   selection was changed somewhere else
 * @param {string} [options.spriteUrl] - items sprite url; read from the page when omitted
 * @returns {{element: HTMLElement, dispose: () => void}|null} null when nothing should be shown
 */
export function buildScrollChips({ actionTypeHrid, onChange, spriteUrl = itemsSpriteUrl() }) {
    if (!config.getSetting('simulateScrollEffects')) return null;
    const buffs = getApplicableScrollBuffs(actionTypeHrid);
    if (buffs.length === 0) return null;

    const sim = simulator();
    const selection = sim.resolveSelection(actionTypeHrid);

    const row = document.createElement('div');
    row.className = SCROLL_CHIPS_CLASS;
    row.dataset.actionType = actionTypeHrid;
    // Wraps: on a phone the groups fall onto further lines, each chip kept with its Plan control
    row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;margin:6px 0;font-size:0.85em;';

    const heading = document.createElement('span');
    heading.textContent = 'Simulate scrolls (not active):';
    heading.style.cssText = 'color:#888;margin-right:2px;';
    row.appendChild(heading);

    const buttonBase =
        'display:inline-flex;align-items:center;gap:3px;padding:2px 8px;min-height:28px;box-sizing:border-box;' +
        'border:1px solid;border-radius:10px;color:inherit;font:inherit;cursor:pointer;line-height:1.4;';
    const groups = [];
    for (const buffTypeHrid of buffs) {
        const itemHrid = scrollItemHrid(buffTypeHrid);
        const group = document.createElement('span');
        group.className = 'mwi-scroll-chip-group';
        group.dataset.item = itemHrid ?? '';
        group.style.cssText = 'display:inline-flex;align-items:center;gap:2px;white-space:nowrap;';

        const chip = document.createElement('button');
        chip.type = 'button';
        chip.dataset.buff = buffTypeHrid;
        chip.style.cssText = buttonBase;
        const itemSuffix = SCROLL_BUFF_ITEMS[buffTypeHrid];
        if (spriteUrl && itemSuffix) {
            chip.innerHTML = `<svg width="14" height="14"><use href="${spriteUrl}#${itemSuffix}"></use></svg>`;
        }
        chip.appendChild(document.createTextNode(shortScrollName(buffTypeHrid)));
        const ownedEl = document.createElement('span');
        ownedEl.className = 'mwi-scroll-chip-owned';
        ownedEl.style.cssText = 'color:#aaa;';
        chip.appendChild(ownedEl);
        group.appendChild(chip);

        if (itemHrid) {
            const plan = document.createElement('button');
            plan.type = 'button';
            plan.dataset.plan = itemHrid;
            plan.textContent = 'Plan';
            plan.style.cssText = `${buttonBase}border-color:rgba(255,255,255,0.25);background:transparent;`;
            group.appendChild(plan);
        }
        paintGroup(group, selection);
        row.appendChild(group);
        groups.push(group);
    }

    const refreshGroups = () => {
        const current = sim.resolveSelection(actionTypeHrid);
        for (const group of groups) paintGroup(group, current);
    };
    const stopOwned = watchOwned(row, refreshGroups);

    let busy = false;
    // A change made somewhere else (the Loadouts or defaults popup) redraws this row too, so its
    // chips never sit on the old selection. One redraw per burst; a chip's own save is skipped
    // here because the click redraws after it.
    let redrawQueued = false;
    const onSelectionChanged = () => {
        if (busy || redrawQueued || !row.isConnected) return;
        redrawQueued = true;
        queueMicrotask(async () => {
            redrawQueued = false;
            if (!row.isConnected) return;
            try {
                await onChange();
            } catch (error) {
                console.error('[ScrollChips] Redraw after a selection change failed:', error);
            }
        });
    };
    const stopWatching = watchSelection(row, onSelectionChanged);

    // Plan opens the planner's window and nothing else: no toggle, no save, no spend
    const openPlanner = (planButton) => {
        const itemHrid = planButton.dataset.plan;
        let opened = false;
        const planner = runningPlanner();
        if (planner && getOwnedScrolls(itemHrid) !== 0) {
            try {
                opened = planner.openWithSelection([itemHrid]) === true;
            } catch (error) {
                console.error('[ScrollChips] Opening the Scroll Planner failed:', error);
            }
        }
        // The planner went away (or has no row for this scroll) since the last paint
        if (!opened) refreshGroups();
    };

    // One delegated listener on the row, which goes away with the row
    const onClick = async (event) => {
        const planButton = event.target?.closest?.('button[data-plan]');
        if (planButton) {
            openPlanner(planButton);
            return;
        }
        const chip = event.target?.closest?.('button[data-buff]');
        if (!chip) return;
        try {
            // Resolve again at click time: the loadout can have changed since the draw
            const current = sim.resolveSelection(actionTypeHrid);
            const next = new Set(current.set);
            if (next.has(chip.dataset.buff)) next.delete(chip.dataset.buff);
            else next.add(chip.dataset.buff);
            // Memory changes and the figures redraw before the save's first await, while the write itself can
            // take seconds: `busy` covers only that part, so the chip follows at once and another press counts
            busy = true;
            const saving = sim.saveScrollsForLoadout(current.loadoutName, [...next]);
            busy = false;
            refreshGroups();
            if (await saving) await onChange();
        } catch (error) {
            busy = false;
            console.error('[ScrollChips] Toggle failed:', error);
        }
    };
    row.addEventListener('click', onClick);

    return {
        element: row,
        dispose: () => {
            row.removeEventListener('click', onClick);
            stopWatching();
            stopOwned();
        },
    };
}
