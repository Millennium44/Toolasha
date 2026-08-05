/**
 * Warning before the task board fills up.
 *
 * The thing being tested is not the arithmetic — that is
 * `task-slot-forecast.test.js` — but the three ways a lead-time alert over a
 * *projected* instant goes wrong: it fires on every one of the hundreds of
 * re-checks that produce the same deadline, it stays silent after something
 * frees a slot and moves the deadline, or it keeps announcing a board that has
 * been full for hours.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

const game = vi.hoisted(() => ({
    settings: {},
    characterData: null,
    characterQuests: [],
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
        get characterQuests() {
            return game.characterQuests;
        },
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
    default: taskSlotAlerts,
    MASTER_SETTING,
    LEAD_HOURS_SETTING,
    CHECK_INTERVAL_MS,
    MIN_LEAD_HOURS,
    MAX_LEAD_HOURS,
    DEFAULT_LEAD_HOURS,
} = await import('./task-slot-alerts.js');

const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-05T12:00:00.000Z');

/** A task sitting on the board */
const boardTask = { category: '/quest_category/random_task', status: '/quest_status/in_progress' };

/**
 * Put the character on a board with this much room left.
 *
 * @param {Object} [options] - The board
 * @param {number} [options.onBoard=0] - Tasks currently held
 * @param {number} [options.cap=6] - Slots
 * @param {number} [options.cooldownHours=3] - The arrival cadence
 * @param {number} [options.lastTaskHoursAgo=0] - When the last task arrived
 */
function board({ onBoard = 0, cap = 6, cooldownHours = 3, lastTaskHoursAgo = 0 } = {}) {
    game.characterData = {
        characterInfo: {
            taskSlotCap: cap,
            taskCooldownHours: cooldownHours,
            lastTaskTimestamp: new Date(NOW - lastTaskHoursAgo * HOUR).toISOString(),
            unreadTaskCount: 0,
        },
    };
    game.characterQuests = Array.from({ length: onBoard }, () => ({ ...boardTask }));
}

describe('task slot alerts', () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        game.settings = { [MASTER_SETTING]: true, [LEAD_HOURS_SETTING]: 8 };
        game.wsHandlers = {};
        game.dmHandlers = {};
        game.notified = [];
        game.notifyResult = { fired: true, channels: ['toast'] };
        // Five of six slots taken, the last one an hour ago: the board fills in
        // two hours, comfortably inside the eight-hour lead
        board({ onBoard: 5, lastTaskHoursAgo: 1 });
        taskSlotAlerts.disable();
        await taskSlotAlerts.initialize();
    });

    afterEach(() => {
        taskSlotAlerts.disable();
        vi.useRealTimers();
    });

    test('the master switch off wires nothing at all', async () => {
        taskSlotAlerts.disable();
        game.settings[MASTER_SETTING] = false;
        game.notified = [];
        await taskSlotAlerts.initialize();

        expect(game.wsHandlers.character_info_updated).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
        expect(game.notified).toHaveLength(0);
    });

    test('a board inside the lead window is announced, with the room left and the cadence', () => {
        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('2h');
        expect(game.notified[0].message).toContain('1 free slot of 6');
        expect(game.notified[0].message).toContain('one task every 3h');
        expect(game.notified[0].options.title).toBe('Task slots filling up');
    });

    test('a deadline still outside the lead window says nothing until it comes inside', async () => {
        taskSlotAlerts.disable();
        game.notified = [];
        // Four free slots at three hours each: twelve hours off, past an
        // eight-hour lead
        board({ onBoard: 2 });
        await taskSlotAlerts.initialize();
        expect(game.notified).toHaveLength(0);

        // Three hours of ticks leaves nine, still outside an eight-hour lead
        vi.advanceTimersByTime(3 * HOUR);
        expect(game.notified).toHaveLength(0);

        // The crossing itself is the tick where the deadline reaches the lead
        vi.advanceTimersByTime(2 * HOUR);
        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('fill in 8h');
    });

    test('the same deadline re-derived on every tick is announced once', () => {
        // The failure this exists to prevent: the check runs every minute and
        // on every task message, and each run recomputes the identical instant
        vi.advanceTimersByTime(30 * CHECK_INTERVAL_MS);
        game.wsHandlers.quests_updated({});
        game.wsHandlers.character_info_updated({});

        expect(game.notified).toHaveLength(1);
    });

    test('clearing a task moves the deadline and arms the warning again', () => {
        expect(game.notified).toHaveLength(1);

        // A task claimed: a slot comes free, so the board now fills a cadence
        // later than it was going to
        game.characterQuests = [{ ...boardTask }, { ...boardTask }, { ...boardTask }, { ...boardTask }];
        game.wsHandlers.quests_updated({});

        expect(game.notified).toHaveLength(2);
        expect(game.notified[1].message).toContain('5h');
        expect(game.notified[1].key).not.toBe(game.notified[0].key);
    });

    test('an undelivered alert is retried rather than counted as told', () => {
        // Nothing reached a channel — permission refused, no DOM yet — so the
        // deadline has not actually been announced to anybody
        taskSlotAlerts.disable();
        game.notified = [];
        game.notifyResult = { fired: false, channels: [], reason: 'no channel available' };
        taskSlotAlerts.check();
        expect(game.notified).toHaveLength(1);

        game.notifyResult = { fired: true, channels: ['toast'] };
        taskSlotAlerts.check();
        expect(game.notified).toHaveLength(2);
    });

    test('a full board says so once, however long it stays full', async () => {
        taskSlotAlerts.disable();
        game.notified = [];
        board({ onBoard: 6 });
        await taskSlotAlerts.initialize();

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('All 6 task slots are full');
        expect(game.notified[0].options.title).toBe('Task slots full');

        // The server rolls the cooldown forward every time a task is thrown
        // away, which moves the projected instant without anything having
        // changed for the player
        vi.advanceTimersByTime(6 * HOUR);
        board({ onBoard: 6 });
        game.wsHandlers.character_info_updated({});
        expect(game.notified).toHaveLength(1);
    });

    test('and says so again after the board has had room and filled up once more', async () => {
        taskSlotAlerts.disable();
        game.notified = [];
        board({ onBoard: 6 });
        await taskSlotAlerts.initialize();
        expect(game.notified).toHaveLength(1);

        // Two claimed, so there is room again
        board({ onBoard: 4, lastTaskHoursAgo: 3 });
        game.wsHandlers.quests_updated({});
        game.notified = [];

        board({ onBoard: 6 });
        game.wsHandlers.quests_updated({});
        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('are full');
    });

    test('character data that has not arrived is not a deadline of any kind', async () => {
        taskSlotAlerts.disable();
        game.notified = [];
        game.characterData = null;
        game.characterQuests = [];
        await taskSlotAlerts.initialize();

        vi.advanceTimersByTime(10 * CHECK_INTERVAL_MS);
        expect(game.notified).toHaveLength(0);
    });

    test('a cadence the server did not send is silence, not a guessed one', async () => {
        taskSlotAlerts.disable();
        game.notified = [];
        board({ onBoard: 5, lastTaskHoursAgo: 1 });
        delete game.characterData.characterInfo.taskCooldownHours;
        await taskSlotAlerts.initialize();

        expect(game.notified).toHaveLength(0);
    });

    test('a stale last-task time with slots still free is not a warning', async () => {
        // The page has been open across a gap in the messages, so the deadline
        // it projects is already behind us while the board still has room —
        // which is a reading to distrust rather than an alarm to raise
        taskSlotAlerts.disable();
        game.notified = [];
        board({ onBoard: 5, lastTaskHoursAgo: 9 });
        await taskSlotAlerts.initialize();

        expect(game.notified).toHaveLength(0);
    });

    test('the lead time is clamped to what the control offers', () => {
        game.settings[LEAD_HOURS_SETTING] = 1000;
        expect(taskSlotAlerts.leadHours()).toBe(MAX_LEAD_HOURS);

        game.settings[LEAD_HOURS_SETTING] = 0;
        expect(taskSlotAlerts.leadHours()).toBe(MIN_LEAD_HOURS);

        game.settings[LEAD_HOURS_SETTING] = 'soon';
        expect(taskSlotAlerts.leadHours()).toBe(DEFAULT_LEAD_HOURS);
    });

    test('switching character takes the listeners and the timer away', () => {
        game.dmHandlers.character_switching();

        expect(game.wsHandlers.character_info_updated).toBeUndefined();
        expect(game.wsHandlers.quests_updated).toBeUndefined();

        game.notified = [];
        vi.advanceTimersByTime(10 * CHECK_INTERVAL_MS);
        expect(game.notified).toHaveLength(0);
    });
});

describe('the settings schema backs what the feature reads', () => {
    test('the master switch is off until asked for', () => {
        const definition = getSettingDefinition(MASTER_SETTING);
        expect(definition).toBeTruthy();
        expect(definition.type).toBe('checkbox');
        expect(definition.default).toBe(false);
    });

    test('the lead time defaults to eight hours, and says what it cannot know', () => {
        const lead = getSettingDefinition(LEAD_HOURS_SETTING);
        expect(lead.type).toBe('number');
        expect(lead.default).toBe(DEFAULT_LEAD_HOURS);
        expect(lead.min).toBe(MIN_LEAD_HOURS);
        expect(lead.max).toBe(MAX_LEAD_HOURS);

        // The caveat belongs on the toggle, next to the claim it qualifies
        expect(getSettingDefinition(MASTER_SETTING).help).toMatch(/projection, not an observation/i);
    });
});
