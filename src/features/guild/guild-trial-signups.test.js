import { describe, expect, test } from 'vitest';
import { buildGuildMember, buildSignedUpGuildMember } from '../../__fixtures__/wire/guild-members.js';
import {
    currentSignup,
    loadoutIdChanges,
    loadoutViewStatus,
    parseLoadoutId,
    parseLoadoutPrefs,
    parseRolePrefs,
    parseSignupRole,
    roleLabel,
    signupFieldsFromGuildChar,
    signupFieldsFromUpdate,
} from './guild-trial-signups.js';

const WEEK = '2026-11-02T00:00:00Z';

describe('role and loadout fields as the game sends them', () => {
    test('a role is a bare word; empty and junk are no role', () => {
        expect(['damage_dealer', 'support', 'tank'].map(parseSignupRole)).toEqual(['damage_dealer', 'support', 'tank']);
        expect([
            parseSignupRole(''),
            parseSignupRole(null),
            parseSignupRole(7),
            parseSignupRole('a b'),
            parseSignupRole('x'.repeat(41)),
        ]).toEqual(['', '', '', '', '']);
        expect(roleLabel('tank')).toBe('Tank');
        expect(roleLabel('')).toBe('');
        expect(roleLabel('off_tank')).toBe('off tank');
    });

    test('a loadout id is a positive whole number, 0 for none', () => {
        expect([15811, '15811', 0, '', null, undefined, -3, 1.5, NaN, 'abc'].map(parseLoadoutId)).toEqual([
            15811, 15811, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);
    });

    test('prefs: a malformed string, an array or a non-object is ignored, not fatal', () => {
        for (const bad of ['{not json', '[1,2]', '"text"', '7', 'null', '', null, undefined, 7, ['a']]) {
            expect(parseRolePrefs(bad)).toEqual({});
            expect(parseLoadoutPrefs(bad)).toEqual({});
        }
        expect(parseRolePrefs('{"/guild_combat/swarm":"tank","/guild_combat/badger":"","/guild_combat/x":5}')).toEqual({
            '/guild_combat/swarm': 'tank',
        });
        expect(parseLoadoutPrefs('{"/guild_combat/swarm":41111,"/guild_skilling/foraging":0,"a":"zz"}')).toEqual({
            '/guild_combat/swarm': 41111,
        });
        // An already parsed object is accepted too
        expect(parseLoadoutPrefs({ '/guild_combat/swarm': '7' })).toEqual({ '/guild_combat/swarm': 7 });
    });

    test('a guild character parses with the capture’s own values, and an empty one to nothing', () => {
        const fields = signupFieldsFromGuildChar(buildSignedUpGuildMember());
        expect(fields).toMatchObject({
            signedUpCombatRoleHrid: 'damage_dealer',
            signedUpCombatLoadoutID: 41111,
            signedUpSkillingLoadoutID: 15811,
        });
        expect(fields.trialRolePrefs['/guild_combat/swarm']).toBe('damage_dealer');
        expect(signupFieldsFromGuildChar(undefined)).toEqual({
            signedUpCombatRoleHrid: '',
            signedUpCombatLoadoutID: 0,
            signedUpSkillingLoadoutID: 0,
            trialRolePrefs: {},
            trialLoadoutPrefs: {},
        });
        // A garbled prefs string on an otherwise good member
        expect(signupFieldsFromGuildChar(buildSignedUpGuildMember({ trialRolePrefs: '{oops' })).trialRolePrefs).toEqual(
            {}
        );
    });
});

describe('currentSignup', () => {
    const meta = (overrides) => ({
        ...buildSignedUpGuildMember(overrides),
        ...signupFieldsFromGuildChar(buildSignedUpGuildMember(overrides)),
    });

    test('counts only in the current cycle', () => {
        expect(currentSignup(meta(), WEEK)).toMatchObject({
            combatTrial: '/guild_combat/swarm',
            role: 'damage_dealer',
            skillingTrial: '/guild_skilling/foraging',
            combatLoadoutId: 41111,
        });
        expect(currentSignup(meta({ signupWeekStartAt: '2026-11-01T00:00:00Z' }), WEEK)).toBeNull();
        expect(currentSignup(meta({ signupWeekStartAt: null }), WEEK)).toBeNull();
        expect(currentSignup(meta(), null)).toBeNull();
        expect(currentSignup(null, WEEK)).toBeNull();
    });

    test('empty strings are not a sign-up, and a role without a combat trial is ignored', () => {
        const none = meta({
            signedUpCombatTrialHrid: '',
            signedUpSkillingTrialHrid: '',
            signedUpCombatRoleHrid: 'tank',
        });
        expect(currentSignup(none, WEEK)).toBeNull();
        const skillingOnly = currentSignup(meta({ signedUpCombatTrialHrid: '', signedUpCombatRoleHrid: 'tank' }), WEEK);
        expect(skillingOnly).toMatchObject({ combatTrial: '', role: '', combatLoadoutId: 0 });
        // A combat trial with no role is a real state: no role, the usual one offered separately
        const noRole = currentSignup(meta({ signedUpCombatRoleHrid: '' }), WEEK);
        expect(noRole).toMatchObject({ role: '', rolePref: 'damage_dealer' });
    });

    test('a bare guild member fixture has no sign-up', () => {
        expect(currentSignup(buildGuildMember({ signupWeekStartAt: WEEK }), WEEK)).toBeNull();
    });
});

describe('guild_trial_signup_updated on top of held fields', () => {
    const held = signupFieldsFromGuildChar(buildSignedUpGuildMember());
    Object.assign(held, {
        signedUpCombatTrialHrid: '/guild_combat/swarm',
        signedUpSkillingTrialHrid: '/guild_skilling/foraging',
    });

    test('a message that states nothing new leaves role and ids alone', () => {
        expect(
            signupFieldsFromUpdate(held, {
                signedUpCombatTrialHrid: '/guild_combat/swarm',
                signedUpSkillingTrialHrid: '/guild_skilling/foraging',
            })
        ).toEqual({});
    });

    test('a changed combat trial clears the role and loadout it belonged to unless the message states them', () => {
        const moved = signupFieldsFromUpdate(held, {
            signedUpCombatTrialHrid: '/guild_combat/badger',
            signedUpSkillingTrialHrid: '/guild_skilling/foraging',
        });
        expect(moved).toEqual({ signedUpCombatRoleHrid: '', signedUpCombatLoadoutID: 0 });
        const stated = signupFieldsFromUpdate(held, {
            signedUpCombatTrialHrid: '/guild_combat/badger',
            signedUpSkillingTrialHrid: '/guild_skilling/foraging',
            signedUpCombatRoleHrid: 'tank',
            signedUpCombatLoadoutID: 9,
        });
        expect(stated).toEqual({ signedUpCombatRoleHrid: 'tank', signedUpCombatLoadoutID: 9 });
    });

    test('withdrawing a sign-up (absent trials) clears both', () => {
        expect(signupFieldsFromUpdate(held, {})).toEqual({
            signedUpCombatRoleHrid: '',
            signedUpCombatLoadoutID: 0,
            signedUpSkillingLoadoutID: 0,
        });
    });
});

describe('a loadout view against the sign-up', () => {
    test('id changes: first sight is not a change, 0 is a real value', () => {
        expect(loadoutIdChanges(undefined, { signedUpCombatLoadoutID: 5 })).toEqual({ combat: false, skilling: false });
        expect(
            loadoutIdChanges(
                { signedUpCombatLoadoutID: 5, signedUpSkillingLoadoutID: 0 },
                { signedUpCombatLoadoutID: 0, signedUpSkillingLoadoutID: 0 }
            )
        ).toEqual({ combat: true, skilling: false });
    });

    test('stale only after a change seen later than the view; unknown without a member or kind', () => {
        const view = { kind: 'combat', capturedAt: 1000 };
        expect(loadoutViewStatus(view, null, true)).toBe('current');
        expect(loadoutViewStatus(view, 900, true)).toBe('current');
        expect(loadoutViewStatus(view, 1000, true)).toBe('current');
        expect(loadoutViewStatus(view, 1001, true)).toBe('stale');
        expect(loadoutViewStatus(view, 1001, false)).toBe('unknown');
        expect(loadoutViewStatus({ kind: null, capturedAt: 1000 }, 1001, true)).toBe('unknown');
        expect(loadoutViewStatus({ kind: 'skilling' }, 1001, true)).toBe('unknown');
    });
});
