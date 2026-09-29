import { describe, test, expect } from 'vitest';
import { MARKET_TAX, COWBELL_BAG_TAX } from './profit-constants.js';

describe('market tax constants', () => {
    test('the market tax is 4% since the September 2026 market patch', () => {
        expect(MARKET_TAX).toBe(0.04);
    });

    test('the cowbell bag tax is 18%', () => {
        expect(COWBELL_BAG_TAX).toBe(0.18);
    });
});
