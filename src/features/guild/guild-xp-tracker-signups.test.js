import { beforeEach, describe, expect, test, vi } from 'vitest';
import { buildSignedUpGuildMember } from '../../__fixtures__/wire/guild-members.js';

const storageMock = vi.hoisted(() => ({
    store: new Map(),
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
    default: {
        getSetting: () => true,
        isFeatureEnabled: () => true,
        onSettingChange: () => () => {},
    },
}));
vi.mock('../../utils/performance-monitor.js', () => ({ default: { startSpan: () => () => {} } }));

import { guildXPTracker } from './guild-xp-tracker.js';

const WEEK = '2026-11-02T00:00:00Z';
const sharable = (names) => Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { name }]));
const swarmMember = (overrides) =>
    buildSignedUpGuildMember({ guildID: 'g1', guildExperience: 5, signupWeekStartAt: WEEK, ...overrides });

describe('the sign-up role and loadout ids ride the same messages as the trial hrids', () => {
    beforeEach(() => {
        guildXPTracker.disable();
        guildXPTracker.ownGuildName = 'Milky';
        guildXPTracker.ownGuildID = 'g1';
        guildXPTracker.memberXPHistory = {};
        guildXPTracker.memberMeta = {};
        guildXPTracker._loadsPending = 0;
        guildXPTracker.ready = null;
    });

    test('guild_characters_updated writes role, ids and parsed prefs; a garbled prefs string is just empty', async () => {
        await guildXPTracker._onMembersUpdated({
            guildCharacterMap: {
                101: swarmMember(),
                102: swarmMember({
                    trialRolePrefs: '{oops',
                    signedUpCombatRoleHrid: 'tank',
                    signedUpCombatLoadoutID: 0,
                }),
                103: swarmMember({ signedUpCombatRoleHrid: '', signedUpCombatTrialHrid: '' }),
            },
            guildSharableCharacterMap: sharable({ 101: 'A', 102: 'B', 103: 'C' }),
        });
        expect(guildXPTracker.getMemberMeta('101')).toMatchObject({
            signedUpCombatRoleHrid: 'damage_dealer',
            signedUpCombatLoadoutID: 41111,
            signedUpSkillingLoadoutID: 15811,
            trialRolePrefs: expect.objectContaining({ '/guild_combat/swarm': 'damage_dealer' }),
        });
        expect(guildXPTracker.getMemberMeta('102')).toMatchObject({
            signedUpCombatRoleHrid: 'tank',
            signedUpCombatLoadoutID: 0,
            trialRolePrefs: {},
        });
        expect(guildXPTracker.getMemberMeta('103').signedUpCombatRoleHrid).toBe('');
    });

    test('the login payload carries them too', async () => {
        await guildXPTracker._onCharacterInit({
            guild: { id: 'g1', name: 'Milky', currentWeekStartAt: WEEK },
            guildCharacterMap: { 101: swarmMember() },
            guildSharableCharacterMap: sharable({ 101: 'A' }),
        });
        expect(guildXPTracker.getMemberMeta('101')).toMatchObject({
            signedUpCombatRoleHrid: 'damage_dealer',
            signedUpSkillingLoadoutID: 15811,
        });
    });

    test('a changed signed-up loadout id is stamped; first sight and an unchanged id are not', async () => {
        const update = (overrides) =>
            guildXPTracker._onMembersUpdated({
                guildCharacterMap: { 101: swarmMember(overrides) },
                guildSharableCharacterMap: sharable({ 101: 'A' }),
            });
        await update({});
        expect(guildXPTracker.getLoadoutChangedAt('101', 'combat')).toBeNull();
        await update({});
        expect(guildXPTracker.getLoadoutChangedAt('101', 'combat')).toBeNull();
        await update({ signedUpCombatLoadoutID: 41112 });
        expect(guildXPTracker.getLoadoutChangedAt('101', 'combat')).toBeGreaterThan(0);
        expect(guildXPTracker.getLoadoutChangedAt('101', 'skilling')).toBeNull();
        // The stamp survives the next unchanged message
        const stamped = guildXPTracker.getLoadoutChangedAt('101', 'combat');
        await update({ signedUpCombatLoadoutID: 41112 });
        expect(guildXPTracker.getLoadoutChangedAt('101', 'combat')).toBe(stamped);
    });

    test('a member the message lists only in the sharable map keeps their held ids and is not stamped', async () => {
        await guildXPTracker._onMembersUpdated({
            guildCharacterMap: { 101: swarmMember() },
            guildSharableCharacterMap: sharable({ 101: 'A' }),
        });
        await guildXPTracker._onMembersUpdated({
            guildCharacterMap: {},
            guildSharableCharacterMap: sharable({ 101: 'A' }),
        });
        expect(guildXPTracker.getMemberMeta('101').signedUpCombatLoadoutID).toBe(41111);
        expect(guildXPTracker.getLoadoutChangedAt('101', 'combat')).toBeNull();
    });

    test('someone who left the guild takes their stamps with them', async () => {
        await guildXPTracker._onMembersUpdated({
            guildCharacterMap: { 101: swarmMember(), 102: swarmMember(), 103: swarmMember() },
            guildSharableCharacterMap: sharable({ 101: 'A', 102: 'B', 103: 'C' }),
        });
        await guildXPTracker._onMembersUpdated({
            guildCharacterMap: { 101: swarmMember({ signedUpCombatLoadoutID: 3 }), 103: swarmMember() },
            guildSharableCharacterMap: sharable({ 101: 'A', 103: 'C' }),
        });
        expect(guildXPTracker.getMemberMeta('102')).toBeNull();
        expect(guildXPTracker.getLoadoutChangedAt('102', 'combat')).toBeNull();
        expect(guildXPTracker.getLoadoutChangedAt('101', 'combat')).toBeGreaterThan(0);
    });

    test('guild_trial_signup_updated: a bare message keeps ids, a moved trial drops its role', async () => {
        await guildXPTracker._onMembersUpdated({
            guildCharacterMap: { 101: swarmMember() },
            guildSharableCharacterMap: sharable({ 101: 'A' }),
        });
        guildXPTracker._onTrialSignupUpdated({
            characterId: 101,
            signedUpCombatTrialHrid: '/guild_combat/swarm',
            signedUpSkillingTrialHrid: '/guild_skilling/foraging',
            signupWeekStartAt: WEEK,
        });
        expect(guildXPTracker.getMemberMeta('101')).toMatchObject({
            signedUpCombatRoleHrid: 'damage_dealer',
            signedUpCombatLoadoutID: 41111,
        });
        expect(guildXPTracker.getLoadoutChangedAt('101', 'combat')).toBeNull();
        guildXPTracker._onTrialSignupUpdated({
            characterId: 101,
            signedUpCombatTrialHrid: '/guild_combat/badger',
            signedUpSkillingTrialHrid: '/guild_skilling/foraging',
            signupWeekStartAt: WEEK,
        });
        expect(guildXPTracker.getMemberMeta('101')).toMatchObject({
            signedUpCombatTrialHrid: '/guild_combat/badger',
            signedUpCombatRoleHrid: '',
            signedUpCombatLoadoutID: 0,
        });
        // Their loadout was changed by the move, so a view taken before it is out of date
        expect(guildXPTracker.getLoadoutChangedAt('101', 'combat')).toBeGreaterThan(0);
        expect(guildXPTracker.getLoadoutChangedAt('101', 'skilling')).toBeNull();
    });

    test('a guild switch drops the departed guild’s stamps with its roster', async () => {
        await guildXPTracker._onMembersUpdated({
            guildCharacterMap: { 101: swarmMember() },
            guildSharableCharacterMap: sharable({ 101: 'A' }),
        });
        await guildXPTracker._onMembersUpdated({
            guildCharacterMap: { 101: swarmMember({ signedUpCombatLoadoutID: 3 }) },
            guildSharableCharacterMap: sharable({ 101: 'A' }),
        });
        expect(guildXPTracker.getLoadoutChangedAt('101', 'combat')).toBeGreaterThan(0);
        await guildXPTracker._onMembersUpdated({
            guildCharacterMap: { 201: swarmMember({ guildID: 'g2' }) },
            guildSharableCharacterMap: sharable({ 201: 'Z' }),
        });
        expect(guildXPTracker.getLoadoutChangedAt('101', 'combat')).toBeNull();
        expect(guildXPTracker.getMemberMeta('101')).toBeNull();
    });
});
