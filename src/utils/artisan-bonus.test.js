import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ drinks: [], bonus: 0, throws: false }));

vi.mock('../core/data-manager.js', () => ({ default: { getInitClientData: () => ({ itemDetailMap: {} }) } }));
vi.mock('./action-context.js', () => ({
    resolveActionContext: () => {
        if (state.throws) throw new Error('no data');
        return { equipment: new Map(), drinks: state.drinks };
    },
}));
vi.mock('./tea-parser.js', () => ({
    getDrinkConcentration: () => 0,
    parseArtisanBonus: (drinks) => (drinks.length ? state.bonus : 0),
}));

const { getArtisanBonus } = await import('./artisan-bonus.js');

beforeEach(() => {
    state.drinks = [];
    state.bonus = 0;
    state.throws = false;
});

describe('getArtisanBonus', () => {
    test('no Artisan tea is 0, so the cost factor is 1', () => {
        expect(getArtisanBonus('/action_types/cooking')).toBe(0);
    });

    test('an active Artisan tea returns its bonus', () => {
        state.drinks = [{ itemHrid: '/items/artisan_tea' }];
        state.bonus = 0.112;
        expect(getArtisanBonus('/action_types/cooking')).toBe(0.112);
    });

    test('unreadable data is no reduction, not a thrown error', () => {
        state.throws = true;
        expect(getArtisanBonus('/action_types/cooking')).toBe(0);
    });
});
