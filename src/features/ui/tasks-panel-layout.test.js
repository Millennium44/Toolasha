/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

function fixture(width = 360) {
    const host = document.createElement('div');
    host.className = 'GamePage_gamePanel__fixture';
    host.innerHTML = `<div class="TasksPanel_tasksPanel__fixture">
        <div class="TasksPanel_tabsComponentContainer__fixture">
            <div class="TabsComponent_tabsComponent__fixture">
            <div class="TabsComponent_tabsContainer__fixture">
                <div class="MuiTabs-root"><div class="MuiTabs-scroller MuiTabs-fixed" style="overflow:hidden">
                    <div class="MuiTabs-flexContainer" role="tablist">
                        <button class="MuiTab-root" role="tab">Task Board</button>
                        <button class="MuiTab-root" role="tab">Task Shop</button>
                    </div>
                </div></div>
            </div>
            <div class="TabsComponent_tabPanelsContainer__fixture">
                <div class="TasksPanel_taskBoard__fixture">
                    <div class="TasksPanel_taskBoardInfo__fixture">
                        <div class="TasksPanel_taskSlotCount__fixture">22/22 Tasks
                            <button>Upgrade Capacity</button><button data-mwi-task-sort>Sort Tasks</button>
                            <div data-mwi-task-filters style="display:flex;gap:8px">
                                <button>Battle</button><button>Dungeon 1</button><button>Dungeon 2</button>
                            </div>
                            <button data-mwi-task-highlight>Highlight Task Items</button>
                            <button id="mwi-claim-proxy-btn">Claim Reward</button>
                            <span class="toolasha-reroll-spend-badge">Rerolls: 390.0K</span>
                            <button>Merged crafting</button>
                        </div>
                        <div class="TasksPanel_taskTimer__fixture">Next task: 2h 3m</div>
                        <span class="mwi-task-protection-btn">Shield</span><span>Auto reroll</span><span>Walk</span>
                    </div>
                    <div class="TasksPanel_taskList__fixture">Task cards</div>
                </div>
                <div class="TabsComponent_tabsContainer__fixture" role="dialog">
                    <div class="MuiTabs-root"><div class="MuiTabs-scroller"><div class="MuiTabs-flexContainer" role="tablist"></div></div></div>
                </div>
            </div>
        </div></div>
    </div>`;
    // Relevant declarations captured from the test client's main.12f09e2d CSS.
    // DOM tests assert scope/state, not browser-measured geometry.
    const native = document.createElement('style');
    native.textContent = `
        .TasksPanel_taskBoardInfo__fixture { display:flex; height:1.875rem; justify-content:space-between; }
        .TasksPanel_taskSlotCount__fixture { display:flex; gap:4px; }
    `;
    host.append(native);
    document.body.append(host);
    const rect = vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ width });
    return {
        host,
        rect,
        panel: host.firstElementChild,
        list: host.querySelector('[role="tablist"]'),
        scroller: host.querySelector('.MuiTabs-scroller'),
    };
}

test('the layout fix is registered independently of optional Task Statistics', () => {
    const entry = readFileSync(resolve('src/entrypoint.js'), 'utf8');
    const ui = readFileSync(resolve('src/libraries/ui.js'), 'utf8');
    expect(entry).toMatch(
        /key: 'tasksPanelLayout',[\s\S]*?module: UI\.tasksPanelLayout,[\s\S]*?customCheck: \(\) => true/
    );
    expect(ui).toContain("import tasksPanelLayout from '../features/ui/tasks-panel-layout.js'");
});

test('narrow layout styles only the horizontal Tasks strip, including tabs inserted later', () => {
    const { panel, list, scroller } = fixture();
    feature.initialize();
    feature.initialize();
    expect(panel.hasAttribute('data-toolasha-tasks-layout-narrow')).toBe(true);
    expect(getComputedStyle(scroller).overflowX).toBe('auto');
    expect(getComputedStyle(scroller).maxWidth).toBe('100%');
    const statistics = document.createElement('div');
    statistics.className = 'MuiTab-root toolasha-task-stats-btn';
    statistics.textContent = 'Statistics';
    const clicked = vi.fn();
    statistics.addEventListener('click', clicked);
    list.append(statistics);
    expect(getComputedStyle(statistics).flexShrink).toBe('0');
    expect(getComputedStyle(statistics).whiteSpace).toBe('nowrap');
    statistics.click();
    expect(clicked).toHaveBeenCalledOnce();
    const gesture = new Event('touchmove', { bubbles: true, cancelable: true });
    statistics.dispatchEvent(gesture);
    expect(gesture.defaultPrevented).toBe(false);
    expect(panel.querySelector('[role="dialog"] [data-toolasha-tasks-layout-layer]')).toBeNull();
    expect(document.querySelectorAll('#toolasha-tasks-panel-layout')).toHaveLength(1);
});

test('content width drives resize and widening restores the native inline overflow', () => {
    const { panel, rect, scroller } = fixture(1000);
    feature.initialize();
    expect(panel.hasAttribute('data-toolasha-tasks-layout-narrow')).toBe(false);
    rect.mockReturnValue({ width: 360 });
    observers[0].callback();
    expect(getComputedStyle(scroller).overflowX).toBe('auto');
    rect.mockReturnValue({ width: 1000 });
    window.dispatchEvent(new Event('resize'));
    expect(panel.hasAttribute('data-toolasha-tasks-layout-narrow')).toBe(false);
    expect(scroller.style.overflow).toBe('hidden');
    expect(scroller.style.overflowX).not.toBe('auto');
});

test('finds the Tasks injection chain without assuming a optional wrapper', () => {
    const { panel, scroller } = fixture();
    const optionalWrapper = panel.firstElementChild;
    optionalWrapper.replaceWith(...optionalWrapper.childNodes);
    feature.initialize();
    expect(panel.hasAttribute('data-toolasha-tasks-layout-narrow')).toBe(true);
    expect(getComputedStyle(scroller).overflowX).toBe('auto');
});

test('navigation and cleanup disconnect observers, remove markers, and leave no duplicate listeners', () => {
    const first = fixture();
    feature.initialize();
    first.host.remove();
    handlers.added.forEach((callback) => callback());
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    expect(first.panel.hasAttribute('data-toolasha-tasks-layout-narrow')).toBe(false);
    const second = fixture();
    handlers.classes.forEach((callback) => callback(second.panel));
    expect(second.panel.hasAttribute('data-toolasha-tasks-layout-narrow')).toBe(true);
    feature.cleanup();
    expect(observers[1].disconnect).toHaveBeenCalledOnce();
    expect(second.panel.querySelector('[data-toolasha-tasks-layout-layer]')).toBeNull();
    expect(handlers.classes).toHaveLength(0);
    expect(handlers.ready).toHaveLength(0);
    expect(handlers.added).toHaveLength(0);
    window.dispatchEvent(new Event('resize'));
    expect(second.panel.hasAttribute('data-toolasha-tasks-layout-narrow')).toBe(false);
});

test('wraps the fixed-height native board header and existing injected controls without moving them', () => {
    const { panel } = fixture();
    const header = panel.querySelector('[class*="TasksPanel_taskBoardInfo"]');
    const slots = panel.querySelector('[class*="TasksPanel_taskSlotCount"]');
    const filters = panel.querySelector('[data-mwi-task-filters]');
    const order = Array.from(slots.children);
    const clicked = vi.fn();
    const claim = slots.querySelector('#mwi-claim-proxy-btn');
    claim.addEventListener('click', clicked);
    feature.initialize();
    expect(getComputedStyle(header).height).toBe('auto');
    expect(getComputedStyle(header).flexWrap).toBe('wrap');
    expect(getComputedStyle(slots).flexWrap).toBe('wrap');
    expect(getComputedStyle(filters).flexWrap).toBe('wrap');
    expect(Array.from(slots.children)).toEqual(order);
    claim.click();
    expect(clicked).toHaveBeenCalledOnce();
    feature.cleanup();
    expect(getComputedStyle(header).height).toBe('30px');
    expect(getComputedStyle(header).flexWrap).not.toBe('wrap');
});

test('late controls inherit wrapping, while Combat and other strips stay untouched', () => {
    const { panel } = fixture();
    const outside = document.createElement('div');
    outside.className = 'CombatPanel_combatPanel__fixture';
    outside.innerHTML = '<div class="MuiTabs-scroller"><div role="tablist"></div></div>';
    document.body.append(outside);
    feature.initialize();
    const filters = panel.querySelector('[data-mwi-task-filters]');
    filters.remove();
    panel.querySelector('[class*="TasksPanel_taskSlotCount"]').append(filters);
    expect(getComputedStyle(filters).flexWrap).toBe('wrap');
    expect(outside.querySelector('[data-toolasha-tasks-layout-layer]')).toBeNull();
    expect(outside.hasAttribute('data-toolasha-tasks-layout-narrow')).toBe(false);
});

test('replacement tab lists release the old markers and re-enable does not duplicate handlers', () => {
    const { panel, list } = fixture();
    feature.initialize();
    const replacement = list.cloneNode(true);
    list.replaceWith(replacement);
    handlers.classes.forEach((callback) => callback(replacement));
    expect(list.hasAttribute('data-toolasha-tasks-layout-layer')).toBe(false);
    expect(replacement.getAttribute('data-toolasha-tasks-layout-layer')).toBe('list');
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    feature.cleanup();
    feature.initialize();
    expect(panel.hasAttribute('data-toolasha-tasks-layout-narrow')).toBe(true);
    expect(handlers.classes).toHaveLength(1);
    expect(document.querySelectorAll('#toolasha-tasks-panel-layout')).toHaveLength(1);
});
