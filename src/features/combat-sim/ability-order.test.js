import { describe, test, expect } from 'vitest';
import { abilitySlotUnlocks, moveAbilitySlot } from './ability-order.js';

const ab = (hrid, level = 10, triggers = null) => ({ hrid, level, triggers });
const AURA = ab('/abilities/fierce_aura', 40);
const A = ab('/abilities/a', 11, [{ dependencyHrid: 'x' }]);
const B = ab('/abilities/b', 22);
const C = ab('/abilities/c', 33);

describe('moveAbilitySlot', () => {
    const slots = () => [AURA, A, B, C, null];

    test('moves down, carrying level and trigger rows with the ability', () => {
        const result = moveAbilitySlot(slots(), 1, 1);
        expect(result.moved).toBe(true);
        expect(result.abilities).toEqual([AURA, B, A, C, null]);
        expect(result.abilities[2]).toBe(A);
        expect(result.abilities[2].triggers).toEqual([{ dependencyHrid: 'x' }]);
    });

    test('moves up', () => {
        expect(moveAbilitySlot(slots(), 3, -1).abilities).toEqual([AURA, A, C, B, null]);
    });

    test('moves into an empty neighbor', () => {
        expect(moveAbilitySlot(slots(), 3, 1).abilities).toEqual([AURA, A, B, null, C]);
    });

    test('does not mutate the input', () => {
        const input = slots();
        moveAbilitySlot(input, 1, 1);
        expect(input).toEqual(slots());
    });

    test('top and bottom limits', () => {
        expect(moveAbilitySlot(slots(), 1, -1)).toMatchObject({ moved: false, reason: 'limit' });
        expect(moveAbilitySlot([AURA, A, B, C, ab('/abilities/d')], 4, 1)).toMatchObject({
            moved: false,
            reason: 'limit',
        });
    });

    test('the special slot never moves and nothing moves into it', () => {
        expect(moveAbilitySlot(slots(), 0, 1)).toMatchObject({ moved: false, reason: 'special' });
        expect(moveAbilitySlot(slots(), 0, -1)).toMatchObject({ moved: false, reason: 'special' });
        expect(moveAbilitySlot(slots(), 1, -1).abilities[0]).toBe(AURA);
    });

    test('an empty slot has nothing to move', () => {
        expect(moveAbilitySlot(slots(), 4, -1)).toMatchObject({ moved: false, reason: 'empty' });
    });

    test('a locked slot is neither entered nor left', () => {
        const unlocked = [true, true, true, false, false];
        expect(moveAbilitySlot(slots(), 2, 1, unlocked)).toMatchObject({ moved: false, reason: 'locked' });
        expect(moveAbilitySlot(slots(), 3, -1, unlocked)).toMatchObject({ moved: false, reason: 'locked' });
        expect(moveAbilitySlot(slots(), 1, 1, unlocked).moved).toBe(true);
    });

    test('bad input is refused', () => {
        expect(moveAbilitySlot(slots(), 1, 2).reason).toBe('invalid');
        expect(moveAbilitySlot(slots(), 1.5, 1).reason).toBe('invalid');
        expect(moveAbilitySlot(null, 1, 1).reason).toBe('empty');
    });
});

describe('abilitySlotUnlocks', () => {
    test('reads the game list by slot number', () => {
        const data = { abilitySlotsLevelRequirementList: [0, 1, 20, 50, 90, 120] };
        expect(abilitySlotUnlocks({ intelligenceLevel: 50 }, data)).toEqual([true, true, true, false, false]);
    });
});
