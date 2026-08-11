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
