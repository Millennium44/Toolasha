/**
 * @vitest-environment happy-dom
 *
 * The panel computes nothing — it reads a summary and lays it out — so its only
 * failure mode is reading a field that stopped being there, which no arithmetic
 * test catches and drawing it does. The observer half is tested for the two
 * things that would quietly waste hours of somebody's fighting: whether the
 * tally reaches storage and comes back, and whether the zone context is read
 * off the running action rather than the front of the queue.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
    settings: { waveGapWatch: true },
    stored: new Map(),
    handlers: new Map(),
    actions: [],
    actionDetails: {},
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
        getCurrentActions: () => state.actions,
        getActionDetails: (hrid) => state.actionDetails[hrid],
        getCurrentCharacterId: () => 'char1',
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

const { default: waveGap, waveGapPanel } = await import('./wave-gap-observer.js');
const { emptyTally, foldObservation, CATEGORIES } = await import('./wave-gap.js');

const FAILED = 'could not be drawn';
const text = () => waveGapPanel.panel?.textContent || '';

/** A wave of two monsters. @returns {Object} `new_battle` payload */
const roster = (wave) => ({ wave, monsters: { 0: {}, 1: {} } });

beforeEach(() => {
    state.settings = { waveGapWatch: true };
    state.stored.clear();
    state.handlers.clear();
    state.actions = [{ actionHrid: '/actions/combat/golem_cave', isDone: false, ordinal: 0, id: 'a' }];
    state.actionDetails = { '/actions/combat/golem_cave': { combatZoneInfo: { isDungeon: false } } };
    vi.useRealTimers();
});

afterEach(async () => {
    waveGapPanel.hide({ remember: false });
    waveGap.cleanup();
    await waveGap.forget();
});

describe('the panel', () => {
    test('draws with nothing collected, and says what the measurement is made of', () => {
        waveGapPanel.show({ remember: false });
        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('Nothing measured yet');
        expect(text()).toContain('How good the ruler is');
    });

    test('says so when the setting is off, rather than drawing an empty measurement', () => {
        state.settings.waveGapWatch = false;
        waveGapPanel.show({ remember: false });
        expect(text()).toContain('switched off in settings');
    });

    test('draws every section once there is a sample', async () => {
        await waveGap.initialize();
        const tally = waveGap.tally();
        for (let index = 0; index < 40; index += 1) {
            foldObservation(tally, {
                category: CATEGORIES.openZone,
                gapMs: 3023 + (index % 12) * 6,
                deathAt: 1_700_000_000_000 + index * 9137,
            });
        }

        waveGapPanel.show({ remember: false });
        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('Open-zone respawn');
        expect(text()).toContain('Dungeon run boundary');
        expect(text()).toContain('Percentiles');
        expect(text()).toContain('120 s cycle');
        expect(text()).toContain('Discarded transitions');
    });
});

describe('the live wiring', () => {
    test('labels a wave by the running action, not the front of the queue', async () => {
        // A requeued repeat sits first in the array with a higher ordinal; the
        // dungeon underneath it is what is actually running
        state.actions = [
            { actionHrid: '/actions/combat/golem_cave', isDone: false, ordinal: 8_589_934_587, id: 'b' },
            { actionHrid: '/actions/combat/chimerical_den', isDone: false, ordinal: 0, id: 'a' },
        ];
        state.actionDetails['/actions/combat/chimerical_den'] = { combatZoneInfo: { isDungeon: true } };

        await waveGap.initialize();
        const battle = state.handlers.get('new_battle');
        const tick = state.handlers.get('battle_updated');
        expect(typeof battle).toBe('function');

        // The gap is read off the wall clock, so the wall clock is driven
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        battle(roster(4));
        vi.setSystemTime(1_700_000_004_000);
        tick({ pMap: {}, mMap: { 0: { cHP: 0 }, 1: { cHP: 0 } } });
        vi.setSystemTime(1_700_000_007_037);
        battle(roster(5));

        expect(waveGap.tally().categories[CATEGORIES.dungeonWave].n).toBe(1);
        expect(waveGap.tally().categories[CATEGORIES.openZone].n).toBe(0);
    });

    test('attaches nothing at all while the setting is off', async () => {
        state.settings.waveGapWatch = false;
        await waveGap.initialize();
        expect(state.handlers.size).toBe(0);
    });
});

describe('the durable tally', () => {
    test('reads back what a previous session stored', async () => {
        const stored = emptyTally();
        foldObservation(stored, { category: CATEGORIES.openZone, gapMs: 3037, deathAt: 1 });
        state.stored.set('waveGapTally', stored);

        await waveGap.initialize();
        expect(waveGap.tally().categories[CATEGORIES.openZone].n).toBe(1);
        expect(waveGap.summary().categories[CATEGORIES.openZone].mean).toBe(3037);
    });

    test('writes what it has collected on the way out', async () => {
        await waveGap.initialize();
        const battle = state.handlers.get('new_battle');
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        battle(roster(0));
        vi.setSystemTime(1_700_000_004_000);
        state.handlers.get('battle_updated')({ pMap: {}, mMap: { 0: { cHP: 0 }, 1: { cHP: 0 } } });
        vi.setSystemTime(1_700_000_007_037);
        battle(roster(0));

        waveGap.cleanup();
        vi.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(state.stored.get('waveGapTally')?.categories[CATEGORIES.openZone].n).toBe(1);
    });

    test('ignores a stored tally from a schema it does not know', async () => {
        state.stored.set('waveGapTally', { version: 99, categories: { openZone: { n: 500 } } });
        await waveGap.initialize();
        expect(waveGap.tally().categories[CATEGORIES.openZone].n).toBe(0);
    });
});
