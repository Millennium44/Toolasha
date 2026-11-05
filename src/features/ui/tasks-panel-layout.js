/** Keep Tasks tabs and injected board controls inside a narrow game pane. */
import domObserver from '../../core/dom-observer.js';
import { addStyles, removeStyles } from '../../utils/dom.js';
import { capToViewport } from '../../utils/responsive-dock.js';
import { hasCoarsePointer } from '../../utils/mobile.js';

const STYLE_ID = 'toolasha-tasks-panel-layout';
const PANEL = '[class*="TasksPanel_tasksPanel"]';
const ACTIVE = '[data-toolasha-tasks-layout-narrow]';
const LAYER = 'data-toolasha-tasks-layout-layer';
const INFO = '[class*="TasksPanel_taskBoardInfo"]';
const SLOTS = '[class*="TasksPanel_taskSlotCount"]';
const TIMER = '[class*="TasksPanel_taskTimer"]';
const FOLD = 'data-toolasha-task-bar-fold';
const OPEN = 'data-toolasha-task-bar-tools-open';
const TOOLS_ID = 'toolasha-task-tools-btn';
const CLAIM_ID = 'mwi-claim-proxy-btn';
const WALK_CHIP_ID = 'mwi-task-reroll-walk-chip';
const MERGED_WALK_ID = 'mwi-task-train-button';
const TOUCH_MIN_HEIGHT = '32px';
/** The game's own small toolbar button, as the Merged crafting walk button wears it */
const TOOLBAR_BUTTON_CLASS = 'Button_button__1Fe9z Button_small__3fqC7';
// The phone bar. Nothing React owns moves: the slot-count group becomes `display: contents`, so its
// children and the board header's own children are one flex container, sorted with `order` and left to
// wrap. Game order, the walk right after Sort Tasks: the count, Upgrade Capacity, Sort Tasks, the reroll
// walk and its merged walk button, Tools, then the game's Next Task timer at the right; Claim Reward
// has a row of its own after those. Each of those is named below, so order never depends on insert
// order. Anything not named (Highlight, the spend badge, the task icons, a node added late) is a tool:
// hidden while Tools is closed. The game's Upgrade Capacity button carries no id, data attribute or
// Toolasha class, which is how it is told from ours.
const BAR = `${ACTIVE} ${INFO}[${FOLD}]`;
const UPGRADE = `button:not([id]):not([data-mwi-task-sort]):not([data-mwi-task-highlight]):not([class*="mwi-"]):not([class*="toolasha"])`;
const CLOSED = `${ACTIVE} ${INFO}[${FOLD}]:not([${OPEN}])`;
const FOLD_CSS = `
${BAR} { align-items: center; }
${BAR} > ${SLOTS} { display: contents !important; }
${BAR} > :not(${SLOTS}):not(${TIMER}), ${BAR} > ${SLOTS} > * { order: 20; }
${BAR} > ${SLOTS} > ${UPGRADE} { order: 1; }
${BAR} > ${SLOTS} > [data-mwi-task-sort] { order: 2; }
${BAR} #${WALK_CHIP_ID} {
    order: 3; flex: 0 1 auto !important; min-width: 0 !important; max-width: 100% !important;
    margin-left: 0 !important;
}
${BAR} #${MERGED_WALK_ID} { order: 4; flex: 0 0 auto; }
${BAR} > #${TOOLS_ID} { order: 5; flex: 0 0 auto; margin: 0; }
${BAR} > ${TIMER} { order: 6; margin-left: auto; }
${BAR} #${CLAIM_ID} { order: 8; flex: 1 1 100%; min-width: 0 !important; margin-left: 0 !important; }
/* The walk takes the width of its label and never cuts it: a label too long for the row wraps */
${BAR} #${WALK_CHIP_ID} .mwi-task-reroll-walk-advance {
    flex: 0 1 auto !important; width: auto !important; min-width: 0 !important; max-width: 100% !important;
    white-space: normal !important; overflow: visible !important; text-overflow: clip !important;
    overflow-wrap: anywhere; text-align: left;
}
${BAR} .toolasha-reroll-spend-badge { white-space: nowrap; }
/* One left edge, finger-sized controls, and the three header icons together at the right */
${BAR} > ${SLOTS} > * { margin-left: 0 !important; }
${BAR} > ${SLOTS} > button { min-height: ${TOUCH_MIN_HEIGHT}; }
${BAR} #${WALK_CHIP_ID} [class*="-chip-extras"]:empty { display: none; }
${BAR} #${WALK_CHIP_ID} button:not(.mwi-task-reroll-walk-advance) { min-width: ${TOUCH_MIN_HEIGHT} !important; }
${BAR} > .mwi-task-protection-btn { margin-left: auto !important; }
${CLOSED} > ${SLOTS} > :not(button):not(#${WALK_CHIP_ID}),
${CLOSED} > ${SLOTS} > button[data-mwi-task-highlight],
${CLOSED} > ${SLOTS} > button[id]:not(#${CLAIM_ID}):not(#${MERGED_WALK_ID}),
${CLOSED} > ${SLOTS} > button[class*="mwi-"],
${CLOSED} > ${SLOTS} > button[class*="toolasha"],
${CLOSED} > :not(${SLOTS}):not(${TIMER}):not(#${TOOLS_ID}) {
    display: none !important;
}
`;
// The same order on a wider screen, with nothing folded: the count, Upgrade Capacity, Sort Tasks, the
// reroll walk and its merged walk button, Claim Reward, then the other tools, the timer and the header icons.
const WIDE_BAR = `${INFO}:not([${FOLD}])`;
const WIDE_CSS = `
${WIDE_BAR} { align-items: center; column-gap: 6px; }
${WIDE_BAR} > ${SLOTS} { display: contents !important; }
${WIDE_BAR} > ${SLOTS} > * { order: 20; }
${WIDE_BAR} > ${SLOTS} > ${UPGRADE} { order: 1; }
${WIDE_BAR} > ${SLOTS} > [data-mwi-task-sort] { order: 2; }
${WIDE_BAR} #${WALK_CHIP_ID} { order: 3; flex: 0 0 auto !important; margin-left: 0 !important; }
${WIDE_BAR} #${MERGED_WALK_ID} { order: 4; flex: 0 0 auto; }
${WIDE_BAR} #${CLAIM_ID} { order: 5; }
${WIDE_BAR} > ${TIMER} { order: 21; margin-left: auto; }
${WIDE_BAR} > :not(${SLOTS}):not(${TIMER}):not(#${WALK_CHIP_ID}):not(#${MERGED_WALK_ID}) { order: 22; }
`;
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
${FOLD_CSS}
${WIDE_CSS}`;

let current = null;
let unregister = [];
/** Whether the player has Tools open; kept in memory for the session only */
let toolsOpen = false;
/** The board header that is folded right now, with the Tools button in it */
let fold = null;

function applyOpen() {
    if (!fold) return;
    fold.header.toggleAttribute(OPEN, toolsOpen);
    fold.button.setAttribute('aria-expanded', String(toolsOpen));
    fold.button.textContent = toolsOpen ? 'Tools ▴' : 'Tools ▾';
}

function buildToolsButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = TOOLS_ID;
    button.className = TOOLBAR_BUTTON_CLASS;
    if (hasCoarsePointer()) button.style.minHeight = TOUCH_MIN_HEIGHT;
    button.addEventListener('click', () => {
        toolsOpen = !toolsOpen;
        applyOpen();
    });
    return button;
}

/** Put the desktop bar back exactly: no marker, no Tools button. */
function unfold() {
    if (!fold) return;
    fold.header.removeAttribute(FOLD);
    fold.header.removeAttribute(OPEN);
    fold.button.remove();
    fold = null;
}

/** Fold the board header on a phone, or restore it; safe to call as often as the panel changes. */
function syncFold(panel, narrow) {
    const header = narrow ? panel.querySelector(INFO) : null;
    if (fold && fold.header !== header) unfold();
    // A redrawn header leaves no second Tools button behind
    panel.querySelectorAll(`#${TOOLS_ID}`).forEach((node) => {
        if (node !== fold?.button) node.remove();
    });
    if (!header) return;
    if (!fold) fold = { header, button: buildToolsButton() };
    if (fold.button.parentElement !== header) header.append(fold.button);
    header.setAttribute(FOLD, '');
    applyOpen();
}

function release() {
    unfold();
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
    syncFold(panel, narrow);
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
            domObserver.onClass(
                'TasksPanelLayout',
                ['TasksPanel_tasksPanel', 'MuiTabs-flexContainer', 'TasksPanel_taskBoardInfo'],
                discover
            ),
            domObserver.onReady('TasksPanelLayoutCatchUp', () => attach(document.querySelector(PANEL))),
            // The shared observer already handles navigation. This constant-time
            // check releases an old pane without another MutationObserver or poll.
            domObserver.register('TasksPanelLayoutDetach', () => {
                if (current && (!current.panel.isConnected || !current.list.isConnected)) release();
                // A redrawn header, or a Tools button the game's redraw took out, is folded again
                else if (fold && (!fold.header.isConnected || fold.button.parentElement !== fold.header)) update();
            }),
        ];
        window.addEventListener('resize', update);
    },
    disable() {
        unregister.forEach((off) => off());
        unregister = [];
        window.removeEventListener('resize', update);
        release();
        toolsOpen = false;
        removeStyles(STYLE_ID);
    },
    cleanup() {
        this.disable();
    },
};

export default tasksPanelLayout;
