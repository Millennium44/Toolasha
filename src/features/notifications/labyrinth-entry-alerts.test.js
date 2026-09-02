/**
 * Labyrinth entry alerts.
 *
 * The arithmetic is labyrinth-entry-forecast.test.js; this covers the two
 * triggers (the stock rising, and the projected instant passing on an idle
 * tab), the once-per-regeneration keying, and the seed that must not fire.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    settings: {},
    characterData: null,
    characterId: 'char-1',
    wsHandlers: {},
    dmHandlers: {},
    notified: [],
    notifyResult: { fired: true, channels: ['toast'] },
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key, fallback = false) => (key in game.settings ? game.settings[key] : fallback) },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
        getCurrentCharacterId: () => game.characterId,
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
            return game.notifyResult;
        },
    },
}));

const { default: labyrinthEntryAlerts, MASTER_SETTING } = await import('./labyrinth-entry-alerts.js');

const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-13T04:18:00.000Z');

function stock({ entries = 1, cooldownHours = 48, lastHoursAgo = 0 } = {}) {
    game.characterData = {
        characterInfo: {
            labyrinthEntries: entries,
            labyrinthCooldownHours: cooldownHours,
            lastLabyrinthTimestamp: new Date(NOW - lastHoursAgo * HOUR).toISOString(),
        },
    };
}

describe('labyrinth entry alerts', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        game.settings = { [MASTER_SETTING]: true };
        game.characterId = 'char-1';
        game.wsHandlers = {};
        game.dmHandlers = {};
        game.notified = [];
        game.notifyResult = { fired: true, channels: ['toast'] };
        labyrinthEntryAlerts.lastEntries = null;
        labyrinthEntryAlerts.announcedAt = null;
    });

    afterEach(() => {
        labyrinthEntryAlerts.disable();
        vi.useRealTimers();
    });

    test('fires when the stock rises', () => {
        stock({ entries: 1, lastHoursAgo: 0.3 });
        labyrinthEntryAlerts.check({ seed: true }); // baseline at 1
        stock({ entries: 2, lastHoursAgo: 0.3 });
        const result = labyrinthEntryAlerts.check();
        expect(result?.fired).toBe(true);
        expect(game.notified.at(-1).message).toContain('2/5');
    });

    test('the seed observation does not fire', () => {
        stock({ entries: 3, lastHoursAgo: 0.3 });
        expect(labyrinthEntryAlerts.check({ seed: true })).toBeNull();
        expect(game.notified).toHaveLength(0);
    });

    test('fires when the projected instant has passed on an idle tab', () => {
        // Last entry 49h ago, cooldown 48h → one regenerated an hour ago but the
        // count in memory has not moved.
        stock({ entries: 1, lastHoursAgo: 49 });
        labyrinthEntryAlerts.check({ seed: true });
        const result = labyrinthEntryAlerts.check();
        expect(result?.fired).toBe(true);
    });

    test('does not repeat the same regeneration instant', () => {
        stock({ entries: 1, lastHoursAgo: 49 });
        labyrinthEntryAlerts.check({ seed: true });
        labyrinthEntryAlerts.check();
        const after = game.notified.length;
        labyrinthEntryAlerts.check();
        expect(game.notified.length).toBe(after);
    });

    test('two characters regenerating in the same minute bucket are keyed apart', () => {
        // char-1 regenerated an entry an hour ago
        stock({ entries: 1, lastHoursAgo: 49 });
        labyrinthEntryAlerts.check({ seed: true });
        expect(labyrinthEntryAlerts.check()?.fired).toBe(true);
        const firstKey = game.notified.at(-1).key;

        // A switch stands the watcher down; the arriving character starts clean
        labyrinthEntryAlerts.disable();
        game.characterId = 'char-2';

        // Identical stock → same regeneration instant → same minute bucket
        stock({ entries: 1, lastHoursAgo: 49 });
        labyrinthEntryAlerts.check({ seed: true });
        expect(labyrinthEntryAlerts.check()?.fired).toBe(true);
        const secondKey = game.notified.at(-1).key;

        // Scoped by character, so the shared de-dup map cannot swallow the second
        expect(secondKey).not.toBe(firstKey);
    });

    test('the projection and the server’s own edge are one regeneration, not two', () => {
        // Projected first on an idle tab: due an hour ago, count not moved yet.
        stock({ entries: 1, lastHoursAgo: 49 });
        labyrinthEntryAlerts.check({ seed: true });
        expect(labyrinthEntryAlerts.check()?.fired).toBe(true);

        // Then the server pushes the regeneration it had already made: the count
        // rises and lastLabyrinthTimestamp moves to that same instant.
        stock({ entries: 2, lastHoursAgo: 1 });
        expect(labyrinthEntryAlerts.check()).toBeNull();
        expect(game.notified).toHaveLength(1);
    });

    test('a server stamp a few seconds off the projected deadline is still one event', () => {
        stock({ entries: 1, lastHoursAgo: 49 });
        labyrinthEntryAlerts.check({ seed: true });
        labyrinthEntryAlerts.check();
        game.characterData.characterInfo = {
            labyrinthEntries: 2,
            labyrinthCooldownHours: 48,
            lastLabyrinthTimestamp: new Date(NOW - HOUR + 3000).toISOString(),
        };
        expect(labyrinthEntryAlerts.check()).toBeNull();
        expect(game.notified).toHaveLength(1);
    });

    test('the projected alert quotes the stock the regeneration produced, not the stale one', () => {
        stock({ entries: 1, lastHoursAgo: 49 });
        labyrinthEntryAlerts.check({ seed: true });
        labyrinthEntryAlerts.check();
        expect(game.notified.at(-1).message).toContain('2/5');
        expect(game.notified.at(-1).message).not.toContain('1/5');
    });

    test('a full stock is announced but never projects a next entry', () => {
        stock({ entries: 4, lastHoursAgo: 0.3 });
        labyrinthEntryAlerts.check({ seed: true });
        stock({ entries: 5, lastHoursAgo: 0.3 });
        const result = labyrinthEntryAlerts.check();
        expect(result?.fired).toBe(true);
        expect(game.notified.at(-1).message).toContain('full');
    });

    test('does nothing while the setting is off', () => {
        game.settings = { [MASTER_SETTING]: false };
        stock({ entries: 2, lastHoursAgo: 0.3 });
        expect(labyrinthEntryAlerts.check()).toBeNull();
    });
});
