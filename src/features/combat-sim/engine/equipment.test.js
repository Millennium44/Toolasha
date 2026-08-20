// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * Reading a combat stat off a piece of equipment.
 *
 * The interesting case is the one the old truthy check dropped: an item whose
 * base value for a stat is exactly 0 but whose enhancement bonus is not. That
 * shape is real — enhancing is what switches some stats on — and it read as
 * "this item has no such stat", so every point the enhancement granted was
 * silently thrown away.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const gameData = vi.hoisted(() => ({ current: null }));

vi.mock('./game-data.js', () => ({
    getGameData: () => gameData.current,
}));

const { default: Equipment } = await import('./equipment.js');

/** Multiplier table where +5 doubles the enhancement bonus. */
const MULTIPLIERS = [0, 0.2, 0.4, 0.6, 0.8, 2];

function setItem(combatStats, combatEnhancementBonuses) {
    gameData.current = {
        enhancementLevelTotalBonusMultiplierTable: MULTIPLIERS,
        itemDetailMap: {
            '/items/test_item': {
                equipmentDetail: { combatStats, combatEnhancementBonuses },
            },
        },
    };
}

describe('getCombatStat', () => {
    beforeEach(() => {
        gameData.current = null;
    });

    test('a base of exactly zero still gets its enhancement bonus', () => {
        setItem({ criticalRate: 0 }, { criticalRate: 0.01 });
        const equipment = new Equipment('/items/test_item', 5);

        expect(equipment.getCombatStat('criticalRate')).toBeCloseTo(0.02);
    });

    test('an absent base with an enhancement bonus counts too', () => {
        setItem({}, { taskDamage: 0.05 });
        const equipment = new Equipment('/items/test_item', 5);

        expect(equipment.getCombatStat('taskDamage')).toBeCloseTo(0.1);
    });

    test('base and bonus add as before', () => {
        setItem({ armor: 10 }, { armor: 2 });
        const equipment = new Equipment('/items/test_item', 5);

        expect(equipment.getCombatStat('armor')).toBeCloseTo(14);
    });

    test('a stat the item does not have is still zero', () => {
        setItem({ armor: 10 }, { armor: 2 });
        const equipment = new Equipment('/items/test_item', 5);

        expect(equipment.getCombatStat('lifeSteal')).toBe(0);
    });

    test('no enhancement bonuses at all is not a crash', () => {
        setItem({ armor: 10 }, undefined);
        const equipment = new Equipment('/items/test_item', 5);

        expect(equipment.getCombatStat('armor')).toBe(10);
    });

    test('an unenhanced item takes no multiplier', () => {
        setItem({ armor: 10 }, { armor: 2 });
        const equipment = new Equipment('/items/test_item', 0);

        expect(equipment.getCombatStat('armor')).toBe(10);
    });
});
