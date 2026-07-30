/**
 * Tests for the forced Lab Sim armor candidates: style matching, enhancement
 * resolution, and the set combinations.
 */

import { describe, test, expect } from 'vitest';
import {
    ANCHORBOUND_HRIDS,
    DEFAULT_ARMOR_ENHANCEMENT,
    findTopTierArmor,
    generateLabArmorCandidates,
    getWeaponStyleFamily,
    resolveArmorEnhancement,
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

describe('resolveArmorEnhancement', () => {
    const hrid = '/items/anchorbound_plate_body';

    test('uses the equipped level first', () => {
        const dto = player({ [BODY]: { hrid, enhancementLevel: 12 } });
        const inventory = [{ itemHrid: hrid, enhancementLevel: 3, count: 1 }];
        expect(resolveArmorEnhancement(hrid, dto, inventory)).toBe(12);
    });

    test('falls back to the best copy in inventory', () => {
        const inventory = [
            { itemHrid: hrid, enhancementLevel: 4, count: 1, itemLocationHrid: '/item_locations/inventory' },
            { itemHrid: hrid, enhancementLevel: 9, count: 1, itemLocationHrid: '/item_locations/inventory' },
        ];
        expect(resolveArmorEnhancement(hrid, player({}), inventory)).toBe(9);
    });

    test('ignores copies equipped elsewhere and empty stacks', () => {
        const inventory = [
            { itemHrid: hrid, enhancementLevel: 15, count: 1, itemLocationHrid: '/item_locations/body' },
            { itemHrid: hrid, enhancementLevel: 11, count: 0, itemLocationHrid: '/item_locations/inventory' },
        ];
        expect(resolveArmorEnhancement(hrid, player({}), inventory)).toBe(DEFAULT_ARMOR_ENHANCEMENT);
    });

    test('defaults when neither equipped nor owned', () => {
        expect(resolveArmorEnhancement(hrid, player({}), [])).toBe(7);
        expect(resolveArmorEnhancement(hrid, player({}), null)).toBe(7);
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
