import { describe, test, expect } from 'vitest';
import {
    BUILD_GUIDE,
    ARCHETYPE_KEYS,
    auraGroup,
    buildGuidePlan,
    detectArchetype,
    resolveAbilityHrid,
    signatureGroup,
} from './build-guide.js';

const MAIN_HAND = '/equipment_types/main_hand';
const TWO_HAND = '/equipment_types/two_hand';
const OFF_HAND = '/equipment_types/off_hand';
const BODY = '/equipment_types/body';
const LEGS = '/equipment_types/legs';

/** Every ability the guide names anywhere, as a game-data ability map */
function guideAbilityMap(extra = {}) {
    const map = {};
    for (const archetype of Object.values(BUILD_GUIDE)) {
        archetype.abilityGroups.forEach((group, index) => {
            for (const name of group) {
                const hrid = `/abilities/${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
                map[hrid] = { name, isSpecialAbility: index === 0 };
            }
        });
    }
    return { ...map, ...extra };
}

/**
 * A game data payload holding one weapon (and optionally armor), with every
 * guide ability present.
 */
function gameData(items = {}, abilities = guideAbilityMap()) {
    return { itemDetailMap: items, abilityDetailMap: abilities };
}

const weapon = (name, combatStats) => ({ name, equipmentDetail: { type: MAIN_HAND, combatStats } });

describe('detectArchetype', () => {
    test('names every weapon the guide lists', () => {
        // The whole table in one pass: the guide's own weapons must land on the
        // archetype that lists them, or a build's swaps come from another build
        for (const archetype of Object.values(BUILD_GUIDE)) {
            for (const hrid of archetype.weapons) {
                const dto = { equipment: { [MAIN_HAND]: { hrid } } };
                expect(detectArchetype(dto, gameData({ [hrid]: weapon(hrid, {}) }))).toBe(archetype.key);
            }
        }
    });

    test('sees through a refined weapon', () => {
        const dto = { equipment: { [MAIN_HAND]: { hrid: '/items/furious_spear_refined' } } };
        expect(detectArchetype(dto, gameData({}))).toBe('spear');
    });

    test('reads a two-handed weapon, which leaves the main hand empty', () => {
        const dto = { equipment: { [TWO_HAND]: { hrid: '/items/cursed_bow' } } };
        expect(detectArchetype(dto, gameData({}))).toBe('bow');
    });

    test('falls back to the melee sub-style for a weapon the guide never listed', () => {
        const items = {
            '/items/fine_spear': weapon('Fine Spear', { stabDamage: 10 }),
            '/items/fine_sword': weapon('Fine Sword', { slashDamage: 10 }),
            '/items/fine_mace': weapon('Fine Mace', { smashDamage: 10 }),
        };
        const at = (hrid) => detectArchetype({ equipment: { [MAIN_HAND]: { hrid } } }, gameData(items));
        expect(at('/items/fine_spear')).toBe('spear');
        expect(at('/items/fine_sword')).toBe('sword');
        expect(at('/items/fine_mace')).toBe('mace');
    });

    test('a bulwark is the defensive build, not the mace one it measures as', () => {
        // Its stats say smash, and a wark build shares nothing with a mace build
        // but the damage type — the whole ability set is different
        const items = { '/items/iron_bulwark': weapon('Iron Bulwark', { smashDamage: 10 }) };
        const dto = { equipment: { [MAIN_HAND]: { hrid: '/items/iron_bulwark' } } };
        expect(detectArchetype(dto, gameData(items))).toBe('wark');
    });

    test('tells a crossbow from a bow by name, then by the hand it takes', () => {
        const items = {
            '/items/plain_crossbow': weapon('Plain Crossbow', { rangedDamage: 10 }),
            '/items/plain_bow': weapon('Plain Bow', { rangedDamage: 10 }),
            '/items/sling': weapon('Sling', { rangedDamage: 10 }),
        };
        const at = (slot, hrid) => detectArchetype({ equipment: { [slot]: { hrid } } }, gameData(items));
        expect(at(MAIN_HAND, '/items/plain_crossbow')).toBe('crossbow');
        expect(at(TWO_HAND, '/items/plain_bow')).toBe('bow');
        // Nameless: two-handed ranged is a bow, one-handed is a crossbow
        expect(at(TWO_HAND, '/items/sling')).toBe('bow');
        expect(at(MAIN_HAND, '/items/sling')).toBe('crossbow');
    });

    test('takes the element off the weapon when it names one', () => {
        const items = {
            '/items/odd_staff': weapon('Odd Staff', { magicDamage: 10, damageType: '/damage_types/water' }),
        };
        const dto = { equipment: { [MAIN_HAND]: { hrid: '/items/odd_staff' } } };
        expect(detectArchetype(dto, gameData(items))).toBe('water');
    });

    test('and off the robes when it does not', () => {
        const items = {
            '/items/odd_staff': weapon('Odd Staff', { magicDamage: 10 }),
            '/items/luna_robe_top': { name: 'Luna Robe Top', equipmentDetail: { type: BODY, combatStats: {} } },
            '/items/flaming_robe_bottoms': {
                name: 'Flaming Robe Bottoms',
                equipmentDetail: { type: LEGS, combatStats: { fireAmplify: 0.1 } },
            },
        };
        // The amplify stat wins over the guide's own robe list, so a robe the
        // guide has not caught up with still places the build
        const dto = {
            equipment: {
                [MAIN_HAND]: { hrid: '/items/odd_staff' },
                [BODY]: { hrid: '/items/luna_robe_top' },
                [LEGS]: { hrid: '/items/flaming_robe_bottoms' },
            },
        };
        expect(detectArchetype(dto, gameData(items))).toBe('fire');
    });

    test('names the element from the guide robe list when nothing carries an amplify stat', () => {
        const items = {
            '/items/odd_staff': weapon('Odd Staff', { magicDamage: 10 }),
            '/items/icy_robe_top': { name: 'Icy Robe Top', equipmentDetail: { type: BODY, combatStats: {} } },
        };
        const dto = {
            equipment: { [MAIN_HAND]: { hrid: '/items/odd_staff' }, [BODY]: { hrid: '/items/icy_robe_top' } },
        };
        expect(detectArchetype(dto, gameData(items))).toBe('water');
    });

    test('refuses to guess rather than guessing wrong', () => {
        const items = {
            '/items/odd_staff': weapon('Odd Staff', { magicDamage: 10 }),
            '/items/paperweight': weapon('Paperweight', {}),
        };
        // Unarmed
        expect(detectArchetype({ equipment: {} }, gameData(items))).toBeNull();
        // A weapon with no damage stat at all
        expect(
            detectArchetype({ equipment: { [MAIN_HAND]: { hrid: '/items/paperweight' } } }, gameData(items))
        ).toBeNull();
        // Magic with no element anywhere: a fire set and a nature set are
        // different builds, and picking one is worse than admitting ignorance
        expect(
            detectArchetype({ equipment: { [MAIN_HAND]: { hrid: '/items/odd_staff' } } }, gameData(items))
        ).toBeNull();
    });
});

describe('the guide table itself', () => {
    test('every archetype names an aura group and a signature group', () => {
        for (const key of ARCHETYPE_KEYS) {
            expect(auraGroup(key).length).toBeGreaterThan(0);
            expect(signatureGroup(key).length).toBeGreaterThan(0);
        }
    });

    test('the signature is the archetype-defining ability', () => {
        expect(signatureGroup('spear')).toEqual(['Puncture']);
        expect(signatureGroup('sword')).toEqual(['Maim']);
        expect(signatureGroup('mace')).toEqual(['Shield Bash']);
        expect(signatureGroup('wark')).toEqual(['Shield Bash', 'Retribution']);
        expect(signatureGroup('bow')).toEqual(['Pestilent Shot']);
        expect(signatureGroup('crossbow')).toEqual(['Steady Shot', 'Silencing Shot']);
        expect(signatureGroup('fire')).toEqual(['Fireball']);
        expect(signatureGroup('water')).toEqual(['Water Strike']);
        expect(signatureGroup('nature')).toEqual(['Entangle']);
    });

    test('the aura group carries both sides of the OR, and warks carry Invincible', () => {
        expect(auraGroup('spear')).toEqual(['Critical Aura', 'Fierce Aura']);
        expect(auraGroup('fire')).toEqual(['Critical Aura', 'Mystic Aura']);
        expect(auraGroup('wark')).toEqual(['Invincible']);
    });

    test('an unknown key asks for nothing rather than throwing', () => {
        expect(signatureGroup('bagpipes')).toEqual([]);
        expect(auraGroup(undefined)).toEqual([]);
    });
});

describe('resolveAbilityHrid', () => {
    test('takes the slug when the game has it', () => {
        expect(resolveAbilityHrid('Shield Bash', { '/abilities/shield_bash': { name: 'Shield Bash' } })).toBe(
            '/abilities/shield_bash'
        );
    });

    test('finds one the game renamed the hrid of', () => {
        const map = { '/abilities/renamed_thing': { name: 'Critical Aura' } };
        expect(resolveAbilityHrid('Critical Aura', map)).toBe('/abilities/renamed_thing');
    });

    test('returns null for an ability the game does not have', () => {
        expect(resolveAbilityHrid('Puncture', { '/abilities/smack': { name: 'Smack' } })).toBeNull();
        expect(resolveAbilityHrid('Puncture', null)).toBeNull();
    });
});

describe('buildGuidePlan', () => {
    const fireMage = {
        equipment: { [TWO_HAND]: { hrid: '/items/blazing_trident' } },
        abilities: [
            { hrid: '/abilities/critical_aura', level: 20 },
            { hrid: '/abilities/elemental_affinity', level: 40 },
            { hrid: '/abilities/smack', level: 30 },
            null,
            null,
        ],
    };

    test('offers the archetype set minus what is already slotted', () => {
        const plan = buildGuidePlan(fireMage, gameData({}));
        expect(plan.archetype).toBe('fire');
        // Critical Aura and Elemental Affinity are already run; the rest of the
        // fire set, the other aura option included, is what is on offer
        expect(plan.offers.sort()).toEqual(
            ['/abilities/mystic_aura', '/abilities/precision', '/abilities/smoke_burst', '/abilities/fireball'].sort()
        );
        // Nothing from another archetype
        expect(plan.offers).not.toContain('/abilities/puncture');
        expect(plan.offers).not.toContain('/abilities/entangle');
    });

    test('aura-only offers just the other aura, not the signature', () => {
        const plan = buildGuidePlan(fireMage, gameData({}), { auraOnly: true });
        expect(plan.offers).toEqual(['/abilities/mystic_aura']);
        expect(plan.auraOnly).toBe(true);
    });

    test('but still knows the whole set, so the rest of it is not treated as replaceable', () => {
        const plan = buildGuidePlan(fireMage, gameData({}), { auraOnly: true });
        // Precision is not offered in this mode, but it is still on-guide — the
        // generator reads `memberOf` to decide what may be displaced
        expect(plan.memberOf.has('/abilities/precision')).toBe(true);
        expect(plan.memberOf.get('/abilities/critical_aura')).toBe(plan.memberOf.get('/abilities/mystic_aura'));
        expect(plan.memberOf.get('/abilities/fireball')).not.toBe(plan.memberOf.get('/abilities/precision'));
    });

    test('a wark plan captures both signature options in full mode, none in aura-only', () => {
        const wark = {
            equipment: { [TWO_HAND]: { hrid: '/items/griffin_bulwark' }, [OFF_HAND]: null },
            abilities: [{ hrid: '/abilities/invincible', level: 10 }, null, null, null, null],
        };
        const full = buildGuidePlan(wark, gameData({}), {});
        expect(full.archetype).toBe('wark');
        expect(full.offers).toContain('/abilities/shield_bash');
        expect(full.offers).toContain('/abilities/retribution');
        // Invincible is slotted, so it is not offered — but it is on-guide
        expect(full.memberOf.get('/abilities/invincible')).toBe(0);

        // Aura-only reaches only the aura slot, which for a wark is Invincible —
        // already slotted, so nothing is offered and the signature is not reached.
        expect(buildGuidePlan(wark, gameData({}), { auraOnly: true }).offers).toEqual([]);
    });

    test('is null when the archetype cannot be read', () => {
        expect(buildGuidePlan({ equipment: {}, abilities: [] }, gameData({}))).toBeNull();
    });

    test('but a loadout already running the whole guide offers nothing rather than falling back', () => {
        // Empty offers and a null plan mean opposite things to the generator:
        // one is "there is nothing left to try", the other is "I could not
        // read this build, offer everything"
        const perfect = {
            equipment: { [MAIN_HAND]: { hrid: '/items/furious_spear' } },
            abilities: [
                { hrid: '/abilities/critical_aura', level: 20 },
                { hrid: '/abilities/frenzy', level: 20 },
                { hrid: '/abilities/berserk', level: 20 },
                { hrid: '/abilities/precision', level: 20 },
                { hrid: '/abilities/puncture', level: 20 },
            ],
        };
        const plan = buildGuidePlan(perfect, gameData({}));
        // Fierce Aura is the one thing left, and only because it is the OR-half
        expect(plan.offers).toEqual(['/abilities/fierce_aura']);
        expect(buildGuidePlan(perfect, gameData({}), { auraOnly: true }).offers).toEqual(['/abilities/fierce_aura']);
    });

    test('is null when the game data has none of the guide abilities', () => {
        // A guide that resolves to nothing must not silently produce an empty
        // candidate list — the caller falls back to offering everything
        const data = gameData({}, { '/abilities/smack': { name: 'Smack' } });
        expect(buildGuidePlan(fireMage, data)).toBeNull();
    });
});
