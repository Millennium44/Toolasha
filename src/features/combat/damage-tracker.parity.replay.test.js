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

describe('the team total against the table', () => {
    // Ground truth is every point of monster health the recording lost, counted
    // straight off `mMap`. The rows plus the named remainder reach it exactly;
    // on the party recording the remainder is one hit the non-damaging filter
    // holds back (a slot with no action history when it landed)
    test.each([
        ['combat-dungeon', dungeon, 29335, 0, 0],
        ['combat-five', five, 109623, 0, 0],
        ['combat-party', party, 233768, 0, 1000],
        ['combat-refresh', refresh, 16430, 0, 0],
        ['combat-run', run, 31278, 0, 0],
    ])('%s', (_name, recording, lost, unattributed, filtered) => {
        const breakdown = replay(recording);
        const rows = breakdown.players.reduce((sum, row) => sum + row.damage, 0);

        expect(Math.round(breakdown.team.damage)).toBe(lost);
        expect(Math.round(breakdown.team.unattributed)).toBe(unattributed);
        expect(Math.round(breakdown.team.filtered)).toBe(filtered);
        expect(Math.round(rows + breakdown.team.unattributed + breakdown.team.filtered)).toBe(lost);
    });
});

describe('healing done', () => {
    /** Every health rise a recording shows, revives excepted, counted straight off `pMap` */
    function rises(recording) {
        const last = {};
        let total = 0;
        for (const tick of recording.ticks) {
            if (tick.type !== 'battle_updated') continue;
            for (const [index, player] of Object.entries(tick.payload.pMap || {})) {
                const health = Number(player?.cHP);
                if (!Number.isFinite(health)) continue;
                if (last[index] > 0 && health > last[index]) total += health - last[index];
                last[index] = health;
            }
        }
        return total;
    }

    // Credited plus regeneration is every rise: nothing is dropped, and
    // regeneration is never on a row. The healer on the five-player run is the
    // one with the heal on their bar
    test.each([
        ['combat-dungeon', dungeon, 246, 74],
        ['combat-five', five, 2197, 1618],
        ['combat-party', party, 291, 1450],
        ['combat-refresh', refresh, 185, 130],
        ['combat-run', run, 758, 197],
    ])('%s', (_name, recording, credited, regen) => {
        const { healing } = replay(recording);

        expect(Math.round(healing.total)).toBe(credited);
        expect(Math.round(healing.regen)).toBe(regen);
        expect(Math.round(healing.total + healing.regen)).toBe(rises(recording));
        expect(healing.shared).toBe(0);
    });

    test('combat-five: the healer’s row is Rejuvenate first', () => {
        const { healing } = replay(five);
        const healer = healing.players[0];

        expect(healer.index).toBe('1');
        expect(Math.round(healer.healing)).toBe(2067);
        expect(healer.abilities[0].action).toBe('/abilities/rejuvenate');
        expect(Math.round(healer.abilities[0].healing)).toBe(1150);
    });
});
