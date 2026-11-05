import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ clientData: null }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => state.clientData,
        getCurrentCharacterId: () => 'c1',
    },
}));

import { ENHANCEMENT_SOLVER_MAX_LEVEL } from './game-maximums.js';
import { SOLVER_MAX_LEVEL, calculateEnhancement } from './enhancement-calculator.js';
import { ENHANCEMENT_BONUSES, getEnhancementMultiplier, enhancementBonusAt } from './enhancement-multipliers.js';
import { parseEquipmentEfficiencyBonuses } from './equipment-parser.js';
import { sweepProtectFrom } from './enhancement-protect-sweep.js';
import { calculateCumulativeCost } from './house-cost-calculator.js';

const CHARM = { equipmentDetail: { type: '/equipment_types/charm' } };
const BODY = { equipmentDetail: { type: '/equipment_types/body' } };

/** `enhancementLevelTotalBonusMultiplierTable` as the game sent it on 2026-11-05 */
const GAME_TABLE = [
    0, 1, 2.1, 3.3, 4.6, 6, 7.5, 9.1, 10.8, 12.6, 14.5, 16.7, 19.2, 22, 25.1, 28.5, 32.2, 36.2, 40.5, 45.1, 50,
];

beforeEach(() => {
    state.clientData = null;
});

describe('the solver ceiling', () => {
    test('the mirror in game-maximums matches the calculator, and the solver refuses above it', () => {
        expect(ENHANCEMENT_SOLVER_MAX_LEVEL).toBe(SOLVER_MAX_LEVEL);
        expect(() => calculateEnhancement({ enhancingLevel: 100, itemLevel: 100, targetLevel: 21 })).toThrow(
            /between 1 and 20/
        );
    });

    test('a protect sweep above the ceiling prices nothing instead of throwing or pricing +20', () => {
        const chain = { enhancingLevel: 100, itemLevel: 100 };
        const above = sweepProtectFrom({ chain, targetLevel: SOLVER_MAX_LEVEL + 1 });
        expect(above.rows).toEqual([]);
        const at = sweepProtectFrom({ chain, targetLevel: SOLVER_MAX_LEVEL });
        expect(at.rows.length).toBeGreaterThan(0);
    });
});

describe('the enhancement multiplier follows the game table', () => {
    test('today: the constant table, and a raised table gives a real bonus above +20', () => {
        expect(enhancementBonusAt(20)).toBe(1.0);
        expect(getEnhancementMultiplier(CHARM, 20)).toBe(6);
        expect(getEnhancementMultiplier(CHARM, 21)).toBe(1);

        state.clientData = {
            enhancementLevelTotalBonusMultiplierTable: [...GAME_TABLE, 55, 56, 57, 60],
        };
        expect(enhancementBonusAt(21)).toBeCloseTo(1.1, 10);
        expect(getEnhancementMultiplier(CHARM, 21)).toBeCloseTo(1 + 1.1 * 5, 10);
        expect(getEnhancementMultiplier(BODY, 24)).toBeCloseTo(2.2, 10);
        // A level the table lacks, or junk, falls back to the constant table
        state.clientData = { enhancementLevelTotalBonusMultiplierTable: [0, 'x', null] };
        expect(enhancementBonusAt(1)).toBe(0.02);
        expect(enhancementBonusAt(2)).toBe(0.042);
    });

    test('the game table is in steps of 2%, not fractions: every level agrees with the constant table', () => {
        state.clientData = { enhancementLevelTotalBonusMultiplierTable: GAME_TABLE };
        for (let level = 1; level <= 20; level += 1) {
            expect(enhancementBonusAt(level)).toBeCloseTo(ENHANCEMENT_BONUSES[level], 10);
        }
        expect(getEnhancementMultiplier(BODY, 10)).toBeCloseTo(1.29, 10);
        expect(getEnhancementMultiplier(CHARM, 10)).toBeCloseTo(2.45, 10);
    });

    test('a +10 top with the real table matches what the game adds: base + table * bonus', () => {
        state.clientData = { enhancementLevelTotalBonusMultiplierTable: GAME_TABLE };
        const itemDetailMap = {
            '/items/foragers_top': {
                equipmentDetail: {
                    type: '/equipment_types/body',
                    noncombatStats: { foragingEfficiency: 0.1 },
                    noncombatEnhancementBonuses: { foragingEfficiency: 0.002 },
                },
            },
        };
        const equipment = new Map([
            ['/item_locations/body', { itemHrid: '/items/foragers_top', enhancementLevel: 10 }],
        ]);
        expect(parseEquipmentEfficiencyBonuses(equipment, '/action_types/foraging', itemDetailMap)).toBeCloseTo(
            (0.1 + 14.5 * 0.002) * 100,
            8
        );
    });
});

describe('house cumulative cost follows the room cap', () => {
    test('refuses above the cap, and a raised ladder is allowed through', async () => {
        await expect(calculateCumulativeCost('/house_rooms/dojo', 7, 9)).rejects.toThrow(/Maximum house level is 8/);
        state.clientData = {
            houseRoomDetailMap: { '/house_rooms/dojo': { upgradeCostsMap: { 8: [], 9: [] } } },
        };
        await expect(calculateCumulativeCost('/house_rooms/dojo', 7, 9)).resolves.toBeDefined();
    });
});
