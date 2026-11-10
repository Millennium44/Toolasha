/**
 * Net Worth hands its expensive startup work to the shared idle queue. A
 * teardown can land before that queue runs, or between any of its awaited
 * calculations/recorders. Retired startup work must not restore those services.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ characterId: 'alice', jobs: [], connected: true, optionalServices: true }));
const steps = vi.hoisted(() => ({
    calculation: vi.fn(),
    history: vi.fn(),
    production: vi.fn(),
    chests: vi.fn(),
    combat: vi.fn(),
    itemFlow: vi.fn(),
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => state.characterId, on: vi.fn(), off: vi.fn() },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        isFeatureEnabled: () => false,
        getSetting: () => state.optionalServices,
        onSettingChange: vi.fn(),
        offSettingChange: vi.fn(),
    },
}));
vi.mock('../../core/connection-state.js', () => ({ default: { isConnected: () => state.connected } }));
vi.mock('../../api/marketplace.js', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../utils/performance-monitor.js', () => ({
    default: { enabled: false, span: (_group, _name, work) => work() },
}));
vi.mock('../../utils/background-work.js', () => ({
    runInBackground: (_name, work) => {
        state.jobs.push(work);
        return Promise.resolve();
    },
}));
vi.mock('./networth-calculator.js', () => ({
    calculateNetworth: steps.calculation,
    networthUnitValue: () => 0,
    GUILD_RATE_UNKNOWN_NOTE: 'unknown rate',
}));
vi.mock('./networth-display.js', () => ({
    networthHeaderDisplay: { setNetworthFeature: vi.fn(), initialize: vi.fn(), update: vi.fn(), disable: vi.fn() },
    networthInventoryDisplay: { setNetworthFeature: vi.fn(), initialize: vi.fn(), update: vi.fn(), disable: vi.fn() },
}));
vi.mock('./networth-exclusions.js', () => ({ initExclusions: async () => {} }));
vi.mock('./networth-cache.js', () => ({ default: { clear: vi.fn() } }));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: vi.fn() }));
vi.mock('./networth-history.js', () => ({ default: { initialize: steps.history, disable: vi.fn() } }));
vi.mock('./networth-history-chart.js', () => ({
    default: { setNetworthFeature: vi.fn(), closeModal: vi.fn() },
}));
vi.mock('./production-income-recorder.js', () => ({
    default: { initialize: steps.production, cleanup: vi.fn() },
    mergeProductionDays: (rows) => rows,
}));
vi.mock('./chest-opening-recorder.js', () => ({
    default: { initialize: steps.chests, cleanup: vi.fn() },
    mergeChestOpeningDays: (rows) => rows,
}));
vi.mock('./combat-loot-recorder.js', () => ({
    default: { initialize: steps.combat, cleanup: vi.fn() },
    mergeCombatLootDays: (rows) => rows,
}));
vi.mock('./item-flow-recorder.js', () => ({ default: { initialize: steps.itemFlow, cleanup: vi.fn() } }));
vi.mock('./gold-sources-panel.js', () => ({ default: { closeModal: vi.fn() } }));
vi.mock('./networth-exclusion-popup.js', () => ({ default: { refresh: vi.fn(), close: vi.fn() } }));
vi.mock('../../utils/networth-worker-manager.js', () => ({ terminateItemValueWorkerPool: vi.fn() }));

const feature = (await import('./index.js')).default;

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

beforeEach(() => {
    feature.disable();
    state.characterId = 'alice';
    state.jobs = [];
    state.connected = true;
    state.optionalServices = true;
    for (const step of Object.values(steps)) step.mockReset().mockResolvedValue(undefined);
    steps.calculation.mockResolvedValue({ totalNetworth: 123, coins: 0 });
});
afterEach(() => feature.disable());

describe('Net Worth startup queued until idle', () => {
    test('does not restore calculations, history or recorders after disable', async () => {
        await feature.initialize();
        feature.disable();
        await state.jobs[0]();
        for (const step of Object.values(steps)) expect(step).not.toHaveBeenCalled();
        expect(feature.currentData).toBeNull();
    });

    test('a retired callback cannot restart work after same-character re-enable', async () => {
        await feature.initialize();
        feature.disable();
        await feature.initialize();
        await state.jobs[0]();
        for (const step of Object.values(steps)) expect(step).not.toHaveBeenCalled();
        await state.jobs[1]();
        for (const step of Object.values(steps)) expect(step).toHaveBeenCalledTimes(1);
    });

    test('an old character callback cannot start on a different character', async () => {
        await feature.initialize();
        state.characterId = 'bob';
        await state.jobs[0]();
        for (const step of Object.values(steps)) expect(step).not.toHaveBeenCalled();
    });

    test('disabled optional services still stay off during a current startup', async () => {
        state.optionalServices = false;
        await feature.initialize();
        await state.jobs[0]();
        expect(steps.calculation).toHaveBeenCalledTimes(1);
        for (const [name, step] of Object.entries(steps)) {
            if (name !== 'calculation') expect(step).not.toHaveBeenCalled();
        }
    });

    test('a disconnected startup skips pricing but still initializes enabled history and recorders', async () => {
        state.connected = false;
        await feature.initialize();
        await state.jobs[0]();
        expect(steps.calculation).not.toHaveBeenCalled();
        for (const [name, step] of Object.entries(steps)) {
            if (name !== 'calculation') expect(step).toHaveBeenCalledTimes(1);
        }
    });

    test('a current startup still calculates and starts every enabled service once', async () => {
        await feature.initialize();
        await state.jobs[0]();
        for (const step of Object.values(steps)) expect(step).toHaveBeenCalledTimes(1);
        expect(feature.currentData.totalNetworth).toBe(123);
    });
});

describe('teardown while startup is awaiting a step', () => {
    const order = Object.keys(steps);
    test.each(order.slice(0, -1))('does not start another service after %s resumes', async (pausedStep) => {
        const reached = deferred();
        const held = deferred();
        steps[pausedStep].mockImplementationOnce(() => {
            reached.resolve();
            return held.promise;
        });
        await feature.initialize();
        const job = state.jobs[0]();
        await reached.promise;
        feature.disable();
        held.resolve({ totalNetworth: 123, coins: 0 });
        await job;
        for (const key of order.slice(order.indexOf(pausedStep) + 1)) expect(steps[key]).not.toHaveBeenCalled();
        expect(feature.currentData).toBeNull();
    });
});
