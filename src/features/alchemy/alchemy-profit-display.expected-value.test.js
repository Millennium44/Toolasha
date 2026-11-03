/** @vitest-environment happy-dom */

/**
 * The Profitability panel prices essence and crate outputs from the expected-value calculator's cache, so
 * it has to make sure that calculator is running when the player has left its own tooltip setting off, and
 * redraw when it finishes. Without it those outputs read as unpriced and every figure reads as a floor.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const ev = vi.hoisted(() => ({ isInitialized: false, initialize: null }));
const bus = vi.hoisted(() => ({ handlers: new Map() }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (key, def) => def,
        getPricingModeDisplayLabel: (mode) => `label:${mode}`,
        onSettingChange: () => () => {},
        onSettingsLoaded: () => () => {},
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, register: () => () => {}, onReady: () => () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => null,
        getSkills: () => [],
        getItemDetails: () => null,
        on: (event, fn) => {
            if (!bus.handlers.has(event)) bus.handlers.set(event, new Set());
            bus.handlers.get(event).add(fn);
        },
        off: (event, fn) => bus.handlers.get(event)?.delete(fn),
    },
}));
vi.mock('./alchemy-profit.js', () => ({
    readAlchemyTabType: () => null,
    readAlchemyPanelSelection: () => null,
    default: {
        getCurrentActionHrid: () => null,
        getStateFingerprint: () => 'fp',
        extractDrops: async () => [],
        extractRequirements: async () => [],
    },
}));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: {} }));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        get isInitialized() {
            return ev.isInitialized;
        },
        initialize: (...args) => ev.initialize(...args),
    },
}));
vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalMultiplier: 1 }),
}));

const { default: display } = await import('./alchemy-profit-display.js');

const listeners = () => bus.handlers.get('expected_value_initialized')?.size ?? 0;
const emitReady = () => {
    for (const fn of [...(bus.handlers.get('expected_value_initialized') ?? [])]) fn({ timestamp: 1 });
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    ev.isInitialized = false;
    ev.initialize = vi.fn(async () => true);
    bus.handlers.clear();
    vi.spyOn(display, 'createDisplay').mockImplementation(() => {});
    vi.spyOn(display, 'removeDisplay').mockImplementation(() => {});
});

afterEach(() => {
    display.disable();
    display.expectedValueStart = null; // a still-pending start must not leak into the next test
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('starting the expected-value calculator', () => {
    test('a draw starts it when it is not running', async () => {
        await display.updateDisplay(document.createElement('div'));

        expect(ev.initialize).toHaveBeenCalledTimes(1);
    });

    test('a draw leaves it alone when it already runs', async () => {
        ev.isInitialized = true;

        await display.updateDisplay(document.createElement('div'));

        expect(ev.initialize).not.toHaveBeenCalled();
    });

    test('draws while the first start is still in flight join it; a start that found no data is retried', async () => {
        let finish;
        ev.initialize = vi.fn(() => new Promise((resolve) => (finish = resolve)));

        await display.updateDisplay(document.createElement('div'));
        await display.updateDisplay(document.createElement('div'));
        expect(ev.initialize).toHaveBeenCalledTimes(1);

        finish(false); // no market data yet, so the calculator is still not initialized
        await settle();
        await display.updateDisplay(document.createElement('div'));
        expect(ev.initialize).toHaveBeenCalledTimes(2);
    });

    test('a start that throws is logged and does not break the draw; the next draw retries', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        ev.initialize = vi.fn(async () => {
            throw new Error('no data');
        });

        await expect(display.updateDisplay(document.createElement('div'))).resolves.toBeUndefined();
        await settle();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('Expected value start failed'), expect.any(Error));

        await display.updateDisplay(document.createElement('div'));
        expect(ev.initialize).toHaveBeenCalledTimes(2);
    });
});

describe('redrawing when the calculator finishes', () => {
    test('the ready event forces a redraw of the panel on screen', () => {
        display.initialize();
        const redraw = vi.spyOn(display, 'checkAndUpdateDisplay').mockImplementation(() => {});
        display.lastFingerprint = 'stale';

        emitReady();

        expect(display.lastFingerprint).toBeNull();
        expect(redraw).toHaveBeenCalledTimes(1);
    });

    test('disable() removes the listener, and a re-enable registers exactly one', () => {
        display.initialize();
        expect(listeners()).toBe(1);

        display.disable();
        expect(listeners()).toBe(0);

        display.initialize();
        expect(listeners()).toBe(1);
    });

    test('a ready event after disable() redraws nothing', () => {
        display.initialize();
        const redraw = vi.spyOn(display, 'checkAndUpdateDisplay').mockImplementation(() => {});
        display.disable();

        emitReady();

        expect(redraw).not.toHaveBeenCalled();
    });
});
