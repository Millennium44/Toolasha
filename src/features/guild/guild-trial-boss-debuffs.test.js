/**
 * Boss debuff timers, from the trial stream's counters and the game's ability data.
 *
 * The ability data below is shaped as `initClientData.abilityDetailMap` states it:
 * a debuff is a damage effect whose `buffs` land on its enemy target, durations in
 * nanoseconds, and a stun is `stunDuration` on the effect.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => ({}) } }));

const { activeBossDebuffs, debuffProfile, newBossDebuffState, noteBossDebuffTick, STUN_GRACE_MS, STUN_UNTIMED_MS } =
    await import('./guild-trial-boss-debuffs.js');

const enemyDebuff = (uniqueHrid, seconds, targetType = 'enemy') => ({
    targetType,
    effectType: '/ability_effect_types/damage',
    buffs: [{ uniqueHrid, typeHrid: '/buff_types/attack_speed', duration: seconds * 1e9 }],
});

const detailMap = {
    '/abilities/ice_spear': { name: 'Ice Spear', abilityEffects: [enemyDebuff('/buff_uniques/ice_spear', 8)] },
    '/abilities/frost_surge': {
        name: 'Frost Surge',
        abilityEffects: [enemyDebuff('/buff_uniques/frost_surge', 9, 'allEnemies')],
    },
    '/abilities/entangle': {
        name: 'Entangle',
        abilityEffects: [
            { targetType: 'enemy', effectType: '/ability_effect_types/damage', stunChance: 0.1, stunDuration: 2e9 },
        ],
    },
    '/abilities/fireball': {
        name: 'Fireball',
        abilityEffects: [{ targetType: 'enemy', effectType: '/ability_effect_types/damage' }],
    },
    '/abilities/toughness': {
        name: 'Toughness',
        abilityEffects: [
            {
                targetType: 'self',
                effectType: '/ability_effect_types/buff',
                buffs: [{ uniqueHrid: '/buff_uniques/toughness', typeHrid: '/buff_types/armor', duration: 20e9 }],
            },
        ],
    },
};

const now = 1_800_000_000_000;

/**
 * The attribution engine's baselines, as they stood before a tick.
 * @param {Object} actions - Slot → prepared action
 * @param {Object} [overrides] - Fields to replace
 * @returns {Object} The engine state the tracker reads
 */
function engine(actions, overrides = {}) {
    return {
        playersAtk: Object.fromEntries(Object.keys(actions).map((slot) => [slot, 1])),
        dmgCounter: { 0: 5, 1: 5 },
        monstersMaxHP: { 0: 650_000, 1: 650_000 },
        actions,
        ...overrides,
    };
}

const boss = (fields = {}) => ({ cHP: 600_000, mHP: 650_000, dmgCounter: 5, ...fields });

/**
 * One tick: every slot in `actions` swings, and `mMap` says which bosses were struck.
 * @returns {Object} The debuff state after it
 */
function fold(actions, mMap, { state = newBossDebuffState(), at = now, attribution } = {}) {
    const pMap = Object.fromEntries(Object.keys(actions).map((slot) => [slot, { atkCounter: 2 }]));
    noteBossDebuffTick(state, {
        pMap,
        mMap,
        attribution: attribution ?? engine(actions),
        now: at,
        abilityDetailMap: detailMap,
    });
    return state;
}

describe('debuffProfile', () => {
    test('reads the debuff and stun lengths off the game data', () => {
        expect(debuffProfile('/abilities/ice_spear', detailMap)).toMatchObject({ name: 'Ice Spear', debuffSeconds: 8 });
        expect(debuffProfile('/abilities/entangle', detailMap)).toMatchObject({ stunSeconds: 2, debuffSeconds: null });
    });

    test('a damage-only ability, a self buff, an auto-attack and no game data leave nothing', () => {
        expect(debuffProfile('/abilities/fireball', detailMap)).toBeNull();
        expect(debuffProfile('/abilities/toughness', detailMap)).toBeNull();
        expect(debuffProfile('auto', detailMap)).toBeNull();
        expect(debuffProfile('/abilities/ice_spear', null)).toBeNull();
    });
});

describe('noteBossDebuffTick', () => {
    test('a debuff seen landing runs for the game data’s duration', () => {
        const state = fold({ 0: '/abilities/ice_spear' }, { 0: boss({ dmgCounter: 6 }) });

        expect(state.monsters['0']['/abilities/ice_spear']).toMatchObject({
            kind: 'debuff',
            name: 'Ice Spear',
            expiresAt: now + 8000,
        });
    });

    test('a cast on a tick the boss was not struck starts nothing', () => {
        const state = fold({ 0: '/abilities/ice_spear' }, { 0: boss({ dmgCounter: 5 }) });
        expect(state.monsters).toEqual({});
    });

    test('a recast refreshes the timer', () => {
        const state = fold({ 0: '/abilities/ice_spear' }, { 0: boss({ dmgCounter: 6 }) });
        fold({ 0: '/abilities/ice_spear' }, { 0: boss({ dmgCounter: 6 }) }, { state, at: now + 5000 });

        expect(state.monsters['0']['/abilities/ice_spear'].expiresAt).toBe(now + 13_000);
    });

    test('each boss struck on the tick is marked, and a boss not struck is not', () => {
        const state = fold({ 0: '/abilities/frost_surge' }, { 0: boss({ dmgCounter: 6 }), 1: boss({ dmgCounter: 5 }) });
        expect(Object.keys(state.monsters)).toEqual(['0']);
    });

    test('a boss that dies, or a different monster in its slot, sheds what it carried', () => {
        const state = fold({ 0: '/abilities/ice_spear' }, { 0: boss({ dmgCounter: 6 }), 1: boss({ dmgCounter: 6 }) });
        noteBossDebuffTick(state, {
            pMap: {},
            mMap: { 0: boss({ cHP: 0 }), 1: boss({ mHP: 700_000 }) },
            attribution: engine({}),
            now: now + 250,
            abilityDetailMap: detailMap,
        });
        expect(state.monsters).toEqual({});
    });

    test('a stun lasts as long as the stream states it, counting down from the landing ability', () => {
        const state = fold({ 0: '/abilities/entangle' }, { 0: boss({ dmgCounter: 6, isStunned: true }) });
        expect(state.monsters['0'].stun).toMatchObject({
            kind: 'stun',
            name: 'Stunned by Entangle',
            expiresAt: now + 2000,
        });

        // Restated a tick later: the countdown is not pushed back
        fold({}, { 0: boss({ isStunned: true }) }, { state, at: now + 500 });
        expect(state.monsters['0'].stun.expiresAt).toBe(now + 2000);

        // The boss's next entry without it: over
        fold({}, { 0: boss() }, { state, at: now + 2100 });
        expect(state.monsters['0']?.stun).toBeUndefined();
    });

    test('a stun with no landing cast in sight is drawn without a countdown', () => {
        const state = fold({}, { 0: boss({ isStunned: true }) });
        expect(state.monsters['0'].stun).toMatchObject({ name: 'Stunned', expiresAt: null });
    });
});

describe('activeBossDebuffs', () => {
    test('expired debuffs go, and a boss left with none is dropped', () => {
        const state = fold({ 0: '/abilities/ice_spear' }, { 0: boss({ dmgCounter: 6 }) });
        expect(activeBossDebuffs(state, now + 7999).get('0')).toHaveLength(1);
        expect(activeBossDebuffs(state, now + 8000).size).toBe(0);
        expect(state.monsters).toEqual({});
    });

    test('a stun is listed first, and outlives its countdown only by the grace', () => {
        const state = fold(
            { 0: '/abilities/ice_spear', 1: '/abilities/entangle' },
            { 0: boss({ dmgCounter: 6, isStunned: true }) }
        );
        expect(
            activeBossDebuffs(state, now + 1000)
                .get('0')
                .map((effect) => effect.kind)
        ).toEqual(['stun', 'debuff']);
        expect(activeBossDebuffs(state, now + 2000 + STUN_GRACE_MS).get('0')[0].kind).toBe('stun');
        expect(
            activeBossDebuffs(state, now + 2001 + STUN_GRACE_MS)
                .get('0')
                .map((effect) => effect.kind)
        ).toEqual(['debuff']);
    });

    test('an untimed stun the stream stopped restating goes', () => {
        const state = fold({}, { 0: boss({ isStunned: true }) });
        expect(activeBossDebuffs(state, now + STUN_UNTIMED_MS).size).toBe(1);
        expect(activeBossDebuffs(state, now + STUN_UNTIMED_MS + 1).size).toBe(0);
    });
});
