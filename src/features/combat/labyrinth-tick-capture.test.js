/**
 * The tick capture arms a socket listener, keeps the ordered feed trimmed to
 * what a fight reads, and lets go of the listener when it stops. These pin the
 * arming, the trimming, and that a stopped capture hears nothing more.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const bus = new Map();
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, fn) => {
            if (!bus.has(type)) bus.set(type, new Set());
            bus.get(type).add(fn);
        },
        off: (type, fn) => bus.get(type)?.delete(fn),
    },
}));

import capture from './labyrinth-tick-capture.js';

function emit(type, payload) {
    for (const fn of bus.get(type) || []) fn(payload);
}

const battle = { pMap: { 0: { cHP: 100 } }, mMap: { 0: { cHP: 200 } }, battleId: 'b1', chat: 'ignored' };

beforeEach(() => {
    capture.stopCapture();
    capture.clearCapture();
});

describe('labyrinth tick capture', () => {
    test('a disarmed capture hears nothing', () => {
        emit('battle_updated', battle);
        expect(capture.captureStatus().ticks).toBe(0);
    });

    test('an armed capture keeps the feed, trimmed to what a fight reads', () => {
        capture.startCapture({ monsterHrid: '/monsters/pyre_hunter', roomLevel: 300 });
        emit('battle_updated', battle);
        const file = capture.captureFile();
        expect(file.ticks).toHaveLength(1);
        expect(file.ticks[0].type).toBe('battle_updated');
        expect(file.ticks[0].payload).toEqual({ pMap: battle.pMap, mMap: battle.mMap, battleId: 'b1' });
        // The chat and other noise is dropped
        expect(file.ticks[0].payload.chat).toBeUndefined();
        expect(file.context.monsterHrid).toBe('/monsters/pyre_hunter');
        expect(file.format).toBe('toolasha-labyrinth-tick-capture');
    });

    test('new_battle is kept whole, since it names the units and abilities', () => {
        capture.startCapture();
        emit('new_battle', { players: {}, monsters: {}, extra: 1 });
        const file = capture.captureFile();
        expect(file.ticks[0].type).toBe('new_battle');
        expect(file.ticks[0].payload.extra).toBe(1);
    });

    test('the capture labels itself from the fight when given no monster', () => {
        capture.startCapture();
        emit('new_battle', { monsters: [{ hrid: '/monsters/dryad', name: 'Dryad' }], players: [] });
        const file = capture.captureFile();
        expect(file.context.monsterHrid).toBe('/monsters/dryad');
        expect(file.context.monsterName).toBe('Dryad');
    });

    test('a caller-supplied room level survives the monster backfill', () => {
        capture.startCapture({ roomLevel: 322 });
        emit('new_battle', { monsters: [{ hrid: '/monsters/dryad', name: 'Dryad' }] });
        const file = capture.captureFile();
        expect(file.context.roomLevel).toBe(322);
        expect(file.context.monsterHrid).toBe('/monsters/dryad');
    });

    test('a stopped capture hears nothing more', () => {
        capture.startCapture();
        emit('battle_updated', battle);
        capture.stopCapture();
        emit('battle_updated', battle);
        expect(capture.captureStatus().ticks).toBe(1);
        expect(capture.isCapturing()).toBe(false);
    });

    test('starting again drops the previous capture', () => {
        capture.startCapture();
        emit('battle_updated', battle);
        capture.startCapture();
        expect(capture.captureStatus().ticks).toBe(0);
    });
});

describe('the capture ends when the fight leaves its monster', () => {
    test('a fresh fight against a different monster stops it, keeping what was captured', () => {
        capture.startCapture({ monsterHrid: '/monsters/cyclops', roomLevel: 206 });
        emit('new_battle', { monsters: [{ hrid: '/monsters/cyclops', name: 'Cyclops' }], players: [] });
        emit('battle_updated', battle);
        const kept = capture.captureFile().ticks.length;
        expect(capture.isCapturing()).toBe(true);

        // Room cleared → the game moves on to the next fight (a different monster
        // or your main-game action). The capture ends without recording it.
        emit('new_battle', { monsters: [{ hrid: '/monsters/gobo_stabber' }], players: [] });
        expect(capture.isCapturing()).toBe(false);
        emit('battle_updated', battle); // ignored — stopped
        expect(capture.captureFile().ticks.length).toBe(kept);
    });

    test('a retry against the same monster keeps recording', () => {
        capture.startCapture({ monsterHrid: '/monsters/cyclops', roomLevel: 206 });
        emit('new_battle', { monsters: [{ hrid: '/monsters/cyclops' }], players: [] });
        emit('battle_updated', battle);
        emit('new_battle', { monsters: [{ hrid: '/monsters/cyclops' }], players: [] }); // died, retry
        emit('battle_updated', battle);
        expect(capture.isCapturing()).toBe(true);
        expect(capture.captureFile().ticks.length).toBe(4);
    });

    test('stopOnLeave:false records across monsters (a general capture)', () => {
        capture.startCapture({ monsterHrid: '/monsters/cyclops' }, { stopOnLeave: false });
        emit('new_battle', { monsters: [{ hrid: '/monsters/cyclops' }], players: [] });
        emit('new_battle', { monsters: [{ hrid: '/monsters/other' }], players: [] });
        expect(capture.isCapturing()).toBe(true);
    });
});
