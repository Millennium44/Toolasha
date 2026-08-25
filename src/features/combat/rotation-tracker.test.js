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
const { HISTORY_LIMIT, MIN_SECONDS } = await import('../../utils/rotation-audit.js');

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

    test('does not seed the departing character’s bar over the fresh scopes', () => {
        // `character_switching` fires while characterData still holds the
        // character being left; seeding there would list their abilities as
        // the new character's
        game.characterData = { combatUnit: { combatAbilities: [{ abilityHrid: CHEAP }] } };
        battle();

        emitCharacter('character_switching', {});

        expect(rotationAudit().session.abilities).toEqual([]);
    });

    test('the arriving character’s bar is seeded without the panel reopening', () => {
        battle();
        emitCharacter('character_switching', {});

        // What the data manager does between the two events: the new character's
        // data lands, and only then is there a bar to read
        const OTHER = '/abilities/other_swing';
        game.clientData = { abilityDetailMap: { [OTHER]: { manaCost: 25, cooldownDuration: 3e9 } } };
        game.characterData = { combatUnit: { combatAbilities: [{ abilityHrid: OTHER }] } };
        emitCharacter('character_initialized', {});

        const session = rotationAudit().session;
        expect(session.abilities.map((row) => row.hrid)).toEqual([OTHER]);
        expect(session.castFloor).toBe(25);
    });

    test('the listeners are dropped when the tracker stops', () => {
        stopRotationTracker();
        expect((game.handlers.get('character_switching') || []).length).toBe(0);
        expect((game.handlers.get('character_initialized') || []).length).toBe(0);
    });
});

describe('the per-fight history', () => {
    const START = new Date('2026-08-23T00:00:00Z').getTime();

    /**
     * A fight of `ticks` half-second steps, starting `offset` ms into the clock,
     * with the cheap ability being prepared on every one so the casts are real
     */
    function fightOf(ticks, offset) {
        battle();
        for (let index = 0; index < ticks; index += 1) {
            vi.setSystemTime(offset + index * 500);
            emit('battle_updated', {
                battleId: 'b1',
                pMap: {
                    1: { cMP: 100, mMP: 1000, atkCounter: index, preparingAbilityHrid: CHEAP },
                    2: { cMP: 100, mMP: 1000 },
                },
                mMap: {},
            });
        }
        return offset + ticks * 500;
    }

    test('a finished fight is folded in when the next battle begins, not before', () => {
        fightOf(20, START);

        // The fight is still on screen: nothing has ended, so nothing is recorded
        expect(rotationAudit().history).toEqual([]);

        battle();

        const history = rotationAudit().history;
        expect(history).toHaveLength(1);
        expect(history[0].seconds).toBeCloseTo(9.5, 5);
        expect(history[0].casts).toBe(19);
        expect(history[0].abilities).toEqual([{ hrid: CHEAP, casts: 19 }]);
        expect(history[0].manaSpent).toBe(0);
        expect(history[0].starvedSeconds).toBe(0);

        // And the fight scope itself started again, as it always did
        expect(rotationAudit().fight.seconds).toBe(0);
    });

    test('a fight too short to measure is left out rather than recorded as zeroes', () => {
        // Four half-second gaps is 2s, under MIN_SECONDS
        expect(MIN_SECONDS).toBe(3);
        fightOf(5, START);
        battle();

        expect(rotationAudit().history).toEqual([]);
    });

    test('the buffer is a ring: the last twenty fights, newest first', () => {
        let at = START;
        for (let fight = 0; fight < HISTORY_LIMIT + 5; fight += 1) {
            // Each fight one tick longer than the last, so a row says which it was
            at = fightOf(8 + fight, at + 10_000);
        }
        battle();

        const history = rotationAudit().history;
        expect(history).toHaveLength(HISTORY_LIMIT);
        // Newest first: the longest fight is the most recent one
        expect(history[0].casts).toBeGreaterThan(history[HISTORY_LIMIT - 1].casts);
        for (let index = 1; index < history.length; index += 1) {
            expect(history[index - 1].seconds).toBeGreaterThan(history[index].seconds);
        }
    });

    test('a character switch empties it, on the session scope’s own reasoning', () => {
        fightOf(20, START);
        battle();
        expect(rotationAudit().history).toHaveLength(1);

        emitCharacter('character_switching', {});

        expect(rotationAudit().history).toEqual([]);
    });

    test('stopping the tracker forgets it too', () => {
        fightOf(20, START);
        battle();
        expect(rotationAudit().history).toHaveLength(1);

        stopRotationTracker();

        expect(rotationAudit().history).toEqual([]);
    });
});
