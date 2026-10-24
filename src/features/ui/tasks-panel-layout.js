/** Keep Tasks tabs and injected board controls inside a narrow game pane. */
import domObserver from '../../core/dom-observer.js';
import { addStyles, removeStyles } from '../../utils/dom.js';
import { capToViewport } from '../../utils/responsive-dock.js';

const STYLE_ID = 'toolasha-tasks-panel-layout';
const PANEL = '[class*="TasksPanel_tasksPanel"]';
const ACTIVE = '[data-toolasha-tasks-layout-narrow]';
const LAYER = 'data-toolasha-tasks-layout-layer';
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
/* The native board header is a fixed 1.875rem, nonwrapping flex row. Sort,
   filters, claims and crafting add to its slot-count group; protection and
   walk buttons add alongside it. Let those existing nodes wrap in place. */
${ACTIVE} [class*="TasksPanel_taskBoardInfo"] {
    height: auto !important; min-height: 1.875rem;
    flex-wrap: wrap; gap: 6px; justify-content: flex-start !important;
}
${ACTIVE} [class*="TasksPanel_taskSlotCount"] {
    min-width: 0; max-width: 100%; flex: 1 1 100%; flex-wrap: wrap;
}
${ACTIVE} [data-mwi-task-filters] {
    min-width: 0; max-width: 100%; flex-wrap: wrap;
}
${ACTIVE} [class*="TasksPanel_taskTimer"] { margin-left: auto; }
`;

let current = null;
let unregister = [];

function release() {
    if (!current) return;
    current.observer?.disconnect();
    current.panel.removeAttribute('data-toolasha-tasks-layout-narrow');
    capToViewport(current.scroller, false);
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
    if (panel.hasAttribute('data-toolasha-tasks-layout-narrow') !== narrow) {
        panel.toggleAttribute('data-toolasha-tasks-layout-narrow', narrow);
    }
    // The game's middle panel can overhang a phone screen; keep the strip's last tab reachable
    capToViewport(current.scroller, narrow);
}

function attach(panel) {
    if (!panel?.isConnected) return;
    // The game's TasksPanel_tabsComponentContainer owns a TabsComponent, the
    // same chain task-statistics uses. Never touch a nested dialog's tabs.
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
    current = { panel, list, scroller, measure, layers, observer };
    observer?.observe(measure);
    update();
}

function discover(node) {
    const panel = node?.closest?.(PANEL);
    if (panel) attach(panel);
}

const tasksPanelLayout = {
    initialize() {
        if (unregister.length) return;
        addStyles(CSS, STYLE_ID);
        unregister = [
            domObserver.onClass('TasksPanelLayout', ['TasksPanel_tasksPanel', 'MuiTabs-flexContainer'], discover),
            domObserver.onReady('TasksPanelLayoutCatchUp', () => attach(document.querySelector(PANEL))),
            // The shared observer already handles navigation. This constant-time
            // check releases an old pane without another MutationObserver or poll.
            domObserver.register('TasksPanelLayoutDetach', () => {
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

export default tasksPanelLayout;
