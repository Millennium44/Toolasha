/**
 * Alert when the party starts or stops fighting.
 *
 * What is under test is the part that can go wrong: announcing the game
 * reporting where a party already stands (login, first status) as though it had
 * changed, announcing for a character that is gone, and leaving a listener
 * behind when the setting goes off.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';
import { kindForEventKey } from './notice-policy.js';

const game = vi.hoisted(() => ({
    settings: {},
    characterId: 'me',
    switching: false,
    partyInfo: null,
    listeners: {},
    notified: [],
    notifyResult: { fired: true, channels: ['toast'] },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in game.settings ? game.settings[key] : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get isCharacterSwitching() {
            return game.switching;
        },
        get characterData() {
            return { partyInfo: game.partyInfo };
        },
        getCurrentCharacterId: () => game.characterId,
        getActionDetails: (hrid) => (hrid === '/actions/combat/fly' ? { name: 'Fly' } : null),
        on: (event, handler) => {
            (game.listeners[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            game.listeners[event] = (game.listeners[event] || []).filter((h) => h !== handler);
        },
    },
}));
vi.mock('./notification-service.js', () => ({
    default: {
        notify: (key, message, options) => {
            game.notified.push({ key, message, options });
            return game.notifyResult;
        },
    },
}));

const { default: partyStatusAlerts, MASTER_SETTING, changeMessage } = await import('./party-status-alerts.js');

/** What dataManager emits, in the shape applyPartyUpdate builds it */
function change(previousStatus, status) {
    return {
        status,
        previousStatus,
        started: previousStatus !== 'battling' && status === 'battling',
        stopped: previousStatus === 'battling' && status !== 'battling',
    };
}

/** Deliver an event to whoever is listening, as dataManager would */
function emit(event, data) {
    for (const handler of [...(game.listeners[event] || [])]) handler(data);
}

describe('party status alerts', () => {
    beforeEach(async () => {
        game.settings = { [MASTER_SETTING]: true };
        game.characterId = 'me';
        game.switching = false;
        game.partyInfo = { party: { actionHrid: '/actions/combat/fly', status: 'battling' } };
        game.listeners = {};
        game.notified = [];
        game.notifyResult = { fired: true, channels: ['toast'] };
        partyStatusAlerts.disable();
        await partyStatusAlerts.initialize();
    });

    test('the setting is registered, off by default and says what it does', () => {
        const def = getSettingDefinition('notifications_partyStatus');
        expect(def).toMatchObject({ type: 'checkbox', default: false });
        expect(def.label).toMatch(/party starts or stops fighting/i);
    });

    test('its event keys land in the combat category', () => {
        expect(kindForEventKey('party-status:me:1').category).toBe('combat');
    });

    test('a party that starts, then stops, is announced both times, with the zone on the start', () => {
        emit('party_status_changed', change('recruiting', 'battling'));
        emit('party_status_changed', change('battling', 'recruiting'));

        expect(game.notified.map((n) => n.options.title)).toEqual(['Party started', 'Party stopped']);
        expect(game.notified[0].message).toContain('in Fly');
        expect(game.notified[1].message).toContain('now recruiting');
        expect(new Set(game.notified.map((n) => n.key)).size).toBe(2);
    });

    test('a party that is gone altogether, disbanded or left, says it was disbanded or left', () => {
        emit('party_status_changed', change('battling', null));
        emit('party_status_changed', change('battling', 'disbanded'));

        expect(game.notified).toHaveLength(2);
        for (const n of game.notified) expect(n.message).toContain('disbanded or you are no longer in it');
    });

    test('a status that arrives with no earlier one known is the game reporting, not a change', () => {
        // The login payload carried no party status, so the first party_updated has nothing to compare against
        emit('party_status_changed', change(null, 'battling'));

        expect(game.notified).toHaveLength(0);
    });

    test('a change after that first status is announced', () => {
        emit('party_status_changed', change(null, 'battling'));
        emit('party_status_changed', change('battling', 'recruiting'));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].options.title).toBe('Party stopped');
    });

    test('a change delivered while a character switch is under way is dropped', () => {
        game.switching = true;
        emit('party_status_changed', change('recruiting', 'battling'));

        expect(game.notified).toHaveLength(0);
    });

    test('a change delivered after the character changed is dropped', () => {
        // dataManager delivers a tick late; the character the listener was started for may be gone by then
        game.characterId = 'someone-else';
        emit('party_status_changed', change('recruiting', 'battling'));

        expect(game.notified).toHaveLength(0);
    });

    test('the setting switched off between emit and delivery says nothing', () => {
        game.settings[MASTER_SETTING] = false;
        emit('party_status_changed', change('recruiting', 'battling'));

        expect(game.notified).toHaveLength(0);
    });

    test('an event that is neither a start nor a stop says nothing', () => {
        partyStatusAlerts.onChange({ status: 'battling', previousStatus: 'battling', started: false, stopped: false });
        partyStatusAlerts.onChange(null);

        expect(game.notified).toHaveLength(0);
    });

    test('a change that reached no channel does not use up a counter value', () => {
        game.notifyResult = { fired: false, channels: [] };
        emit('party_status_changed', change('recruiting', 'battling'));
        game.notifyResult = { fired: true, channels: ['toast'] };
        emit('party_status_changed', change('battling', 'recruiting'));

        expect(game.notified).toHaveLength(2);
        // Not told the first time, so the second change reuses the number rather than skipping one
        expect(game.notified[0].key).toBe(game.notified[1].key);
    });

    test('the master switch off wires nothing at all', async () => {
        partyStatusAlerts.disable();
        game.settings[MASTER_SETTING] = false;
        await partyStatusAlerts.initialize();

        expect(game.listeners.party_status_changed ?? []).toHaveLength(0);
        expect(game.listeners.character_switching ?? []).toHaveLength(0);
    });

    test('initializing twice does not double the alert', async () => {
        await partyStatusAlerts.initialize();
        emit('party_status_changed', change('recruiting', 'battling'));

        expect(game.notified).toHaveLength(1);
    });

    test('disable removes both listeners, and re-enabling redoes init for the character then current', async () => {
        partyStatusAlerts.disable();
        expect(game.listeners.party_status_changed).toHaveLength(0);
        expect(game.listeners.character_switching).toHaveLength(0);

        game.characterId = 'second';
        await partyStatusAlerts.initialize();
        emit('party_status_changed', change('recruiting', 'battling'));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].key).toContain(':second:');
    });

    test('a character switch tears the listeners down', () => {
        emit('character_switching', {});

        expect(game.listeners.party_status_changed).toHaveLength(0);
    });

    test('the count never restarts across a switch, so the arriving character gets a fresh key', async () => {
        emit('party_status_changed', change('recruiting', 'battling'));
        const first = game.notified[0].key;
        emit('character_switching', {});
        game.characterId = 'second';
        await partyStatusAlerts.initialize();
        emit('party_status_changed', change('recruiting', 'battling'));

        expect(game.notified[1].key).not.toBe(first);
    });

    test('changeMessage names the zone only when it knows it', () => {
        expect(changeMessage(change('recruiting', 'battling'), '')).toBe('Your party has started fighting.');
        expect(changeMessage(change('recruiting', 'battling'), 'Fly')).toContain('in Fly');
    });
});
