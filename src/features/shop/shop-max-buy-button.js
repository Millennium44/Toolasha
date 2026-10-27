/**
 * Shop Max Buy Button
 * Adds a "Max" button to the Shop, Task Shop, Labyrinth Shop and Cowbell Store buy dialogs that
 * fills in the most the player can afford, as the Marketplace and Guild Shop already do natively.
 *
 * Toolasha never buys: the button only types a quantity. It reads the Buy button's disabled
 * state to find a purchase cap, and never clicks it or any other spend control.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { addStyles, removeStyles } from '../../utils/dom.js';
import {
    resolveCostLines,
    computeMaxAffordable,
    findMaxValidQuantity,
    resolveCommunityBuffCostLines,
    findCommunityBuffIcon,
    normalizeCostLinesToUnit,
} from '../../utils/shop-max-buy.js';
import { setReactInputValue } from '../../utils/react-input.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';

const SETTING = 'shop_maxBuyButton';
const BUTTON_CLASS = 'toolasha-shop-max-buy-button';
const STYLE_ID = 'mwi-shop-max-buy-button-style';

// The injected button has no native styling of its own; match the game's dark theme.
const BUTTON_CSS = `
    .${BUTTON_CLASS} {
        margin-left: 4px;
        padding: 4px 10px;
        background: linear-gradient(180deg, rgba(91, 141, 239, 0.2) 0%, rgba(91, 141, 239, 0.1) 100%);
        color: #ffffff;
        border: 1px solid rgba(91, 141, 239, 0.4);
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
    }
    .${BUTTON_CLASS}:hover {
        background: linear-gradient(180deg, rgba(91, 141, 239, 0.3) 0%, rgba(91, 141, 239, 0.15) 100%);
    }
`;

// Each panel is its own React component with its own CSS-module class prefix, but all share the
// same inner structure: quantity input, then a cost row, then the Buy button. Prefixes survive
// game rebuilds; the hash suffix does not. modalContentClass scopes the Buy-button lookup to the
// panel's own dialog. The Cowbell Store's MooPass, Community Buffs and
// Convenience tabs all render through one component.
const PANEL_CLASSES = [
    { key: 'shop', inputContainerClass: 'ShopPanel_inputContainer', modalContentClass: 'ShopPanel_modalContent' },
    { key: 'tasks', inputContainerClass: 'TasksPanel_inputContainer', modalContentClass: 'TasksPanel_modalContent' },
    {
        key: 'labyrinth',
        inputContainerClass: 'LabyrinthPanel_inputContainer',
        modalContentClass: 'LabyrinthPanel_modalContent',
    },
    {
        key: 'cowbellStore',
        inputContainerClass: 'CowbellStorePanel_inputContainer',
        modalContentClass: 'CowbellStorePanel_modalContent',
    },
];

function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
}

class ShopMaxBuyButton {
    constructor() {
        this.isInitialized = false;
        this.registry = null;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting(SETTING)) return;

        this.isInitialized = true;
        this.registry = createCleanupRegistry();
        addStyles(BUTTON_CSS, STYLE_ID);

        for (const panel of PANEL_CLASSES) {
            const unregister = domObserver.onClass(
                `shop-max-buy-${panel.key}`,
                panel.inputContainerClass,
                (container) => this.injectButton(container, panel.modalContentClass, panel.key)
            );
            this.registry.registerCleanup(unregister);
        }
    }

    disable() {
        this.registry?.cleanupAll();
        this.registry = null;
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
        removeStyles(STYLE_ID);
        this.isInitialized = false;
    }

    /**
     * @param {Element} container - the *Panel_inputContainer element
     * @param {string} [modalContentClass] - the panel's *_modalContent class prefix
     * @param {string} [panelKey] - the PANEL_CLASSES key of the panel the dialog belongs to
     */
    injectButton(container, modalContentClass, panelKey) {
        if (container.querySelector(`.${BUTTON_CLASS}`)) return;

        const input = container.querySelector('input[type="number"]');
        const inputWrapper = container.querySelector('[class*="Input_inputContainer"]');
        if (!input || !inputWrapper) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = BUTTON_CLASS;
        button.textContent = 'Max';
        button.addEventListener('click', (event) => {
            event.preventDefault();
            this.handleMaxClick(container, input, modalContentClass, panelKey);
        });

        inputWrapper.insertAdjacentElement('afterend', button);
    }

    /**
     * @param {Element} container
     * @param {HTMLInputElement} input
     * @param {string} [modalContentClass]
     * @param {string} [panelKey]
     */
    async handleMaxClick(container, input, modalContentClass, panelKey) {
        try {
            const candidate = computeMaxAffordable(this.resolveUnitCostLines(container, input, panelKey));
            if (candidate === null) return;
            await this.fillAndVerify(container, input, candidate, modalContentClass);
        } catch (error) {
            console.error('[ShopMaxBuyButton] Max failed:', error);
        }
    }

    /**
     * Per-unit cost lines for the dialog. Community Buff dialogs open at 10 minutes, so their
     * "You Pay" row is a total, not a unit price: take the per-minute cost from game data, and
     * only if that cannot be resolved divide the displayed total by the typed quantity.
     * @param {Element} container
     * @param {HTMLInputElement} input
     * @param {string} [panelKey]
     * @returns {Array<{itemHrid: string, perUnitAmount: number}>}
     */
    resolveUnitCostLines(container, input, panelKey) {
        // Only Community Buff dialogs open at a multi-minute total; item dialogs show a unit price
        if (panelKey !== 'cowbellStore' || !findCommunityBuffIcon(container)) return resolveCostLines(container);

        const fromGameData = resolveCommunityBuffCostLines(container);
        if (fromGameData) return fromGameData;

        return normalizeCostLinesToUnit(resolveCostLines(container), parseInt(input.value, 10));
    }

    /**
     * Fill the input with `candidate`, then step down to the largest quantity the Buy button
     * accepts. Only reads `disabled`; the Buy button is never clicked.
     *
     * The Buy button is looked up inside this panel's own modal content, not merely the input's
     * parent: Button_success is shared by every success-colored button in the game, so a scope
     * that is too narrow misses the real button and one that is too wide can match another.
     * It is trusted as the oracle only when exactly one visible match is found. With zero or
     * several there is no reliable oracle, so verification stops and the quantity already
     * filled is left as-is.
     * @param {Element} container
     * @param {HTMLInputElement} input
     * @param {number} candidate
     * @param {string} [modalContentClass]
     */
    async fillAndVerify(container, input, candidate, modalContentClass) {
        const modalRoot = (modalContentClass && container.closest(`[class*="${modalContentClass}"]`)) || document;
        const findBuyButton = () => {
            const matches = [...modalRoot.querySelectorAll('button[class*="Button_success"]')].filter(
                (button) => button.offsetParent !== null
            );
            return matches.length === 1 ? matches[0] : null;
        };

        // true: found and disabled (go smaller). false: found and enabled (quantity works).
        // null: no reliable oracle (stop and leave as-is).
        const isDisabledAt = async (value) => {
            setReactInputValue(input, value, { focus: false });
            await nextFrame();
            const button = findBuyButton();
            return button ? button.disabled : null;
        };

        const best = await findMaxValidQuantity(candidate, isDisabledAt);
        if (best !== null && best !== candidate) {
            await isDisabledAt(best);
        }
        // else: nothing valid even at 1, or the oracle was lost; leave the game's own validation to explain it
    }
}

const shopMaxBuyButton = new ShopMaxBuyButton();

export { shopMaxBuyButton };

export default {
    name: 'Shop Max Buy Button',
    initialize: async () => {
        shopMaxBuyButton.initialize();
    },
    cleanup: () => {
        shopMaxBuyButton.disable();
    },
    disable: () => {
        shopMaxBuyButton.disable();
    },
};
