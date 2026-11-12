import { describe, test, expect, vi } from 'vitest';

const host = vi.hoisted(() => ({ testServer: true }));
vi.mock('./game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => host.testServer,
}));

const { sharedSlottedTalismans, describeSimTalismans } = await import('./talisman-bonuses.js');
const { loadoutSignature } = await import('./all-zones-snapshot.js');
const { BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE } = await import('../__fixtures__/talisman-bonuses.js');
const { COMBAT_MODIFIER_DETAILS } = await import('../__fixtures__/talisman-combat-modifiers.js');

describe('sharedSlottedTalismans', () => {
    test('keeps slotted records with lines, drops the rest, and tells absent from empty', () => {
        expect(sharedSlottedTalismans(undefined)).toBeNull();
        expect(sharedSlottedTalismans('x')).toBeNull();
        expect(sharedSlottedTalismans([])).toEqual([]);
        const kept = sharedSlottedTalismans([
            {
                talismanTypeHrid: '/talisman_types/combat',
                slotIndex: 2,
                modifiers: [{ hrid: '/a', grade: 3 }, { hrid: 5 }],
            },
            { slotIndex: 0, modifiers: [{ hrid: '/a', grade: 1 }] },
            { slotIndex: 1 },
            null,
        ]);
        expect(kept).toEqual([{ slotIndex: 2, modifiers: [{ hrid: '/a', grade: 3 }] }]);
    });
});

describe('describeSimTalismans', () => {
    const talismans = [
        { slotIndex: 2, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 6 }] },
        { slotIndex: 1, modifiers: [{ hrid: '/talisman_modifiers/critical_damage', grade: 3 }] },
        { slotIndex: 3, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 1 }] },
    ];
    const describe_ = (belt) =>
        describeSimTalismans(talismans, belt, BELT_ITEMS, COMBAT_MODIFIER_DETAILS, TALISMAN_ENHANCEMENT_TABLE);

    test('scaled by the belt, in slot order, limited to its slots', () => {
        expect(describe_({ itemHrid: '/items/large_talisman_belt', enhancementLevel: 10 })).toEqual([
            { slotIndex: 1, lines: ['Critical Damage +3.77%'] },
            { slotIndex: 2, lines: ['Armor +10.06'] },
            { slotIndex: 3, lines: ['Armor +2.52'] },
        ]);
        expect(describe_({ itemHrid: '/items/small_talisman_belt', enhancementLevel: 0 })).toHaveLength(1);
    });

    test('nothing without a belt or off the test server', () => {
        expect(describe_(null)).toEqual([]);
        host.testServer = false;
        expect(describe_({ itemHrid: '/items/large_talisman_belt' })).toEqual([]);
        host.testServer = true;
    });
});

describe('loadoutSignature', () => {
    const snapshot = { equipment: [], abilities: [], food: [], drinks: [] };
    const worn = (grade) => [{ slotIndex: 1, modifiers: [{ hrid: '/talisman_modifiers/armor', grade }] }];

    test('unchanged without talismans, different when they differ', () => {
        const plain = loadoutSignature(snapshot, []);
        expect(loadoutSignature(snapshot, [], [])).toBe(plain);
        expect(loadoutSignature(snapshot, [], worn(1))).not.toBe(plain);
        expect(loadoutSignature(snapshot, [], worn(1))).not.toBe(loadoutSignature(snapshot, [], worn(2)));
        expect(loadoutSignature(snapshot, [], worn(1))).toBe(loadoutSignature(snapshot, [], worn(1)));
    });
});

describe('malformed input never throws', () => {
    test('sharedSlottedTalismans drops non-object lines and non-list line sets', () => {
        const rows = [
            { slotIndex: 1, modifiers: [null, 3, 'x', { grade: 2 }, { hrid: '/a', grade: 2 }] },
            { slotIndex: 2, modifiers: {} },
            { slotIndex: 3, modifiers: [null] },
        ];
        expect(() => sharedSlottedTalismans(rows)).not.toThrow();
        expect(sharedSlottedTalismans(rows)).toEqual([
            { slotIndex: 1, modifiers: [{ hrid: '/a', grade: 2 }] },
            { slotIndex: 3, modifiers: [] },
        ]);
    });
});
