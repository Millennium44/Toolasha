/**
 * Skilling Buy Supplies Button
 *
 * Puts a "Buy supplies" button in place of the "Consumables" heading on a skill's action panel
 * (gathering and production skills, Alchemy, Enhancing). It opens the Consumables panel on its
 * Skilling tab, showing the skill the panel belongs to: its slotted teas, how long they last, and
 * the Buy-all walk for whatever is short. The combat page and the Labyrinth entry screen have the
 * same button (combat-buy-supplies.js, labyrinth-missing-supplies.js).
 *
 * The heading holds the game's text and, beside it, the tea recommendation buttons
 * (tea-recommendation.js), so the heading itself stays: only its own text is blanked, and the
 * button goes where the text was. `disable()` puts the text back.
 *
 * The panel lives in the UI bundle, so it is reached through the bundle bridge at press time.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { consumablesPanel } from '../../utils/bundle-bridge.js';
import { showToast } from '../../utils/toast.js';

const BUTTON_CLASS = 'mwi-skilling-buy-supplies-button';
const SETTING_KEY = 'skillingBuySuppliesButton';
/** The heading's own text, kept on the heading while it is blanked, for `disable()` */
const TEXT_ATTR = 'data-mwi-skilling-supplies-text';

/** The consumables blocks of the skill panels, by the class part each one's name carries */
const CONTAINER_CLASSES = [
    'GatheringProductionSkillPanel_consumablesContainer',
    'AlchemyPanel_consumablesContainer',
    'EnhancingPanel_consumablesContainer',
];

/**
 * The block's "Consumables" heading, by position and class rather than text (players run the game in
 * Chinese). Live DOM (2026-11-14, Foraging and Alchemy): the container's first children are a
 * `*Panel_label` (the text, then the tea recommendation buttons) and the ActionTypeConsumableSlots.
 * @param {Element} container - A *_consumablesContainer element
 * @returns {Element|null}
 */
export function findConsumablesHeading(container) {
    return container?.querySelector?.(':scope > [class*="Panel_label"]') || null;
}

/**
 * The heading's own text node (the game's "Consumables"), not text inside added children.
 * @param {Element} heading
 * @returns {Text|null}
 */
function headingTextNode(heading) {
    for (const node of heading.childNodes) {
        if (node.nodeType === 3 && node.nodeValue.trim()) return node;
    }
    return null;
}

/**
 * The skill a consumables block is for, from the React props of its slot row (the same lookup the
 * drink timer uses). Walked at press time only, never on mount.
 * @param {Element} container - A *_consumablesContainer element
 * @returns {string|null} An action type hrid
 */
export function blockActionType(container) {
    const slots = container?.querySelector?.('[class*="ActionTypeConsumableSlots_actionTypeConsumableSlots"]');
    if (!slots) return null;
    const root = document.getElementById('root');
    const rootFiber = root?._reactRootContainer?.current || root?._reactRootContainer?._internalRoot?.current;
    if (!rootFiber) return null;
    // Iterative, so a deep tree cannot overflow the stack
    const stack = [rootFiber];
    while (stack.length) {
        const fiber = stack.pop();
        if (fiber.stateNode === slots) return fiber.return?.memoizedProps?.actionTypeHrid ?? null;
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
    }
    return null;
}

/**
 * Open the Consumables panel on its Skilling tab for this block's skill.
 * @param {Element} container - The block the pressed button sits in
 */
export function handleClick(container) {
    const panel = consumablesPanel();
    if (!panel) {
        // The UI bundle publishes the panel a moment after load; say so rather than ignore the press
        showToast('The Consumables panel is still loading. Try again in a moment.');
        return;
    }
    let skill = null;
    try {
        skill = blockActionType(container);
    } catch (error) {
        console.error('[SkillingBuySupplies] Reading the block’s skill failed:', error);
    }
    panel.openTab('skilling', skill ? { skill } : undefined);
}

function createButton(container) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.textContent = 'Buy supplies';
    button.title =
        'Open the Consumables panel on this skill: how long your teas last, with a Buy all walk for whatever ' +
        'is short of your target';
    // On the heading's line, in its font: an inset shadow instead of a border adds no height
    button.style.cssText =
        'margin: 0; padding: 0 10px; font: inherit; line-height: inherit; color: #ffffff; ' +
        'background: rgba(91, 141, 239, 0.15); border: none; box-shadow: inset 0 0 0 1px rgba(91, 141, 239, 0.5); ' +
        'border-radius: 6px; cursor: pointer;';
    button.addEventListener('click', () => {
        try {
            handleClick(container);
        } catch (error) {
            console.error('[SkillingBuySupplies] Opening the Consumables panel failed:', error);
        }
    });
    return button;
}

/**
 * Put the button where the heading's text was, once per rendered block. With no heading (or no text in
 * it) the button goes at the top of the block instead.
 * @param {Element} container - A *_consumablesContainer element
 */
export function injectButton(container) {
    if (!container || container.querySelector(`.${BUTTON_CLASS}`)) return;
    const button = createButton(container);
    const heading = findConsumablesHeading(container);
    const text = heading && headingTextNode(heading);
    if (!text) {
        button.style.margin = '0 0 4px 0';
        container.insertAdjacentElement('afterbegin', button);
        return;
    }
    // The text node stays React's; it is only emptied, and the heading keeps the tea buttons
    heading.setAttribute(TEXT_ATTR, text.nodeValue);
    text.nodeValue = '';
    heading.insertBefore(button, text);
}

let unregisters = [];

export function initialize() {
    if (unregisters.length) return;
    if (!config.getSetting(SETTING_KEY)) return;
    for (const cls of CONTAINER_CLASSES) {
        unregisters.push(domObserver.onClass(`SkillingBuySupplies-${cls}`, cls, (el) => injectButton(el)));
        document.querySelectorAll(`[class*="${cls}"]`).forEach((el) => injectButton(el));
    }
}

export function disable() {
    for (const unregister of unregisters) unregister?.();
    unregisters = [];
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll(`[${TEXT_ATTR}]`).forEach((heading) => {
        const original = heading.getAttribute(TEXT_ATTR);
        heading.removeAttribute(TEXT_ATTR);
        // Into the emptied text node React still holds, so a later render finds its own node
        const blank = [...heading.childNodes].find((node) => node.nodeType === 3 && !node.nodeValue.trim());
        if (blank) blank.nodeValue = original;
        else heading.insertBefore(document.createTextNode(original), heading.firstChild);
    });
}

export default { name: 'Skilling Buy Supplies Button', initialize, disable };
