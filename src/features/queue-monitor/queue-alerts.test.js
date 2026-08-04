/**
 * Tests for the alt-has-stopped alert.
 *
 * The thing worth guarding is that it says something exactly once. The check
 * runs every minute against snapshots that do not change while you are away, so
 * a missing edge means the same character is announced sixty times an hour —
 * and the announcement is a desktop notification, which makes that the kind of
 * bug people uninstall over.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ snapshots: [], settings: {}, notified: [] }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => game.settings[key] ?? false },
}));

vi.mock('../notifications/notification-service.js', () => ({
    default: {
        notify: (eventKey, message) => {
            game.notified.push({ eventKey, message });
            return { fired: true, channels: ['toast'] };
        },
    },
}));

vi.mock('./queue-snapshot.js', () => ({
    default: { getOtherCharacterSnapshots: () => game.snapshots },
}));

const { default: queueAlerts } = await import('./queue-alerts.js');

/** A character that queued `seconds` of work `agoMs` ago */
function snapshot(characterId, { seconds, agoMs, infinite = false }) {
    return {
        characterId,
        characterName: characterId,
        timestamp: Date.now() - agoMs,
        actions: [{ actionName: 'Chopping' }],
        totalQueueSeconds: seconds,
        hasInfiniteAction: infinite,
    };
}

beforeEach(() => {
    game.snapshots = [];
    game.notified = [];
    game.settings = { notifications_otherCharacterIdle: true };
    queueAlerts.disable();
});

describe('queue alerts', () => {
    test('announces a character whose queue has run out', () => {
        game.snapshots = [snapshot('Alt', { seconds: 60, agoMs: 3600_000 })];

        queueAlerts.check();

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].eventKey).toBe('character-idle:Alt');
        expect(game.notified[0].message).toContain('Alt');
    });

    test('says it once, however many times the poll runs', () => {
        game.snapshots = [snapshot('Alt', { seconds: 60, agoMs: 3600_000 })];

        queueAlerts.check();
        queueAlerts.check();
        queueAlerts.check();

        expect(game.notified).toHaveLength(1);
    });

    test('stays quiet about a character still working through its queue', () => {
        game.snapshots = [snapshot('Alt', { seconds: 86400, agoMs: 60_000 })];

        queueAlerts.check();

        expect(game.notified).toEqual([]);
    });

    test('never announces a character running something unbounded', () => {
        game.snapshots = [snapshot('Alt', { seconds: 0, agoMs: 86400_000, infinite: true })];

        queueAlerts.check();

        expect(game.notified).toEqual([]);
    });

    test('a newer snapshot makes the same character announceable again', () => {
        game.snapshots = [snapshot('Alt', { seconds: 60, agoMs: 3600_000 })];
        queueAlerts.check();
        expect(game.notified).toHaveLength(1);

        // You switched to that character, queued more, and switched away again
        game.snapshots = [snapshot('Alt', { seconds: 60, agoMs: 1800_000 })];
        queueAlerts.check();

        expect(game.notified).toHaveLength(2);
    });

    test('the setting off means no check at all', () => {
        game.settings.notifications_otherCharacterIdle = false;
        game.snapshots = [snapshot('Alt', { seconds: 60, agoMs: 3600_000 })];

        expect(queueAlerts.check()).toEqual([]);
        expect(game.notified).toEqual([]);
    });

    test('initialize does nothing while the setting is off', () => {
        game.settings.notifications_otherCharacterIdle = false;
        game.snapshots = [snapshot('Alt', { seconds: 60, agoMs: 3600_000 })];

        queueAlerts.initialize();

        expect(game.notified).toEqual([]);
        queueAlerts.disable();
    });

    test('initialize checks immediately, for an alt that stopped while the page was shut', () => {
        game.snapshots = [snapshot('Alt', { seconds: 60, agoMs: 3600_000 })];

        queueAlerts.initialize();

        expect(game.notified).toHaveLength(1);
        queueAlerts.disable();
    });
});
