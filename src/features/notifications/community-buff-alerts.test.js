import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

const game = vi.hoisted(() => ({
    settings: {},
    characterData: null,
    initClientData: null,
    wsHandlers: {},
    dmHandlers: {},
    notified: [],
    /** What notify() reports back; a delivered alert is the normal case */
    notifyResult: { fired: true, channels: ['toast'] },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in game.settings ? game.settings[key] : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        getInitClientData: () => game.initClientData,
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
            return game.notifyResult;
        },
    },
}));

const {
    default: communityBuffAlerts,
    COMMUNITY_BUFF_TYPES,
    MASTER_SETTING,
    LEAD_MINUTES_SETTING,
    CHECK_INTERVAL_MS,
} = await import('./community-buff-alerts.js');

const NOW = Date.parse('2026-08-05T12:00:00.000Z');

/** A buff record shaped like the ones the server sends */
function buff(hrid, minutesLeft, extra = {}) {
    return {
        id: 1,
        hrid,
        level: 10,
        startTime: new Date(NOW - 5 * 3600 * 1000).toISOString(),
        expireTime: new Date(NOW + minutesLeft * 60 * 1000).toISOString(),
        isDone: false,
        ...extra,
    };
}

const EXPERIENCE = '/community_buff_types/experience';
const ENHANCING = '/community_buff_types/enhancing_speed';

describe('community buff expiry alerts', () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        game.settings = { [MASTER_SETTING]: true, [LEAD_MINUTES_SETTING]: 15 };
        game.characterData = { communityBuffs: [] };
        game.initClientData = null;
        game.wsHandlers = {};
        game.dmHandlers = {};
        game.notified = [];
        game.notifyResult = { fired: true, channels: ['toast'] };
        communityBuffAlerts.disable();
        await communityBuffAlerts.initialize();
    });

    afterEach(() => {
        communityBuffAlerts.disable();
        vi.useRealTimers();
    });

    test('the master switch off wires nothing at all', async () => {
        communityBuffAlerts.disable();
        game.settings[MASTER_SETTING] = false;
        await communityBuffAlerts.initialize();

        expect(game.wsHandlers.community_buffs_updated).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });

    test('a buff inside the lead window is announced with its real remaining time', () => {
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff(EXPERIENCE, 10)] });

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('Experience');
        expect(game.notified[0].message).toContain('10m');
        expect(game.notified[0].options.title).toBe('Community buff expiring');
    });

    test('a buff still outside the lead window says nothing until it crosses in', () => {
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff(EXPERIENCE, 40)] });
        expect(game.notified).toHaveLength(0);

        // 26 minutes of ticks brings 40 minutes left down to 14
        vi.advanceTimersByTime(26 * 60 * 1000);
        expect(game.notified).toHaveLength(1);
    });

    test('polling the same expiry over and over only announces it once', () => {
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff(EXPERIENCE, 10)] });
        vi.advanceTimersByTime(20 * CHECK_INTERVAL_MS);

        expect(game.notified).toHaveLength(1);
    });

    test('a donation that pushes the expiry out re-arms the alert for the new expiry', () => {
        const first = buff(EXPERIENCE, 10);
        game.wsHandlers.community_buffs_updated({ communityBuffs: [first] });
        expect(game.notified).toHaveLength(1);

        // Extended well past the window, then time walks it back in again
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff(EXPERIENCE, 60)] });
        expect(game.notified).toHaveLength(1);

        vi.advanceTimersByTime(50 * 60 * 1000);
        expect(game.notified).toHaveLength(2);
        expect(game.notified[0].key).not.toBe(game.notified[1].key);
    });

    test('the event key carries the exact expiry, so no two expiries share one', () => {
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff(EXPERIENCE, 10)] });

        const expected = new Date(NOW + 10 * 60 * 1000).toISOString();
        expect(game.notified[0].key).toBe(`community-buff-expiring:${EXPERIENCE}:${expected}`);
    });

    test('an already-expired buff is not announced — there is nothing left to save', () => {
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff(EXPERIENCE, -5)] });

        expect(game.notified).toHaveLength(0);
    });

    test('a buff the server marks done is skipped', () => {
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff(EXPERIENCE, 10, { isDone: true })] });

        expect(game.notified).toHaveLength(0);
    });

    test('a record with no parseable expiry is skipped rather than guessed at', () => {
        game.wsHandlers.community_buffs_updated({
            communityBuffs: [
                { hrid: EXPERIENCE, level: 5 },
                { hrid: ENHANCING, level: 5, expireTime: 'soon' },
            ],
        });

        expect(game.notified).toHaveLength(0);
    });

    test('a buff type with no toggle of its own is left alone', () => {
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff('/community_buff_types/time_travel', 10)] });

        expect(game.notified).toHaveLength(0);
    });

    test('per-buff toggles pick out which buffs speak', () => {
        game.settings.notifications_communityBuff_experience = false;
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff(EXPERIENCE, 10), buff(ENHANCING, 10)] });

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('Enhancing Speed');
    });

    test('per-buff toggles default on, so the master switch alone covers everything', () => {
        game.wsHandlers.community_buffs_updated({
            communityBuffs: COMMUNITY_BUFF_TYPES.map((type) => buff(type.hrid, 10)),
        });

        expect(game.notified).toHaveLength(COMMUNITY_BUFF_TYPES.length);
    });

    test('the lead time is the one the player set', () => {
        game.settings[LEAD_MINUTES_SETTING] = 90;
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff(EXPERIENCE, 80)] });

        expect(game.notified).toHaveLength(1);
    });

    test('a lead time past the top of the range is clamped to it, not honoured', () => {
        game.settings[LEAD_MINUTES_SETTING] = 9000;
        game.wsHandlers.community_buffs_updated({
            communityBuffs: [buff(EXPERIENCE, 119), buff(ENHANCING, 121)],
        });

        // Clamped to 120 minutes: 119 minutes out is inside the window, 121 is not
        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].key).toContain(EXPERIENCE);
    });

    test('a lead time below the bottom of the range is clamped up to it', () => {
        game.settings[LEAD_MINUTES_SETTING] = 0;
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff(EXPERIENCE, 4)] });

        expect(game.notified).toHaveLength(1);
    });

    test('a lead time that is not a number falls back to the default', () => {
        game.settings[LEAD_MINUTES_SETTING] = 'soon';
        game.wsHandlers.community_buffs_updated({
            communityBuffs: [buff(EXPERIENCE, 14), buff(ENHANCING, 16)],
        });

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].key).toContain(EXPERIENCE);
    });

    test('the master switch is re-checked per tick, not only at initialize', () => {
        game.settings[MASTER_SETTING] = false;
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff(EXPERIENCE, 10)] });

        expect(game.notified).toHaveLength(0);
    });

    test('an alert that reached no channel is retried rather than counted as told', () => {
        game.notifyResult = { fired: false, channels: [], reason: 'no channel available' };
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff(EXPERIENCE, 10)] });
        expect(game.notified).toHaveLength(1);

        game.notifyResult = { fired: true, channels: ['toast'] };
        vi.advanceTimersByTime(CHECK_INTERVAL_MS);
        expect(game.notified).toHaveLength(2);

        vi.advanceTimersByTime(10 * CHECK_INTERVAL_MS);
        expect(game.notified).toHaveLength(2);
    });

    test('a message without a buff list leaves the last known list standing', () => {
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff(EXPERIENCE, 40)] });
        game.wsHandlers.community_buffs_updated({ communityActionTypeBuffsMap: {} });

        vi.advanceTimersByTime(26 * 60 * 1000);
        expect(game.notified).toHaveLength(1);
    });

    test('the buff list already on the character is used without waiting for a message', async () => {
        communityBuffAlerts.disable();
        game.notified = [];
        game.characterData = { communityBuffs: [buff(EXPERIENCE, 10)] };
        await communityBuffAlerts.initialize();

        expect(game.notified).toHaveLength(1);
    });

    test('the display name comes from game data when the game has one', () => {
        game.initClientData = { communityBuffTypeDetailMap: { [EXPERIENCE]: { name: 'Wisdom' } } };
        game.wsHandlers.community_buffs_updated({ communityBuffs: [buff(EXPERIENCE, 10)] });

        expect(game.notified[0].message).toContain('Wisdom');
    });

    test('a character switch tears down listeners and the polling timer', () => {
        game.dmHandlers.character_switching();

        expect(game.wsHandlers.community_buffs_updated).toBeUndefined();
        expect(game.wsHandlers.init_character_data).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();

        vi.advanceTimersByTime(10 * CHECK_INTERVAL_MS);
        expect(game.notified).toHaveLength(0);
    });
});

describe('settings schema backs every buff toggle the feature reads', () => {
    test('each community buff type has a toggle, defaulting on', () => {
        for (const type of COMMUNITY_BUFF_TYPES) {
            const definition = getSettingDefinition(type.settingKey);
            expect(definition, `missing schema entry for ${type.hrid}`).toBeTruthy();
            expect(definition.type).toBe('checkbox');
            expect(definition.default).toBe(true);
        }
    });

    test('the master switch is off until asked for, and the lead time defaults to 15 minutes', () => {
        expect(getSettingDefinition(MASTER_SETTING).default).toBe(false);

        const lead = getSettingDefinition(LEAD_MINUTES_SETTING);
        expect(lead.default).toBe(15);
        expect(lead.min).toBe(5);
        expect(lead.max).toBe(120);
        expect(lead.help).toMatch(/actual expiry/i);
    });
});
