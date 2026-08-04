/** @vitest-environment happy-dom
 *
 * Where the Lab Sim panel opens, and whether it stays there.
 *
 * It used to hardcode `top:60px; right:60px` on every build and throw away the
 * result of both its resize grips, so a panel you dragged somewhere useful was
 * back in the top-right corner on the next reload. These tests are about the
 * geometry store now doing that remembering, not about anything the simulator
 * computes.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const geometry = vi.hoisted(() => ({ saved: null, restoreCalls: [], saveCalls: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 100,
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
        setSetting: () => {},
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (_key, _store, fallback) => fallback,
        set: async () => {},
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ abilityDetailMap: {} }),
        getItemDetails: () => null,
        getSkills: () => [],
        characterItems: [],
        characterEquipment: new Map(),
        characterData: { characterAbilities: [] },
    },
}));

vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));

// The store itself lives in IndexedDB. What matters here is that the panel asks
// it, and hands it back what a drag or a resize produced — so the mock applies a
// geometry the way the real one does and records what it is told.
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: async (panel, panelKey, min) => {
        geometry.restoreCalls.push({ panelKey, min });
        const saved = geometry.saved;
        if (!saved || !panel) return;
        if (saved.width) panel.style.width = `${saved.width}px`;
        if (saved.height) panel.style.height = `${saved.height}px`;
        if (saved.left !== undefined) {
            panel.style.left = `${saved.left}px`;
            panel.style.top = `${saved.top}px`;
            panel.style.right = 'auto';
        }
    },
    saveGeometry: async (panelKey, values) => {
        geometry.saveCalls.push({ panelKey, values });
    },
}));

vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => ({ itemDetailMap: {} }),
    buildAllPlayerDTOs: async () => ({ players: [] }),
    getCombatZones: () => [],
    getCommunityBuffs: () => ({}),
    getLabyrinthMonsters: () => [],
}));

vi.mock('./combat-sim-runner.js', () => ({
    runLabyrinthSimulation: async () => ({}),
    cancelSimulation: () => {},
}));

vi.mock('./sim-editor.js', () => ({
    SimEditor: class {
        isInitialized() {
            return true;
        }
        initEditor() {}
        reset() {}
    },
}));

// The upgrade-row handoff buttons come from the combat sim panel, which brings
// two module-scope inventory panels with it. This file is about where the lab
// panel opens, so it borrows the vocabulary and none of the furniture
vi.mock('./combat-sim-ui.js', () => ({
    default: {
        upgradeRowPurchase: () => null,
        upgradeRowActionsHtml: () => '',
        wireUpgradeRowActions: () => {},
    },
}));

vi.mock('../combat/labyrinth-clear-rate.js', () => ({ default: {} }));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: { get: () => null } }));

const { default: ui } = await import('./lab-sim-ui.js');

/** A pointer event happy-dom will hand to the drag helper's listeners. */
function pointer(type, x, y) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, button: 0 });
    return event;
}

describe('the Lab Sim panel remembers where it was left', () => {
    beforeEach(() => {
        geometry.saved = null;
        geometry.restoreCalls = [];
        geometry.saveCalls = [];
    });

    afterEach(() => {
        ui.destroy();
    });

    test('with nothing saved it opens at its designed corner', async () => {
        ui.buildPanel();
        await Promise.resolve();

        expect(ui.panel.style.right).toBe('60px');
        expect(ui.panel.style.top).toBe('60px');
        // The viewport-clamped `min(900px, 96vw)` from the stylesheet still
        // governs the size — nothing has overwritten it with a pixel figure
        expect(ui.panel.style.width).not.toMatch(/px/);
    });

    test('a saved geometry wins over the corner it would otherwise open at', async () => {
        geometry.saved = { left: 120, top: 40, width: 640, height: 480 };

        ui.buildPanel();
        await Promise.resolve();

        expect(ui.panel.style.left).toBe('120px');
        expect(ui.panel.style.top).toBe('40px');
        expect(ui.panel.style.width).toBe('640px');
        expect(ui.panel.style.height).toBe('480px');
        // Anchoring by the left edge from here on, or a window resize moves it
        expect(ui.panel.style.right).toBe('auto');
    });

    test('it asks the store under its own key, with its own floor size', async () => {
        ui.buildPanel();
        await Promise.resolve();

        expect(geometry.restoreCalls[0]).toMatchObject({
            panelKey: 'labSimPanel',
            min: { width: 400, height: 300 },
        });
    });

    test('dropping it somewhere writes that somewhere down', async () => {
        ui.buildPanel();
        await Promise.resolve();

        const header = ui.panel.firstChild;
        header.dispatchEvent(pointer('pointerdown', 200, 100));
        document.dispatchEvent(pointer('pointermove', 260, 180));
        document.dispatchEvent(pointer('pointerup', 260, 180));

        expect(geometry.saveCalls).toHaveLength(1);
        expect(geometry.saveCalls[0].panelKey).toBe('labSimPanel');
        expect(geometry.saveCalls[0].values).toMatchObject({ left: 60, top: 80 });
    });

    test('a click on the header that never moved is not a move worth saving', async () => {
        ui.buildPanel();
        await Promise.resolve();

        const header = ui.panel.firstChild;
        header.dispatchEvent(pointer('pointerdown', 200, 100));
        document.dispatchEvent(pointer('pointerup', 200, 100));

        expect(geometry.saveCalls).toHaveLength(0);
    });

    test('the panel is not reopened on load — a simulator opens when asked', async () => {
        ui.buildPanel();
        await Promise.resolve();

        // Deliberate: `panel-geometry.js` can remember an open panel, and this
        // one does not ask it to
        expect(ui.panel.style.display).toBe('none');
    });
});
