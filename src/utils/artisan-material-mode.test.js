import { describe, test, expect, vi } from 'vitest';

vi.mock('../core/config.js', () => ({ default: { getSettingValue: (key, fallback) => fallback } }));

const { artisanInputTotal, ARTISAN_MATERIAL_MODE } = await import('./artisan-material-mode.js');

describe('artisanInputTotal', () => {
    test('an exact whole-unit total is not rounded up by floating-point residue', () => {
        // 3 × 0.8 × 100 evaluates to 240.00000000000003
        expect(artisanInputTotal(3, 0.2, 100, ARTISAN_MATERIAL_MODE.EXPECTED)).toBe(240);
        // 5 × 0.88 × 100 evaluates to 440.00000000000006
        expect(artisanInputTotal(5, 0.12, 100, ARTISAN_MATERIAL_MODE.EXPECTED)).toBe(440);
    });

    test('a genuine fraction is still rounded up', () => {
        expect(artisanInputTotal(4, 0.1, 1, ARTISAN_MATERIAL_MODE.EXPECTED)).toBe(4);
        expect(artisanInputTotal(4, 0.1, 3, ARTISAN_MATERIAL_MODE.EXPECTED)).toBe(11); // 10.8
    });

    test('worst case bills every craft its rounded-up count', () => {
        expect(artisanInputTotal(4, 0.1, 10, ARTISAN_MATERIAL_MODE.WORST_CASE)).toBe(40);
        expect(artisanInputTotal(10, 0.1, 10, ARTISAN_MATERIAL_MODE.WORST_CASE)).toBe(90);
    });
});
