/** Keep the Combat and Labyrinth pages' horizontal tabs reachable in a narrow game pane. */
import domObserver from '../../core/dom-observer.js';
import { addStyles, removeStyles } from '../../utils/dom.js';
import { capToViewport } from '../../utils/responsive-dock.js';

const STYLE_ID = 'toolasha-combat-tabs-layout';
const PANEL = '[class*="CombatPanel_combatPanel"], [class*="LabyrinthPanel_labyrinthPanel"]';
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

// One entry per attached panel (Combat, Labyrinth), keyed by the panel element.
const states = new Map();
let unregister = [];

function release(panel) {
    const state = states.get(panel);
    if (!state) return;
    state.observer?.disconnect();
    panel.removeAttribute('data-toolasha-combat-tabs-narrow');
    capToViewport(state.scroller, false);
    state.layers.forEach((node) => node.removeAttribute(LAYER));
    states.delete(panel);
}

function releaseAll() {
    Array.from(states.keys()).forEach(release);
}

function updateState(state) {
    const { panel, list, measure } = state;
    if (!panel.isConnected || !list.isConnected) {
        release(panel);
        return;
    }
    const width = measure.getBoundingClientRect().width;
    if (!(width > 0)) return;
    const narrow = width <= 640;
    if (panel.hasAttribute('data-toolasha-combat-tabs-narrow') !== narrow) {
        panel.toggleAttribute('data-toolasha-combat-tabs-narrow', narrow);
    }
    // The game's middle panel can overhang a phone screen; keep the strip's last tab reachable
    capToViewport(state.scroller, narrow);
}

function updateAll() {
    Array.from(states.values()).forEach(updateState);
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
    const existing = states.get(panel);
    if (existing?.list === list) {
        updateState(existing);
        return;
    }
    release(panel);
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
    const state = { panel, list, scroller, measure, layers, observer: null };
    state.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => updateState(state)) : null;
    states.set(panel, state);
    state.observer?.observe(measure);
    updateState(state);
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
            domObserver.onClass(
                'CombatTabsLayout',
                ['CombatPanel_combatPanel', 'LabyrinthPanel_labyrinthPanel', 'MuiTabs-flexContainer'],
                discover
            ),
            domObserver.onReady('CombatTabsLayoutCatchUp', () => document.querySelectorAll(PANEL).forEach(attach)),
            // The shared observer already handles navigation. This constant-time
            // check releases an old pane without another MutationObserver or poll.
            domObserver.register('CombatTabsLayoutDetach', () => {
                states.forEach((state, panel) => {
                    if (!panel.isConnected || !state.list.isConnected) release(panel);
                });
            }),
        ];
        window.addEventListener('resize', updateAll);
    },
    disable() {
        unregister.forEach((off) => off());
        unregister = [];
        window.removeEventListener('resize', updateAll);
        releaseAll();
        removeStyles(STYLE_ID);
    },
    cleanup() {
        this.disable();
    },
};

export default combatTabsLayout;
