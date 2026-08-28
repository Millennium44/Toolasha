/**
 * @vitest-environment happy-dom
 *
 * Named layouts, end to end through the panel.
 *
 * `overlay-layouts.test.js` covers the map on its own. What that cannot cover is
 * the part that matters: a saved layout is written by the same function the
 * export button uses and read by the same one the import button uses, so a
 * layout has to survive the trip through `toOPanelConfig` and back with its
 * positions, sizes and text scales intact. Those two are deliberately *not*
 * mocked here — mocking them would leave exactly the round trip untested.
 *
 * Storage is a map in memory, because the question is never whether IndexedDB
 * works.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: new Map() }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, Z_HUD: 50, Z_FLOATING_PANEL: 1100, Z_POPUP: 9000 },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key) => (store.data.has(key) ? JSON.parse(JSON.stringify(store.data.get(key))) : null),
        setJSON: async (key, value) => {
            store.data.set(key, JSON.parse(JSON.stringify(value)));
            return true;
        },
        tryGet: async (key) =>
            store.data.has(key)
                ? { found: true, value: JSON.parse(JSON.stringify(store.data.get(key))) }
                : { found: false, value: null },
        set: async (key, value) => {
            store.data.set(key, JSON.parse(JSON.stringify(value)));
            return true;
        },
    },
}));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, registerInterval: () => {}, clearAll: () => {} }),
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
    PANEL_Z_CAP: 1199,
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: async () => {},
    saveGeometry: async () => {},
    clearGeometry: async () => {},
    allGeometry: async () => ({ overlayPanel: { left: 10, top: 20, width: 500, height: 300 } }),
}));
vi.mock('../../utils/floating-panel.js', () => ({ makeDraggable: () => () => {}, makeResizable: () => () => {} }));

const dialog = vi.hoisted(() => ({ answer: null }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => dialog.answer }));

const { registerRow } = await import('../../utils/overlay-rows.js');
const overlayPanel = (await import('./overlay-panel.js')).default;
const { loadLayouts, layoutNames } = await import('./overlay-layouts.js');

/** An arrangement worth telling apart from another one. @returns {Object} */
function dungeonLayout() {
    return {
        order: ['dps', 'luck'],
        visible: { dps: true, luck: true },
        positions: { dps: { x: 0, y: 0 }, luck: { x: 200, y: 0 } },
        sizes: { dps: { width: 180, height: 40 }, luck: { width: 180, height: 40 } },
        zoom: { dps: 130 },
        textScale: 110,
    };
}

/** A visibly different one. @returns {Object} */
function marketLayout() {
    return {
        order: ['luck', 'dps'],
        visible: { dps: false, luck: true },
        positions: { dps: { x: 40, y: 90 }, luck: { x: 40, y: 0 } },
        sizes: { dps: { width: 120, height: 60 }, luck: { width: 120, height: 60 } },
        zoom: { luck: 80 },
        textScale: 90,
    };
}

/**
 * Put an arrangement on the panel as though it had been dragged there.
 * @param {Object} layout - What to apply
 */
function wear(layout) {
    overlayPanel.settings = { ...overlayPanel.settings, ...layout };
}

/**
 * The parts of the panel's settings a layout is supposed to carry.
 * @returns {Object}
 */
function worn() {
    const { order, visible, positions, sizes, zoom, textScale } = overlayPanel.settings;
    return { order, visible, positions, sizes, zoom, textScale };
}

beforeEach(async () => {
    store.data.clear();
    dialog.answer = null;
    document.body.replaceChildren();

    registerRow({ key: 'dps', name: 'DPS', render: (el) => (el.textContent = 'dps') });
    registerRow({ key: 'luck', name: 'Luck', render: (el) => (el.textContent = 'luck') });

    overlayPanel.settings = {
        visible: {},
        order: [],
        positions: {},
        sizes: {},
        zoom: {},
        locked: true,
        snapToGrid: true,
        separators: true,
        textScale: 100,
        open: false,
        docked: false,
        dockHeightPx: null,
    };
    overlayPanel.savedLayouts = null;
    overlayPanel.undoState = null;
    overlayPanel.show();
});

afterEach(() => {
    overlayPanel.hide();
});

describe('saving and switching named layouts', () => {
    test('a layout comes back exactly as it was saved', async () => {
        wear(dungeonLayout());
        expect(await overlayPanel.saveNamedLayout('Dungeon')).toBe(true);

        wear(marketLayout());
        expect(worn().positions.dps).toEqual({ x: 40, y: 90 });

        expect(await overlayPanel.applyNamedLayout('Dungeon')).toBe(true);

        const back = worn();
        expect(back.order).toEqual(['dps', 'luck']);
        expect(back.positions).toEqual(dungeonLayout().positions);
        expect(back.sizes).toEqual(dungeonLayout().sizes);
        expect(back.zoom).toEqual(dungeonLayout().zoom);
        expect(back.textScale).toBe(110);
    });

    test('two layouts can be switched between, repeatedly', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        wear(marketLayout());
        await overlayPanel.saveNamedLayout('Market');

        await overlayPanel.applyNamedLayout('Dungeon');
        expect(worn().positions.luck).toEqual({ x: 200, y: 0 });
        expect(worn().visible.dps).toBe(true);

        await overlayPanel.applyNamedLayout('Market');
        expect(worn().positions.luck).toEqual({ x: 40, y: 0 });
        expect(worn().visible.dps).toBe(false);

        await overlayPanel.applyNamedLayout('Dungeon');
        expect(worn().positions.luck).toEqual({ x: 200, y: 0 });
    });

    test('saving over a name replaces it rather than adding a second', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Mine');
        wear(marketLayout());
        await overlayPanel.saveNamedLayout('Mine');

        expect(await overlayPanel.listLayouts()).toEqual(['Mine']);

        wear(dungeonLayout());
        await overlayPanel.applyNamedLayout('Mine');
        expect(worn().textScale).toBe(90);
    });

    test('deleting one leaves the others and the arrangement on screen alone', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        wear(marketLayout());
        await overlayPanel.saveNamedLayout('Market');

        dialog.answer = 'Dungeon';
        const select = document.createElement('select');
        await overlayPanel._promptDeleteLayout(select);

        expect(layoutNames(await loadLayouts())).toEqual(['Market']);
        expect(worn().positions.luck).toEqual({ x: 40, y: 0 });
    });

    test('cancelling the delete dialog deletes nothing', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');

        dialog.answer = null;
        await overlayPanel._promptDeleteLayout(document.createElement('select'));

        expect(layoutNames(await loadLayouts())).toEqual(['Dungeon']);
    });

    test('a name with nothing in it saves nothing', async () => {
        wear(dungeonLayout());
        expect(await overlayPanel.saveNamedLayout('   ')).toBe(false);
        expect(await overlayPanel.listLayouts()).toEqual([]);
    });

    test('switching to a layout that is not there does nothing', async () => {
        wear(dungeonLayout());
        expect(await overlayPanel.applyNamedLayout('Nowhere')).toBe(false);
        expect(worn().positions).toEqual(dungeonLayout().positions);
    });

    test('a switch can be taken back', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        wear(marketLayout());

        await overlayPanel.applyNamedLayout('Dungeon');
        expect(overlayPanel.undoState.what).toBe('switch to Dungeon');

        overlayPanel._undo();
        expect(worn().positions.dps).toEqual({ x: 40, y: 90 });
    });

    test('the gear popover offers the saved layouts, then the presets', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.saveNamedLayout('Market');

        overlayPanel.pickerEl.style.display = '';
        await overlayPanel._refreshLayoutNames();

        const select = overlayPanel.pickerEl.querySelector('[data-overlay-layout-select]');
        // The class the shared option-contrast CSS rule targets (see
        // entrypoint.js) — this is the "preset" dropdown the Firefox
        // unreadable-options report was about.
        expect(select.classList.contains('toolasha-select')).toBe(true);
        const options = [...select.querySelectorAll('option')].map((o) => o.textContent);
        // "Market" is saved, so the preset of that name is shadowed rather than
        // offered a second time
        expect(options).toEqual([
            'Switch to…',
            'Dungeon',
            'Market',
            'Combat · preset',
            'Skilling · preset',
            'Labyrinth · preset',
            'Default · preset',
        ]);
    });

    test('with nothing saved the popover still has the presets to offer', async () => {
        overlayPanel.pickerEl.style.display = '';
        await overlayPanel._refreshLayoutNames();

        const select = overlayPanel.pickerEl.querySelector('[data-overlay-layout-select]');
        expect(select.disabled).toBe(false);
        expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
            'Switch to…',
            'Combat · preset',
            'Skilling · preset',
            'Labyrinth · preset',
            'Market · preset',
            'Default · preset',
        ]);
    });
});
