import { describe, test, expect } from 'vitest';
import {
    addTalismanLine,
    clampGrade,
    removeTalismanLine,
    setTalismanLineGrade,
    setTalismanLineType,
    talismanInSlot,
    talismanListSignature,
} from './sim-talisman-edit.js';

const LIMITS = { maxGrade: 6, linesPerTalisman: 4 };
const ARMOR = '/talisman_modifiers/armor';
const HASTE = '/talisman_modifiers/ability_haste';
const POWER = '/talisman_modifiers/ability_damage';

const three = () => [
    { id: 11, talismanTypeHrid: '/talisman_types/combat', slotIndex: 1, modifiers: [{ hrid: ARMOR, grade: 6 }] },
    { id: 12, talismanTypeHrid: '/talisman_types/combat', slotIndex: 2, modifiers: [{ hrid: ARMOR, grade: 2 }] },
    { id: 13, talismanTypeHrid: '/talisman_types/combat', slotIndex: 3, modifiers: [] },
];

describe('editing a sim talisman list', () => {
    test('adds a line to an empty slot, creating the talisman, in slot order', () => {
        const list = addTalismanLine([three()[2], three()[0]], 2, HASTE, 3, LIMITS);
        expect(list.map((t) => t.slotIndex)).toEqual([1, 2, 3]);
        expect(talismanInSlot(list, 2).modifiers).toEqual([{ hrid: HASTE, grade: 3 }]);
    });

    test('refuses a duplicate type on one talisman and a fifth line, and never mutates the input', () => {
        const input = three();
        const before = structuredClone(input);
        expect(addTalismanLine(input, 1, ARMOR, 1, LIMITS)).toEqual(before);
        let list = input;
        for (const hrid of [HASTE, POWER, '/talisman_modifiers/a', '/talisman_modifiers/b']) {
            list = addTalismanLine(list, 3, hrid, 1, LIMITS);
        }
        expect(talismanInSlot(list, 3).modifiers).toHaveLength(4);
        expect(input).toEqual(before);
    });

    test('the same type on two talismans is allowed and both stay', () => {
        const list = setTalismanLineType(three(), 2, 0, ARMOR);
        expect(list.filter((t) => t.modifiers.some((m) => m.hrid === ARMOR))).toHaveLength(2);
    });

    test('changing a type to one already on that talisman is refused', () => {
        const list = addTalismanLine(three(), 1, HASTE, 2, LIMITS);
        expect(setTalismanLineType(list, 1, 1, ARMOR)).toEqual(list);
        expect(setTalismanLineType(list, 1, 1, POWER)[0].modifiers[1].hrid).toBe(POWER);
    });

    test('grades clamp to 1..max, whole numbers; G6 is kept', () => {
        expect(clampGrade(0, 6)).toBe(1);
        expect(clampGrade(9, 6)).toBe(6);
        expect(clampGrade(2.9, 6)).toBe(2);
        expect(clampGrade('x', 6)).toBe(1);
        expect(setTalismanLineGrade(three(), 1, 0, 6, 6)[0].modifiers[0].grade).toBe(6);
        expect(setTalismanLineGrade(three(), 1, 0, 7, 6)[0].modifiers[0].grade).toBe(6);
    });

    test('removing the last line leaves a talisman with no lines', () => {
        const list = removeTalismanLine(three(), 1, 0);
        expect(talismanInSlot(list, 1).modifiers).toEqual([]);
        expect(removeTalismanLine(three(), 1, 5)).toEqual(three());
    });

    test('tolerates a missing or junk list', () => {
        expect(addTalismanLine(undefined, 1, ARMOR, 1, LIMITS)).toHaveLength(1);
        expect(addTalismanLine([null, 'x'], 1, ARMOR, 1, LIMITS)).toHaveLength(1);
    });

    test('the signature ignores order, spare fields and empty talismans, and sees a changed grade', () => {
        const a = three();
        const b = [...three()].reverse().map((t) => ({ ...t, id: undefined }));
        expect(talismanListSignature(a)).toBe(talismanListSignature(b));
        expect(talismanListSignature(a)).toBe(talismanListSignature(a.slice(0, 2)));
        expect(talismanListSignature(a)).not.toBe(talismanListSignature(setTalismanLineGrade(a, 2, 0, 3, 6)));
        expect(talismanListSignature(undefined)).toBe(talismanListSignature([]));
    });
});
