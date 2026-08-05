/**
 * Tests for Buff Parser Utilities
 */
import { describe, test, expect, vi } from 'vitest';

const character = vi.hoisted(() => ({ characterData: null }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return character.characterData;
        },
    },
}));

const { getAlchemySuccessBonus } = await import('./buff-parser.js');

describe('getAlchemySuccessBonus', () => {
    test('returns 0 when there is no character data', () => {
        character.characterData = null;
        expect(getAlchemySuccessBonus()).toBe(0);
    });

    test('returns 0 when the alchemy action type has no buffs map entry', () => {
        character.characterData = { consumableActionTypeBuffsMap: {} };
        expect(getAlchemySuccessBonus()).toBe(0);
    });

    test('returns 0 when alchemy buffs is not an array', () => {
        character.characterData = {
            consumableActionTypeBuffsMap: { '/action_types/alchemy': null },
        };
        expect(getAlchemySuccessBonus()).toBe(0);
    });

    test('sums only alchemy_success buffs, ignoring others', () => {
        character.characterData = {
            consumableActionTypeBuffsMap: {
                '/action_types/alchemy': [
                    { typeHrid: '/buff_types/alchemy_success', ratioBoost: 0.05 },
                    { typeHrid: '/buff_types/alchemy_success', ratioBoost: 0.037 },
                    { typeHrid: '/buff_types/efficiency', ratioBoost: 0.5 },
                ],
            },
        };
        expect(getAlchemySuccessBonus()).toBeCloseTo(0.087, 9);
    });

    test('treats a missing ratioBoost as zero rather than throwing', () => {
        character.characterData = {
            consumableActionTypeBuffsMap: {
                '/action_types/alchemy': [{ typeHrid: '/buff_types/alchemy_success' }],
            },
        };
        expect(getAlchemySuccessBonus()).toBe(0);
    });
});
