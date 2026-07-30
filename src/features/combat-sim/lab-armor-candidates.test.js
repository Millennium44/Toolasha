/**
 * Tests for the forced Lab Sim armor candidates: style matching, enhancement
 * resolution, and the set combinations.
 */

import { describe, test, expect } from 'vitest';
import {
    ANCHORBOUND_HRIDS,
    DEFAULT_ARMOR_ENHANCEMENT,
    findElementalArmor,
    findElementalWeapon,
    findTopTierArmor,
    getEquippedWeapon,
    generateLabArmorCandidates,
    getLoadoutElements,
    getWeaponStyleFamily,
    resolveItemEnhancement,
    styleFamilyOfStats,
} from './lab-armor-candidates.js';

const BODY = '/equipment_types/body';
const LEGS = '/equipment_types/legs';

function armor(name, type, itemLevel, combatStats) {
    return { name, itemLevel, equipmentDetail: { type, combatStats } };
}

function gameData() {
    return {
        itemDetailMap: {
            '/items/anchorbound_plate_body': armor('Anchorbound Plate Body', BODY, 95, { armor: 50 }),
            '/items/anchorbound_plate_legs': armor('Anchorbound Plate Legs', LEGS, 95, { armor: 40 }),
            '/items/kraken_tunic': armor('Kraken Tunic', BODY, 95, { rangedDamage: 0.1, rangedAccuracy: 0.08 }),
            '/items/kraken_chaps': armor('Kraken Chaps', LEGS, 95, { rangedDamage: 0.08 }),
            '/items/maelstrom_plate_body': armor('Maelstrom Plate Body', BODY, 95, { smashDamage: 0.1 }),
            '/items/maelstrom_plate_legs': armor('Maelstrom Plate Legs', LEGS, 95, { slashDamage: 0.08 }),
            '/items/old_tunic': armor('Old Tunic', BODY, 60, { rangedDamage: 0.05 }),
            '/items/kraken_tunic_refined': armor('Kraken Tunic (R)', BODY, 95, { rangedDamage: 0.2 }),
            '/items/bow': armor('Bow', '/equipment_types/two_hand', 90, { rangedDamage: 1 }),
            '/items/sword': armor('Sword', '/equipment_types/main_hand', 90, { slashDamage: 1 }),
            '/items/staff': armor('Staff', '/equipment_types/two_hand', 90, { magicDamage: 1 }),
        },
    };
}

function player(equipment) {
    return { hrid: 'player1', equipment };
}

describe('styleFamilyOfStats', () => {
    test('classifies by the dominant offensive stat', () => {
        expect(styleFamilyOfStats({ rangedDamage: 0.1 })).toBe('ranged');
        expect(styleFamilyOfStats({ magicDamage: 0.1 })).toBe('magic');
        expect(styleFamilyOfStats({ slashDamage: 0.1 })).toBe('melee');
        expect(styleFamilyOfStats({ stabAccuracy: 0.1 })).toBe('melee');
    });

    test('treats elemental amplify as magic', () => {
        expect(styleFamilyOfStats({ fireAmplify: 0.05 })).toBe('magic');
    });

    test('armor with no offensive stats is style-neutral', () => {
        expect(styleFamilyOfStats({ armor: 50, evasion: 10 })).toBe('defensive');
        expect(styleFamilyOfStats(null)).toBe('defensive');
    });
});

describe('getWeaponStyleFamily', () => {
    test('reads a two-handed weapon', () => {
        expect(getWeaponStyleFamily(player({ '/equipment_types/two_hand': { hrid: '/items/bow' } }), gameData())).toBe(
            'ranged'
        );
    });

    test('reads a main-hand weapon', () => {
        expect(
            getWeaponStyleFamily(player({ '/equipment_types/main_hand': { hrid: '/items/sword' } }), gameData())
        ).toBe('melee');
    });

    test('falls back to neutral when unarmed', () => {
        expect(getWeaponStyleFamily(player({}), gameData())).toBe('defensive');
    });
});

describe('findTopTierArmor', () => {
    test('picks the top item level matching the weapon style', () => {
        expect(findTopTierArmor(BODY, 'ranged', gameData()).hrid).toBe('/items/kraken_tunic');
        expect(findTopTierArmor(BODY, 'melee', gameData()).hrid).toBe('/items/maelstrom_plate_body');
    });

    test('never returns a lower tier just because the style matches', () => {
        // Old Tunic is ranged too, but two tiers down
        expect(findTopTierArmor(BODY, 'ranged', gameData()).itemLevel).toBe(95);
    });

    test('falls back to style-neutral armor when no top-tier piece matches', () => {
        // Nothing at the top tier is magic, so the neutral plate wins
        expect(findTopTierArmor(BODY, 'magic', gameData()).hrid).toBe('/items/anchorbound_plate_body');
    });

    test('skips refined variants', () => {
        expect(findTopTierArmor(BODY, 'ranged', gameData()).hrid).not.toBe('/items/kraken_tunic_refined');
    });

    test('returns null for a slot with no armor', () => {
        expect(findTopTierArmor('/equipment_types/pouch', 'melee', gameData())).toBe(null);
    });
});

describe('resolveItemEnhancement', () => {
    const hrid = '/items/anchorbound_plate_body';

    test('uses the equipped level first', () => {
        const dto = player({ [BODY]: { hrid, enhancementLevel: 12 } });
        const inventory = [{ itemHrid: hrid, enhancementLevel: 3, count: 1 }];
        expect(resolveItemEnhancement(hrid, dto, inventory)).toBe(12);
    });

    test('falls back to the best copy in inventory', () => {
        const inventory = [
            { itemHrid: hrid, enhancementLevel: 4, count: 1, itemLocationHrid: '/item_locations/inventory' },
            { itemHrid: hrid, enhancementLevel: 9, count: 1, itemLocationHrid: '/item_locations/inventory' },
        ];
        expect(resolveItemEnhancement(hrid, player({}), inventory)).toBe(9);
    });

    test('ignores copies equipped elsewhere and empty stacks', () => {
        const inventory = [
            { itemHrid: hrid, enhancementLevel: 15, count: 1, itemLocationHrid: '/item_locations/body' },
            { itemHrid: hrid, enhancementLevel: 11, count: 0, itemLocationHrid: '/item_locations/inventory' },
        ];
        expect(resolveItemEnhancement(hrid, player({}), inventory)).toBe(DEFAULT_ARMOR_ENHANCEMENT);
    });

    test('defaults when neither equipped nor owned', () => {
        expect(resolveItemEnhancement(hrid, player({}), [])).toBe(7);
        expect(resolveItemEnhancement(hrid, player({}), null)).toBe(7);
    });
});

describe('generateLabArmorCandidates', () => {
    const rangedLoadout = () => player({ '/equipment_types/two_hand': { hrid: '/items/bow' } });

    test('offers both sets alone, as pairs, and crossed', () => {
        const candidates = generateLabArmorCandidates(rangedLoadout(), gameData(), []);

        const singles = candidates.filter((c) => Object.keys(c.addedSlots).length === 1);
        const pairs = candidates.filter((c) => Object.keys(c.addedSlots).length === 2);

        // Anchorbound body, Anchorbound legs, Kraken tunic, Kraken chaps
        expect(singles).toHaveLength(4);
        // 2 body options x 2 legs options
        expect(pairs).toHaveLength(4);

        const pairKeys = pairs.map((c) => `${c.addedSlots[BODY].hrid}+${c.addedSlots[LEGS].hrid}`).sort();
        expect(pairKeys).toEqual([
            '/items/anchorbound_plate_body+/items/anchorbound_plate_legs',
            '/items/anchorbound_plate_body+/items/kraken_chaps',
            '/items/kraken_tunic+/items/anchorbound_plate_legs',
            '/items/kraken_tunic+/items/kraken_chaps',
        ]);
    });

    test('defaults every piece to +7 when none are owned', () => {
        const candidates = generateLabArmorCandidates(rangedLoadout(), gameData(), []);
        for (const candidate of candidates) {
            for (const item of Object.values(candidate.addedSlots)) {
                expect(item.enhancementLevel).toBe(7);
            }
        }
    });

    test('uses owned and equipped levels per piece', () => {
        const dto = player({
            '/equipment_types/two_hand': { hrid: '/items/bow' },
            [BODY]: { hrid: '/items/anchorbound_plate_body', enhancementLevel: 13 },
        });
        const inventory = [
            {
                itemHrid: '/items/kraken_tunic',
                enhancementLevel: 5,
                count: 1,
                itemLocationHrid: '/item_locations/inventory',
            },
        ];
        const candidates = generateLabArmorCandidates(dto, gameData(), inventory);

        const anchorBody = candidates.find((c) => c.addedSlots[BODY]?.hrid === '/items/anchorbound_plate_body');
        const krakenBody = candidates.find((c) => c.addedSlots[BODY]?.hrid === '/items/kraken_tunic');
        expect(anchorBody.addedSlots[BODY].enhancementLevel).toBe(13);
        expect(krakenBody.addedSlots[BODY].enhancementLevel).toBe(5);
    });

    test('skips the combination already worn', () => {
        const dto = player({
            '/equipment_types/two_hand': { hrid: '/items/bow' },
            [BODY]: { hrid: '/items/kraken_tunic', enhancementLevel: 7 },
        });
        const candidates = generateLabArmorCandidates(dto, gameData(), []);

        // The body-only Kraken swap is a no-op; the pairs that include it are not
        const bodyOnlyKraken = candidates.find(
            (c) => Object.keys(c.addedSlots).length === 1 && c.addedSlots[BODY]?.hrid === '/items/kraken_tunic'
        );
        expect(bodyOnlyKraken).toBeUndefined();
        expect(candidates.some((c) => c.addedSlots[LEGS]?.hrid === '/items/kraken_chaps')).toBe(true);
    });

    test('credits the gear it replaces and clears nothing', () => {
        const dto = player({
            '/equipment_types/two_hand': { hrid: '/items/bow' },
            [BODY]: { hrid: '/items/old_tunic', enhancementLevel: 4 },
        });
        const candidates = generateLabArmorCandidates(dto, gameData(), []);
        const bodySwap = candidates.find(
            (c) => Object.keys(c.addedSlots).length === 1 && c.addedSlots[BODY]?.hrid === '/items/kraken_tunic'
        );

        expect(bodySwap.type).toBe('cross_slot');
        expect(bodySwap.clearedSlots).toEqual([]);
        expect(bodySwap.removedItems).toEqual([{ hrid: '/items/old_tunic', enhancementLevel: 4 }]);
        expect(bodySwap.description).toBe('Old Tunic → Kraken Tunic (+7)');
    });

    test('describes a pair as one swap of both pieces', () => {
        const dto = player({
            '/equipment_types/two_hand': { hrid: '/items/bow' },
            [BODY]: { hrid: '/items/old_tunic', enhancementLevel: 4 },
        });
        const candidates = generateLabArmorCandidates(dto, gameData(), []);
        const pair = candidates.find(
            (c) =>
                c.addedSlots[BODY]?.hrid === '/items/anchorbound_plate_body' &&
                c.addedSlots[LEGS]?.hrid === '/items/anchorbound_plate_legs'
        );

        expect(pair.description).toBe('Old Tunic + empty → Anchorbound Plate Body + Anchorbound Plate Legs (+7)');
        expect(pair.removedItems).toEqual([{ hrid: '/items/old_tunic', enhancementLevel: 4 }]);
    });

    test('shows per-piece levels when a pair mixes them', () => {
        const dto = player({ '/equipment_types/two_hand': { hrid: '/items/bow' } });
        const inventory = [
            {
                itemHrid: '/items/anchorbound_plate_legs',
                enhancementLevel: 10,
                count: 1,
                itemLocationHrid: '/item_locations/inventory',
            },
        ];
        const candidates = generateLabArmorCandidates(dto, gameData(), inventory);
        const pair = candidates.find(
            (c) =>
                c.addedSlots[BODY]?.hrid === '/items/anchorbound_plate_body' &&
                c.addedSlots[LEGS]?.hrid === '/items/anchorbound_plate_legs'
        );

        expect(pair.description).toContain('(+7/+10)');
    });

    test('describes an empty slot as empty', () => {
        const candidates = generateLabArmorCandidates(rangedLoadout(), gameData(), []);
        const bodySwap = candidates.find(
            (c) => Object.keys(c.addedSlots).length === 1 && c.addedSlots[BODY]?.hrid === '/items/kraken_tunic'
        );
        expect(bodySwap.description).toBe('empty → Kraken Tunic (+7)');
        expect(bodySwap.removedItems).toEqual([]);
    });

    test('collapses duplicates when Anchorbound is itself the top-tier match', () => {
        // A melee-neutral loadout picks the Anchorbound plate as top tier too
        const dto = player({});
        const candidates = generateLabArmorCandidates(dto, gameData(), []);
        const keys = candidates.map((c) =>
            Object.entries(c.addedSlots)
                .map(([slot, item]) => `${slot}=${item.hrid}`)
                .sort()
                .join('|')
        );
        expect(new Set(keys).size).toBe(keys.length);
    });

    test('returns nothing without game data', () => {
        expect(generateLabArmorCandidates(player({}), null, [])).toEqual([]);
        expect(generateLabArmorCandidates(null, gameData(), [])).toEqual([]);
    });

    test('exports the Anchorbound pieces it forces', () => {
        expect(ANCHORBOUND_HRIDS).toEqual(['/items/anchorbound_plate_body', '/items/anchorbound_plate_legs']);
    });
});

describe('elemental magic armor', () => {
    const NATURE = '/damage_types/nature';
    const FIRE = '/damage_types/fire';

    /** Mirrors the reported loadout: a Nature trident cast alongside Fireball. */
    function magicGameData() {
        return {
            itemDetailMap: {
                '/items/anchorbound_plate_body': armor('Anchorbound Plate Body', BODY, 95, { armor: 50 }),
                '/items/anchorbound_plate_legs': armor('Anchorbound Plate Legs', LEGS, 95, { armor: 40 }),
                '/items/royal_fire_robe_top': armor('Royal Fire Robe Top', BODY, 95, { fireAmplify: 0.12 }),
                '/items/royal_fire_robe_bottoms': armor('Royal Fire Robe Bottoms', LEGS, 95, { fireAmplify: 0.1 }),
                '/items/royal_nature_robe_top': armor('Royal Nature Robe Top', BODY, 95, { natureAmplify: 0.12 }),
                '/items/royal_nature_robe_bottoms': armor('Royal Nature Robe Bottoms', LEGS, 95, {
                    natureAmplify: 0.1,
                }),
                '/items/old_nature_robe_top': armor('Old Nature Robe Top', BODY, 70, { natureAmplify: 0.2 }),
                '/items/blooming_trident': armor('Blooming Trident', '/equipment_types/main_hand', 95, {
                    magicDamage: 0.5,
                    natureAmplify: 0.3,
                    damageType: NATURE,
                }),
                '/items/blazing_trident': armor('Blazing Trident', '/equipment_types/main_hand', 95, {
                    magicDamage: 0.5,
                    fireAmplify: 0.3,
                    damageType: FIRE,
                }),
                '/items/flame_wand': armor('Flame Wand', '/equipment_types/main_hand', 80, {
                    magicDamage: 0.3,
                    damageType: FIRE,
                }),
            },
            abilityDetailMap: {
                '/abilities/fireball': { abilityEffects: [{ damageType: FIRE }] },
                '/abilities/firestorm': { abilityEffects: [{ damageType: FIRE }] },
                '/abilities/entangle': { abilityEffects: [{ damageType: NATURE }] },
                '/abilities/haste': { abilityEffects: [{ damageType: '' }] },
            },
        };
    }

    const natureTridentWithFireSpells = () => ({
        hrid: 'player1',
        equipment: { '/equipment_types/main_hand': { hrid: '/items/blooming_trident' } },
        abilities: [{ hrid: '/abilities/fireball' }, { hrid: '/abilities/firestorm' }, null],
    });

    describe('getLoadoutElements', () => {
        test('reports the weapon element first, then ability elements', () => {
            expect(getLoadoutElements(natureTridentWithFireSpells(), magicGameData())).toEqual([NATURE, FIRE]);
        });

        test('collapses to one element when weapon and spells agree', () => {
            const dto = {
                equipment: { '/equipment_types/main_hand': { hrid: '/items/blooming_trident' } },
                abilities: [{ hrid: '/abilities/entangle' }],
            };
            expect(getLoadoutElements(dto, magicGameData())).toEqual([NATURE]);
        });

        test('orders ability elements by how many abilities use them', () => {
            const dto = {
                equipment: {},
                abilities: [
                    { hrid: '/abilities/fireball' },
                    { hrid: '/abilities/firestorm' },
                    { hrid: '/abilities/entangle' },
                ],
            };
            expect(getLoadoutElements(dto, magicGameData())).toEqual([FIRE, NATURE]);
        });

        test('ignores abilities that deal no elemental damage', () => {
            const dto = { equipment: {}, abilities: [{ hrid: '/abilities/haste' }] };
            expect(getLoadoutElements(dto, magicGameData())).toEqual([]);
        });

        test('returns nothing for a physical loadout', () => {
            expect(
                getLoadoutElements(player({ '/equipment_types/two_hand': { hrid: '/items/bow' } }), gameData())
            ).toEqual([]);
        });
    });

    describe('findElementalArmor', () => {
        test('picks the top-tier piece amplifying that element', () => {
            expect(findElementalArmor(BODY, NATURE, magicGameData()).hrid).toBe('/items/royal_nature_robe_top');
            expect(findElementalArmor(BODY, FIRE, magicGameData()).hrid).toBe('/items/royal_fire_robe_top');
        });

        test('does not drop a tier for a bigger amplify', () => {
            // Old Nature Robe Top amplifies more but is 25 levels down
            expect(findElementalArmor(BODY, NATURE, magicGameData()).itemLevel).toBe(95);
        });

        test('returns null when nothing amplifies the element', () => {
            expect(findElementalArmor(BODY, '/damage_types/water', magicGameData())).toBe(null);
            expect(findElementalArmor(BODY, '/damage_types/physical', magicGameData())).toBe(null);
        });
    });

    test('offers both robe sets when the weapon and spells differ', () => {
        const candidates = generateLabArmorCandidates(natureTridentWithFireSpells(), magicGameData(), []);
        const bodyHrids = new Set(candidates.map((c) => c.addedSlots[BODY]?.hrid).filter(Boolean));

        expect(bodyHrids).toContain('/items/royal_nature_robe_top');
        expect(bodyHrids).toContain('/items/royal_fire_robe_top');
        expect(bodyHrids).toContain('/items/anchorbound_plate_body');

        // 3 body options x 3 legs options
        expect(candidates.filter((c) => Object.keys(c.addedSlots).length === 2)).toHaveLength(9);
    });

    test('offers only the matching set when weapon and spells agree', () => {
        const dto = {
            equipment: { '/equipment_types/main_hand': { hrid: '/items/blooming_trident' } },
            abilities: [{ hrid: '/abilities/entangle' }],
        };
        const candidates = generateLabArmorCandidates(dto, magicGameData(), []);
        const bodyHrids = new Set(candidates.map((c) => c.addedSlots[BODY]?.hrid).filter(Boolean));

        expect(bodyHrids).toContain('/items/royal_nature_robe_top');
        expect(bodyHrids).not.toContain('/items/royal_fire_robe_top');
    });

    test('pairs each robe set with itself and across sets', () => {
        const candidates = generateLabArmorCandidates(natureTridentWithFireSpells(), magicGameData(), []);
        const pairKeys = candidates
            .filter((c) => Object.keys(c.addedSlots).length === 2)
            .map((c) => `${c.addedSlots[BODY].hrid}+${c.addedSlots[LEGS].hrid}`);

        expect(pairKeys).toContain('/items/royal_nature_robe_top+/items/royal_nature_robe_bottoms');
        expect(pairKeys).toContain('/items/royal_fire_robe_top+/items/royal_fire_robe_bottoms');
        expect(pairKeys).toContain('/items/anchorbound_plate_body+/items/royal_nature_robe_bottoms');
    });
});

describe('elemental weapon swaps', () => {
    const NATURE = '/damage_types/nature';
    const FIRE = '/damage_types/fire';

    function magicGameData() {
        return {
            itemDetailMap: {
                '/items/anchorbound_plate_body': armor('Anchorbound Plate Body', BODY, 95, { armor: 50 }),
                '/items/anchorbound_plate_legs': armor('Anchorbound Plate Legs', LEGS, 95, { armor: 40 }),
                '/items/royal_fire_robe_top': armor('Royal Fire Robe Top', BODY, 95, { fireAmplify: 0.12 }),
                '/items/royal_fire_robe_bottoms': armor('Royal Fire Robe Bottoms', LEGS, 95, { fireAmplify: 0.1 }),
                '/items/royal_nature_robe_top': armor('Royal Nature Robe Top', BODY, 95, { natureAmplify: 0.12 }),
                '/items/royal_nature_robe_bottoms': armor('Royal Nature Robe Bottoms', LEGS, 95, {
                    natureAmplify: 0.1,
                }),
                '/items/blooming_trident': armor('Blooming Trident', '/equipment_types/main_hand', 95, {
                    magicDamage: 0.5,
                    damageType: NATURE,
                }),
                '/items/blazing_trident': armor('Blazing Trident', '/equipment_types/main_hand', 95, {
                    magicDamage: 0.5,
                    damageType: FIRE,
                }),
                '/items/flame_wand': armor('Flame Wand', '/equipment_types/main_hand', 95, {
                    magicDamage: 0.4,
                    damageType: FIRE,
                }),
            },
            abilityDetailMap: {
                '/abilities/fireball': { abilityEffects: [{ damageType: FIRE }] },
                '/abilities/entangle': { abilityEffects: [{ damageType: NATURE }] },
            },
        };
    }

    const natureTridentFireSpells = () => ({
        hrid: 'player1',
        equipment: { '/equipment_types/main_hand': { hrid: '/items/blooming_trident', enhancementLevel: 7 } },
        abilities: [{ hrid: '/abilities/fireball' }],
    });

    describe('getEquippedWeapon', () => {
        test('reports the weapon slot, name and damage type', () => {
            expect(getEquippedWeapon(natureTridentFireSpells(), magicGameData())).toMatchObject({
                slot: '/equipment_types/main_hand',
                hrid: '/items/blooming_trident',
                damageType: NATURE,
            });
        });

        test('returns null when unarmed', () => {
            expect(getEquippedWeapon({ equipment: {} }, magicGameData())).toBe(null);
        });
    });

    describe('findElementalWeapon', () => {
        test('prefers the same weapon class in the other element', () => {
            const weapon = getEquippedWeapon(natureTridentFireSpells(), magicGameData());
            // Flame Wand is also fire and same tier, but a Trident maps to a Trident
            expect(findElementalWeapon(weapon, FIRE, magicGameData()).hrid).toBe('/items/blazing_trident');
        });

        test('never returns the weapon already equipped', () => {
            const weapon = getEquippedWeapon(natureTridentFireSpells(), magicGameData());
            expect(findElementalWeapon(weapon, NATURE, magicGameData())).toBe(null);
        });

        test('returns null for an element with no weapon', () => {
            const weapon = getEquippedWeapon(natureTridentFireSpells(), magicGameData());
            expect(findElementalWeapon(weapon, '/damage_types/water', magicGameData())).toBe(null);
        });
    });

    test('sims the spells-element weapon alone and with its robes', () => {
        const candidates = generateLabArmorCandidates(natureTridentFireSpells(), magicGameData(), []);
        const withWeapon = candidates.filter((c) => c.addedSlots['/equipment_types/main_hand']);

        expect(withWeapon).toHaveLength(2);
        for (const candidate of withWeapon) {
            expect(candidate.addedSlots['/equipment_types/main_hand'].hrid).toBe('/items/blazing_trident');
        }

        const full = withWeapon.find((c) => Object.keys(c.addedSlots).length === 3);
        expect(full.addedSlots[BODY].hrid).toBe('/items/royal_fire_robe_top');
        expect(full.addedSlots[LEGS].hrid).toBe('/items/royal_fire_robe_bottoms');
        expect(full.description).toBe(
            'Blooming Trident + empty + empty → Blazing Trident + Royal Fire Robe Top + Royal Fire Robe Bottoms (+7)'
        );
    });

    test('credits the weapon it replaces', () => {
        const candidates = generateLabArmorCandidates(natureTridentFireSpells(), magicGameData(), []);
        const weaponOnly = candidates.find(
            (c) => Object.keys(c.addedSlots).length === 1 && c.addedSlots['/equipment_types/main_hand']
        );

        expect(weaponOnly.removedItems).toEqual([{ hrid: '/items/blooming_trident', enhancementLevel: 7 }]);
        expect(weaponOnly.clearedSlots).toEqual([]);
    });

    test('leaves the weapon alone when the spells match its element', () => {
        const dto = {
            equipment: { '/equipment_types/main_hand': { hrid: '/items/blooming_trident', enhancementLevel: 7 } },
            abilities: [{ hrid: '/abilities/entangle' }],
        };
        const candidates = generateLabArmorCandidates(dto, magicGameData(), []);
        expect(candidates.some((c) => c.addedSlots['/equipment_types/main_hand'])).toBe(false);
    });
});
