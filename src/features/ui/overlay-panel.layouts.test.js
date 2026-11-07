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

const store = vi.hoisted(() => ({ data: new Map(), transactions: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        Z_HUD: 50,
        Z_FLOATING_PANEL: 1100,
        Z_POPUP: 9000,
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key) => (store.data.has(key) ? JSON.parse(JSON.stringify(store.data.get(key))) : null),
        getMany: async (keys) => {
            // One transaction however many keys it carries, which is what the
            // panel's start-up read is counted on
            store.transactions.push([...keys]);
            return new Map(
                keys.map((key) => [key, store.data.has(key) ? JSON.parse(JSON.stringify(store.data.get(key))) : null])
            );
        },
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
vi.mock('../../utils/floating-panel.js', () => ({
    panelHeightCap: (px, fraction = 0.8) =>
        `min(${px}px, calc(var(--toolasha-visual-viewport-height, 100vh) * ${fraction}))`,
    makeDraggable: () => () => {},
    makeResizable: () => () => {},
}));

const dialog = vi.hoisted(() => ({ answer: null }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => dialog.answer }));

const { registerRow } = await import('../../utils/overlay-rows.js');
const overlayPanel = (await import('./overlay-panel.js')).default;
const { loadLayouts, layoutNames, presetSpans, PRESET_LAYOUTS, legacyPresetFiles } =
    await import('./overlay-layouts.js');
const { toOPanelConfig, fromOPanelConfig } = await import('../../utils/opanel-config.js');

/** An arrangement worth telling apart from another one. @returns {Object} */
function dungeonLayout() {
    return {
        version: 2,
        order: ['dps', 'luck'],
        span: { luck: 2 },
        visible: { dps: true, luck: true },
        zoom: { dps: 130 },
        textScale: 110,
    };
}

/** A visibly different one. @returns {Object} */
function marketLayout() {
    return {
        version: 2,
        order: ['luck', 'dps'],
        span: { dps: 2 },
        visible: { dps: false, luck: true },
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
    const { order, span, visible, zoom, textScale } = overlayPanel.settings;
    return { order, span, visible, zoom, textScale };
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
        span: {},
        zoom: {},
        locked: true,
        separators: true,
        textScale: 100,
        open: false,
        docked: false,
        dockHeightPx: null,
    };
    overlayPanel.savedLayouts = null;
    overlayPanel.undoState = null;
    overlayPanel.appliedLayout = null;
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
        expect(worn().span.dps).toBe(2);

        expect(await overlayPanel.applyNamedLayout('Dungeon')).toBe(true);

        const back = worn();
        expect(back.order).toEqual(['dps', 'luck']);
        expect(back.span).toEqual(dungeonLayout().span);
        expect(back.zoom).toEqual(dungeonLayout().zoom);
        expect(back.textScale).toBe(110);
    });

    test('two layouts can be switched between, repeatedly', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        wear(marketLayout());
        await overlayPanel.saveNamedLayout('Market');

        await overlayPanel.applyNamedLayout('Dungeon');
        expect(worn().order).toEqual(['dps', 'luck']);
        expect(worn().visible.dps).toBe(true);

        await overlayPanel.applyNamedLayout('Market');
        expect(worn().order).toEqual(['luck', 'dps']);
        expect(worn().visible.dps).toBe(false);

        await overlayPanel.applyNamedLayout('Dungeon');
        expect(worn().order).toEqual(['dps', 'luck']);
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
        expect(worn().order).toEqual(['luck', 'dps']);
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

    test('a pinned column count survives being saved under a name and switched back to', async () => {
        // The pin is part of the arrangement: a layout pinned to three columns
        // that comes back advisory is redrawn at whatever the width affords,
        // which is exactly the count the pin existed to overrule
        wear({ ...dungeonLayout(), columns: 3, columnsPinned: true });
        await overlayPanel.saveNamedLayout('Pinned');
        wear({ ...marketLayout(), columns: 2, columnsPinned: false });

        await overlayPanel.applyNamedLayout('Pinned');

        expect(overlayPanel.settings.columns).toBe(3);
        expect(overlayPanel.settings.columnsPinned).toBe(true);
    });

    test('a layout saved unpinned releases a pin when it is applied', async () => {
        wear({ ...dungeonLayout(), columns: 2, columnsPinned: false });
        await overlayPanel.saveNamedLayout('Loose');
        wear({ ...marketLayout(), columns: 3, columnsPinned: true });

        await overlayPanel.applyNamedLayout('Loose');

        expect(overlayPanel.settings.columnsPinned).toBe(false);
    });

    /** Make the panel measure as this wide. @param {number} width - Scroller width in pixels */
    function measureAs(width) {
        Object.defineProperty(overlayPanel.scrollEl, 'offsetWidth', { configurable: true, value: width });
    }

    test('a preset applied on a three-column panel arrives with its three-column spans', async () => {
        measureAs(640);
        await overlayPanel.applyNamedLayout('Skilling');
        expect(overlayPanel.columns).toBe(3);
        expect(overlayPanel.settings.span).toEqual({ consumables: 2, coins: 2 });
        expect(overlayPanel.settings.columnsPinned).toBe(false);
    });

    test('the same preset on a narrow and a medium panel keeps the flat spans', async () => {
        measureAs(380);
        await overlayPanel.applyNamedLayout('Skilling');
        expect(overlayPanel.settings.span).toEqual({ consumables: 2 });
        measureAs(480);
        await overlayPanel.applyNamedLayout('Skilling');
        expect(overlayPanel.settings.span).toEqual({ consumables: 2 });
    });

    test('a column count set by hand survives a preset switch, and the preset fits it', async () => {
        measureAs(900);
        overlayPanel.settings.columns = 2;
        overlayPanel.settings.columnsPinned = true;

        await overlayPanel.applyNamedLayout('Dashboard');

        expect(overlayPanel.settings.columns).toBe(2);
        expect(overlayPanel.settings.columnsPinned).toBe(true);
        expect(overlayPanel.columns).toBe(2);
        expect(overlayPanel.settings.span.accountView).toBe(2);

        overlayPanel.settings.columns = 3;
        await overlayPanel.applyNamedLayout('Market');
        expect(overlayPanel.settings.columns).toBe(3);
        expect(overlayPanel.settings.columnsPinned).toBe(true);
        expect(overlayPanel.settings.span).toEqual({ skillBooks: 2, watchlist: 3, equipmentWatch: 3 });
    });

    test('a preset switch taken back restores a hand-set count too', async () => {
        overlayPanel.settings.columns = 3;
        overlayPanel.settings.columnsPinned = true;
        await overlayPanel.applyNamedLayout('Combat');
        overlayPanel._undo();
        expect(overlayPanel.settings.columns).toBe(3);
        expect(overlayPanel.settings.columnsPinned).toBe(true);
    });

    test("a layout of the player's own still releases a hand-set count, and keeps old-shape spans", async () => {
        wear({ ...dungeonLayout(), columns: 2, columnsPinned: false });
        await overlayPanel.saveNamedLayout('Mine');
        overlayPanel.settings.columns = 3;
        overlayPanel.settings.columnsPinned = true;

        await overlayPanel.applyNamedLayout('Mine');

        expect(overlayPanel.settings.columnsPinned).toBe(false);
        expect(overlayPanel.settings.span).toEqual({ luck: 2 });
    });

    test('a saved layout named like a preset shadows it, with its own spans and pin rules', async () => {
        measureAs(640);
        wear({ ...dungeonLayout(), columns: 2, columnsPinned: false });
        await overlayPanel.saveNamedLayout('Skilling');
        overlayPanel.settings.columns = 3;
        overlayPanel.settings.columnsPinned = true;

        await overlayPanel.applyNamedLayout('Skilling');

        expect(overlayPanel.settings.span).toEqual({ luck: 2 });
        expect(overlayPanel.settings.columnsPinned).toBe(false);
    });

    test('an exported three-column preset re-imports with the same spans', async () => {
        measureAs(640);
        await overlayPanel.applyNamedLayout('Market');
        const exported = toOPanelConfig(overlayPanel.settings, null);
        const read = fromOPanelConfig(JSON.parse(JSON.stringify(exported)));

        expect(read.settings.span).toEqual({ skillBooks: 2, watchlist: 3, equipmentWatch: 3 });
    });

    test('a preset applied three-column is not reported as edited', async () => {
        measureAs(640);
        await overlayPanel.applyNamedLayout('Market');
        const line = document.createElement('div');
        document.body.appendChild(line);
        line.textContent = 'Showing: Market';
        await overlayPanel._markAppliedLayoutDrift(line);
        expect(line.textContent).toBe('Showing: Market');
    });

    test('a preset follows the width from two columns through three and four to nine', async () => {
        const steps = [
            [480, 2],
            [640, 3],
            [1000, 4],
            [2040, 9],
        ];
        for (const [width, columns] of steps) {
            measureAs(width);
            await overlayPanel.applyNamedLayout('Combat');
            expect(overlayPanel.columns).toBe(columns);
            expect(overlayPanel.settings.span).toEqual(presetSpans('Combat', columns));
            expect(overlayPanel.settings.columnsPinned).toBe(false);
        }
        // Wider panels give the blocks more than the two-column spans did
        expect(overlayPanel.settings.span.consumables).toBeGreaterThan(2);
    });

    describe('a preset follows the panel as it is resized afterwards', () => {
        /** Resize the panel and let the coalesced redraw and the refit run. @param {number} width - Pixels */
        async function resizeTo(width) {
            measureAs(width);
            overlayPanel._onPanelResized();
            await new Promise((resolve) => setTimeout(resolve, 60));
        }

        test('an unedited preset gets the spans of each new count: 2, 3, 9, 3', async () => {
            measureAs(480);
            await overlayPanel.applyNamedLayout('Skilling');
            expect(overlayPanel.columns).toBe(2);

            for (const [width, columns] of [
                [640, 3],
                [2040, 9],
                [640, 3],
            ]) {
                await resizeTo(width);
                expect(overlayPanel.columns).toBe(columns);
                expect(overlayPanel.settings.span).toEqual(presetSpans('Skilling', columns));
            }
            expect(overlayPanel.appliedLayout).toBe('Skilling');
        });

        test.each(['Dashboard'])('%s follows a chain 3, 5, 9, 4, 3 exactly as applying it would', async (name) => {
            // The whole registry, as a live game has it: the preset's own tiles and others it switches off
            for (const key of [...PRESET_LAYOUTS[name].order, 'houses', 'skillLevel', 'accountView', 'noticeLog'])
                registerRow({ key, name: key, render: (el) => (el.textContent = key) });
            overlayPanel.settings.visible = {};
            measureAs(660);
            await overlayPanel.applyNamedLayout(name);
            expect(overlayPanel.columns).toBe(3);

            for (const [width, columns] of [
                [1350, 5],
                [2050, 9],
                [1000, 4],
                [660, 3],
            ]) {
                await resizeTo(width);
                expect(overlayPanel.columns).toBe(columns);
                expect(overlayPanel.settings.span).toEqual(presetSpans(name, columns));
            }
        });

        test('a resize chain writes nothing to storage, and the re-fitted preset still reads unedited', async () => {
            measureAs(660);
            await overlayPanel.applyNamedLayout('Dashboard');
            const saves = vi.spyOn(overlayPanel, '_save');
            const stored = JSON.stringify(overlayPanel.settings.span);

            for (const [width, columns] of [
                [1350, 5],
                [2050, 9],
                [1000, 4],
            ]) {
                await resizeTo(width);
                expect(overlayPanel.settings.span).toEqual(presetSpans('Dashboard', columns));
            }

            expect(saves).not.toHaveBeenCalled();
            expect(stored).toBe(JSON.stringify(presetSpans('Dashboard', 3)));
            const line = document.createElement('div');
            document.body.appendChild(line);
            line.textContent = 'Showing: Dashboard';
            await overlayPanel._markAppliedLayoutDrift(line);
            expect(line.textContent).toBe('Showing: Dashboard');
            saves.mockRestore();
        });

        describe('a panel opened at a width other than the one its spans were written for', () => {
            let widthSpy;
            const widthAs = (width) => widthSpy.mockReturnValue(width);

            beforeEach(() => {
                widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(2040);
            });

            afterEach(() => {
                widthSpy.mockRestore();
            });

            test('applied at nine columns, closed and reopened at two, it has the two-column spans', async () => {
                await overlayPanel.applyNamedLayout('Dashboard');
                expect(overlayPanel.columns).toBe(9);
                overlayPanel.hide();
                const written = [];
                const saves = vi.spyOn(overlayPanel, '_save').mockImplementation(() => {
                    written.push(JSON.stringify(overlayPanel.settings.span));
                });

                widthAs(480);
                overlayPanel.show();
                await new Promise((resolve) => setTimeout(resolve, 60));

                expect(overlayPanel.columns).toBe(2);
                expect(overlayPanel.settings.span).toEqual(presetSpans('Dashboard', 2));
                // Whatever else saved (opening it does), the re-fitted spans were never written
                expect(written).not.toContain(JSON.stringify(overlayPanel.settings.span));
                saves.mockRestore();
            });

            test('stored nine-column spans on a three-column page load become three-column spans, unsaved', async () => {
                await overlayPanel.applyNamedLayout('Dashboard');
                overlayPanel.hide();
                overlayPanel.columns = 0;
                const written = [];
                const saves = vi.spyOn(overlayPanel, '_save').mockImplementation(() => {
                    written.push(JSON.stringify(overlayPanel.settings.span));
                });

                widthAs(660);
                overlayPanel.show();
                await new Promise((resolve) => setTimeout(resolve, 60));

                expect(overlayPanel.columns).toBe(3);
                expect(overlayPanel.settings.span).toEqual(presetSpans('Dashboard', 3));
                // Whatever else saved (opening it does), the re-fitted spans were never written
                expect(written).not.toContain(JSON.stringify(overlayPanel.settings.span));
                saves.mockRestore();
            });

            test('a hand-edited layout is left alone on reopen', async () => {
                await overlayPanel.applyNamedLayout('Dashboard');
                overlayPanel.settings.span = { ...overlayPanel.settings.span, coins: 3 };
                const edited = { ...overlayPanel.settings.span };
                overlayPanel.hide();

                widthAs(480);
                overlayPanel.show();
                await new Promise((resolve) => setTimeout(resolve, 60));

                expect(overlayPanel.settings.span).toEqual(edited);
            });
        });

        test('a window resize that applies the new count first still re-fits the preset', async () => {
            measureAs(660);
            await overlayPanel.applyNamedLayout('Dashboard');
            for (const [width, columns] of [
                [1350, 5],
                [2050, 9],
            ]) {
                measureAs(width);
                overlayPanel._onViewportChange();
                await new Promise((resolve) => setTimeout(resolve, 60));
                expect(overlayPanel.columns).toBe(columns);
                expect(overlayPanel.settings.span).toEqual(presetSpans('Dashboard', columns));
            }
        });

        test('a span edited after the first re-fit stops the re-fitting', async () => {
            measureAs(660);
            await overlayPanel.applyNamedLayout('Dashboard');
            await resizeTo(1350);
            expect(overlayPanel.settings.span).toEqual(presetSpans('Dashboard', 5));

            overlayPanel.settings.span = { ...overlayPanel.settings.span, netWorth: 4 };
            const edited = { ...overlayPanel.settings.span };
            await resizeTo(2050);

            expect(overlayPanel.columns).toBe(9);
            expect(overlayPanel.settings.span).toEqual(edited);
        });

        test('a preset the player edited keeps the spans it has', async () => {
            measureAs(480);
            await overlayPanel.applyNamedLayout('Skilling');
            overlayPanel.settings.zoom = { coins: 130 };
            const before = { ...overlayPanel.settings.span };

            await resizeTo(2040);

            expect(overlayPanel.columns).toBe(9);
            expect(overlayPanel.settings.span).toEqual(before);
        });

        test('a hand-edited span keeps the spans it has', async () => {
            measureAs(480);
            await overlayPanel.applyNamedLayout('Skilling');
            overlayPanel.settings.span = { ...overlayPanel.settings.span, coins: 2 };
            const before = { ...overlayPanel.settings.span };

            await resizeTo(640);

            expect(overlayPanel.columns).toBe(3);
            expect(overlayPanel.settings.span).toEqual(before);
        });

        test('a saved layout named like a preset keeps its own spans', async () => {
            measureAs(480);
            wear({ ...dungeonLayout(), columns: 2, columnsPinned: false });
            await overlayPanel.saveNamedLayout('Skilling');
            await overlayPanel.applyNamedLayout('Skilling');

            await resizeTo(2040);

            expect(overlayPanel.columns).toBe(9);
            expect(overlayPanel.settings.span).toEqual({ luck: 2 });
        });

        test('a layout of their own keeps its spans', async () => {
            measureAs(480);
            wear({ ...dungeonLayout(), columns: 2, columnsPinned: false });
            await overlayPanel.saveNamedLayout('Mine');
            await overlayPanel.applyNamedLayout('Mine');

            await resizeTo(2040);

            expect(overlayPanel.settings.span).toEqual({ luck: 2 });
        });

        test('a hand-set column count is not changed by a resize, and neither are the spans', async () => {
            measureAs(480);
            overlayPanel.settings.columns = 2;
            overlayPanel.settings.columnsPinned = true;
            await overlayPanel.applyNamedLayout('Skilling');
            const before = { ...overlayPanel.settings.span };

            await resizeTo(2040);

            expect(overlayPanel.columns).toBe(2);
            expect(overlayPanel.settings.columns).toBe(2);
            expect(overlayPanel.settings.span).toEqual(before);
        });
    });

    test('a hand-set column count of six or nine is kept and the preset is built for it', async () => {
        measureAs(380);
        for (const columns of [6, 9]) {
            overlayPanel.settings.columns = columns;
            overlayPanel.settings.columnsPinned = true;
            await overlayPanel.applyNamedLayout('Market');
            expect(overlayPanel.settings.columns).toBe(columns);
            expect(overlayPanel.settings.columnsPinned).toBe(true);
            expect(overlayPanel.columns).toBe(columns);
            expect(overlayPanel.settings.span).toEqual(presetSpans('Market', columns));
        }
    });

    test('a phone gets one column and the spans clamp, as before', async () => {
        measureAs(200);
        await overlayPanel.applyNamedLayout('Skilling');
        expect(overlayPanel.columns).toBe(1);
        expect(overlayPanel.settings.span).toEqual({ consumables: 2 });
        expect(overlayPanel.settings.columnsPinned).toBe(false);
    });

    test('a saved layout named like a preset keeps its own spans on a wide panel', async () => {
        measureAs(2040);
        wear({ ...dungeonLayout(), columns: 2, columnsPinned: false });
        await overlayPanel.saveNamedLayout('Combat');
        await overlayPanel.applyNamedLayout('Combat');
        expect(overlayPanel.settings.span).toEqual({ luck: 2 });
    });

    test('an exported wide preset re-imports with the same spans, flat and numeric', async () => {
        measureAs(2040);
        await overlayPanel.applyNamedLayout('Market');
        const exported = JSON.parse(JSON.stringify(toOPanelConfig(overlayPanel.settings, null)));
        const read = fromOPanelConfig(exported);

        expect(read.settings.span).toEqual(presetSpans('Market', 9));
        for (const wide of Object.values(read.settings.span)) expect(Number.isInteger(wide)).toBe(true);
    });

    test('a preset applied on a wide grid is not reported as edited, now or on a narrower panel', async () => {
        measureAs(2040);
        await overlayPanel.applyNamedLayout('Dashboard');
        const line = document.createElement('div');
        document.body.appendChild(line);
        line.textContent = 'Showing: Dashboard';
        await overlayPanel._markAppliedLayoutDrift(line);
        expect(line.textContent).toBe('Showing: Dashboard');

        measureAs(900);
        await overlayPanel._markAppliedLayoutDrift(line);
        expect(line.textContent).toBe('Showing: Dashboard');

        overlayPanel.settings.span = { ...overlayPanel.settings.span, coins: 4 };
        await overlayPanel._markAppliedLayoutDrift(line);
        expect(line.textContent).toBe('Showing: Dashboard (edited)');
    });

    test('a preset applied under a held pin is not reported as edited, and re-fits once the pin is cleared', async () => {
        measureAs(2040);
        overlayPanel.settings.columns = 3;
        overlayPanel.settings.columnsPinned = true;
        await overlayPanel.applyNamedLayout('Dense');
        const line = document.createElement('div');
        document.body.appendChild(line);
        line.textContent = 'Showing: Dense';
        await overlayPanel._markAppliedLayoutDrift(line);
        expect(line.textContent).toBe('Showing: Dense');

        // Pressing "auto" clears the pin and leaves the count where it was
        overlayPanel.settings.columnsPinned = false;
        await overlayPanel._markAppliedLayoutDrift(line);
        expect(line.textContent).toBe('Showing: Dense');
        overlayPanel._applyColumns();
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(overlayPanel.columns).toBe(9);
        expect(overlayPanel.settings.span).toEqual(presetSpans('Dense', 9));
    });

    test('Dense applies its twenty-two tiles with the nine-column spans, and keeps a count set by hand', async () => {
        measureAs(2040);
        await overlayPanel.applyNamedLayout('Dense');
        expect(overlayPanel.columns).toBe(9);
        expect(overlayPanel.settings.span).toEqual(presetSpans('Dense', 9));
        expect(overlayPanel.settings.span.totalProfit).toBe(5);
        expect(overlayPanel.settings.order).toHaveLength(22);

        overlayPanel.settings.columns = 3;
        overlayPanel.settings.columnsPinned = true;
        await overlayPanel.applyNamedLayout('Dense');
        expect(overlayPanel.columns).toBe(3);
        expect(overlayPanel.settings.columnsPinned).toBe(true);
        expect(overlayPanel.settings.span).toEqual(presetSpans('Dense', 3));
    });

    describe('Dense on a narrow panel', () => {
        /** Resize the panel and let the coalesced redraw and the refit run. @param {number} width - Pixels */
        async function resizeTo(width) {
            measureAs(width);
            overlayPanel._onPanelResized();
            await new Promise((resolve) => setTimeout(resolve, 60));
        }

        test('applied on the 378px panel it gets three narrow columns and its three-column spans', async () => {
            measureAs(378);
            await overlayPanel.applyNamedLayout('Dense');
            expect(overlayPanel.columns).toBe(3);
            expect(overlayPanel.settings.span).toEqual(presetSpans('Dense', 3));
            // What is stored is what any preset stores: the count stays advisory and unpinned
            expect(overlayPanel.settings.columns).toBe(2);
            expect(overlayPanel.settings.columnsPinned).toBe(false);
        });

        test('from two ordinary columns up it has the nine columns of the layout it copies', async () => {
            for (const width of [480, 876, 1350]) {
                measureAs(width);
                await overlayPanel.applyNamedLayout('Dense');
                expect(overlayPanel.columns).toBe(9);
                expect(overlayPanel.settings.span).toEqual(presetSpans('Dense', 9));
            }
        });

        describe('a Dense applied under 3.77.0', () => {
            /** Wear the 3.77.0 Dense as applied at three columns, then open the panel at 876px */
            async function openWithOldDense(edit = {}, { appendHidden = false } = {}) {
                for (const key of [...PRESET_LAYOUTS.Dense.order, 'houses', 'skillLevel'])
                    registerRow({ key, name: key, render: (el) => (el.textContent = key) });
                measureAs(876);
                await overlayPanel.applyNamedLayout('Dense');
                const [old] = legacyPresetFiles('Dense', { columns: 3 });
                const { order, span, visible } = fromOPanelConfig(old).settings;
                // A live page's stored copy: every other tile appended hidden, keys in another order
                const extra = appendHidden ? ['skillLevel', 'noticeLog', 'accountView'] : [];
                const stored = appendHidden
                    ? Object.fromEntries([...extra.map((key) => [key, false]), ...Object.entries(visible)].reverse())
                    : visible;
                wear({
                    order: [...order, ...extra.filter((key) => !order.includes(key))],
                    span: { ...span, ...edit },
                    visible: stored,
                });
                overlayPanel._checkPresetFit();
                await new Promise((resolve) => setTimeout(resolve, 60));
            }

            test('untouched, it becomes the current Dense with its nine-column widths and new tiles', async () => {
                await openWithOldDense();
                expect(overlayPanel.columns).toBe(9);
                expect(overlayPanel.settings.order).toEqual(PRESET_LAYOUTS.Dense.order);
                expect(overlayPanel.settings.span).toEqual(presetSpans('Dense', 9));
                expect(overlayPanel.appliedLayout).toBe('Dense');
            });

            test('stored the way a live page keeps it, other tiles appended hidden, it is still recognised', async () => {
                await openWithOldDense({}, { appendHidden: true });
                expect(overlayPanel.settings.span).toEqual(presetSpans('Dense', 9));
                expect(overlayPanel.settings.visible.charmValue).toBe(true);
            });

            test('edited by hand, it is left as it is', async () => {
                await openWithOldDense({ coins: 3 });
                expect(overlayPanel.settings.order).toHaveLength(20);
                expect(overlayPanel.settings.span.coins).toBe(3);
            });
        });

        test('a two-column preset on the same panel is one column, as before', async () => {
            measureAs(378);
            await overlayPanel.applyNamedLayout('Dashboard');
            expect(overlayPanel.columns).toBe(1);
            await overlayPanel.applyNamedLayout('Combat');
            expect(overlayPanel.columns).toBe(1);
        });

        test('a column count pinned by hand still wins', async () => {
            measureAs(378);
            overlayPanel.settings.columns = 1;
            overlayPanel.settings.columnsPinned = true;
            await overlayPanel.applyNamedLayout('Dense');
            expect(overlayPanel.columns).toBe(1);
        });

        test('re-fits as the panel narrows and widens: 9, 3, 2, 1, 3, unsaved', async () => {
            measureAs(2040);
            await overlayPanel.applyNamedLayout('Dense');
            expect(overlayPanel.columns).toBe(9);
            const saves = vi.spyOn(overlayPanel, '_save');

            for (const [width, columns] of [
                [378, 3],
                [300, 2],
                [220, 1],
                [378, 3],
            ]) {
                await resizeTo(width);
                expect(overlayPanel.columns).toBe(columns);
                expect(overlayPanel.settings.span).toEqual(presetSpans('Dense', columns));
            }
            expect(saves).not.toHaveBeenCalled();
            saves.mockRestore();
        });

        test('a span wider than the narrow grid is clamped to it', async () => {
            registerRow({ key: 'totalProfit', name: 'Profit', render: (el) => (el.textContent = 'profit') });
            measureAs(2040);
            await overlayPanel.applyNamedLayout('Dense');
            // Edited, so the re-fit leaves it alone and the stored 5 reaches the grid
            overlayPanel.settings.span = { ...overlayPanel.settings.span, totalProfit: 5, dps: 7 };
            await resizeTo(378);
            expect(overlayPanel.columns).toBe(3);
            expect(overlayPanel.settings.span.totalProfit).toBe(5);
            const spans = Object.fromEntries(overlayPanel._visibleRows().map((row) => [row.key, row.span]));
            expect(spans.totalProfit).toBe(3);
            expect(spans.dps).toBe(3);
        });
    });

    test('a saved layout named Dense shadows the preset, and the switcher lists it once', async () => {
        measureAs(2040);
        wear({ ...dungeonLayout(), columns: 2, columnsPinned: false });
        await overlayPanel.saveNamedLayout('Dense');
        await overlayPanel.applyNamedLayout('Dense');
        expect(overlayPanel.settings.span).toEqual({ luck: 2 });
        expect(await overlayPanel.listLayouts()).toEqual(['Dense']);
    });

    test('a switch can be taken back', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        wear(marketLayout());

        await overlayPanel.applyNamedLayout('Dungeon');
        expect(overlayPanel.undoState.what).toBe('switch to Dungeon');

        overlayPanel._undo();
        expect(worn().order).toEqual(['luck', 'dps']);
    });

    test('undoing a named-layout switch restores the previously active layout name', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        wear(marketLayout());
        await overlayPanel.saveNamedLayout('Market');

        await overlayPanel.applyNamedLayout('Dungeon');
        await overlayPanel.applyNamedLayout('Market');
        expect(overlayPanel.appliedLayout).toBe('Market');

        overlayPanel._undo();
        expect(overlayPanel.appliedLayout).toBe('Dungeon');

        overlayPanel.openPicker();
        await overlayPanel._refreshLayoutNames();
        expect(overlayPanel.pickerEl.querySelector('[data-overlay-active-layout]').textContent).toBe(
            'Showing: Dungeon'
        );
        expect(
            [...overlayPanel.pickerEl.querySelectorAll('button')].some(
                (button) => button.textContent === 'Update "Dungeon"'
            )
        ).toBe(true);
    });

    test('undoing a preset switch restores the absence of an active layout', async () => {
        wear(marketLayout());

        await overlayPanel.applyNamedLayout('Dashboard');
        expect(overlayPanel.appliedLayout).toBe('Dashboard');

        overlayPanel._undo();
        expect(overlayPanel.appliedLayout).toBeNull();

        overlayPanel.openPicker();
        await overlayPanel._refreshLayoutNames();
        expect(overlayPanel.pickerEl.querySelector('[data-overlay-active-layout]')).toBeNull();
        expect(
            [...overlayPanel.pickerEl.querySelectorAll('button')].some((button) =>
                button.textContent.startsWith('Update')
            )
        ).toBe(false);
    });

    test('undoing an import retains the active layout metadata captured before the import', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.applyNamedLayout('Dungeon');

        await overlayPanel._applyLayout({ settings: marketLayout(), geometry: null }, 'Import');

        expect(overlayPanel.appliedLayout).toBe('Dungeon');
        overlayPanel._undo();
        expect(overlayPanel.appliedLayout).toBe('Dungeon');
        expect(worn().order).toEqual(['dps', 'luck']);
    });

    test('undoing Reset restores the active layout metadata captured before Reset', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.applyNamedLayout('Dungeon');
        dialog.answer = 'reset';

        await overlayPanel._resetLayout();

        expect(overlayPanel.appliedLayout).toBeNull();
        overlayPanel._undo();
        expect(overlayPanel.appliedLayout).toBe('Dungeon');
    });

    test('taking a switch back puts the column count and its pin back too', async () => {
        // The restored spans were written for the old grid; left on the new
        // layout's count they are a two-column arrangement drawn on ten columns
        // - and the next export would persist the mismatch
        wear({ ...dungeonLayout(), columns: 9, columnsPinned: true });
        await overlayPanel.saveNamedLayout('Wide');
        wear({ ...marketLayout(), columns: 2, columnsPinned: false });

        await overlayPanel.applyNamedLayout('Wide');
        expect(overlayPanel.settings.columns).toBe(9);

        overlayPanel._undo();

        expect(overlayPanel.settings.columns).toBe(2);
        expect(overlayPanel.settings.columnsPinned).toBe(false);
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
            'Dashboard · preset',
            'Dense · preset',
        ]);
    });

    test('the layout in force gets a one-press Update button that resaves it', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.applyNamedLayout('Dungeon');

        // Drift the screen from the saved copy
        overlayPanel.settings.span = { ...overlayPanel.settings.span, battleTimer: 3 };

        overlayPanel.pickerEl.style.display = '';
        await overlayPanel._refreshLayoutNames();

        const update = [...overlayPanel.pickerEl.querySelectorAll('button')].find((b) =>
            b.textContent.startsWith('Update')
        );
        expect(update.textContent).toBe('Update "Dungeon"');

        update.click();
        await vi.waitFor(async () => {
            const { loadLayouts } = await import('./overlay-layouts.js');
            const map = await loadLayouts();
            expect(map.Dungeon.file.toolasha.settings.span.battleTimer).toBe(3);
        });
    });

    test('the active-layout line says when the screen has drifted from the saved copy', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.applyNamedLayout('Dungeon');

        overlayPanel.pickerEl.style.display = '';
        await overlayPanel._refreshLayoutNames();
        let active = overlayPanel.pickerEl.querySelector('[data-overlay-active-layout]');
        // Unchanged: the drift check settles without annotating
        await vi.waitFor(() => expect(active.textContent).toBe('Showing: Dungeon'));

        overlayPanel.settings.span = { ...overlayPanel.settings.span, battleTimer: 3 };
        await overlayPanel._refreshLayoutNames();
        active = overlayPanel.pickerEl.querySelector('[data-overlay-active-layout]');
        await vi.waitFor(() => expect(active.textContent).toBe('Showing: Dungeon (edited)'));
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
            'Dashboard · preset',
            'Dense · preset',
        ]);
    });
});
