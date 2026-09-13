/**
 * The recorded fights, replayed through the real tracker, for the figures the
 * per-player meters now carry beyond damage: who landed each kill, and the team
 * total the table has to add up to.
 *
 * The clock is driven off each recording's own tick times, because a remembered
 * reflect cast is a window in time and a replay at one frozen instant would keep
 * every cast up forever.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import dungeon from '../../utils/__fixtures__/combat-dungeon.json';
import five from '../../utils/__fixtures__/combat-five.json';
import party from '../../utils/__fixtures__/combat-party.json';
import refresh from '../../utils/__fixtures__/combat-refresh.json';
import run from '../../utils/__fixtures__/combat-run.json';

const listeners = vi.hoisted(() => ({}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ abilityDetailMap: {}, itemDetailMap: {} }) },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => (listeners[type] = handler),
        off: (type) => delete listeners[type],
    },
}));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => null },
}));

const tracker = await import('./damage-tracker.js');

const START = Date.parse('2026-09-12T00:00:00Z');

/**
 * Feed a whole recording through the tracker on its own clock.
 * @param {Object} recording - `{ticks: [{at, type, payload}]}`
 * @returns {Object} `damageBreakdown()` at the end
 */
function replay(recording) {
    for (const tick of recording.ticks) {
        vi.setSystemTime(START + (tick.at || 0));
        if (tick.type === 'new_battle') listeners.new_battle(tick.payload);
        else if (tick.type === 'battle_updated') listeners.battle_updated(tick.payload);
    }
    return tracker.damageBreakdown();
}

/** @param {Object} breakdown @returns {Object} slot → kills */
const killsBySlot = (breakdown) => Object.fromEntries(breakdown.players.map((row) => [row.index, row.kills]));

beforeEach(() => {
    vi.useFakeTimers();
    tracker.default.initialize();
});

afterEach(() => {
    tracker.default.cleanup();
    vi.useRealTimers();
});

describe('kills per player', () => {
    // Every kill in these recordings landed on a tick with a single owner. The
    // enemy tally can read short of the player kills where a monster was never
    // named (the refresh recording starts mid-fight): a kill needs a name to be
    // filed under a monster, and none to be filed under the player who landed it
    test.each([
        ['combat-dungeon', dungeon, { 0: 13 }],
        ['combat-five', five, { 0: 4, 1: 0, 2: 3, 3: 7, 4: 7 }],
        ['combat-party', party, { 0: 27, 1: 14 }],
        ['combat-refresh', refresh, { 0: 5 }],
        ['combat-run', run, { 0: 15 }],
    ])('%s', (_name, recording, expected) => {
        const breakdown = replay(recording);
        expect(killsBySlot(breakdown)).toEqual(expected);
        expect(breakdown.unownedKills).toBe(0);
    });
});
