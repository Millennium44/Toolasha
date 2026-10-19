/**
 * Tests for the combat death alert.
 *
 * `deathCount` is a running total that is republished on every battle, so the
 * cases that matter are the ones where the number is present and nothing has
 * actually happened: an unchanged count, a new session that resets it, and
 * somebody else's deaths in the same payload.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

const game = vi.hoisted(() => ({
    battleData: null,
    party: [],
    settings: {},
    characterId: 'me',
    wsHandlers: {},
    dmHandlers: {},
    notified: [],
    opened: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in game.settings ? game.settings[key] : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        get battleData() {
            return game.battleData;
        },
        getPartyMembers: () => ({ members: game.party }),
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.wsHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.wsHandlers[event] === handler) delete game.wsHandlers[event];
        },
    },
}));
vi.mock('./notification-service.js', () => ({
    default: {
        notify: (key, message, options) => {
            game.notified.push({ key, message, options });
            return { fired: true, channels: ['toast'] };
        },
    },
}));

vi.mock('./death-recap.js', () => ({
    openRecap: (...args) => {
        game.opened.push(args);
        return true;
    },
}));

const { default: combatDeathAlerts, MASTER_SETTING } = await import('./combat-death-alerts.js');

/** A `new_battle` payload with the given death counts */
function battle(...counts) {
    return {
        players: counts.map(([id, deathCount]) => ({ character: { id, name: id }, deathCount })),
    };
}

const send = (payload) => game.wsHandlers.new_battle(payload);

/** A battle_updated tick; `null` omits the seat (a partial tick). Seat 0 is us in `battle(['me', ...], ...)` */
const tick = (...seats) => {
    const pMap = {};
    seats.forEach((hp, i) => {
        if (hp === null) return;
        pMap[i] =
            hp <= 0
                ? { cHP: 0, mHP: 1600, isActive: false, respawnTime: '2026-10-19T09:00:15.000Z' }
                : { cHP: hp, mHP: 1600, isActive: true };
    });
    game.wsHandlers.battle_updated({ battleId: 1, pMap, mMap: {} });
};

describe('combat death alerts', () => {
    beforeEach(async () => {
        game.settings = { [MASTER_SETTING]: true };
        game.characterId = 'me';
        game.battleData = null;
        game.party = [];
        game.wsHandlers = {};
        game.dmHandlers = {};
        game.notified = [];
        game.opened = [];
        combatDeathAlerts.disable();
        await combatDeathAlerts.initialize();
    });

    afterEach(() => {
        combatDeathAlerts.disable();
    });

    test('the master switch off wires nothing at all', async () => {
        combatDeathAlerts.disable();
        game.settings[MASTER_SETTING] = false;
        await combatDeathAlerts.initialize();

        expect(game.wsHandlers.new_battle).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });

    test('a rise in the death count is announced, with the running total', () => {
        send(battle(['me', 0]));
        send(battle(['me', 1]));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('You died in combat');
        expect(game.notified[0].message).toContain('1 death');
        expect(game.notified[0].options.title).toBe('You died');
    });

    test('the alert carries an action that opens the death recap', () => {
        send(battle(['me', 0]));
        send(battle(['me', 1]));

        const { action } = game.notified[0].options;
        expect(action.label).toMatch(/recap/i);
        expect(game.opened).toHaveLength(0);
        action.onClick();
        expect(game.opened).toHaveLength(1);
    });

    test('several deaths at once are reported as the total, pluralised', () => {
        send(battle(['me', 1]));
        send(battle(['me', 4]));

        expect(game.notified[0].message).toContain('4 deaths');
    });

    test('the first battle seen is a baseline, not a death', () => {
        send(battle(['me', 9]));

        expect(game.notified).toHaveLength(0);
    });

    test('an unchanged count on every battle says nothing', () => {
        send(battle(['me', 2]));
        send(battle(['me', 2]));
        send(battle(['me', 2]));

        expect(game.notified).toHaveLength(0);
    });

    test('a new session takes the count back down without announcing a thing', () => {
        send(battle(['me', 3]));
        send(battle(['me', 0]));

        expect(game.notified).toHaveLength(0);
    });

    test('after a reset, the next death is measured from the new baseline', () => {
        send(battle(['me', 3]));
        send(battle(['me', 0]));
        send(battle(['me', 1]));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('1 death');
    });

    describe('on death, not on respawn', () => {
        test('a solo death tick alerts at once; the dead ticks, the respawn and the later count rise do not alert again', () => {
            send(battle(['me', 0]));
            tick(1591);
            tick(95);
            expect(game.notified).toHaveLength(0);

            tick(0);
            expect(game.notified).toHaveLength(1);
            expect(game.notified[0].message).toContain('You died in combat');

            tick(0);
            tick(null);
            tick(0);
            tick(1600);
            expect(game.notified).toHaveLength(1);

            // the server's counter catches up on a later battle: the same death
            send(battle(['me', 1]));
            expect(game.notified).toHaveLength(1);
        });

        test('a second death in the same fight alerts again once the respawn re-armed it', () => {
            send(battle(['me', 0]));
            tick(100);
            tick(0);
            tick(1600);
            tick(50);
            tick(0);
            expect(game.notified).toHaveLength(2);
            send(battle(['me', 2]));
            expect(game.notified).toHaveLength(2);
        });

        test('a partial tick is never a death or a respawn', () => {
            send(battle(['me', 0]));
            tick(0);
            tick(null);
            tick(null);
            expect(game.notified).toHaveLength(1);
            tick(null);
            tick(0);
            expect(game.notified).toHaveLength(1);
        });

        test('a party member at 0 HP does not alert; our seat is read by position', () => {
            send(battle(['friend', 0], ['me', 0]));
            tick(0, 900);
            tick(0, 800);
            expect(game.notified).toHaveLength(0);
            tick(500, 0);
            expect(game.notified).toHaveLength(1);
        });

        test('a missed tick with a later count rise alerts once, from the counter', () => {
            send(battle(['me', 0]));
            tick(900);
            send(battle(['me', 1]));
            expect(game.notified).toHaveLength(1);
            expect(game.notified[0].message).toContain('1 death');
        });

        test('one death seen on a tick plus one the tick missed announces only the missed one', () => {
            send(battle(['me', 0]));
            tick(0);
            expect(game.notified).toHaveLength(1);
            send(battle(['me', 2]));
            expect(game.notified).toHaveLength(2);
        });

        test('nothing is wired to ticks while the master switch is off', async () => {
            combatDeathAlerts.disable();
            game.settings[MASTER_SETTING] = false;
            await combatDeathAlerts.initialize();
            expect(game.wsHandlers.battle_updated).toBeUndefined();
        });

        test('disable() drops the tick handler and the seat', () => {
            send(battle(['me', 0]));
            combatDeathAlerts.disable();
            expect(game.wsHandlers.battle_updated).toBeUndefined();
        });
    });

    describe('after a reload with no new_battle', () => {
        test('a solo fight alerts on the death tick, once', () => {
            tick(1591);
            expect(game.notified).toHaveLength(0);
            tick(0);
            tick(0);
            tick(1600);
            expect(game.notified).toHaveLength(1);
        });

        test('a party with no roster is never guessed at', () => {
            game.party = [{ characterID: 'me' }, { characterID: 'friend' }];
            tick(100);
            tick(0);
            expect(game.notified).toHaveLength(0);

            send(battle(['friend', 0], ['me', 0]));
            tick(500, 100);
            tick(500, 0);
            expect(game.notified).toHaveLength(1);
        });

        test('the cached new_battle names our seat in a party', () => {
            game.party = [{ characterID: 'me' }, { characterID: 'friend' }];
            game.battleData = battle(['friend', 0], ['me', 0]);
            tick(0, 800);
            expect(game.notified).toHaveLength(0);
            tick(800, 0);
            expect(game.notified).toHaveLength(1);
        });
    });

    test('a party member dying is their business', () => {
        send(battle(['me', 0], ['friend', 0]));
        send(battle(['me', 0], ['friend', 3]));

        expect(game.notified).toHaveLength(0);
    });

    test('your own death is still found when the party is listed around you', () => {
        send(battle(['friend', 0], ['me', 0], ['other', 0]));
        send(battle(['friend', 0], ['me', 1], ['other', 2]));

        expect(game.notified).toHaveLength(1);
    });

    test('a payload with no entry for you is skipped rather than guessed at', () => {
        send(battle(['me', 0]));
        send(battle(['friend', 5]));
        send(battle(['me', 0]));

        expect(game.notified).toHaveLength(0);
    });

    test('a payload with no players at all is ignored', () => {
        send(battle(['me', 0]));
        send({});
        send({ players: [] });
        send(battle(['me', 1]));

        expect(game.notified).toHaveLength(1);
    });

    test('one event key for the feature, so the service caps a bad zone at one message', () => {
        send(battle(['me', 0]));
        send(battle(['me', 1]));
        send(battle(['me', 2]));

        expect(game.notified.map((entry) => entry.key)).toEqual(['combat-death', 'combat-death']);
    });

    test('the master switch is re-checked per battle, not only at initialize', () => {
        send(battle(['me', 0]));
        game.settings[MASTER_SETTING] = false;
        send(battle(['me', 1]));

        expect(game.notified).toHaveLength(0);
    });

    test('a character switch tears the listeners down and forgets the count', () => {
        send(battle(['me', 4]));
        game.dmHandlers.character_switching();

        expect(game.wsHandlers.new_battle).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });
});

describe('settings schema backs the death alert', () => {
    test('the switch exists and is off until asked for', () => {
        const definition = getSettingDefinition(MASTER_SETTING);
        expect(definition).toBeTruthy();
        expect(definition.type).toBe('checkbox');
        expect(definition.default).toBe(false);
        expect(definition.help).toMatch(/not the party/i);
    });
});
