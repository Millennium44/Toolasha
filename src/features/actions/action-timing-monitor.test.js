/** @vitest-environment happy-dom
 *
 * The monitor measures the progress bar's own CSS animation events, so the
 * tests drive those events directly against a bar shaped like the game's.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

const state = vi.hoisted(() => ({
    settingEnabled: true,
    characterId: 'char-a',
    stored: null,
    writes: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn(() => state.settingEnabled),
        onSettingChange: vi.fn(),
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(async () => state.stored),
        set: vi.fn(async (key, value) => {
            state.writes.push({ key, value: structuredClone(value) });
            return true;
        }),
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: vi.fn(() => state.characterId),
        getCurrentActions: vi.fn(() => [{ actionHrid: '/actions/cheesesmithing/cheese_gauntlets' }]),
        getActionDetails: vi.fn(() => ({
            name: 'Cheese Gauntlets',
            type: '/action_types/cheesesmithing',
            baseTimeCost: 30e9,
        })),
        getInitClientData: vi.fn(() => ({
            itemDetailMap: { '/items/super_cheesesmithing_tea': { name: 'Super Tea' } },
        })),
        getCommunityBuffLevel: vi.fn(() => 2),
        getPersonalBuffFlatBoost: vi.fn(() => 0.15),
        getHouseRooms: vi.fn(() => new Map([['/house_rooms/forge', { level: 8 }]])),
        isTaskAction: vi.fn(() => false),
        getTaskSpeedBonus: vi.fn(() => 0),
        isBuffBeingSimulated: vi.fn((_type, buffHrid) => buffHrid === '/buff_types/action_speed'),
        getSkills: vi.fn(() => []),
        characterData: { guildActionTypeBuffsMap: {} },
    },
}));

vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: vi.fn(() => ({
        equipment: new Map(),
        drinks: [{ itemHrid: '/items/super_cheesesmithing_tea', isActive: true, duration: 3e11 }],
    })),
}));
vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: vi.fn(() => ({ actionTime: 8.5176 })),
}));
vi.mock('../../utils/equipment-parser.js', () => ({ parseEquipmentSpeedBonuses: vi.fn(() => 0.1) }));
vi.mock('../../utils/house-efficiency.js', () => ({ calculateHouseActionSpeed: vi.fn(() => 0) }));
vi.mock('../../utils/community-buffs.js', () => ({ getCommunityBuffBonus: vi.fn(() => 0.14) }));

const feature = (await import('./action-timing-monitor.js')).default;
const monitor = feature._monitor;
const { default: storage } = await import('../../core/storage.js');

/** @returns {HTMLElement} The animated inner bar, mounted and reporting `--duration` */
function mountBar(duration) {
    document.body.innerHTML =
        '<div class="ProgressBar_progressBar__a">' +
        '<div class="ProgressBar_innerBarContainer__b"><div class="ProgressBar_innerBar__c"></div></div>' +
        '</div>';
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => String(duration) }));
    return document.querySelector('.ProgressBar_innerBar__c');
}

/** Dispatch one bubbling animation event of the game's roundtime keyframes. */
function fire(el, type, animationName = 'ProgressBar_roundtime__xyz') {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, 'animationName', { value: animationName });
    el.dispatchEvent(event);
}

/**
 * One complete action: it starts, the bar finishes after `animatedMs`, and the
 * next action starts `deadMs` later.
 */
function runAction(el, { animatedMs, deadMs }) {
    vi.advanceTimersByTime(animatedMs);
    fire(el, 'animationend');
    vi.advanceTimersByTime(deadMs);
    fire(el, 'animationstart');
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
    state.settingEnabled = true;
    state.characterId = 'char-a';
    state.stored = null;
    state.writes = [];
});

afterEach(() => {
    monitor.cleanup();
    monitor.settingChangeHandler = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('measuring the bar', () => {
    test('a bar that finishes early and sits full is recorded', async () => {
        const bar = mountBar(3);
        await feature.initialize();

        fire(bar, 'animationstart');
        runAction(bar, { animatedMs: 3000, deadMs: 25000 });

        expect(monitor.observed).toBe(1);
        expect(monitor.anomalies).toHaveLength(1);
        const record = monitor.anomalies[0];
        expect(record.declaredDuration).toBe(3);
        expect(record.animatedSeconds).toBe(3);
        expect(record.deadSeconds).toBe(25);
        expect(record.intervalSeconds).toBe(28);
        expect(record.actionName).toBe('Cheese Gauntlets');
        expect(record.actionHrid).toBe('/actions/cheesesmithing/cheese_gauntlets');
    });

    test('the record carries the whole speed picture', async () => {
        const bar = mountBar(3);
        await feature.initialize();
        fire(bar, 'animationstart');
        runAction(bar, { animatedMs: 3000, deadMs: 25000 });

        const speed = monitor.anomalies[0].speed;
        expect(speed.drinks).toEqual([
            { itemHrid: '/items/super_cheesesmithing_tea', name: 'Super Tea', isActive: true, duration: 3e11 },
        ]);
        expect(speed.simulatedBuffs).toEqual(['/buff_types/action_speed']);
        expect(speed.equipmentSpeedBonus).toBe(0.1);
        expect(speed.personalSpeedBonus).toBe(0.15);
        expect(speed.houseRoomLevels).toEqual({ '/house_rooms/forge': 8 });
        expect(speed.communityBuffs['/community_buff_types/efficiency']).toEqual({ level: 2, bonus: 0.14 });
        expect(speed.predictedSeconds).toBe(8.5176);
    });

    test('a healthy action records nothing', async () => {
        const bar = mountBar(8.5176);
        await feature.initialize();

        fire(bar, 'animationstart');
        runAction(bar, { animatedMs: 8518, deadMs: 90 });
        runAction(bar, { animatedMs: 8518, deadMs: 120 });

        expect(monitor.observed).toBe(2);
        expect(monitor.anomalies).toHaveLength(0);
        expect(storage.set).not.toHaveBeenCalled();
    });

    test('a long action is not flagged for a proportionally trivial pause', async () => {
        const bar = mountBar(30);
        await feature.initialize();

        fire(bar, 'animationstart');
        // 2s of dead time clears the absolute floor but is under a quarter of 30s
        runAction(bar, { animatedMs: 30000, deadMs: 2000 });

        expect(monitor.anomalies).toHaveLength(0);
    });

    test('a gap measured across a hidden tab is not evidence', async () => {
        const bar = mountBar(3);
        await feature.initialize();
        fire(bar, 'animationstart');

        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
        hidden.mockReturnValue(false);

        runAction(bar, { animatedMs: 3000, deadMs: 25000 });

        expect(monitor.observed).toBe(1);
        expect(monitor.anomalies).toHaveLength(0);
        hidden.mockRestore();
    });

    // The bar is torn out mid-fill when the action is stopped or the queue
    // empties, and a cancelled animation fires `animationcancel`, not
    // `animationend`. `lastEndAt` therefore stays at an EARLIER action's end,
    // and measuring the next interval from it invents a stall that never
    // happened — with a negative animated span, which no real bar can have.
    test('an end that belongs to an earlier action is not measured from', async () => {
        const bar = mountBar(3);
        await feature.initialize();

        fire(bar, 'animationstart');
        runAction(bar, { animatedMs: 3000, deadMs: 100 });
        // This action's fill is cancelled part-way: no `animationend` at all
        vi.advanceTimersByTime(8000);
        fire(bar, 'animationstart');

        expect(monitor.anomalies).toHaveLength(0);
    });

    // The queue emptied, the action was stopped, the user clicked away and came
    // back. Nothing here can tell any of those from a server stall, and a
    // ten-minute "dead time" in the buffer drags the median it is read from.
    test('an idle stretch between actions is not evidence of a stall', async () => {
        const bar = mountBar(3);
        await feature.initialize();

        fire(bar, 'animationstart');
        runAction(bar, { animatedMs: 3000, deadMs: 10 * 60 * 1000 });

        expect(monitor.anomalies).toHaveLength(0);
    });

    // A diagnostic that throws while recording must not also poison the next
    // measurement: leaving `lastStartAt` at the previous action's start makes
    // the following interval read as one action longer than it was.
    test('a failed recording does not corrupt the next measurement', async () => {
        const bar = mountBar(3);
        await feature.initialize();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { default: dataManager } = await import('../../core/data-manager.js');
        dataManager.getActionDetails.mockImplementationOnce(() => {
            throw new Error('game data went away mid-switch');
        });

        fire(bar, 'animationstart');
        const startedAt = Date.now();
        runAction(bar, { animatedMs: 3000, deadMs: 5000 });

        expect(monitor.lastStartAt).toBe(startedAt + 8000);
        errors.mockRestore();
    });

    test('animations that are not the roundtime fill are ignored', async () => {
        const bar = mountBar(3);
        await feature.initialize();

        fire(bar, 'animationstart', 'SomeOther_pulse__x');
        vi.advanceTimersByTime(30000);
        fire(bar, 'animationstart', 'SomeOther_pulse__x');

        expect(monitor.observed).toBe(0);
    });
});

describe('storage and lifetime', () => {
    test('the ring buffer is capped', async () => {
        const bar = mountBar(3);
        await feature.initialize();

        fire(bar, 'animationstart');
        for (let i = 0; i < 60; i += 1) {
            runAction(bar, { animatedMs: 3000, deadMs: 25000 });
        }

        expect(monitor.observed).toBe(60);
        expect(monitor.anomalies).toHaveLength(50);
        // The oldest were dropped, not the newest
        expect(monitor.anomalies[49].at).toBeGreaterThan(monitor.anomalies[0].at);
    });

    test('the log is written under the character that was current when it started', async () => {
        const bar = mountBar(3);
        await feature.initialize();
        state.characterId = 'char-b';

        fire(bar, 'animationstart');
        runAction(bar, { animatedMs: 3000, deadMs: 25000 });
        await vi.waitFor(() => expect(state.writes.length).toBeGreaterThan(0));

        expect(state.writes[0].key).toBe('actionTimingLog_char-a');
    });

    test('a stored log older than the retention window is dropped on load', async () => {
        state.stored = {
            observed: 12,
            anomalies: [{ at: Date.now() - 30 * 24 * 60 * 60 * 1000 }, { at: Date.now() - 1000 }],
        };
        await feature.initialize();

        expect(monitor.observed).toBe(12);
        expect(monitor.anomalies).toHaveLength(1);
    });

    test('cleanup stops listening and forgets the character', async () => {
        const bar = mountBar(3);
        await feature.initialize();
        fire(bar, 'animationstart');
        runAction(bar, { animatedMs: 3000, deadMs: 25000 });
        expect(monitor.anomalies).toHaveLength(1);

        feature.cleanup();
        expect(monitor.anomalies).toHaveLength(0);
        expect(monitor.characterId).toBeNull();
        expect(monitor.initialized).toBe(false);

        fire(bar, 'animationstart');
        runAction(bar, { animatedMs: 3000, deadMs: 25000 });
        expect(monitor.observed).toBe(0);
        expect(monitor.anomalies).toHaveLength(0);
    });

    test('a load that finishes after a character switch is discarded', async () => {
        state.stored = { observed: 99, anomalies: [] };
        const started = feature.initialize();
        // The switch: the registry tears the feature down while the read is in flight
        feature.cleanup();
        await started;

        expect(monitor.observed).toBe(0);
    });

    test('the setting being off keeps it entirely dormant', async () => {
        state.settingEnabled = false;
        const bar = mountBar(3);
        await feature.initialize();

        fire(bar, 'animationstart');
        runAction(bar, { animatedMs: 3000, deadMs: 25000 });

        expect(monitor.initialized).toBe(false);
        expect(monitor.observed).toBe(0);
        expect(storage.get).not.toHaveBeenCalled();
    });
});

describe('the report', () => {
    test('it summarises what was seen without throwing on an empty log', async () => {
        await feature.initialize();
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        const empty = feature.report();
        expect(empty).toEqual({ observed: 0, anomalous: 0, medianDeadSeconds: null, anomalies: [] });

        const bar = mountBar(3);
        fire(bar, 'animationstart');
        runAction(bar, { animatedMs: 3000, deadMs: 25000 });
        runAction(bar, { animatedMs: 3000, deadMs: 5000 });
        vi.spyOn(console, 'table').mockImplementation(() => {});

        const summary = feature.report();
        expect(summary.observed).toBe(2);
        expect(summary.anomalous).toBe(2);
        expect(summary.medianDeadSeconds).toBe(15);
        log.mockRestore();
    });
});

describe('observation only', () => {
    // A shipped feature performs no game actions. The monitor reads the DOM and
    // its own storage record and nothing else, which is cheapest to prove by
    // reading the module: no socket, no send, no click.
    test('the module cannot send a game message', () => {
        const source = readFileSync('src/features/actions/action-timing-monitor.js', 'utf8');
        for (const forbidden of ['websocket', 'WebSocket', '.send(', 'sendMessage', '.click(', 'dispatchEvent']) {
            expect(source).not.toContain(forbidden);
        }
    });
});
