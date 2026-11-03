/**
 * The one live subscription the Iron Bell panel and action-bar strip share.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const bus = vi.hoisted(() => ({
    events: new Map(),
    market: new Set(),
    settings: new Map(),
    registrations: { events: 0, market: 0, settings: 0 },
    /** Which data manager registration (1-based) throws, once; 0 for none */
    failAt: 0,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (event, fn) => {
            bus.registrations.events++;
            if (bus.registrations.events === bus.failAt) {
                bus.failAt = 0;
                throw new Error('registration failed');
            }
            if (!bus.events.has(event)) bus.events.set(event, new Set());
            bus.events.get(event).add(fn);
        },
        off: (event, fn) => bus.events.get(event)?.delete(fn),
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        on: (fn) => {
            bus.registrations.market++;
            bus.market.add(fn);
        },
        off: (fn) => bus.market.delete(fn),
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        onSettingChange: (key, fn) => {
            bus.registrations.settings++;
            if (!bus.settings.has(key)) bus.settings.set(key, new Set());
            bus.settings.get(key).add(fn);
            return () => bus.settings.get(key)?.delete(fn);
        },
    },
}));

const { onIronBellLive } = await import('./ironbell-live.js');
const { LIVE_EVENTS } = await import('./ironbell-cycle.js');

const listening = () => ({
    events: [...bus.events.values()].reduce((sum, set) => sum + set.size, 0),
    market: bus.market.size,
    settings: [...bus.settings.values()].reduce((sum, set) => sum + set.size, 0),
});
const deliver = () => {
    for (const set of bus.events.values()) for (const fn of [...set]) fn();
};

let offs;
const subscribe = (callback) => {
    const off = onIronBellLive(callback);
    offs.push(off);
    return off;
};

beforeEach(() => {
    offs = [];
    bus.registrations = { events: 0, market: 0, settings: 0 };
});

afterEach(() => {
    offs.forEach((off) => off());
});

describe('onIronBellLive', () => {
    test('two subscribers share one listener per source, not one each', () => {
        subscribe(() => {});
        subscribe(() => {});

        expect(bus.registrations).toEqual({ events: LIVE_EVENTS.length, market: 1, settings: 1 });
        expect(listening()).toEqual({ events: LIVE_EVENTS.length, market: 1, settings: 1 });
    });

    test('an event, a market tick and the setting each reach every subscriber exactly once', () => {
        const strip = vi.fn();
        const panel = vi.fn();
        subscribe(strip);
        subscribe(panel);

        for (const fn of bus.events.get('actions_updated')) fn();
        expect([strip.mock.calls.length, panel.mock.calls.length]).toEqual([1, 1]);

        for (const fn of bus.market) fn();
        expect([strip.mock.calls.length, panel.mock.calls.length]).toEqual([2, 2]);

        for (const fn of bus.settings.get('actionPanel_enhanceMatLimitProtections')) fn();
        expect([strip.mock.calls.length, panel.mock.calls.length]).toEqual([3, 3]);
    });

    test('the listeners stay while any subscriber remains and all go when the last one leaves', () => {
        const offStrip = subscribe(() => {});
        const offPanel = subscribe(() => {});

        offStrip();
        expect(listening().events).toBe(LIVE_EVENTS.length);
        expect(listening().market).toBe(1);

        offPanel();
        expect(listening()).toEqual({ events: 0, market: 0, settings: 0 });
    });

    test('leaving twice does not take another subscriber down, and a later subscriber attaches afresh', () => {
        const offFirst = subscribe(() => {});
        const survivor = vi.fn();
        subscribe(survivor);

        offFirst();
        offFirst();
        deliver();
        expect(survivor).toHaveBeenCalledTimes(LIVE_EVENTS.length);

        offs.forEach((off) => off());
        expect(listening()).toEqual({ events: 0, market: 0, settings: 0 });

        const again = vi.fn();
        subscribe(again);
        expect(listening()).toEqual({ events: LIVE_EVENTS.length, market: 1, settings: 1 });
        for (const fn of bus.market) fn();
        expect(again).toHaveBeenCalledTimes(1);
    });

    test('an attach that throws part-way leaves nothing registered, and the next subscriber registers once', () => {
        bus.failAt = 3;

        expect(() => onIronBellLive(() => {})).toThrow('registration failed');
        expect(listening()).toEqual({ events: 0, market: 0, settings: 0 });

        bus.registrations = { events: 0, market: 0, settings: 0 };
        const again = vi.fn();
        subscribe(again);
        expect(listening()).toEqual({ events: LIVE_EVENTS.length, market: 1, settings: 1 });
        for (const fn of bus.market) fn();
        expect(again).toHaveBeenCalledTimes(1);
    });

    test('one subscriber throwing does not stop the others', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const after = vi.fn();
        subscribe(() => {
            throw new Error('boom');
        });
        subscribe(after);

        for (const fn of bus.market) fn();

        expect(after).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});
