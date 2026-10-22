/** Keep the Combat page's horizontal tabs reachable in a narrow game pane. */
import domObserver from '../../core/dom-observer.js';
import { addStyles, removeStyles } from '../../utils/dom.js';

const STYLE_ID = 'toolasha-combat-tabs-layout';
const PANEL = '[class*="CombatPanel_combatPanel"]';
const ACTIVE = '[data-toolasha-combat-tabs-narrow]';
const LAYER = 'data-toolasha-combat-tabs-layer';
const CSS = `
${ACTIVE} { min-width: 0 !important; max-width: 100% !important; }
${ACTIVE} [${LAYER}="owner"], ${ACTIVE} [${LAYER}="wrapper"], ${ACTIVE} [${LAYER}="root"] {
    min-width: 0 !important; max-width: 100% !important; width: 100% !important;
}
${ACTIVE} [${LAYER}="scroller"] {
    min-width: 0 !important; max-width: 100% !important;
    overflow-x: auto !important; overflow-y: hidden !important;
    -webkit-overflow-scrolling: touch;
}
${ACTIVE} [${LAYER}="list"] {
    display: flex; flex-wrap: nowrap !important; justify-content: flex-start !important;
    width: max-content !important; min-width: 100%; max-width: none !important;
}
${ACTIVE} [${LAYER}="list"] > .MuiTab-root {
    flex: 0 0 auto !important; white-space: nowrap !important;
}
`;

let current = null;
let unregister = [];

function release() {
    if (!current) return;
    current.observer?.disconnect();
    current.panel.removeAttribute('data-toolasha-combat-tabs-narrow');
    current.layers.forEach((node) => node.removeAttribute(LAYER));
    current = null;
}

function update() {
    if (!current) return;
    const { panel, list, measure } = current;
    if (!panel.isConnected || !list.isConnected) {
        release();
        return;
    }
    const width = measure.getBoundingClientRect().width;
    if (!(width > 0)) return;
    const narrow = width <= 640;
    if (panel.hasAttribute('data-toolasha-combat-tabs-narrow') !== narrow) {
        panel.toggleAttribute('data-toolasha-combat-tabs-narrow', narrow);
    }
}

function attach(panel) {
    if (!panel?.isConnected) return;
    // Same MUI wrapper chain used by Combat Sim and Statistics injection.
    // Refuse the vertical zone list and any nested panel/dialog tab strips.
    const candidates = panel.querySelectorAll(
        '[class*="TabsComponent_tabsContainer"] > .MuiTabs-root:not(.MuiTabs-vertical) > ' +
            '.MuiTabs-scroller > .MuiTabs-flexContainer[role="tablist"]'
    );
    const list = Array.from(candidates).find((candidate) => {
        const nested = candidate.closest('[class*="TabsComponent_tabPanelsContainer"], [role="dialog"]');
        return !nested || !panel.contains(nested);
    });
    if (!list) return;
    if (current?.list === list) {
        update();
        return;
    }
    release();
    const scroller = list.parentElement;
    const root = scroller.parentElement;
    const wrapper = root.parentElement;
    const measure = panel.closest('[class*="GamePage_mainPanel"], [class*="GamePage_gamePanel"]') || panel;
    const layers = [wrapper, root, scroller, list];
    layers.forEach((node, index) => node.setAttribute(LAYER, ['wrapper', 'root', 'scroller', 'list'][index]));
    // Bound only the actual strip's ancestors, regardless of wrapper names.
    for (let owner = wrapper.parentElement; owner && owner !== panel; owner = owner.parentElement) {
        owner.setAttribute(LAYER, 'owner');
        layers.push(owner);
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    current = { panel, list, measure, layers, observer };
    observer?.observe(measure);
    update();
}

function discover(node) {
    const panel = node?.closest?.(PANEL);
    if (panel) attach(panel);
}

const combatTabsLayout = {
    initialize() {
        if (unregister.length) return;
        addStyles(CSS, STYLE_ID);
        unregister = [
            domObserver.onClass('CombatTabsLayout', ['CombatPanel_combatPanel', 'MuiTabs-flexContainer'], discover),
            domObserver.onReady('CombatTabsLayoutCatchUp', () => attach(document.querySelector(PANEL))),
            // The shared observer already handles navigation. This constant-time
            // check releases an old pane without another MutationObserver or poll.
            domObserver.register('CombatTabsLayoutDetach', () => {
                if (current && (!current.panel.isConnected || !current.list.isConnected)) release();
            }),
        ];
        window.addEventListener('resize', update);
    },
    disable() {
        unregister.forEach((off) => off());
        unregister = [];
        window.removeEventListener('resize', update);
        release();
        removeStyles(STYLE_ID);
    },
    cleanup() {
        this.disable();
    },
};

export default combatTabsLayout;
