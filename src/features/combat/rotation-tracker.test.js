/**
 * The rotation tracker's plumbing.
 *
 * The arithmetic is `utils/rotation-audit.js`' and is tested there. What is left
 * here is what a subscription can get wrong: which slot it watches, and how long
 * a session scope is allowed to live. A scope that survives a character switch
 * is the one that matters — it averages two bars, two mana pools and two sets of
 * fights into rows that say which ability but never which character.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    name: 'Me',
    clientData: { abilityDetailMap: {} },
    characterData: null,
    /** event → handlers, so a test can fire a character switch */
    handlers: new Map(),
    /** websocket event → handlers */
    socket: new Map(),
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterName: () => game.name,
        getInitClientData: () => game.clientData,
        get characterData() {
            return game.characterData;
        },
        on: (event, handler) => {
            if (!game.handlers.has(event)) game.handlers.set(event, []);
            game.handlers.get(event).push(handler);
        },
        off: (event, handler) => {
            game.handlers.set(
                event,
                (game.handlers.get(event) || []).filter((entry) => entry !== handler)
            );
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            if (!game.socket.has(event)) game.socket.set(event, []);
            game.socket.get(event).push(handler);
        },
        off: (event, handler) => {
            game.socket.set(
                event,
                (game.socket.get(event) || []).filter((entry) => entry !== handler)
            );
        },
    },
}));

const { startRotationTracker, stopRotationTracker, rotationAudit } = await import('./rotation-tracker.js');

const CHEAP = '/abilities/cheap_jab';

/** Fire one websocket event at whatever is subscribed */
const emit = (event, data) => (game.socket.get(event) || []).forEach((handler) => handler(data));

/** Fire one data-manager event */
const emitCharacter = (event, data) => (game.handlers.get(event) || []).forEach((handler) => handler(data));

/** A battle in which this character holds slot 1, with one ability on the bar */
function battle() {
    emit('new_battle', {
        players: {
            1: { name: 'Me', combatDetails: { combatAbilities: [{ abilityHrid: CHEAP }] } },
            2: { name: 'Ally' },
        },
    });
}

/** A tick of that battle, half a second on from the last */
function tick(index) {
    emit('battle_updated', {
        battleId: 'b1',
        pMap: { 1: { cMP: 100, mMP: 1000, atkCounter: index }, 2: { cMP: 100, mMP: 1000 } },
        mMap: {},
    });
}

beforeEach(() => {
    game.name = 'Me';
    game.characterData = null;
    game.clientData = { abilityDetailMap: { [CHEAP]: { manaCost: 10, cooldownDuration: 2e9 } } };
    game.handlers = new Map();
    game.socket = new Map();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T00:00:00Z'));
    startRotationTracker();
});

afterEach(() => {
    stopRotationTracker();
    vi.useRealTimers();
});

describe('whose slot is being watched', () => {
    test('nothing is tracked until a battle names this character', () => {
        expect(rotationAudit().tracking).toBe(false);
        battle();
        expect(rotationAudit().tracking).toBe(true);
    });
});

describe('a character switch', () => {
    test('ends the session scope rather than averaging two characters into it', () => {
        battle();
        for (let index = 0; index < 5; index += 1) {
            vi.setSystemTime(new Date('2026-08-23T00:00:00Z').getTime() + index * 500);
            tick(index);
        }

        const before = rotationAudit();
        expect(before.session.fights).toBe(1);
        expect(before.session.seconds).toBeGreaterThan(0);

        emitCharacter('character_switching', {});

        const after = rotationAudit();
        expect(after.tracking).toBe(false);
        expect(after.session.fights).toBe(0);
        expect(after.session.seconds).toBe(0);
        expect(after.session.abilities).toEqual([]);
    });

    test('the listener is dropped when the tracker stops', () => {
        stopRotationTracker();
        expect((game.handlers.get('character_switching') || []).length).toBe(0);
    });
});
