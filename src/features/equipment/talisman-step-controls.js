/**
 * Talisman window controls for the reroll advisor's highlight and its "Do next step" button.
 *
 * Every control is found through the game's React tree, never by translated text:
 *  - the window's component is the fiber above the window element that carries the `talisman` prop; its instance
 *    holds the window's own handlers (handleReroll, handleUseNewRoll, handleKeepCurrent, handleUnlock,
 *    handleOrbSelected, handleFocusToggled) and helpers (getOrbItem, getInventoryCount);
 *  - a game button is the element whose React `onClick` is one of those handlers (identity, not name);
 *  - the orb picker is the element whose `selectItemHandler` is the window's handleOrbSelected;
 *  - a line's lock button sits in the TalismanModal_lockAction span of the row the game keys by modifier hrid.
 *
 * Choosing an orb (and focus picks) is the window's client state, so it goes through the window's own handlers.
 * Anything that reaches the server (reroll, use or keep a roll, lock, unlock) is one press of the host <button>:
 * its own React onClick with a full synthetic click (pressGameButton), falling back to
 * clickThroughReact(button, { reactFirst: true }) only when the host has no onClick. One press, one action.
 */

import { clickThroughReact, fiberFor } from '../../utils/react-click.js';
import { REROLL_MODES } from '../../utils/talisman-reroll-solver.js';

const ROW_CLASS = 'TalismanModal_modifierRow';
const LOCK_ACTION_SELECTOR = '[class*="TalismanModal_lockAction"] button';
export const MARK_CLASS = 'toolasha-advised-step';
const MARK_STYLE = '2px solid #f5c542';

/**
 * The window component above a talisman window element.
 * @param {Element} modal
 * @returns {{fiber: Object|null, talisman: Object|null, instance: Object|null}}
 */
export function findWindowComponent(modal) {
    const own = fiberFor(modal);
    let fiber = own;
    for (let hops = 0; fiber && hops < 12; hops++, fiber = fiber.return) {
        const talisman = fiber.memoizedProps?.talisman;
        if (talisman && typeof talisman === 'object' && talisman.id !== undefined) {
            const node = fiber.stateNode;
            const instance = node && typeof node.handleReroll === 'function' ? node : null;
            return { fiber: own, talisman, instance };
        }
    }
    return { fiber: own, talisman: null, instance: null };
}

function hostElement(fiber) {
    const stack = [fiber];
    let guard = 0;
    while (stack.length && guard++ < 200) {
        const current = stack.pop();
        if (!current) continue;
        if (current.stateNode && current.stateNode.nodeType === 1) return current.stateNode;
        if (current.sibling && current !== fiber) stack.push(current.sibling);
        if (current.child) stack.push(current.child);
    }
    return null;
}

function rowKey(fiber) {
    let current = fiber;
    for (let hops = 0; current && hops < 4; hops++, current = current.return) {
        if (current.key !== null && current.key !== undefined) return String(current.key);
    }
    return null;
}

/**
 * The window's controls, found once per call through its React tree.
 * @param {Element} modal
 * @param {Object} instance - The window component instance
 * @returns {{reroll, useNew, keep, unlock, picker, lockButtons: Map<string, Element>}}
 */
export function scanControls(modal, instance) {
    const found = { reroll: null, useNew: null, keep: null, unlock: null, picker: null, lockButtons: new Map() };
    const root = fiberFor(modal);
    if (!root || !instance) return found;
    const byHandler = new Map([
        [instance.handleReroll, 'reroll'],
        [instance.handleUseNewRoll, 'useNew'],
        [instance.handleKeepCurrent, 'keep'],
        [instance.handleUnlock, 'unlock'],
    ]);
    const rows = [];
    const stack = [root.child];
    let guard = 0;
    while (stack.length && guard++ < 20000) {
        const fiber = stack.pop();
        if (!fiber) continue;
        const props = fiber.memoizedProps;
        if (props && typeof props === 'object') {
            const role = typeof props.onClick === 'function' ? byHandler.get(props.onClick) : undefined;
            if (role && !found[role]) found[role] = hostElement(fiber);
            if (!found.picker && props.selectItemHandler && props.selectItemHandler === instance.handleOrbSelected) {
                found.picker = hostElement(fiber);
            }
        }
        const node = fiber.stateNode;
        if (node && node.nodeType === 1 && typeof node.className === 'string' && node.className.includes(ROW_CLASS)) {
            const key = rowKey(fiber);
            if (key) rows.push([key, node]);
        }
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
    }
    for (const [hrid, row] of rows) {
        const button = row.querySelector(LOCK_ACTION_SELECTOR);
        if (button && button !== found.unlock && !found.unlock?.contains(button) && !button.contains(found.unlock)) {
            found.lockButtons.set(hrid, button);
        }
    }
    return found;
}

/** Whether a game button is disabled right now */
export function isDisabled(element) {
    if (!element) return true;
    const button = element.tagName === 'BUTTON' ? element : element.querySelector?.('button') || element;
    return (
        button.disabled === true ||
        button.getAttribute?.('aria-disabled') === 'true' ||
        (typeof button.className === 'string' && button.className.includes('Mui-disabled'))
    );
}

/**
 * The game control the advice points at, for the highlight.
 * @returns {Element[]}
 */
export function advisedElements(advice, controls, instance) {
    if (!advice) return [];
    if (advice.status === 'accept') return [controls.useNew].filter(Boolean);
    if (advice.status === 'discard') return [controls.keep].filter(Boolean);
    if (advice.status !== 'move') return [];
    const move = advice.move;
    const selected = instance?.state?.selectedOrbHrid || '';
    if (move.kind === 'unlock') return [controls.unlock].filter(Boolean);
    if (move.kind === 'lock') {
        const lock = controls.lockButtons.get(move.modifierHrid);
        return [selected === move.itemHrid && lock ? lock : controls.picker].filter(Boolean);
    }
    return [controls.picker, selected === move.itemHrid ? controls.reroll : null].filter(Boolean);
}

const marked = new Set();

/** Mark elements (and take every earlier mark off) */
export function markElements(elements) {
    clearMarks();
    for (const element of elements) {
        element.classList.add(MARK_CLASS);
        element.style.outline = MARK_STYLE;
        element.style.outlineOffset = '2px';
        marked.add(element);
    }
}

/** Take every mark off */
export function clearMarks() {
    for (const element of marked) {
        element.classList.remove(MARK_CLASS);
        element.style.outline = '';
        element.style.outlineOffset = '';
    }
    marked.clear();
    // Anything a lost reference left behind
    if (typeof document !== 'undefined') {
        for (const element of document.querySelectorAll(`.${MARK_CLASS}`)) {
            element.classList.remove(MARK_CLASS);
            element.style.outline = '';
            element.style.outlineOffset = '';
        }
    }
}

/** The item a move spends, or null */
export function itemFor(advice) {
    if (advice?.status !== 'move') return null;
    if (advice.move.kind === 'orb' || advice.move.kind === 'lock') return advice.move.itemHrid || null;
    return null;
}

/** How many of an item the window counts in the inventory, or null when the window cannot say */
export function inventoryCount(instance, itemHrid) {
    if (!instance || !itemHrid || typeof instance.getInventoryCount !== 'function') return null;
    try {
        return Number(instance.getInventoryCount(itemHrid)) || 0;
    } catch {
        return null;
    }
}

/** Select an orb in the window's picker (client state) */
function selectOrb(instance, itemHrid) {
    if (instance.state?.selectedOrbHrid === itemHrid) return true;
    if (typeof instance.getOrbItem !== 'function' || typeof instance.handleOrbSelected !== 'function') return false;
    const stack = instance.getOrbItem(itemHrid);
    if (!stack?.hash) return false;
    instance.handleOrbSelected(stack.hash);
    return instance.state?.selectedOrbHrid === itemHrid;
}

/** Make the window's focus picks exactly `wanted` (client state) */
function setFocusPicks(instance, wanted) {
    if (typeof instance.handleFocusToggled !== 'function') return false;
    const current = () => instance.state?.selectedFocusModifierHrids || [];
    for (const hrid of [...current()]) if (!wanted.includes(hrid)) instance.handleFocusToggled(hrid);
    for (const hrid of wanted) if (!current().includes(hrid)) instance.handleFocusToggled(hrid);
    const now = current();
    return now.length === wanted.length && wanted.every((hrid) => now.includes(hrid));
}

/** The host <button> of a control (a wrapper's own button when handed the wrapper) */
function hostButton(element) {
    if (!element || element.tagName === 'BUTTON') return element;
    return element.querySelector?.('button') || element;
}

/**
 * The React onClick the host <button> carries right now; it changes when the game re-renders the button.
 * @param {Element} element
 * @returns {Function|null}
 */
export function onClickOf(element) {
    const button = hostButton(element);
    if (!button) return null;
    const fiber = fiberFor(button);
    return fiber && fiber.stateNode === button ? fiber.memoizedProps?.onClick || null : null;
}

/**
 * Press a game button once, through clickThroughReact(button, { reactFirst: true }) on the live host <button>
 * (found in the current DOM by the caller, never cached across renders).
 * @param {Element} element
 * @param {string} step - What the press is for, for the debug line
 * @returns {'react'|'dom'|'none'}
 */
export function pressGameButton(element, step) {
    const button = hostButton(element);
    if (!button || !button.isConnected) {
        console.debug('[RerollAdvisor] press', step, null, 'none (button not in the document)');
        return 'none';
    }
    const result = clickThroughReact(button, { reactFirst: true });
    console.debug('[RerollAdvisor] press', step, button.textContent, result);
    return result;
}

function press(button, step) {
    const how = pressGameButton(button, step);
    return how === 'react' || how === 'dom';
}

/**
 * Whether the game has a confirm dialog open: a dialog (role="dialog" or aria-modal) other than the talisman window
 * itself, holding a pair of buttons. Found by structure, never by its text.
 * @param {Element} modal - The talisman window
 * @param {Element[]} [ownControls] - The window's own controls; a dialog holding one is not a confirm
 * @returns {boolean}
 */
export function confirmDialogOpen(modal, ownControls = []) {
    if (typeof document === 'undefined') return false;
    for (const dialog of document.querySelectorAll('[role="dialog"], [aria-modal="true"]')) {
        if (modal && (dialog === modal || dialog.contains(modal))) continue;
        if (dialog.closest('.toolasha-reroll-advisor')) continue;
        // The window's own sections (the pending-roll choice) hold its own buttons; a game confirm holds none of them
        if (ownControls.some((el) => el && dialog.contains(el))) continue;
        const buttons = dialog.querySelectorAll('button').length;
        if (buttons >= 2 && buttons <= 3) return true;
    }
    return false;
}

/**
 * The second half of an orb move, once the orb is selected: press Reroll if the game has enabled it.
 * @returns {{status: 'sent'|'notFound'|'notReady', label?: string, message?: string}}
 */
export function pressReroll({ modal, instance, advice, names }) {
    const itemHrid = itemFor(advice);
    // The player may change the picker while the press waits: spend only the orb (and picks) the step chose
    if (!choiceStillHolds(instance, advice)) {
        return { status: 'changed', message: 'The orb was changed; press Do next step again' };
    }
    const button = scanControls(modal, instance).reroll;
    if (!button) return { status: 'notFound', message: "Could not find the game's Reroll button." };
    if (isDisabled(button)) {
        return {
            status: 'notReady',
            message: `Selected the ${names.item(itemHrid)}; the game's Reroll button did not enable.`,
        };
    }
    return press(button, 'reroll')
        ? { status: 'sent', label: `rerolled with one ${names.item(itemHrid)}` }
        : { status: 'notFound', message: 'Could not press the game button; press the marked one yourself.' };
}

/**
 * Whether the window still holds the orb (and, for Focus, exactly the picks) the step chose.
 * @param {Object} instance - The window component instance
 * @param {Object} advice
 * @returns {boolean}
 */
export function choiceStillHolds(instance, advice) {
    const move = advice?.move;
    if (!instance || !move) return false;
    if (instance.state?.selectedOrbHrid !== move.itemHrid) return false;
    if (move.mode !== REROLL_MODES.typesOnly) return true;
    const picks = instance.state?.selectedFocusModifierHrids || [];
    const wanted = move.focusHrids || [];
    return picks.length === wanted.length && wanted.every((hrid) => picks.includes(hrid));
}

/**
 * Perform the one game action the advice names. Never more than one server action.
 * @param {Object} args - {modal, instance, advice, names}
 * @returns {{status: 'sent'|'notFound'|'notReady'|'noItem'|'nothing', label?: string, message?: string}}
 */
export function performStep({ modal, instance, advice, names }) {
    if (!instance) return { status: 'notFound', message: "Could not find the game's talisman window controls." };
    if (!advice) return { status: 'nothing' };
    const item = names.item;
    const mod = names.modifier;

    if (advice.status === 'accept' || advice.status === 'discard') {
        const which = advice.status === 'accept' ? 'useNew' : 'keep';
        const label = advice.status === 'accept' ? 'used the new roll' : 'kept the current lines';
        const button = scanControls(modal, instance)[which];
        if (!button) return { status: 'notFound', message: "Could not find the game's button for this step." };
        if (isDisabled(button)) return { status: 'notReady', message: 'The game button is not ready yet; try again.' };
        return press(button, which)
            ? { status: 'sent', label }
            : { status: 'notFound', message: 'Could not press the game button; press the marked one yourself.' };
    }
    if (advice.status !== 'move') return { status: 'nothing' };

    const move = advice.move;
    const itemHrid = itemFor(advice);
    if (itemHrid && inventoryCount(instance, itemHrid) === 0) {
        return { status: 'noItem', message: `No ${item(itemHrid)} in inventory` };
    }

    if (move.kind === 'unlock') {
        const button = scanControls(modal, instance).unlock;
        if (!button) return { status: 'notFound', message: "Could not find the game's unlock button." };
        if (isDisabled(button)) return { status: 'notReady', message: 'The game button is not ready yet; try again.' };
        return press(button, 'unlock')
            ? { status: 'sent', label: 'unlocked the locked line' }
            : { status: 'notFound', message: 'Could not press the game button; press the marked one yourself.' };
    }

    // Choosing the orb is client state; the press that follows is the one server action. The Reroll button's
    // handler before the choice tells when the game has re-rendered it with the choice in place.
    const wasSelected = instance.state?.selectedOrbHrid === itemHrid;
    const before = move.kind === 'orb' ? onClickOf(scanControls(modal, instance).reroll) : null;
    if (!selectOrb(instance, itemHrid)) {
        return { status: 'notFound', message: `Could not select the ${item(itemHrid)} in the game's orb picker.` };
    }
    if (
        move.kind === 'orb' &&
        move.mode === REROLL_MODES.typesOnly &&
        !setFocusPicks(instance, move.focusHrids || [])
    ) {
        return { status: 'notFound', message: "Could not set the focus picks in the game's window." };
    }
    const controls = scanControls(modal, instance);
    if (move.kind === 'lock') {
        const button = controls.lockButtons.get(move.modifierHrid);
        if (!button)
            return { status: 'notFound', message: `Could not find the lock button of ${mod(move.modifierHrid)}.` };
        if (isDisabled(button)) return { status: 'notReady', message: 'The game button is not ready yet; try again.' };
        return press(button, 'lock')
            ? { status: 'sent', label: `locked ${mod(move.modifierHrid)} (confirm in the game's dialog if it asks)` }
            : { status: 'notFound', message: 'Could not press the game button; press the marked one yourself.' };
    }
    if (!controls.reroll) return { status: 'notFound', message: "Could not find the game's Reroll button." };
    // Never press in the same turn as the choice: the caller waits for the re-render (rerollReady), then presses
    return { status: 'awaitReroll', before, wasSelected };
}

/**
 * Whether the game has re-rendered Reroll with the chosen orb: enabled, and (when the orb was just chosen) carrying
 * a different onClick than before the choice.
 * @param {Object} context - {modal, instance}
 * @param {{before: Function|null, wasSelected: boolean}} wait
 * @returns {'ready'|'waiting'|'missing'}
 */
export function rerollReady({ modal, instance }, wait) {
    const button = scanControls(modal, instance).reroll;
    if (!button) return 'missing';
    if (isDisabled(button)) return 'waiting';
    if (!wait.wasSelected && wait.before && onClickOf(button) === wait.before) return 'waiting';
    return 'ready';
}
