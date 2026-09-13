/**
 * Which reflect is up, and which source said so.
 *
 * The buff map is the better witness and the one nobody has seen on a live
 * personal payload, so the cases worth pinning are the hand-over between the two
 * sources: a map that can be read wins, a slot with no map or game data that
 * cannot join an entry to an ability falls back to the remembered cast, and
 * every answer records which of them gave it.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
    REFLECT_WINDOW_MS,
    newReflectState,
    noteReflectBuffs,
    noteReflectCasts,
    noteReflectEvents,
    reflectFromBuffMap,
    reflectingFor,
    reflectSummary,
} from './reflect-state.js';
import { _resetAbilityEffectIndex } from './ability-effects.js';

const SPIKE = '/abilities/spike_shell';
const NOW = Date.parse('2026-09-12T12:00:00Z');

/** Game data declaring Spike Shell's buff, so a map entry joins back to it */
const DETAILS = {
    [SPIKE]: {
        abilityEffects: [
            {
                targetType: 'self',
                effectType: '/ability_effect_types/buff',
                buffs: [{ uniqueHrid: '/buff_uniques/spike_shell', typeHrid: '/buff_types/thorns', duration: 30e9 }],
            },
        ],
    },
};

const spikeBuff = (startedMsAgo, seconds = 30) => ({
    '/buff_uniques/spike_shell': {
        uniqueHrid: '/buff_uniques/spike_shell',
        typeHrid: '/buff_types/thorns',
        duration: seconds * 1e9,
        startTime: new Date(NOW - startedMsAgo).toISOString(),
    },
});

beforeEach(() => _resetAbilityEffectIndex());

describe('the buff map', () => {
    test('an unexpired reflect entry names its ability', () => {
        expect(reflectFromBuffMap(spikeBuff(5000), NOW, DETAILS)).toBe(SPIKE);
    });

    test('an expired one names nothing', () => {
        expect(reflectFromBuffMap(spikeBuff(31_000), NOW, DETAILS)).toBeNull();
    });

    test('a map with no reflect in it names nothing', () => {
        expect(reflectFromBuffMap({ '/buff_uniques/other': { duration: 30e9 } }, NOW, DETAILS)).toBeNull();
    });

    test('a readable map outranks a remembered cast, both ways', () => {
        const state = newReflectState();
        noteReflectCasts(state, { 0: { abilityHrid: SPIKE } }, NOW - 1000);
        // The map says the buff is gone although the cast was a second ago
        noteReflectBuffs(state, { 0: { combatBuffMap: {} } });
        expect(reflectingFor(state, NOW, DETAILS)('0')).toBeNull();
        expect(state.sources['0']).toBe('buffMap');

        // And says it is up although no cast was ever seen
        noteReflectBuffs(state, { 1: { combatBuffMap: spikeBuff(1000) } });
        expect(reflectingFor(state, NOW, DETAILS)('1')).toBe(SPIKE);
    });

    test('a tick that does not restate a unit’s map keeps the last one', () => {
        const state = newReflectState();
        noteReflectBuffs(state, { 0: { combatBuffMap: spikeBuff(1000) } });
        noteReflectBuffs(state, { 0: { cHP: 10 } });
        expect(reflectingFor(state, NOW, DETAILS)('0')).toBe(SPIKE);
    });
});

describe('the remembered cast', () => {
    test('stands in when no map was ever stated for the slot', () => {
        const state = newReflectState();
        noteReflectCasts(state, { 0: { abilityHrid: SPIKE } }, NOW - 20_000);
        expect(reflectingFor(state, NOW, DETAILS)('0')).toBe(SPIKE);
        expect(state.sources['0']).toBe('castWindow');
    });

    test('lasts the window and no longer', () => {
        const state = newReflectState();
        noteReflectCasts(state, { 0: { abilityHrid: SPIKE } }, NOW - REFLECT_WINDOW_MS - 1);
        expect(reflectingFor(state, NOW, DETAILS)('0')).toBeNull();
    });

    test('stands in for a map the game data cannot join to an ability', () => {
        const state = newReflectState();
        noteReflectBuffs(state, { 0: { combatBuffMap: spikeBuff(1000) } });
        noteReflectCasts(state, { 0: { preparingAbilityHrid: SPIKE } }, NOW - 1000);
        expect(reflectingFor(state, NOW, {})('0')).toBe(SPIKE);
        expect(state.sources['0']).toBe('castWindow');
    });

    test('anything that is not a reflect is not remembered', () => {
        const state = newReflectState();
        noteReflectCasts(state, { 0: { abilityHrid: '/abilities/provoke' } }, NOW);
        expect(state.casts).toEqual({});
    });
});

describe('what a console check reads', () => {
    test('reflect damage is charged to the source that answered', () => {
        const state = newReflectState();
        noteReflectCasts(state, { 0: { abilityHrid: SPIKE } }, NOW - 1000);
        noteReflectBuffs(state, { 1: { combatBuffMap: spikeBuff(1000) } });
        const reflecting = reflectingFor(state, NOW, DETAILS);
        reflecting('0');
        reflecting('1');
        noteReflectEvents(state, [
            { playerIndex: '0', amount: 40, isReflect: true },
            { playerIndex: '1', amount: 60, isReflect: true },
            { playerIndex: '1', amount: 500 },
        ]);

        const summary = reflectSummary(state, NOW);
        expect(summary.damage).toEqual({ buffMap: 60, castWindow: 40 });
        expect(summary.sources).toEqual({ 0: 'castWindow', 1: 'buffMap' });
        expect(summary.buffMapSlots).toEqual(['1']);
        expect(summary.casts['0']).toEqual({ hrid: SPIKE, secondsAgo: 1 });
    });
});
