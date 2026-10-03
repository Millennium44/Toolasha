/**
 * Scroll chips
 *
 * A compact row of toggles in the action panel's profit section, one per scroll that
 * applies to the panel's action type. A chip edits the same selection the resolver
 * reads for that action type (the active loadout's list, else the default), so what
 * the chip shows, what the Loadouts popup shows and what the figures are computed
 * from are one piece of state.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { scrollSimulator } from '../../utils/bundle-bridge.js';
import bundledScrollSimulator from '../combat/scroll-simulator.js';
import {
    SCROLL_BUFF_ITEMS,
    SCROLL_BUFF_LABELS,
    SCROLL_BUFF_ORDER,
    SELECTION_CHANGED_EVENT,
} from '../../utils/scroll-buff-values.js';

export const SCROLL_CHIPS_CLASS = 'mwi-scroll-chips';

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

function simulator() {
    return scrollSimulator() || bundledScrollSimulator;
}

function chipTitle(buffTypeHrid, isOn, selection) {
    const label = SCROLL_BUFF_LABELS[buffTypeHrid] ?? buffTypeHrid;
    const target = selection.scope === 'loadout' ? `this loadout (${selection.loadoutName})` : 'the default selection';
    return `${label}. ${isOn ? 'Simulated' : 'Not simulated'} - click to ${isOn ? 'remove it from' : 'add it to'} ${target}.`;
}

function paintChip(chip, isOn, selection) {
    chip.dataset.on = isOn ? 'true' : 'false';
    chip.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    chip.title = chipTitle(chip.dataset.buff, isOn, selection);
    chip.style.opacity = isOn ? '1' : '0.45';
    chip.style.borderColor = isOn ? config.COLOR_ACCENT : 'rgba(255,255,255,0.25)';
    chip.style.background = isOn ? 'rgba(255,255,255,0.1)' : 'transparent';
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
 * Redraw a profit section that drew no chip row (the simulation was off, or no scroll applies) when
 * the scroll selection or the simulation switch changes, so turning simulation on brings the chips
 * into an already-open panel. Held weakly, like the chip rows. One redraw per burst.
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
 * @param {() => (void|Promise<void>)} options.onChange - Redraws the panel after a toggle was saved
 * @param {string} [options.spriteUrl] - items sprite url, when known
 * @returns {{element: HTMLElement, dispose: () => void}|null} null when nothing should be shown
 */
export function buildScrollChips({ actionTypeHrid, onChange, spriteUrl = '' }) {
    if (!config.getSetting('simulateScrollEffects')) return null;
    const buffs = getApplicableScrollBuffs(actionTypeHrid);
    if (buffs.length === 0) return null;

    const sim = simulator();
    const selection = sim.resolveSelection(actionTypeHrid);

    const row = document.createElement('div');
    row.className = SCROLL_CHIPS_CLASS;
    row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-bottom:8px;font-size:0.85em;';

    const heading = document.createElement('span');
    heading.textContent = 'Simulate:';
    heading.style.cssText = 'color:#888;margin-right:2px;';
    row.appendChild(heading);

    for (const buffTypeHrid of buffs) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.dataset.buff = buffTypeHrid;
        chip.style.cssText =
            'display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border:1px solid;border-radius:10px;' +
            'color:inherit;font:inherit;cursor:pointer;line-height:1.4;';
        const itemSuffix = SCROLL_BUFF_ITEMS[buffTypeHrid];
        if (spriteUrl && itemSuffix) {
            chip.innerHTML = `<svg width="14" height="14"><use href="${spriteUrl}#${itemSuffix}"></use></svg>`;
        }
        const name = (SCROLL_BUFF_LABELS[buffTypeHrid] ?? buffTypeHrid)
            .replace(/^Scroll of /, '')
            .replace(/ \(.*\)$/, '');
        chip.appendChild(document.createTextNode(name));
        paintChip(chip, selection.set.has(buffTypeHrid), selection);
        row.appendChild(chip);
    }

    let busy = false;
    // A change made somewhere else (the Loadouts or defaults popup) redraws this panel too, so its
    // totals and chips never sit on the old selection. One redraw per burst; a chip's own save is
    // skipped here because the click redraws after it.
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

    // One delegated listener on the row, which goes away with the row
    const onClick = async (event) => {
        const chip = event.target?.closest?.('button[data-buff]');
        if (!chip || busy) return;
        busy = true;
        try {
            // Resolve again at click time: the loadout can have changed since the draw
            const current = sim.resolveSelection(actionTypeHrid);
            const next = new Set(current.set);
            if (next.has(chip.dataset.buff)) next.delete(chip.dataset.buff);
            else next.add(chip.dataset.buff);
            const saved = await sim.saveScrollsForLoadout(current.loadoutName, [...next]);
            if (saved) await onChange();
        } catch (error) {
            console.error('[ScrollChips] Toggle failed:', error);
        } finally {
            busy = false;
        }
    };
    row.addEventListener('click', onClick);

    return {
        element: row,
        dispose: () => {
            row.removeEventListener('click', onClick);
            stopWatching();
        },
    };
}
