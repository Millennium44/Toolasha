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
import { getEnhancementMultiplier, enhancementBonusAt } from './enhancement-multipliers.js';
import { sweepProtectFrom } from './enhancement-protect-sweep.js';
import { calculateCumulativeCost } from './house-cost-calculator.js';

const CHARM = { equipmentDetail: { type: '/equipment_types/charm' } };
const BODY = { equipmentDetail: { type: '/equipment_types/body' } };

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
            enhancementLevelTotalBonusMultiplierTable: [0, ...Array.from({ length: 24 }, (_, i) => (i + 1) / 20)],
        };
        expect(enhancementBonusAt(21)).toBe(1.05);
        expect(getEnhancementMultiplier(CHARM, 21)).toBeCloseTo(1 + 1.05 * 5, 10);
        expect(getEnhancementMultiplier(BODY, 24)).toBeCloseTo(2.2, 10);
        // A level the table lacks, or junk, falls back to the constant table
        state.clientData = { enhancementLevelTotalBonusMultiplierTable: [0, 'x', null] };
        expect(enhancementBonusAt(1)).toBe(0.02);
        expect(enhancementBonusAt(2)).toBe(0.042);
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
