/** @vitest-environment happy-dom */
// Happy-dom cannot measure layout. These tests pin classes, attributes, structure and the rule text
// the stylesheet carries; where the rows land on a 369 px pane is for the live game to say.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const handlers = vi.hoisted(() => ({ classes: [], ready: [], added: [] }));
vi.mock('../../core/dom-observer.js', () => ({
    default: Object.fromEntries(
        [
            ['onClass', 'classes'],
            ['onReady', 'ready'],
            ['register', 'added'],
        ].map(([method, key]) => [
            method,
            (...args) => {
                const callback = args.find((value) => typeof value === 'function');
                handlers[key].push(callback);
                if (key === 'ready') callback();
                return () => {
                    handlers[key] = handlers[key].filter((entry) => entry !== callback);
                };
            },
        ])
    ),
}));
import feature from './tasks-panel-layout.js';

const TOOLS = '#toolasha-task-tools-btn';
const FOLD = 'data-toolasha-task-bar-fold';
const OPEN = 'data-toolasha-task-bar-tools-open';

let observers;
beforeEach(() => {
    observers = [];
    vi.stubGlobal(
        'ResizeObserver',
        class {
            disconnect = vi.fn();
            observe = vi.fn();
            constructor(callback) {
                this.callback = callback;
                observers.push(this);
            }
        }
    );
});
afterEach(() => {
    feature.cleanup();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/** The pieces the game and Toolasha put in the Task Board bar, in the shapes they really have. */
function barHtml({ walk = true, claim = true, label = 'Reroll walk' } = {}) {
    return `<div class="TasksPanel_taskBoardInfo__fixture">
        <div class="TasksPanel_taskSlotCount__fixture">48 / 48 Tasks
            <button class="Button_button__1Fe9z" id="game-upgrade">Upgrade Capacity</button>
            <button class="Button_button__1Fe9z Button_small__3fqC7" data-mwi-task-sort>Sort Tasks</button>
            <div data-mwi-task-filters style="display:flex"><button>Battle</button></div>
            <button class="Button_button__1Fe9z Button_small__3fqC7" data-mwi-task-highlight>Highlight</button>
            <button id="mwi-claim-proxy-btn" style="margin-left: 8px; min-width: 130px; ${claim ? '' : 'display: none;'}">
                Claim Reward</button>
            <span class="toolasha-reroll-spend-badge">Rerolls: 47</span>
            ${
                walk
                    ? `<div id="mwi-task-reroll-walk-chip" data-toolasha-docked="true"
                        style="display:inline-flex; margin-left:8px; flex:0 0 auto; max-width:100%; min-width:0">
                        <div class="row" style="display:flex">
                            <button class="mwi-task-reroll-walk-advance"
                                style="width:170px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">
                                ${label}</button>
                            <button class="mwi-task-reroll-walk-info">i</button>
                            <button class="mwi-task-reroll-walk-gear">gear</button>
                        </div></div>
                    <button id="mwi-task-train-button">Merged crafting walk</button>`
                    : ''
            }
        </div>
        <div class="TasksPanel_taskTimer__fixture">Next Task: 9m 13s</div>
        <span class="mwi-task-protection-btn">S</span><span class="mwi-task-autoreroll-btn">A</span>${
            walk ? '<span class="mwi-task-reroll-walk-btn">D</span>' : ''
        }
    </div>`;
}

function fixture({ width = 369, ...bar } = {}) {
    const host = document.createElement('div');
    host.className = 'GamePage_gamePanel__fixture';
    host.innerHTML = `<div class="TasksPanel_tasksPanel__fixture">
        <div class="TabsComponent_tabsContainer__fixture">
            <div class="MuiTabs-root"><div class="MuiTabs-scroller">
                <div class="MuiTabs-flexContainer" role="tablist"><button class="MuiTab-root" role="tab">T</button></div>
            </div></div>
        </div>
        <div class="TasksPanel_taskBoard__fixture">${barHtml(bar)}<div class="TasksPanel_taskList__fixture"></div></div>
    </div>`;
    document.body.append(host);
    const rect = vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ width });
    return { host, rect, panel: host.firstElementChild };
}

const header = (panel) => panel.querySelector('[class*="TasksPanel_taskBoardInfo"]');
const css = () => document.getElementById('toolasha-tasks-panel-layout').textContent;

test('a phone folds the bar: a Tools button, closed, with aria-expanded and every node left in place', () => {
    const { panel } = fixture();
    const slots = panel.querySelector('[class*="TasksPanel_taskSlotCount"]');
    const before = Array.from(slots.children);
    const beforeHeader = Array.from(header(panel).children);
    feature.initialize();
    const tools = panel.querySelector(TOOLS);
    expect(tools).not.toBeNull();
    expect(tools.parentElement).toBe(header(panel));
    expect(tools.getAttribute('aria-expanded')).toBe('false');
    expect(tools.className).toContain('Button_small__3fqC7');
    expect(header(panel).hasAttribute(FOLD)).toBe(true);
    expect(header(panel).hasAttribute(OPEN)).toBe(false);
    // Nothing the game or another module owns moved: only the Tools button was added
    expect(Array.from(slots.children)).toEqual(before);
    expect(Array.from(header(panel).children).filter((node) => node !== tools)).toEqual(beforeHeader);
    expect(getComputedStyle(slots).display).toBe('contents');
});

test('the stylesheet folds by default: only count, timer, walk, Claim Reward and Tools stay while closed', () => {
    fixture();
    feature.initialize();
    const rules = css();
    // Closed: every slot-count child except the claim button and the chip, and every header child
    // except the slot group, the timer and Tools, is hidden. A node added late is hidden too.
    expect(rules).toContain(':not(#mwi-claim-proxy-btn):not(#mwi-task-reroll-walk-chip)');
    expect(rules).toContain(':not([class*="TasksPanel_taskTimer"]):not(#toolasha-task-tools-btn)');
    // Claim Reward has no display rule of its own, so its own display:none (nothing to claim) still wins
    expect(rules).not.toMatch(/#mwi-claim-proxy-btn\s*\{[^}]*display/);
    // The walk fills its row on a phone; the 170px stays inline, and the rule only exists under the fold
    expect(rules).toMatch(/\.mwi-task-reroll-walk-advance\s*\{[^}]*width: auto !important/);
    expect(rules.match(/width: auto !important/g)).toHaveLength(1);
    expect(rules).toContain(
        '[data-toolasha-tasks-layout-narrow] [class*="TasksPanel_taskBoardInfo"][data-toolasha-task-bar-fold]'
    );
});

test('Tools opens and closes with one tap and the open state survives a redrawn bar', () => {
    const { panel } = fixture();
    feature.initialize();
    panel.querySelector(TOOLS).click();
    expect(header(panel).hasAttribute(OPEN)).toBe(true);
    expect(panel.querySelector(TOOLS).getAttribute('aria-expanded')).toBe('true');
    // The game redraws the whole bar: the new header is folded and keeps the session's choice
    const redrawn = document.createElement('div');
    redrawn.innerHTML = barHtml();
    header(panel).replaceWith(redrawn.firstElementChild);
    handlers.classes.forEach((callback) => callback(header(panel)));
    expect(panel.querySelectorAll(TOOLS)).toHaveLength(1);
    expect(header(panel).hasAttribute(OPEN)).toBe(true);
    panel.querySelector(TOOLS).click();
    expect(header(panel).hasAttribute(OPEN)).toBe(false);
    expect(panel.querySelector(TOOLS).getAttribute('aria-expanded')).toBe('false');
});

test('a redraw caught only by the shared mutation check still leaves exactly one Tools button', () => {
    const { panel } = fixture();
    feature.initialize();
    const redrawn = document.createElement('div');
    redrawn.innerHTML = barHtml();
    header(panel).replaceWith(redrawn.firstElementChild);
    handlers.added.forEach((callback) => callback());
    expect(panel.querySelectorAll(TOOLS)).toHaveLength(1);
    expect(header(panel).hasAttribute(FOLD)).toBe(true);
    // The game dropping just the button is repaired the same way
    panel.querySelector(TOOLS).remove();
    handlers.added.forEach((callback) => callback());
    expect(panel.querySelectorAll(TOOLS)).toHaveLength(1);
});

test('no walk (Iron Cow) or a hidden walk: Tools still exists, and nothing else is missing from the header', () => {
    const { panel } = fixture({ walk: false });
    feature.initialize();
    expect(panel.querySelectorAll(TOOLS)).toHaveLength(1);
    expect(panel.querySelector('#mwi-task-reroll-walk-chip')).toBeNull();
    // The 🎲 that brings a hidden walk back is a header child, folded under Tools like the rest
    const { panel: other } = fixture();
    feature.cleanup();
    feature.initialize();
    expect(other.querySelector('.mwi-task-reroll-walk-btn').parentElement).toBe(header(other));
});

test('floating walk mode: the chip is not in the bar, Tools is, and nothing breaks', () => {
    const { panel } = fixture({ walk: false });
    const floating = document.createElement('div');
    floating.id = 'mwi-task-reroll-walk-chip';
    document.body.append(floating);
    feature.initialize();
    expect(panel.querySelectorAll(TOOLS)).toHaveLength(1);
    expect(floating.parentElement).toBe(document.body);
    expect(floating.hasAttribute('style')).toBe(false);
});

test('Claim Reward appearing and a long walk label change nothing about the fold', () => {
    const { panel } = fixture({ claim: false, label: 'Claim: Defeat - Boomy the Very Long Named Monster' });
    feature.initialize();
    const claim = panel.querySelector('#mwi-claim-proxy-btn');
    const chip = panel.querySelector('#mwi-task-reroll-walk-chip');
    expect(claim.style.display).toBe('none');
    claim.style.display = '';
    expect(claim.style.display).toBe('');
    // The chip's inline ellipsis styles are what truncate a long label; the fold adds none of its own
    const advance = chip.querySelector('.mwi-task-reroll-walk-advance');
    expect(advance.style.textOverflow).toBe('ellipsis');
    expect(advance.style.whiteSpace).toBe('nowrap');
    expect(panel.querySelectorAll(TOOLS)).toHaveLength(1);
});

test('crossing the narrow line both ways restores the desktop bar with nothing left behind', () => {
    const { panel, rect } = fixture();
    const slots = panel.querySelector('[class*="TasksPanel_taskSlotCount"]');
    const snapshot = header(panel).outerHTML;
    feature.initialize();
    panel.querySelector(TOOLS).click();
    rect.mockReturnValue({ width: 1000 });
    window.dispatchEvent(new Event('resize'));
    expect(panel.querySelector(TOOLS)).toBeNull();
    expect(header(panel).hasAttribute(FOLD)).toBe(false);
    expect(header(panel).hasAttribute(OPEN)).toBe(false);
    expect(header(panel).outerHTML).toBe(snapshot);
    expect(getComputedStyle(slots).display).not.toBe('contents');
    rect.mockReturnValue({ width: 369 });
    window.dispatchEvent(new Event('resize'));
    expect(panel.querySelectorAll(TOOLS)).toHaveLength(1);
    expect(header(panel).hasAttribute(OPEN)).toBe(true);
});

test('desktop width: the bar is untouched, the walk keeps its 170px, no Tools button', () => {
    const { panel } = fixture({ width: 1000 });
    const snapshot = header(panel).outerHTML;
    feature.initialize();
    expect(header(panel).outerHTML).toBe(snapshot);
    expect(panel.querySelector(TOOLS)).toBeNull();
    const advance = panel.querySelector('.mwi-task-reroll-walk-advance');
    expect(advance.style.width).toBe('170px');
    expect(getComputedStyle(advance).width).toBe('170px');
    expect(panel.querySelector('#mwi-task-reroll-walk-chip').style.flex).toBe('0 0 auto');
});

test('disable and cleanup remove the marker and the Tools button, and a re-enable makes only one', () => {
    const { panel } = fixture();
    feature.initialize();
    feature.disable();
    expect(panel.querySelector(TOOLS)).toBeNull();
    expect(header(panel).hasAttribute(FOLD)).toBe(false);
    expect(header(panel).hasAttribute(OPEN)).toBe(false);
    expect(document.getElementById('toolasha-tasks-panel-layout')).toBeNull();
    feature.initialize();
    expect(panel.querySelectorAll(TOOLS)).toHaveLength(1);
    feature.cleanup();
    expect(panel.querySelector(TOOLS)).toBeNull();
});

test('Tools is a finger-sized target on a touch screen', () => {
    vi.stubGlobal(
        'matchMedia',
        vi.fn((query) => ({ matches: query === '(pointer: coarse)' }))
    );
    const { panel } = fixture();
    feature.initialize();
    expect(panel.querySelector(TOOLS).style.minHeight).toBe('32px');
});

test('Tools starts closed on every new session even after being left open before a disable', () => {
    const first = fixture();
    feature.initialize();
    first.panel.querySelector(TOOLS).click();
    feature.disable();
    first.host.remove();
    const second = fixture();
    feature.initialize();
    expect(second.panel.querySelector(TOOLS).getAttribute('aria-expanded')).toBe('false');
});
