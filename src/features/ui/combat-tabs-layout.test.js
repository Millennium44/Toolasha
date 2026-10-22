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
import feature from './combat-tabs-layout.js';

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
    host.innerHTML = `<div class="CombatPanel_combatPanel__fixture">
        <div class="CombatPanel_tabsComponentContainer__fixture">
            <div class="TabsComponent_tabsContainer__fixture">
                <div class="MuiTabs-root"><div class="MuiTabs-scroller MuiTabs-fixed" style="overflow:hidden">
                    <div class="MuiTabs-flexContainer" role="tablist">
                        <button class="MuiTab-root" role="tab">Combat Zones</button>
                        <button class="MuiTab-root" role="tab">Find Party</button>
                        <button class="MuiTab-root" role="tab">Battle #104</button>
                        <div class="MuiTab-root toolasha-combat-sim-btn">Combat Sim</div>
                    </div>
                </div></div>
            </div>
            <div class="TabsComponent_tabPanelsContainer__fixture">
                <div class="MuiTabs-root MuiTabs-vertical"><div class="MuiTabs-scroller"><div class="MuiTabs-flexContainer" role="tablist"></div></div></div>
            </div>
        </div>
    </div>`;
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

test('the layout fix is registered independently of optional Combat Sim and Statistics', () => {
    const entry = readFileSync(resolve('src/entrypoint.js'), 'utf8');
    const ui = readFileSync(resolve('src/libraries/ui.js'), 'utf8');
    expect(entry).toMatch(
        /key: 'combatTabsLayout',[\s\S]*?module: UI\.combatTabsLayout,[\s\S]*?customCheck: \(\) => true/
    );
    expect(ui).toContain("import combatTabsLayout from '../features/ui/combat-tabs-layout.js'");
});

test('narrow layout styles only the horizontal Combat strip, including tabs inserted later', () => {
    const { panel, list, scroller } = fixture();
    feature.initialize();
    feature.initialize();
    expect(panel.hasAttribute('data-toolasha-combat-tabs-narrow')).toBe(true);
    expect(getComputedStyle(scroller).overflowX).toBe('auto');
    expect(getComputedStyle(scroller).maxWidth).toBe('100%');
    const statistics = document.createElement('div');
    statistics.className = 'MuiTab-root toolasha-combat-stats-btn';
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
    expect(panel.querySelector('.MuiTabs-vertical [data-toolasha-combat-tabs-layer]')).toBeNull();
    expect(document.querySelectorAll('#toolasha-combat-tabs-layout')).toHaveLength(1);
});

test('content width drives resize and widening restores the native inline overflow', () => {
    const { panel, rect, scroller } = fixture(1000);
    feature.initialize();
    expect(panel.hasAttribute('data-toolasha-combat-tabs-narrow')).toBe(false);
    rect.mockReturnValue({ width: 360 });
    observers[0].callback();
    expect(getComputedStyle(scroller).overflowX).toBe('auto');
    rect.mockReturnValue({ width: 1000 });
    window.dispatchEvent(new Event('resize'));
    expect(panel.hasAttribute('data-toolasha-combat-tabs-narrow')).toBe(false);
    expect(scroller.style.overflow).toBe('hidden');
    expect(scroller.style.overflowX).not.toBe('auto');
});

test('finds the existing Combat Sim injection chain without assuming a combat-tabs wrapper', () => {
    const { panel, scroller } = fixture();
    const optionalWrapper = panel.firstElementChild;
    optionalWrapper.replaceWith(...optionalWrapper.childNodes);
    feature.initialize();
    expect(panel.hasAttribute('data-toolasha-combat-tabs-narrow')).toBe(true);
    expect(getComputedStyle(scroller).overflowX).toBe('auto');
});

test('navigation and cleanup disconnect observers, remove markers, and leave no duplicate listeners', () => {
    const first = fixture();
    feature.initialize();
    first.host.remove();
    handlers.added.forEach((callback) => callback());
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    expect(first.panel.hasAttribute('data-toolasha-combat-tabs-narrow')).toBe(false);
    const second = fixture();
    handlers.classes.forEach((callback) => callback(second.panel));
    expect(second.panel.hasAttribute('data-toolasha-combat-tabs-narrow')).toBe(true);
    feature.cleanup();
    expect(observers[1].disconnect).toHaveBeenCalledOnce();
    expect(second.panel.querySelector('[data-toolasha-combat-tabs-layer]')).toBeNull();
    expect(handlers.classes).toHaveLength(0);
    expect(handlers.ready).toHaveLength(0);
    expect(handlers.added).toHaveLength(0);
    window.dispatchEvent(new Event('resize'));
    expect(second.panel.hasAttribute('data-toolasha-combat-tabs-narrow')).toBe(false);
});
