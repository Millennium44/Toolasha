import { beforeEach, describe, expect, test, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    tryGet: vi.fn(async () => ({ found: false, value: null })),
    get: vi.fn(async () => null),
    set: vi.fn(async () => true),
    getAllKeys: vi.fn(async () => []),
    onBeforeTeardown: vi.fn(() => () => {}),
}));
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { on: () => {}, off: () => {}, characterData: null, getInitClientData: () => null },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, isFeatureEnabled: () => true, onSettingChange: () => () => {} },
}));
vi.mock('../../utils/performance-monitor.js', () => ({ default: { startSpan: () => () => {} } }));

import { guildXPTracker } from './guild-xp-tracker.js';
import { getScheduleHourOffset, setScheduleHourOffset } from './guild-trial-schedule.js';

const login = (guild, extra = {}) => ({
    guild,
    guildCharacterMap: { 1: { guildID: guild?.id ?? 'g1', guildExperience: 1 } },
    guildSharableCharacterMap: { 1: { name: 'A' } },
    ...extra,
});

describe('the schedule hour offset follows the guild messages', () => {
    beforeEach(() => {
        guildXPTracker.disable();
        guildXPTracker.ownGuildName = 'Milky';
        guildXPTracker.ownGuildID = 'g1';
        guildXPTracker.memberMeta = {};
        guildXPTracker._loadsPending = 0;
        guildXPTracker.ready = null;
        setScheduleHourOffset(null);
    });

    test('the login payload’s guild states it', async () => {
        await guildXPTracker._onCharacterInit(login({ id: 'g1', name: 'Milky', trialScheduleHourOffset: 21 }));
        expect(getScheduleHourOffset()).toBe(21);
    });

    test('a login whose guild states no offset holds none, and 0 is held as 0', async () => {
        setScheduleHourOffset(21);
        await guildXPTracker._onCharacterInit(login({ id: 'g1', name: 'Milky' }));
        expect(getScheduleHourOffset()).toBeNull();
        await guildXPTracker._onCharacterInit(login({ id: 'g1', name: 'Milky', trialScheduleHourOffset: 0 }));
        expect(getScheduleHourOffset()).toBe(0);
    });

    test('a character with no guild holds none (a switch from a guild with a schedule)', async () => {
        setScheduleHourOffset(21);
        await guildXPTracker._onCharacterInit({ guild: null });
        expect(getScheduleHourOffset()).toBeNull();
    });

    test('guild_updated states it on the guild object or at the top level, and 0 counts', async () => {
        await guildXPTracker._onGuildUpdated({ guild: { id: 'g1', name: 'Milky', trialScheduleHourOffset: 21 } });
        expect(getScheduleHourOffset()).toBe(21);
        await guildXPTracker._onGuildUpdated({ guild: { id: 'g1', name: 'Milky' }, guildTrialScheduleHourOffset: 5 });
        expect(getScheduleHourOffset()).toBe(5);
        await guildXPTracker._onGuildUpdated({ guild: { id: 'g1', name: 'Milky', trialScheduleHourOffset: 0 } });
        expect(getScheduleHourOffset()).toBe(0);
    });

    test('a guild_updated that does not state it leaves the held offset; an unreadable one clears it', async () => {
        await guildXPTracker._onGuildUpdated({ guild: { id: 'g1', name: 'Milky', trialScheduleHourOffset: 21 } });
        await guildXPTracker._onGuildUpdated({ guild: { id: 'g1', name: 'Milky' } });
        expect(getScheduleHourOffset()).toBe(21);
        await guildXPTracker._onGuildUpdated({ guild: { id: 'g1', name: 'Milky', trialScheduleHourOffset: 'soon' } });
        expect(getScheduleHourOffset()).toBeNull();
    });

    test('a different guild arriving drops the old guild’s offset, then takes its own', async () => {
        await guildXPTracker._onGuildUpdated({ guild: { id: 'g1', name: 'Milky', trialScheduleHourOffset: 21 } });
        guildXPTracker.ownGuildID = 'g1';
        await guildXPTracker._onGuildUpdated({ guild: { id: 'g2', name: 'Other' } });
        expect(getScheduleHourOffset()).toBeNull();
        await guildXPTracker._onGuildUpdated({ guild: { id: 'g2', name: 'Other', trialScheduleHourOffset: 7 } });
        expect(getScheduleHourOffset()).toBe(7);
    });

    test('a roster message from another guild drops it', async () => {
        setScheduleHourOffset(21);
        await guildXPTracker._onMembersUpdated({
            guildCharacterMap: { 9: { guildID: 'g2', guildExperience: 1 } },
            guildSharableCharacterMap: { 9: { name: 'Z' } },
        });
        expect(getScheduleHourOffset()).toBeNull();
    });

    test('tearing the tracker down (a character switch) clears it', () => {
        setScheduleHourOffset(21);
        guildXPTracker.disable();
        expect(getScheduleHourOffset()).toBeNull();
    });
});
