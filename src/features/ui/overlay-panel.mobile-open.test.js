/**
 * @vitest-environment happy-dom
 *
 * Whether the overlay reopens itself after a reload.
 *
 * On a phone the panel covers most of the screen, so a refresh must not bring it back; the saved
 * "open" flag is left alone so a desktop on the same synced settings still reopens it.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mobile = vi.hoisted(() => ({ mode: 'off' }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (key, fallback) => (key === 'mobileMode' ? mobile.mode : fallback),
        Z_HUD: 50,
        Z_FLOATING_PANEL: 1100,
        Z_POPUP: 9000,
    },
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
    restoreGeometry: async () => {},
    saveGeometry: async () => {},
    clearGeometry: async () => {},
    allGeometry: async () => ({}),
}));
vi.mock('../../utils/floating-panel.js', () => ({
    panelHeightCap: (px, fraction = 0.8) =>
        `min(${px}px, calc(var(--toolasha-visual-viewport-height, 100vh) * ${fraction}))`,
    makeDraggable: () => () => {},
    makeResizable: () => () => {},
}));
vi.mock('../../utils/opanel-config.js', () => ({ fromOPanelConfig: () => null, toOPanelConfig: () => ({}) }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => null }));

const saved = vi.hoisted(() => ({ read: null, written: null }));
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_scoped`,
    readScopedFrom: async (key) => (key === 'overlayPanelV2' ? saved.read : null),
    readScoped: async (key) => (key === 'overlayPanelV2' ? saved.read : null),
    writeScoped: async (key, value) => {
        saved.written = value;
    },
}));

const overlayPanel = (await import('./overlay-panel.js')).default;

beforeEach(() => {
    saved.read = { visible: {}, order: [], span: {}, zoom: {}, locked: true, open: true };
    saved.written = null;
    mobile.mode = 'off';
    document.body.replaceChildren();
    overlayPanel.isInitialized = false;
});

afterEach(() => {
    overlayPanel.hide();
    overlayPanel.isInitialized = false;
});

describe('reopening after a reload', () => {
    test('a desktop reopens an overlay that was left open', async () => {
        await overlayPanel.initialize();
        expect(overlayPanel.isOpen).toBe(true);
    });

    test('a phone starts with it closed', async () => {
        mobile.mode = 'on';
        await overlayPanel.initialize();
        expect(overlayPanel.isOpen).toBe(false);
    });

    test('a phone keeps the saved open flag and can still open it', async () => {
        mobile.mode = 'on';
        await overlayPanel.initialize();
        expect(overlayPanel.settings.open).toBe(true);
        overlayPanel.toggle();
        expect(overlayPanel.isOpen).toBe(true);
    });

    test('a closed overlay stays closed on a desktop', async () => {
        saved.read.open = false;
        await overlayPanel.initialize();
        expect(overlayPanel.isOpen).toBe(false);
    });
});
