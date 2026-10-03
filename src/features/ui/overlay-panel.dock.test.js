/**
 * @vitest-environment happy-dom
 *
 * Docking the overlay into the character column.
 *
 * Floating over the game is the wrong default for a panel that is always up:
 * whatever it covers is covered permanently, and moving it out of the way means
 * moving it somewhere else that is also in the way. Docked, it has its own space
 * and the tab body gives up the height — which only works if the column is
 * turned into a flex column while the panel is in it, and only stays working if
 * the panel is put back after React rebuilds that column.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const geometry = vi.hoisted(() => ({ deferNextRestore: false, pending: [] }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, Z_HUD: 50, Z_FLOATING_PANEL: 1100, Z_POPUP: 9000 },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async () => null,
        setJSON: async () => {},
        getMany: async (keys) => new Map(keys.map((key) => [key, null])),
    },
}));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, registerInterval: () => {}, clearAll: () => {} }),
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: async (panel) => {
        if (!geometry.deferNextRestore) return;
        geometry.deferNextRestore = false;
        await new Promise((resolve) => geometry.pending.push(resolve));
        panel.style.position = 'fixed';
        panel.style.top = '777px';
    },
    saveGeometry: async () => {},
    clearGeometry: async () => {},
    allGeometry: async () => ({}),
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/floating-panel.js', () => ({
    panelHeightCap: (px, fraction = 0.8) =>
        `min(${px}px, calc(var(--toolasha-visual-viewport-height, 100vh) * ${fraction}))`,
    makeDraggable: () => () => {},
    makeResizable: () => () => {},
}));
vi.mock('../../utils/overlay-rows.js', async (importActual) => ({
    ...(await importActual()),
    registeredRows: () => [{ key: 'luck', name: 'Drop Luck', render: (el) => (el.textContent = '27.3%') }],
    resolveRows: (available) => available.map((row) => ({ ...row, visible: true })),
    moveRow: (order) => order,
}));
vi.mock('../../utils/opanel-config.js', () => ({ fromOPanelConfig: () => null, toOPanelConfig: () => ({}) }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => null }));

const overlayPanel = (await import('./overlay-panel.js')).default;

const DOCK_HOST_CLASS = 'toolasha-overlay-dock-host';

/**
 * The character column as the game builds it: a tab strip and the body it
 * switches, side by side under one container.
 * @returns {HTMLElement} The container the panel should join
 */
function buildColumn() {
    const management = document.createElement('div');
    management.id = 'management-root';
    management.className = 'CharacterManagement_characterManagement__test';
    const characterTabs = document.createElement('div');
    characterTabs.className = 'CharacterManagement_tabsComponentContainer__test';
    const component = document.createElement('div');
    component.id = 'column';
    component.className = 'TabsComponent_tabsComponent__test';
    const strip = document.createElement('div');
    strip.className = 'TabsComponent_tabsContainer__test';
    const tablist = document.createElement('div');
    tablist.setAttribute('role', 'tablist');
    for (const label of ['装备', '背包']) {
        const tab = document.createElement('button');
        tab.setAttribute('role', 'tab');
        tab.textContent = label;
        tablist.appendChild(tab);
    }
    strip.appendChild(tablist);
    const panels = document.createElement('div');
    panels.className = 'TabsComponent_tabPanelsContainer__test';
    component.append(strip, panels);
    characterTabs.appendChild(component);
    management.appendChild(characterTabs);
    document.body.appendChild(management);
    return component;
}

/** A matching tab strip that is not the character management strip. */
function unrelatedTabs(label) {
    const component = document.createElement('div');
    component.className = 'TabsComponent_tabsComponent__decoy';
    const strip = document.createElement('div');
    strip.className = 'TabsComponent_tabsContainer__decoy';
    const tablist = document.createElement('div');
    tablist.setAttribute('role', 'tablist');
    const tab = document.createElement('button');
    tab.setAttribute('role', 'tab');
    tab.textContent = label;
    tablist.appendChild(tab);
    strip.appendChild(tablist);
    component.appendChild(strip);
    return component;
}

beforeEach(() => {
    geometry.deferNextRestore = false;
    geometry.pending = [];
    overlayPanel.settings.docked = false;
    overlayPanel.settings.dockHeightPx = null;
    overlayPanel.settings.locked = true;
    window.innerHeight = 900;
});

afterEach(() => {
    overlayPanel.hide();
    document.getElementById('management-root')?.remove();
    document.getElementById('outside-decoy')?.remove();
});

describe('docked into the character column', () => {
    test('the panel becomes a child of the column, not of the body', () => {
        const column = buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        expect(overlayPanel.panel.parentElement).toBe(column);
        expect(overlayPanel.panel.dataset.docked).toBe('true');
    });

    test('the direct character tab strip is found when its labels are translated', () => {
        const host = buildColumn();

        expect(overlayPanel._findDockHost()).toBe(host);
    });

    test('English and nested decoy tab strips do not replace the character host', () => {
        const host = buildColumn();
        const outsideDecoy = unrelatedTabs('Inventory');
        outsideDecoy.id = 'outside-decoy';
        const nestedDecoy = unrelatedTabs('Inventory');
        const panels = host.querySelector('[class*="TabsComponent_tabPanelsContainer"]');
        panels.appendChild(nestedDecoy);
        document.body.insertBefore(outsideDecoy, document.getElementById('management-root'));

        expect(overlayPanel._findDockHost()).toBe(host);
    });

    test('a docked panel is a Toolasha surface, so text size and font reach it', () => {
        buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        expect(overlayPanel.panel.getAttribute('data-toolasha-surface')).toBe('panel');
    });

    test('the column is marked so the tab body gives up the height', () => {
        // The mark is the whole mechanism: without it the panel is simply a
        // third child and the column grows instead of the inventory shrinking
        const column = buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        expect(column.classList.contains(DOCK_HOST_CLASS)).toBe(true);
    });

    test('the sheet gives the tab body the leftover height and nothing else', () => {
        buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        const css = document.getElementById('toolasha-overlay-dock').textContent;
        expect(css).toContain('TabsComponent_tabPanelsContainer');
        // A flex item will not shrink under its content without this, so the
        // body would keep its full height and push the panel off the screen
        expect(css).toContain('min-height: 0');
    });

    test('the column is given a height measured against the window', () => {
        // This is the whole fix. The sheet first said `max-height: 100%`, which
        // resolves against a parent with no definite height and so constrains
        // nothing at all — the column grew and the panel hung off the bottom of
        // the screen with its tiles cut in half.
        const column = buildColumn();
        window.innerHeight = 900;
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        expect(Number.parseInt(column.style.height, 10)).toBeGreaterThan(0);
        expect(document.getElementById('toolasha-overlay-dock').textContent).not.toContain('max-height: 100%');
    });

    test('a shorter window gives the column less', () => {
        const column = buildColumn();
        window.innerHeight = 900;
        overlayPanel.settings.docked = true;
        overlayPanel.show();
        const tall = Number.parseInt(column.style.height, 10);

        window.innerHeight = 500;
        overlayPanel._fitDock();

        expect(Number.parseInt(column.style.height, 10)).toBeLessThan(tall);
    });

    test('refit() re-fits a docked panel without a window resize, and is a no-op while closed', () => {
        const column = buildColumn();
        window.innerHeight = 900;
        expect(() => overlayPanel.refit()).not.toThrow();

        overlayPanel.settings.docked = true;
        overlayPanel.show();
        const tall = Number.parseInt(column.style.height, 10);

        // What a text scale change leaves behind: nothing resized, so no observer fires
        window.innerHeight = 500;
        overlayPanel.refit();

        expect(Number.parseInt(column.style.height, 10)).toBeLessThan(tall);
    });

    test('the column is handed back its own height when the panel leaves', () => {
        const column = buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();
        overlayPanel.hide();

        expect(column.style.height).toBe('');
    });

    test('it is not dragged, since it has nowhere to be dragged to', () => {
        buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        expect(overlayPanel.detachDrag).toBeNull();
        expect(overlayPanel.panel.style.position).toBe('relative');
    });

    test('it takes the height it was left at', () => {
        buildColumn();
        window.innerHeight = 2000;
        overlayPanel.settings.docked = true;
        overlayPanel.settings.dockHeightPx = 300;
        overlayPanel.show();

        expect(overlayPanel.panel.style.height).toBe('300px');
    });

    test('it never takes so much that the inventory has nowhere to draw', () => {
        // A height remembered from a tall window, reopened in a short one, would
        // otherwise leave a column that is entirely overlay
        buildColumn();
        window.innerHeight = 500;
        overlayPanel.settings.docked = true;
        overlayPanel.settings.dockHeightPx = 40000;
        overlayPanel.show();

        const column = Number.parseInt(document.getElementById('column').style.height, 10);
        const panel = Number.parseInt(overlayPanel.panel.style.height, 10);
        expect(column - panel).toBeGreaterThanOrEqual(140);
    });

    test('until the edge is dragged the height follows the tiles', () => {
        // A fixed starting height is a guess about a layout it has never seen,
        // and a guess that is too small cuts the bottom row of tiles in half —
        // which is exactly what docking used to do
        buildColumn();
        window.innerHeight = 2000;
        overlayPanel.settings.docked = true;
        overlayPanel.settings.dockHeightPx = null;
        overlayPanel.show();

        // happy-dom measures nothing, so the canvas is the only real figure
        // here. Measured rather than read off a style: nothing writes the canvas
        // a height since the grid rework, because the grid works one out.
        Object.defineProperty(overlayPanel.canvasEl, 'scrollHeight', { value: 640, configurable: true });
        overlayPanel._fitDock();

        expect(Number.parseInt(overlayPanel.panel.style.height, 10)).toBeGreaterThanOrEqual(640);
    });

    test('under a Toolasha text size the tiles are measured in the scroller’s zoomed pixels', () => {
        // text-appearance.js zooms the scroller, not the panel: 640 of the
        // canvas's own pixels are 960 on screen at 150%
        buildColumn();
        window.innerHeight = 2000;
        overlayPanel.settings.docked = true;
        overlayPanel.settings.dockHeightPx = null;
        overlayPanel.show();

        Object.defineProperty(overlayPanel.canvasEl, 'scrollHeight', { value: 640, configurable: true });
        Object.defineProperty(overlayPanel.scrollEl, 'currentCSSZoom', { value: 1.5, configurable: true });

        expect(overlayPanel._contentHeight()).toBeGreaterThanOrEqual(960);
    });

    test('closing it puts the column back the way it was', () => {
        const column = buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();
        overlayPanel.hide();

        expect(column.classList.contains(DOCK_HOST_CLASS)).toBe(false);
        expect(column.querySelector('#toolasha-overlay-panel')).toBeNull();
    });

    test('it goes back to floating when undocked, and the column is released', () => {
        const column = buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        overlayPanel.toggleDock();

        expect(overlayPanel.settings.docked).toBe(false);
        expect(column.classList.contains(DOCK_HOST_CLASS)).toBe(false);
        expect(overlayPanel.panel.parentElement).toBe(document.body);
        expect(overlayPanel.panel.style.position).toBe('fixed');
    });

    test('asked to dock with no column yet, it opens floating rather than not at all', () => {
        // Which is what a reload looks like: the setting is read back before the
        // game has drawn the column it names
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        expect(overlayPanel.panel.parentElement).toBe(document.body);
        expect(overlayPanel.panel.dataset.docked).toBeUndefined();
        expect(
            overlayPanel.panel.querySelector('button[title="Cancel docking when the character tabs appear"]')
        ).not.toBeNull();
    });

    test('a floating fallback can cancel its pending dock request', () => {
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        overlayPanel.panel.querySelector('button[title="Cancel docking when the character tabs appear"]').click();
        const column = buildColumn();
        overlayPanel._ensureDocked();

        expect(overlayPanel.settings.docked).toBe(false);
        expect(overlayPanel.panel.parentElement).toBe(document.body);
        expect(column.querySelector('#toolasha-overlay-panel')).toBeNull();
    });

    test('a requested dock moves into a column that appears later without a stale geometry restore', async () => {
        geometry.deferNextRestore = true;
        overlayPanel.settings.docked = true;
        overlayPanel.show();
        const fallbackPanel = overlayPanel.panel;
        const fallbackRefresh = overlayPanel.refreshId;
        overlayPanel.openPicker();

        expect(fallbackPanel.parentElement).toBe(document.body);
        expect(fallbackPanel.dataset.docked).toBeUndefined();

        const column = buildColumn();
        overlayPanel._ensureDocked();
        const dockedPanel = overlayPanel.panel;

        expect(dockedPanel).not.toBe(fallbackPanel);
        expect(dockedPanel.parentElement).toBe(column);
        expect(dockedPanel.dataset.docked).toBe('true');
        expect(dockedPanel.style.position).toBe('relative');
        expect(overlayPanel.isPickerOpen).toBe(true);
        expect(overlayPanel.refreshId).not.toBe(fallbackRefresh);

        geometry.pending[0]();
        await Promise.resolve();
        await Promise.resolve();

        expect(dockedPanel.style.position).toBe('relative');
        expect(dockedPanel.style.top).toBe('');
    });
});

describe('after React rebuilds the column', () => {
    test('the panel is put back into the new one', () => {
        buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        // Switching tabs throws the container away and builds another
        document.getElementById('management-root').remove();
        const rebuilt = buildColumn();
        overlayPanel._ensureDocked();

        expect(overlayPanel.panel.parentElement).toBe(rebuilt);
        expect(rebuilt.classList.contains(DOCK_HOST_CLASS)).toBe(true);
    });

    test('a column that kept the panel but lost the mark is marked again', () => {
        const column = buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        column.className = '';
        overlayPanel._ensureDocked();

        expect(column.classList.contains(DOCK_HOST_CLASS)).toBe(true);
    });

    test('with the column gone for good, the switch still opens the overlay', () => {
        // Which is every screen but the inventory on a phone: the column is not
        // rebuilt, it is simply not there, and the docked panel goes with it.
        // The switch then has a panel in hand and nothing on screen, and used to
        // answer a press by "closing" the invisible one
        buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        document.getElementById('management-root').remove();
        expect(overlayPanel.isOpen).toBe(false);

        overlayPanel.toggle();

        expect(overlayPanel.isOpen).toBe(true);
        expect(overlayPanel.panel.parentElement).toBe(document.body);
    });

    test('reopening it that way does not leave the old one refreshing', () => {
        buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();
        const first = overlayPanel.refreshId;

        document.getElementById('management-root').remove();
        overlayPanel.toggle();

        expect(overlayPanel.refreshId).not.toBe(first);
    });

    test('a floating panel is left where it is', () => {
        buildColumn();
        overlayPanel.show();
        overlayPanel._ensureDocked();

        expect(overlayPanel.panel.parentElement).toBe(document.body);
    });
});

describe('saying when it opened and closed', () => {
    test('opening and closing each announce themselves', () => {
        // The tab switch has no other way to know it was closed by its own ✕
        const seen = [];
        const listener = (event) => seen.push(event.detail.open);
        document.addEventListener('toolasha:overlay-visibility', listener);

        overlayPanel.show();
        overlayPanel.hide();
        document.removeEventListener('toolasha:overlay-visibility', listener);

        expect(seen).toEqual([true, false]);
    });
});
