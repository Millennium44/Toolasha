import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ owner: 'alice', enabled: true }));
const tracker = vi.hoisted(() => ({ initialize: vi.fn(async () => {}), disable: vi.fn() }));
const ui = vi.hoisted(() => ({ initialize: vi.fn(), cleanup: vi.fn() }));
const handlers = vi.hoisted(() => ({ setup: vi.fn(), cleanup: vi.fn() }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => state.enabled } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => state.owner } }));
vi.mock('./enhancement-tracker.js', () => ({ default: tracker }));
vi.mock('./enhancement-ui.js', () => ({ default: ui }));
vi.mock('./enhancement-handlers.js', () => ({
    setupEnhancementHandlers: handlers.setup,
    cleanupEnhancementHandlers: handlers.cleanup,
}));
import feature from './enhancement-feature.js';

function deferred() {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
}
beforeEach(() => {
    feature.disable();
    vi.clearAllMocks();
    state.owner = 'alice';
    state.enabled = true;
});
afterEach(() => feature.disable());

describe('the enhancement wrapper does not revive retired startup work', () => {
    test('disable during tracker initialization keeps listeners and UI stopped', async () => {
        const gate = deferred();
        tracker.initialize.mockReturnValueOnce(gate.promise);
        const starting = feature.initialize();
        feature.disable();
        gate.resolve();
        await starting;
        expect(handlers.setup).not.toHaveBeenCalled();
        expect(ui.initialize).not.toHaveBeenCalled();
        expect(feature.isInitialized).toBe(false);
    });

    test('a newer startup owns its listeners when the old one finally settles', async () => {
        const gate = deferred();
        tracker.initialize.mockReturnValueOnce(gate.promise);
        const oldStart = feature.initialize();
        feature.disable();
        state.owner = 'bob';
        await feature.initialize();
        gate.resolve();
        await oldStart;
        expect(handlers.setup).toHaveBeenCalledTimes(1);
        expect(ui.initialize).toHaveBeenCalledTimes(1);
        expect(feature.isInitialized).toBe(true);
    });

    test('a setting turned off during tracker initialization prevents setup and allows a later restart', async () => {
        const gate = deferred();
        tracker.initialize.mockReturnValueOnce(gate.promise);
        const starting = feature.initialize();
        state.enabled = false;
        gate.resolve();
        await starting;
        expect(handlers.setup).not.toHaveBeenCalled();
        expect(ui.initialize).not.toHaveBeenCalled();
        state.enabled = true;
        await feature.initialize();
        expect(handlers.setup).toHaveBeenCalledTimes(1);
        expect(ui.initialize).toHaveBeenCalledTimes(1);
    });

    test('ordinary repeated initialization attaches one set of handlers and UI', async () => {
        await feature.initialize();
        await feature.initialize();
        expect(handlers.setup).toHaveBeenCalledTimes(1);
        expect(ui.initialize).toHaveBeenCalledTimes(1);
    });
});
