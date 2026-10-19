import { describe, test, expect, afterEach } from 'vitest';
import Consumable from './consumable.js';
import { setGameData } from './game-data.js';

describe('Consumable default triggers', () => {
    afterEach(() => setGameData(null));

    test('a consumable with no default combat triggers is built with none, not a failed sim', () => {
        setGameData({
            itemDetailMap: {
                '/items/wisdom_tea': {
                    categoryHrid: '/item_categories/drink',
                    consumableDetail: { cooldownDuration: 300, buffs: [], defaultCombatTriggers: null },
                },
            },
        });
        const tea = new Consumable('/items/wisdom_tea');
        expect(tea.triggers).toEqual([]);
    });
});
