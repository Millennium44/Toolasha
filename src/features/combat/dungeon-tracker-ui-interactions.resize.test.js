/**
 * @vitest-environment happy-dom
 *
 * Dungeon tracker resize grip: the saved size works with the screen-height cap, an unresized
 * tracker stays auto-sized, the reset button returns to auto, and a collapsed tracker neither
 * holds a saved height nor saves a resize.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const geometry = vi.hoisted(() => ({
    saveGeometry: vi.fn(async () => {}),
    clearGeometry: vi.fn(async () => {}),
    clearSize: vi.fn(async () => {}),
    savedSize: vi.fn(async () => null),
    markPanelInteracted: vi.fn(),
}));

vi.mock('./dungeon-tracker.js', () => ({
    default: { getCurrentRun: vi.fn(() => null), getPendingDungeon: vi.fn(() => null) },
}));
vi.mock('./dungeon-tracker-chat-annotations.js', () => ({ default: { refreshRunCounts: vi.fn() } }));
vi.mock('../../core/config.js', () => ({ default: { Z_NOTIFICATION: 9999, Z_HUD: 1, Z_FLOATING_PANEL: 2 } }));
vi.mock('./dungeon-tracker-storage.js', () => ({ default: {} }));
vi.mock('../../utils/panel-z-index.js', () => ({ bringPanelToFront: vi.fn() }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: vi.fn() }));
vi.mock('../../utils/panel-geometry.js', () => geometry);

const { default: Interactions, GEOMETRY_KEY } = await import('./dungeon-tracker-ui-interactions.js');

function setup({ isCollapsed = false, position = null } = {}) {
    const container = document.createElement('div');
    container.innerHTML = '<div id="mwi-dt-content"></div><button id="mwi-dt-reset-position-btn"></button>';
    document.body.appendChild(container);
    // happy-dom's CSS parser drops min(); a plain object keeps what was assigned
    Object.defineProperty(container, 'style', { value: { width: '', height: '' }, configurable: true });
    container.getBoundingClientRect = () => ({ left: 40, top: 30, width: 500, height: 400, right: 540, bottom: 430 });
    const state = {
        isCollapsed,
        position,
        save: vi.fn(),
        updatePosition: vi.fn(),
        heightCap: (top) => `calc(100vh - ${top}px)`,
    };
    const interactions = new Interactions(state, null, null);
    interactions.container = container;
    interactions.callbacks = {};
    return { container, state, interactions };
}

const drag = (container, dx, dy) => {
    const grip = container.querySelector('.toolasha-resize-grip');
    grip.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 }));
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 100 + dx, clientY: 100 + dy }));
    document.dispatchEvent(new MouseEvent('pointerup', { clientX: 100 + dx, clientY: 100 + dy }));
};

beforeEach(() => {
    document.body.innerHTML = '';
    Object.values(geometry).forEach((fn) => fn.mockClear());
    geometry.savedSize.mockResolvedValue(null);
});

describe('dungeon tracker resize grip', () => {
    test('adds one grip, stays auto-sized until dragged, and re-setup does not duplicate it', async () => {
        const { container, interactions } = setup();
        interactions.setupResize();
        interactions.setupResize();
        await Promise.resolve();
        expect(container.querySelectorAll('.toolasha-resize-grip')).toHaveLength(1);
        expect(container.style.width).toBe('');
        expect(container.style.height).toBe('');
    });

    test('a drag saves the size under the panelGeometry key and applies it capped by screen and height cap', () => {
        const { container, interactions } = setup();
        interactions.setupResize();
        drag(container, 50, 60);

        expect(geometry.saveGeometry).toHaveBeenCalledWith(GEOMETRY_KEY, { width: 500, height: 400 });
        expect(container.style.width).toBe('min(500px, calc(100vw - 20px))');
        expect(container.style.height).toBe('min(400px, calc(100vh - 30px))');
    });

    test('a saved size is restored with the same caps, and re-applied on a window resize', async () => {
        geometry.savedSize.mockResolvedValue({ width: 700, height: 900 });
        const { container, interactions } = setup();
        interactions.setupResize();
        await vi.waitFor(() => expect(container.style.height).toBe('min(900px, calc(100vh - 30px))'));
        expect(container.style.width).toBe('min(700px, calc(100vw - 20px))');

        container.style.height = '';
        interactions.setupKeepOnScreen();
        window.dispatchEvent(new Event('resize'));
        expect(container.style.height).toBe('min(900px, calc(100vh - 30px))');
        interactions.cleanup();
    });

    test('the reset button clears the saved size and the inline width and height', () => {
        const { container, interactions } = setup();
        interactions.setupResize();
        interactions.setupResetPositionButton();
        drag(container, 10, 10);
        expect(container.style.height).not.toBe('');

        container.querySelector('#mwi-dt-reset-position-btn').click();

        expect(geometry.clearSize).toHaveBeenCalledWith(GEOMETRY_KEY);
        expect(geometry.clearGeometry).not.toHaveBeenCalled();
        expect(container.style.width).toBe('');
        expect(container.style.height).toBe('');
        expect(interactions.userSize).toBeNull();
    });

    test('the first drag drops the 480px floor so it can narrow, and pins a centered panel to pixels', () => {
        const { container, state, interactions } = setup();
        container.style.transform = 'translateX(-50%)';
        container.style.minWidth = 'min(480px, calc(100vw - 20px))';
        interactions.setupResize();
        const grip = container.querySelector('.toolasha-resize-grip');
        grip.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 }));
        // Pressing alone lifts and moves nothing
        expect(container.style.minWidth).toBe('min(480px, calc(100vw - 20px))');
        expect(container.style.transform).toBe('translateX(-50%)');
        document.dispatchEvent(new MouseEvent('pointermove', { clientX: 120, clientY: 130 }));
        expect(container.style.minWidth).toBe('min(250px, calc(100vw - 20px))');
        expect(container.style.transform).toBe('none');
        expect(container.style.left).toBe('40px');
        expect(container.style.top).toBe('30px');
        // Measured on press (500x400) plus the delta
        expect(container.style.width).toBe('520px');
        expect(container.style.height).toBe('430px');
        // Visual only: the remembered position is not touched
        expect(state.position).toBeNull();
        document.dispatchEvent(new MouseEvent('pointerup', { clientX: 120, clientY: 130 }));
    });

    test('a tap on the grip lifts nothing and saves nothing', () => {
        const { container, interactions } = setup();
        container.style.transform = 'translateX(-50%)';
        container.style.minWidth = 'min(480px, calc(100vw - 20px))';
        interactions.setupResize();
        const grip = container.querySelector('.toolasha-resize-grip');
        grip.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 }));
        document.dispatchEvent(new MouseEvent('pointerup', { clientX: 100, clientY: 100 }));
        expect(container.style.minWidth).toBe('min(480px, calc(100vw - 20px))');
        expect(container.style.transform).toBe('translateX(-50%)');
        expect(geometry.saveGeometry).not.toHaveBeenCalled();
    });

    test('the grip double-click resets the size, restoring the auto floor', () => {
        const { container, interactions } = setup();
        interactions.setupResize();
        drag(container, 10, 10);
        container.querySelector('.toolasha-resize-grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(geometry.clearSize).toHaveBeenCalledWith(GEOMETRY_KEY);
        expect(container.style.height).toBe('');
        expect(container.style.minWidth).toBe('min(480px, calc(100vw - 20px))');
    });

    test('dropping a header drag re-applies the height cap for the new top', () => {
        const { container, state, interactions } = setup({ position: { x: 40, y: 30 } });
        interactions.setupResize();
        drag(container, 10, 10);
        expect(container.style.height).toBe('min(400px, calc(100vh - 30px))');
        container.getBoundingClientRect = () => ({
            left: 40,
            top: 200,
            width: 500,
            height: 400,
            right: 540,
            bottom: 600,
        });
        interactions.isDragging = true;
        interactions.container.querySelector = (sel) =>
            sel === '#mwi-dt-header' ? { style: {}, addEventListener: () => {} } : null;
        interactions.dragUpHandler = null;
        interactions.setupDragging();
        interactions.dragUpHandler();
        expect(container.style.height).toBe('min(400px, calc(100vh - 200px))');
        expect(state.save).toHaveBeenCalled();
    });

    test('collapsing drops the inline size, expanding brings it back, and a collapsed resize is not saved', () => {
        const { container, state, interactions } = setup();
        interactions.setupResize();
        drag(container, 10, 10);
        geometry.saveGeometry.mockClear();

        interactions.toggleCollapse();
        expect(state.isCollapsed).toBe(true);
        expect(container.style.height).toBe('');
        expect(container.style.width).toBe('');
        expect(container.querySelector('.toolasha-resize-grip').style.display).toBe('none');

        interactions.onUserResize({ width: 300, height: 90 });
        expect(geometry.saveGeometry).not.toHaveBeenCalled();

        interactions.toggleCollapse();
        expect(container.style.height).toBe('min(400px, calc(100vh - 30px))');
        expect(container.querySelector('.toolasha-resize-grip').style.display).toBe('');
    });

    test('cleanup removes the grip', () => {
        const { container, interactions } = setup();
        interactions.setupResize();
        interactions.cleanup();
        expect(container.querySelector('.toolasha-resize-grip')).toBeNull();
    });

    test('a restore that lands after cleanup does nothing', async () => {
        let release;
        geometry.savedSize.mockReturnValue(new Promise((r) => (release = r)));
        const { container, interactions } = setup();
        interactions.setupResize();
        interactions.cleanup();
        interactions.container = null;
        release({ width: 700, height: 500 });
        await Promise.resolve();
        await Promise.resolve();
        expect(container.style.width).toBe('');
        expect(interactions.userSize).toBeNull();
    });
});
