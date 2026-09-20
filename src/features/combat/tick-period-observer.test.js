/**
 * @vitest-environment happy-dom
 *
 * The panel computes nothing — it reads a summary and lays it out — so its only
 * failure mode is reading a field that stopped being there, which no arithmetic
 * test catches and drawing it does. The live half is tested for the two things
 * that would quietly waste hours of somebody's fighting: whether the tally
 * reaches storage and comes back, and whether an effect it cannot isolate says
 * so on screen instead of drawing a confident nothing.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
    settings: { tickPeriodWatch: true },
    stored: new Map(),
    handlers: new Map(),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSetting: (key, fallback) => state.settings[key] ?? fallback ?? false,
        getSettingValue: (key, fallback) => fallback,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getCurrentActions: () => [],
        getActionDetails: () => null,
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (state.stored.has(key) ? state.stored.get(key) : fallback),
        set: async (key, value) => {
            state.stored.set(key, value);
            return true;
        },
        isQuotaExceeded: () => false,
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => state.handlers.set(event, handler),
        off: (event) => state.handlers.delete(event),
    },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({ webSocketHook: () => null }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));

const { default: tickPeriod, tickPeriodPanel } = await import('./tick-period-observer.js');
const { emptyTally, foldObservation, foldRejection, EFFECTS } = await import('./tick-period.js');

const FAILED = 'could not be drawn';
const text = () => tickPeriodPanel.panel?.textContent || '';

beforeEach(() => {
    state.settings = { tickPeriodWatch: true };
    state.stored.clear();
    state.handlers.clear();
    vi.useRealTimers();
});

afterEach(async () => {
    tickPeriodPanel.hide({ remember: false });
    tickPeriod.cleanup();
    await tickPeriod.forget();
});

describe('the panel', () => {
    test('draws with nothing collected, and says what the measurement is made of', () => {
        tickPeriodPanel.show({ remember: false });
        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('Nothing measured yet');
        expect(text()).toContain('How good the ruler is');
        expect(text()).toContain('Where the health falls went');
    });

    test('says so when the setting is off, rather than drawing an empty measurement', () => {
        state.settings.tickPeriodWatch = false;
        tickPeriodPanel.show({ remember: false });
        expect(text()).toContain('switched off in settings');
    });

    test('draws every effect once there is a sample, and names the constant each is against', async () => {
        await tickPeriod.initialize();
        const tally = tickPeriod.tally();
        for (let index = 0; index < 30; index += 1) {
            foldObservation(tally, { effect: EFFECTS.regen, intervalMs: 10_000 + (index % 5) - 2, at: index });
        }

        tickPeriodPanel.show({ remember: false });
        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('Hitpoint and mana regeneration');
        expect(text()).toContain('Food and drink recovery');
        expect(text()).toContain('Damage over time');
        expect(text()).toContain('Enrage ramp');
        expect(text()).toContain('10.000 s');
        expect(text()).toContain('Whole multiples');
    });

    test('shows an effect it could not isolate as a stated result, not a blank row', async () => {
        await tickPeriod.initialize();
        const tally = tickPeriod.tally();
        for (let index = 0; index < 20; index += 1) foldRejection(tally, EFFECTS.dot, 'hpFallAttributed');

        tickPeriodPanel.show({ remember: false });
        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('not resolvable');
        expect(text()).toContain('Discarded candidates (20)');
    });
});

describe('the live wiring', () => {
    test('times a regeneration period off the stream and calibrates its own noise', async () => {
        await tickPeriod.initialize();
        const tick = state.handlers.get('battle_updated');
        expect(typeof tick).toBe('function');

        vi.useFakeTimers();
        const unit = (hp, mp, counter) => ({
            pMap: { 0: { cHP: hp, cMP: mp, mHP: 1000, mMP: 500, atkCounter: counter, int: 3_000_000_000 } },
        });
        vi.setSystemTime(1_700_000_000_000);
        tick(unit(500, 200, 1));
        vi.setSystemTime(1_700_000_003_000);
        tick(unit(500, 200, 2));
        vi.setSystemTime(1_700_000_010_000);
        tick(unit(520, 215, 2));
        vi.setSystemTime(1_700_000_020_000);
        tick(unit(540, 230, 2));

        expect(tickPeriod.tally().effects[EFFECTS.regen].n).toBe(1);
        expect(tickPeriod.tally().effects[EFFECTS.regen].rows).toEqual([10_000]);
        expect(tickPeriod.tally().jitter.rows).toEqual([0]);
    });

    test('attaches nothing at all while the setting is off', async () => {
        state.settings.tickPeriodWatch = false;
        await tickPeriod.initialize();
        expect(state.handlers.size).toBe(0);
    });
});

describe('the durable tally', () => {
    test('reads back what a previous session stored', async () => {
        const stored = emptyTally();
        foldObservation(stored, { effect: EFFECTS.regen, intervalMs: 10_000, at: 1 });
        state.stored.set('tickPeriodTally', stored);

        await tickPeriod.initialize();
        expect(tickPeriod.tally().effects[EFFECTS.regen].n).toBe(1);
    });

    test('writes what it has collected on the way out', async () => {
        await tickPeriod.initialize();
        const tick = state.handlers.get('battle_updated');
        vi.useFakeTimers();
        const unit = (hp, mp) => ({ pMap: { 0: { cHP: hp, cMP: mp, mHP: 1000, mMP: 500 } } });
        vi.setSystemTime(1_700_000_000_000);
        tick(unit(500, 200));
        vi.setSystemTime(1_700_000_010_000);
        tick(unit(520, 215));
        vi.setSystemTime(1_700_000_020_000);
        tick(unit(540, 230));

        tickPeriod.cleanup();
        vi.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(state.stored.get('tickPeriodTally')?.effects[EFFECTS.regen].n).toBe(1);
    });

    test('ignores a stored tally from a schema it does not know', async () => {
        state.stored.set('tickPeriodTally', { version: 99, effects: { regen: { n: 500, rows: [] } } });
        await tickPeriod.initialize();
        expect(tickPeriod.tally().effects[EFFECTS.regen].n).toBe(0);
    });
});
