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
import { resolveCostLines, computeMaxAffordable, findMaxValidQuantity } from '../../utils/shop-max-buy.js';
import { setReactInputValue } from '../../utils/react-input.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';

const SETTING = 'shop_maxBuyButton';
const BUTTON_CLASS = 'toolasha-shop-max-buy-button';

// Each panel is its own React component with its own CSS-module class prefix, but all share the
// same inner structure: quantity input, then a cost row, then the Buy button. Prefixes survive
// game rebuilds; the hash suffix does not. The Cowbell Store's MooPass, Community Buffs and
// Convenience tabs all render through one component.
const PANEL_CLASSES = [
    { key: 'shop', inputContainerClass: 'ShopPanel_inputContainer' },
    { key: 'tasks', inputContainerClass: 'TasksPanel_inputContainer' },
    { key: 'labyrinth', inputContainerClass: 'LabyrinthPanel_inputContainer' },
    { key: 'cowbellStore', inputContainerClass: 'CowbellStorePanel_inputContainer' },
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

        for (const panel of PANEL_CLASSES) {
            const unregister = domObserver.onClass(
                `shop-max-buy-${panel.key}`,
                panel.inputContainerClass,
                (container) => this.injectButton(container)
            );
            this.registry.registerCleanup(unregister);
        }
    }

    disable() {
        this.registry?.cleanupAll();
        this.registry = null;
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
        this.isInitialized = false;
    }

    /**
     * @param {Element} container - the *Panel_inputContainer element
     */
    injectButton(container) {
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
            this.handleMaxClick(container, input);
        });

        inputWrapper.insertAdjacentElement('afterend', button);
    }

    /**
     * @param {Element} container
     * @param {HTMLInputElement} input
     */
    async handleMaxClick(container, input) {
        try {
            const candidate = computeMaxAffordable(resolveCostLines(container));
            if (candidate === null) return;
            await this.fillAndVerify(container, input, candidate);
        } catch (error) {
            console.error('[ShopMaxBuyButton] Max failed:', error);
        }
    }

    /**
     * Fill the input with `candidate`, then step down to the largest quantity the Buy button
     * accepts. Only reads `disabled`; the Buy button is never clicked.
     * @param {Element} container
     * @param {HTMLInputElement} input
     * @param {number} candidate
     */
    async fillAndVerify(container, input, candidate) {
        const buyButton = () => container.parentElement?.querySelector('button[class*="Button_success"]');

        const isDisabledAt = async (value) => {
            setReactInputValue(input, value, { focus: false });
            await nextFrame();
            const button = buyButton();
            return button ? button.disabled : true;
        };

        const best = await findMaxValidQuantity(candidate, isDisabledAt);
        if (best !== null && best !== candidate) {
            await isDisabledAt(best);
        }
        // else: nothing valid even at 1; leave the game's own validation to explain it
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
