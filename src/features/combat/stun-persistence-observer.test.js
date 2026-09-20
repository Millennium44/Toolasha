/**
 * @vitest-environment happy-dom
 *
 * The panel computes nothing — it reads a tally and lays it out — so its only
 * failure mode is reading a field that stopped being there, which no arithmetic
 * test catches and building it does. The observer half is tested for the one
 * thing that would quietly lose an hour of somebody's fighting: whether the
 * tally actually reaches storage and comes back.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
    settings: { stunPersistenceWatch: true },
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
        getInitClientData: () => ({
            abilityDetailMap: {
                '/abilities/stunning_blow': { abilityEffects: [{ stunChance: 0.7, stunDuration: 3e9 }] },
            },
            combatMonsterDetailMap: {
                '/monsters/magnetic_golem': { abilities: [{ abilityHrid: '/abilities/stunning_blow' }] },
                '/monsters/stalactite_golem': { abilities: [] },
            },
        }),
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

const { default: stunPersistence, stunPersistencePanel } = await import('./stun-persistence-observer.js');
const { emptyTally } = await import('./stun-persistence.js');

const FAILED = 'could not be drawn';
const text = () => stunPersistencePanel.panel?.textContent || '';

beforeEach(() => {
    state.settings = { stunPersistenceWatch: true };
    state.stored.clear();
    state.handlers.clear();
});

afterEach(async () => {
    stunPersistencePanel.hide({ remember: false });
    stunPersistence.cleanup();
    await stunPersistence.forget();
});

describe('the panel', () => {
    test('draws with nothing collected, and says what it does and does not measure', () => {
        stunPersistencePanel.show({ remember: false });
        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('isStunned');
        expect(text()).toContain('blind');
        expect(text()).toContain('Not enough to say anything yet');
    });

    test('says so when the setting is off, rather than drawing an empty measurement', () => {
        state.settings.stunPersistenceWatch = false;
        stunPersistencePanel.show({ remember: false });
        expect(text()).toContain('switched off in settings');
    });

    test('draws a tally with episodes, brackets and discards in it', async () => {
        await stunPersistence.initialize();
        const battle = state.handlers.get('new_battle');
        const tick = state.handlers.get('battle_updated');
        expect(typeof battle).toBe('function');

        battle({
            monsters: [{ hrid: '/monsters/magnetic_golem' }, { hrid: '/monsters/stalactite_golem' }],
            players: [{ name: 'P' }],
        });
        tick({ pMap: { 0: { cHP: 10, isActive: true, isStunned: true } }, mMap: { 0: {}, 1: {} } });
        tick({
            pMap: { 0: { cHP: 10, isActive: true, isStunned: true } },
            mMap: { 0: { cHP: 0, isActive: false }, 1: {} },
        });
        tick({ pMap: { 0: { cHP: 10, isActive: true, isStunned: true } }, mMap: { 1: {} } });
        tick({ pMap: { 0: { cHP: 10, isActive: true } }, mMap: { 1: {} } });

        expect(stunPersistence.tally().monsterCaster.episodes).toBe(1);

        stunPersistencePanel.show({ remember: false });
        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('Stun outlived its caster');
        expect(text()).toContain('Discarded episodes');
        expect(text()).toContain('magnetic_golem');
    });
});

describe('the durable tally', () => {
    test('reads back what a previous session stored', async () => {
        // An hour of fighting is several sessions' worth, so a tally that does
        // not survive a refresh is a measurement that never finishes
        state.stored.set('stunPersistenceTally', {
            ...emptyTally(),
            monsterCaster: { episodes: 12, outlived: 11, brackets: [12, 0, 0, 0, 0, 0], postDeathSeconds: [0.4] },
        });
        await stunPersistence.initialize();
        expect(stunPersistence.tally().monsterCaster.episodes).toBe(12);
        expect(stunPersistence.summary().directions.monsterCaster.fraction).toBeCloseTo(11 / 12, 5);
    });

    test('writes what it has collected on the way out', async () => {
        await stunPersistence.initialize();
        const battle = state.handlers.get('new_battle');
        battle({ monsters: [{ hrid: '/monsters/magnetic_golem' }], players: [{ name: 'P' }] });
        state.handlers.get('battle_updated')({ pMap: { 0: { cHP: 10, isStunned: true } }, mMap: { 0: {} } });
        state.handlers.get('battle_updated')({ pMap: { 0: { cHP: 10 } }, mMap: { 0: {} } });

        stunPersistence.cleanup();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(state.stored.get('stunPersistenceTally')?.discards.casterSurvived).toBe(1);
    });

    test('ignores a stored tally from a schema it does not know', async () => {
        state.stored.set('stunPersistenceTally', { version: 99, monsterCaster: { episodes: 500 } });
        await stunPersistence.initialize();
        expect(stunPersistence.tally().monsterCaster.episodes).toBe(0);
    });

    test('attaches nothing at all while the setting is off', async () => {
        state.settings.stunPersistenceWatch = false;
        await stunPersistence.initialize();
        expect(state.handlers.size).toBe(0);
    });
});
