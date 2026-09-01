import { describe, test, expect } from 'vitest';
import {
    CLASS_BUCKETS,
    MAX_EVIDENCE,
    abilityProfile,
    bucketForStyle,
    inferClass,
    newCastLog,
    noteCast,
    weaponPassiveBuckets,
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
    '/abilities/spike_shell': {
        abilityEffects: [
            {
                effectType: '/ability_effect_types/buff',
                targetType: 'self',
                buffs: [{ typeHrid: '/buff_types/physical_thorns' }, { typeHrid: '/buff_types/elemental_thorns' }],
            },
        ],
    },
    '/abilities/taunt': {
        abilityEffects: [
            {
                effectType: '/ability_effect_types/buff',
                targetType: 'self',
                buffs: [{ typeHrid: '/buff_types/threat' }],
            },
        ],
    },
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
            tanks: false,
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
    test('a real damaging ability outranks a bare threat number, whatever the sheet says', () => {
        // atlan: threat 208 on the sheet, but a mage kit — the sheet number
        // alone must not override what they are actually observed casting
        const verdict = inferClass(
            { casts: cast('/abilities/cleave'), stats: { threat: 3.2, combatStyleHrids: ['/combat_styles/slash'] } },
            ABILITIES
        );

        expect(verdict.key).toBe('melee');
        expect(verdict.basis).toContain('styles cast');
    });

    test('threat on the captured sheet is a tank only once nothing else has answered', () => {
        // No damaging ability anywhere in the evidence — the sheet's threat
        // number is all there is, so it still gets to speak
        const verdict = inferClass({ stats: { threat: 3.2 } }, ABILITIES);

        expect(verdict).toMatchObject({ key: 'tank', short: CLASS_BUCKETS.tank.short });
        expect(verdict.basis).toContain('threat');
    });

    test('threat merely at the party baseline is not a tank; threat well above it is', () => {
        // Mirrors the reported bug: a mage with Threat 208 sitting near the
        // rest of the party's baseline, versus a real tank materially above it
        const mage = inferClass({ stats: { threat: 208 }, partyThreat: 200 }, ABILITIES);
        expect(mage).toBeNull();

        const tank = inferClass({ stats: { threat: 900 }, partyThreat: 200 }, ABILITIES);
        expect(tank.key).toBe('tank');
        expect(tank.basis).toContain('above the rest of the party');
    });

    test('a mage kit beats a merely-baseline threat number even with a party baseline supplied', () => {
        // The exact reported scenario: captured kit has Fireball, sheet threat
        // is unremarkable next to the rest of the party
        const verdict = inferClass(
            {
                kit: [{ hrid: '/abilities/fireball' }],
                stats: { threat: 208 },
                partyThreat: 190,
            },
            ABILITIES
        );

        expect(verdict.key).toBe('fireMage');
    });

    test('a thorns or taunt ability is a tank, cast or merely carried', () => {
        // Seen casting it, auto-attacking otherwise
        const cast1 = inferClass({ casts: cast('/abilities/spike_shell') }, ABILITIES);
        expect(cast1.key).toBe('tank');
        expect(cast1.basis).toContain('thorns');

        // In the kit with a ranged weapon on the sheet: the kit wins over the weapon style
        const kit = inferClass(
            {
                kit: [{ hrid: '/abilities/taunt' }, { hrid: '/abilities/steady_shot' }],
                stats: { combatStyleHrids: ['/combat_styles/ranged'] },
            },
            ABILITIES
        );
        expect(kit.key).toBe('tank');

        // A plain self-buff says nothing
        expect(inferClass({ casts: cast('/abilities/toughness') }, ABILITIES)).toBeNull();
    });

    test('the verdict carries the melee sub-style, and whether a curse was seen', () => {
        const stab = inferClass({ casts: cast('/abilities/steady_shot') }, ABILITIES);
        expect(stab.key).toBe('ranged');
        expect(stab.style).toBe('ranged');
        expect(stab.curse).toBe(false);

        const slash = inferClass({ casts: cast('/abilities/cleave') }, ABILITIES);
        expect(slash.key).toBe('melee');
        expect(slash.style).toBe('slash');

        // A curse anywhere in the evidence, even one the ability map does not know
        const cursed = inferClass({ casts: cast('/abilities/steady_shot', '/abilities/curse') }, ABILITIES);
        expect(cursed.key).toBe('ranged');
        expect(cursed.curse).toBe(true);

        // The sheet's style when nothing damaging was cast
        const sheet = inferClass({ stats: { combatStyleHrids: ['/combat_styles/stab'] } }, ABILITIES);
        expect(sheet.key).toBe('melee');
        expect(sheet.style).toBe('stab');

        // A known weapon rides along
        expect(
            inferClass({ casts: cast('/abilities/cleave'), weaponHrid: '/items/regal_sword' }, ABILITIES).weaponHrid
        ).toBe('/items/regal_sword');
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

/**
 * The weapon-passive rule, end to end: the mapping is derived from a synthetic
 * `itemDetailMap` in the game's own shape, and the pinned case is the reported
 * one — a crossbow wielder whose slotted melee abilities used to tag them
 * Melee, until the fetched sheet's pierce passive said otherwise.
 */
const weapon = (slot, style, damageType, extra = {}) => ({
    equipmentDetail: { type: slot, combatStats: { combatStyleHrids: [style], damageType, ...extra } },
});

const ITEMS = {
    '/items/test_crossbow': weapon('/equipment_types/two_hand', '/combat_styles/ranged', '/damage_types/physical', {
        pierce: 0.3,
    }),
    '/items/test_cursed_bow': weapon('/equipment_types/two_hand', '/combat_styles/ranged', '/damage_types/physical', {
        curse: 0.3,
    }),
    '/items/test_blooming_trident': weapon(
        '/equipment_types/two_hand',
        '/combat_styles/magic',
        '/damage_types/nature',
        {
            bloom: 0.2,
        }
    ),
    '/items/test_rippling_trident': weapon('/equipment_types/two_hand', '/combat_styles/magic', '/damage_types/water', {
        ripple: 0.2,
    }),
    '/items/test_blazing_trident': weapon('/equipment_types/two_hand', '/combat_styles/magic', '/damage_types/fire', {
        blaze: 0.2,
    }),
    '/items/test_spear': weapon('/equipment_types/two_hand', '/combat_styles/stab', '/damage_types/physical', {
        fury: 0.2,
    }),
    // Two weapons whose shared passive disagrees about the bucket: it proves nothing
    '/items/test_mayhem_axe': weapon('/equipment_types/main_hand', '/combat_styles/slash', '/damage_types/physical', {
        mayhem: 0.1,
    }),
    '/items/test_mayhem_wand': weapon('/equipment_types/main_hand', '/combat_styles/magic', '/damage_types/fire', {
        mayhem: 0.1,
    }),
    // A passive a non-weapon also grants: a nonzero sheet reading no longer proves the weapon
    '/items/test_weaken_sword': weapon('/equipment_types/main_hand', '/combat_styles/slash', '/damage_types/physical', {
        weaken: 0.1,
    }),
    '/items/test_weaken_charm': {
        equipmentDetail: { type: '/equipment_types/charm', combatStats: { weaken: 0.05 } },
    },
    '/items/test_plain_shield': { equipmentDetail: { type: '/equipment_types/off_hand', combatStats: {} } },
};

describe('deriving the passive table from the item data', () => {
    test('each unambiguous weapon passive names the weapon family bucket', () => {
        const buckets = weaponPassiveBuckets(ITEMS);

        expect(buckets.pierce.key).toBe('ranged');
        expect(buckets.curse.key).toBe('ranged');
        expect(buckets.ripple.key).toBe('waterMage');
        expect(buckets.blaze.key).toBe('fireMage');
        // Nature is the healing element, same as everywhere else in the rules
        expect(buckets.bloom.key).toBe('healer');
        expect(buckets.fury).toMatchObject({ key: 'melee', style: 'stab' });
    });

    test('a passive the data makes ambiguous is dropped rather than guessed at', () => {
        const buckets = weaponPassiveBuckets(ITEMS);

        // Carried by weapons of two different buckets
        expect(buckets.mayhem).toBeUndefined();
        // Also granted by a charm, so a sheet reading does not prove the weapon
        expect(buckets.weaken).toBeUndefined();
    });

    test('no item data means no table, not a throw', () => {
        expect(weaponPassiveBuckets(null)).toEqual({});
        expect(weaponPassiveBuckets(undefined)).toEqual({});
    });
});

describe('the weapon passive on a fetched sheet', () => {
    /** The reported unit: a crossbow in hand, melee abilities in the kit */
    const crossbowSheet = {
        pierce: 0.3,
        threat: 100,
        combatStyleHrids: ['/combat_styles/ranged'],
        damageType: '/damage_types/physical',
    };
    const meleeKit = [{ hrid: '/abilities/cleave' }, { hrid: '/abilities/smack' }];

    test('a crossbow wielder with melee abilities is Ranged, off the pierce passive', () => {
        const verdict = inferClass({ kit: meleeKit, stats: crossbowSheet }, ABILITIES, ITEMS);

        expect(verdict.key).toBe('ranged');
        expect(verdict.basis).toContain('pierce');
    });

    test('the same unit without a fetched sheet falls back to the old ability answer', () => {
        // No stats captured — no Battle Info has been opened on them — so the
        // melee abilities are all the evidence there is
        expect(inferClass({ kit: meleeKit }, ABILITIES, ITEMS).key).toBe('melee');
        // And with a sheet but no item data to interpret it, likewise
        expect(inferClass({ kit: meleeKit, stats: { pierce: 0.3 } }, ABILITIES).key).toBe('melee');
    });

    test('a taunt in the kit still outranks the weapon: a tank is a role, not a weapon', () => {
        const verdict = inferClass({ kit: [{ hrid: '/abilities/taunt' }], stats: crossbowSheet }, ABILITIES, ITEMS);

        expect(verdict.key).toBe('tank');
    });

    test('the Cursed Bow announces itself: the curse passive sets the curse flag', () => {
        const verdict = inferClass(
            {
                kit: meleeKit,
                stats: { curse: 0.3, combatStyleHrids: ['/combat_styles/ranged'] },
            },
            ABILITIES,
            ITEMS
        );

        expect(verdict.key).toBe('ranged');
        expect(verdict.curse).toBe(true);
    });

    test('a passive the table dropped proves nothing, and the abilities answer instead', () => {
        expect(inferClass({ kit: meleeKit, stats: { mayhem: 0.1 } }, ABILITIES, ITEMS).key).toBe('melee');
    });

    test('the healing weapon files its wielder as the healer before any cast', () => {
        expect(inferClass({ stats: { bloom: 0.2 } }, ABILITIES, ITEMS).key).toBe('healer');
    });
});
