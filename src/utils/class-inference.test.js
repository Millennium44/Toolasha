import { describe, test, expect } from 'vitest';
import {
    CLASS_BUCKETS,
    MAX_EVIDENCE,
    abilityProfile,
    bucketForStyle,
    inferClass,
    newCastLog,
    noteCast,
} from './class-inference.js';

const damage = (style, damageType = '') => ({
    abilityEffects: [{ effectType: '/ability_effect_types/damage', combatStyleHrid: style, damageType }],
});

const heal = (targetType = 'lowestHpAlly') => ({
    abilityEffects: [{ effectType: '/ability_effect_types/heal', targetType, combatStyleHrid: '/combat_styles/magic' }],
});

/** A synthetic slice of the game's ability data, in the shape the engine reads */
const ABILITIES = {
    '/abilities/fireball': damage('/combat_styles/magic', '/damage_types/fire'),
    '/abilities/firestorm': damage('/combat_styles/magic', '/damage_types/fire'),
    '/abilities/ice_spear': damage('/combat_styles/magic', '/damage_types/water'),
    '/abilities/entangle': damage('/combat_styles/magic', '/damage_types/nature'),
    '/abilities/arcane_blast': damage('/combat_styles/magic', ''),
    '/abilities/steady_shot': damage('/combat_styles/ranged', '/damage_types/physical'),
    '/abilities/rain_of_arrows': damage('/combat_styles/ranged', '/damage_types/physical'),
    '/abilities/cleave': damage('/combat_styles/slash', '/damage_types/physical'),
    '/abilities/smack': damage('/combat_styles/smash', '/damage_types/physical'),
    '/abilities/heal': heal(),
    '/abilities/rejuvenate': heal('allAllies'),
    '/abilities/self_patch': heal('self'),
    '/abilities/toughness': { abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'self' }] },
};

/** A cast log holding the abilities named, in order, once each */
const cast = (...hrids) => {
    const log = newCastLog();
    for (const hrid of hrids) noteCast(log, hrid);
    return log;
};

describe('reading one ability', () => {
    test('a damaging spell states its style and its element', () => {
        expect(abilityProfile('/abilities/fireball', ABILITIES)).toEqual({
            hrid: '/abilities/fireball',
            healsAlly: false,
            damages: true,
            style: 'magic',
            element: 'fire',
        });
    });

    test('a heal aimed at an ally is an ally heal; one aimed at yourself is not', () => {
        expect(abilityProfile('/abilities/heal', ABILITIES).healsAlly).toBe(true);
        expect(abilityProfile('/abilities/rejuvenate', ABILITIES).healsAlly).toBe(true);
        // Every build life-steals; healing yourself says nothing about a role
        expect(abilityProfile('/abilities/self_patch', ABILITIES).healsAlly).toBe(false);
    });

    test('the pseudo-hrids a tick uses in place of an ability read as nothing', () => {
        // `auto` and `idle` are what `noteActions` writes when there is no
        // ability; everybody has an auto-attack, so it classifies nobody
        expect(abilityProfile('auto', ABILITIES)).toBeNull();
        expect(abilityProfile('idle', ABILITIES)).toBeNull();
        expect(abilityProfile('dot', ABILITIES)).toBeNull();
    });

    test('an ability the game data does not know is not guessed at', () => {
        expect(abilityProfile('/abilities/something_new', ABILITIES)).toBeNull();
    });
});

describe('the cast log', () => {
    test('a repeat counts but does not re-list', () => {
        const log = newCastLog();

        expect(noteCast(log, '/abilities/fireball')).toBe(true);
        expect(noteCast(log, '/abilities/fireball')).toBe(false);
        expect(log.order).toEqual(['/abilities/fireball']);
        expect(log.counts['/abilities/fireball']).toBe(2);
    });

    test('auto-attacking and idling are not casts', () => {
        const log = newCastLog();
        noteCast(log, 'auto');
        noteCast(log, 'idle');
        noteCast(log, '');

        expect(log.order).toEqual([]);
    });

    test('the evidence is bounded, and a dropped ability takes its count with it', () => {
        const log = newCastLog();
        for (let index = 0; index < MAX_EVIDENCE + 3; index += 1) noteCast(log, `/abilities/a${index}`);

        expect(log.order).toHaveLength(MAX_EVIDENCE);
        expect(log.order[0]).toBe('/abilities/a3');
        // Otherwise a map keyed off a payload field grows for the session
        expect(Object.keys(log.counts)).toHaveLength(MAX_EVIDENCE);
    });
});

describe('inferring a class', () => {
    test('threat on the captured sheet is a tank, whatever they cast', () => {
        const verdict = inferClass(
            { casts: cast('/abilities/cleave'), stats: { threat: 3.2, combatStyleHrids: ['/combat_styles/slash'] } },
            ABILITIES
        );

        expect(verdict).toMatchObject({ key: 'tank', short: CLASS_BUCKETS.tank.short });
        expect(verdict.basis).toContain('threat');
    });

    test('an ally heal outranks the damage a healer also does', () => {
        const verdict = inferClass({ casts: cast('/abilities/fireball', '/abilities/heal') }, ABILITIES);

        expect(verdict.key).toBe('healer');
        expect(verdict.evidence).toEqual(['/abilities/fireball', '/abilities/heal']);
    });

    test('magic splits by the modal element of what was actually cast', () => {
        const log = cast('/abilities/ice_spear', '/abilities/fireball');
        // Fireball three more times: the mode is what they cast, not what they
        // cast first
        noteCast(log, '/abilities/fireball');
        noteCast(log, '/abilities/fireball');
        noteCast(log, '/abilities/fireball');

        expect(inferClass({ casts: log }, ABILITIES).key).toBe('fireMage');
    });

    test('water is a damage mage; nature is the healer', () => {
        expect(inferClass({ casts: cast('/abilities/ice_spear') }, ABILITIES).key).toBe('waterMage');
        // Nature is the element the game's healing is written in, so a nature
        // caster is what the party calls its healer — not a third mage bucket
        expect(inferClass({ casts: cast('/abilities/entangle') }, ABILITIES).key).toBe('healer');
    });

    test('magic with no element stated is a plain Mage rather than a guess', () => {
        expect(inferClass({ casts: cast('/abilities/arcane_blast') }, ABILITIES).key).toBe('mage');
    });

    test('ranged and the melee styles collapse to two buckets', () => {
        expect(inferClass({ casts: cast('/abilities/steady_shot') }, ABILITIES).key).toBe('ranged');
        expect(inferClass({ casts: cast('/abilities/cleave') }, ABILITIES).key).toBe('melee');
        expect(inferClass({ casts: cast('/abilities/smack') }, ABILITIES).key).toBe('melee');
    });

    test('a captured kit classifies a player nobody has watched cast', () => {
        const verdict = inferClass(
            { kit: [{ hrid: '/abilities/rain_of_arrows' }, { hrid: '/abilities/steady_shot' }] },
            ABILITIES
        );

        expect(verdict.key).toBe('ranged');
        expect(verdict.evidence).toEqual(['/abilities/rain_of_arrows', '/abilities/steady_shot']);
    });

    test('the sheet answers when the kit is all buffs and nothing damaging was seen', () => {
        const verdict = inferClass(
            {
                casts: cast('/abilities/toughness'),
                stats: { combatStyleHrids: ['/combat_styles/magic'], damageType: '/damage_types/nature' },
            },
            ABILITIES
        );

        expect(verdict.key).toBe('healer');
        expect(verdict.basis).toContain('weapon style');
    });

    test('nothing at all produces no tag rather than a default one', () => {
        expect(inferClass({}, ABILITIES)).toBeNull();
        expect(inferClass({ casts: cast('auto', 'idle') }, ABILITIES)).toBeNull();
        // A buff-only kit with no sheet is a real case — an aura carrier
        // clicked before they cast anything — and a made-up melee tag on it
        // would be worse than a blank
        expect(inferClass({ kit: [{ hrid: '/abilities/toughness' }] }, ABILITIES)).toBeNull();
    });

    test('the evidence is deduplicated across the watched casts and the captured kit', () => {
        const verdict = inferClass(
            {
                casts: cast('/abilities/fireball'),
                kit: [{ hrid: '/abilities/fireball' }, { hrid: '/abilities/firestorm' }],
            },
            ABILITIES
        );

        expect(verdict.evidence).toEqual(['/abilities/fireball', '/abilities/firestorm']);
    });
});

describe('bucketForStyle', () => {
    test('an unknown style names no bucket', () => {
        expect(bucketForStyle('/combat_styles/interpretive_dance', '')).toBeNull();
        expect(bucketForStyle('', '/damage_types/fire')).toBeNull();
    });

    test('a bare tail works as well as a full hrid', () => {
        expect(bucketForStyle('magic', 'fire')).toEqual(CLASS_BUCKETS.fireMage);
    });
});
