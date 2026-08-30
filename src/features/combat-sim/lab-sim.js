/**
 * Lab Sim Feature Module
 * Integrates the labyrinth simulator into the game's Labyrinth page.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import labSimUI from './lab-sim-ui.js';
import { cancelSimulation } from './combat-sim-runner.js';
import { isMobileMode } from '../../utils/mobile.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';

const BUTTON_CLASS = 'toolasha-lab-sim-btn';

class LabSim {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('labSim')) return;

        this.isInitialized = true;

        labSimUI.buildPanel();

        registerCommand({
            name: 'Lab Simulator',
            hint: 'Simulate a labyrinth run',
            run: () => labSimUI.toggle(),
        });

        const unregister = domObserver.onClass('LabSimButton', 'LabyrinthPanel_tabsComponentContainer', (node) => {
            this._injectButton(node);
        });
        this.unregisterHandlers.push(unregister);

        // @run-at document-start: a labyrinth panel rendered before the shared observer attaches
        // to document.body is invisible to the class watcher, so the catch-up scan waits for the
        // observer's actual-ready signal (immediate if it is already attached).
        this.unregisterHandlers.push(
            domObserver.onReady('LabSimButtonCatchUp', () => {
                const existingPanel = document.querySelector('[class*="LabyrinthPanel_tabsComponentContainer"]');
                if (existingPanel) {
                    this._injectButton(existingPanel);
                }
            })
        );
    }

    /**
     * @param {HTMLElement} tabsContainer - The LabyrinthPanel_tabsComponentContainer element
     */
    _injectButton(tabsContainer) {
        if (!tabsContainer || tabsContainer.querySelector(`.${BUTTON_CLASS}`)) return;

        const innerContainer = tabsContainer.querySelector('[class*="TabsComponent_tabsContainer"] > div > div > div');
        if (!innerContainer) return;

        const button = document.createElement('div');
        button.className = 'MuiButtonBase-root MuiTab-root MuiTab-textColorPrimary css-1q2h7u5 ' + BUTTON_CLASS;
        button.textContent = 'Lab Sim';
        button.style.cssText =
            'cursor: pointer; background: linear-gradient(135deg, #3a7bd5, #5f3dc4); color: #fff; border-radius: 4px; padding: 4px 10px; font-size: 12px; white-space: nowrap;';

        button.addEventListener('click', () => {
            labSimUI.toggle();
        });

        innerContainer.appendChild(button);

        // On a phone the labyrinth tab bar overflows and the game's MUI scroller
        // clips it with the scroll arrows hidden, so the tabs past the right edge
        // — Lab Sim, appended last, among them — cannot be reached. Let the bar
        // scroll natively on mobile so a swipe brings them into view. Applied to
        // whichever scroll container the build has, once, and only on mobile.
        if (isMobileMode()) {
            for (const selector of ['[class*="MuiTabs-scroller"]', '[class*="TabsComponent_tabsContainer"]']) {
                const scroller = tabsContainer.querySelector(selector);
                if (scroller && scroller.dataset.mwiScrollable !== '1') {
                    scroller.style.overflowX = 'auto';
                    scroller.style.webkitOverflowScrolling = 'touch';
                    scroller.dataset.mwiScrollable = '1';
                }
            }
        }
    }

    disable() {
        try {
            unregisterCommand('Lab Simulator');
            for (const unregister of this.unregisterHandlers) {
                unregister();
            }
            this.unregisterHandlers = [];

            cancelSimulation();
            labSimUI.destroy();

            document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((btn) => btn.remove());

            this.isInitialized = false;
        } catch (error) {
            console.error('[Lab Simulator] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const labSim = new LabSim();
export default labSim;
