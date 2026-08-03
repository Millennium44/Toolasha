/** @vitest-environment happy-dom
 *
 * Simulating a fight with the Critical Aura on.
 *
 * A labyrinth fight is short and often decided by a crit, so the aura worn
 * outside is not always the one worth wearing inside — and swapping gear to
 * find out is a lot of clicking for a question the simulator can answer.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: [], equipment: new Map(), details: {} }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_k, d) => d, setSetting: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap: game.details }),
        get characterItems() {
            return game.items;
        },
        get characterEquipment() {
            return game.equipment;
        },
        characterData: null,
    },
}));

const { ownedCriticalAura, withCriticalAura } = await import('./lab-sim-ui.js');

const TRINKET = '/equipment_types/trinket';

beforeEach(() => {
    game.details = {
        '/items/critical_aura': { name: 'Critical Aura', equipmentDetail: { type: TRINKET } },
        '/items/fierce_aura': { name: 'Fierce Aura', equipmentDetail: { type: TRINKET } },
        '/items/critical_pendant': { name: 'Critical Pendant', equipmentDetail: { type: '/equipment_types/neck' } },
    };
    game.items = [];
    game.equipment = new Map();
});

describe('finding the aura you own', () => {
    test('one in the inventory counts', () => {
        game.items = [{ itemHrid: '/items/critical_aura', count: 1, enhancementLevel: 4 }];

        expect(ownedCriticalAura()).toEqual({ hrid: '/items/critical_aura', enhancementLevel: 4 });
    });

    test('and one already being worn, since that is the likeliest person to want this', () => {
        game.equipment = new Map([[TRINKET, { itemHrid: '/items/critical_aura', enhancementLevel: 7 }]]);

        expect(ownedCriticalAura().enhancementLevel).toBe(7);
    });

    test('the best level wins, because that is the one you would put on', () => {
        game.items = [
            { itemHrid: '/items/critical_aura', count: 1, enhancementLevel: 2 },
            { itemHrid: '/items/critical_aura', count: 1, enhancementLevel: 9 },
        ];

        expect(ownedCriticalAura().enhancementLevel).toBe(9);
    });

    test('a different aura is not it', () => {
        game.items = [{ itemHrid: '/items/fierce_aura', count: 1, enhancementLevel: 5 }];

        expect(ownedCriticalAura()).toBeNull();
    });

    test('nor is something else with "critical" in its name', () => {
        // Matched on the slot as well as the name, so a Critical Pendant is not
        // mistaken for an aura
        game.items = [{ itemHrid: '/items/critical_pendant', count: 1, enhancementLevel: 3 }];

        expect(ownedCriticalAura()).toBeNull();
    });

    test('owning none is null rather than a guess', () => {
        expect(ownedCriticalAura()).toBeNull();
    });

    test('a stack you have none of is not owned', () => {
        game.items = [{ itemHrid: '/items/critical_aura', count: 0, enhancementLevel: 4 }];

        expect(ownedCriticalAura()).toBeNull();
    });
});

describe('putting it on for the simulation', () => {
    const dto = () => ({
        hrid: '/players/me',
        equipment: {
            [TRINKET]: { hrid: '/items/speed_aura', enhancementLevel: 3 },
            '/equipment_types/head': { hrid: '/items/hat', enhancementLevel: 1 },
        },
    });
    const aura = { hrid: '/items/critical_aura', enhancementLevel: 6 };

    test('the trinket is replaced and nothing else is', () => {
        const swapped = withCriticalAura(dto(), aura);

        expect(swapped.equipment[TRINKET]).toEqual(aura);
        expect(swapped.equipment['/equipment_types/head'].hrid).toBe('/items/hat');
    });

    test('an empty trinket slot is filled rather than left', () => {
        const bare = { hrid: '/players/me', equipment: {} };

        expect(withCriticalAura(bare, aura).equipment[TRINKET]).toEqual(aura);
    });

    test('the character the panel is showing is left alone', () => {
        // The editor hands out the DTOs it is still displaying, so a swap made
        // for one simulation must not become gear the panel claims you wear
        const original = dto();
        withCriticalAura(original, aura);

        expect(original.equipment[TRINKET].hrid).toBe('/items/speed_aura');
    });

    test('owning none changes nothing at all', () => {
        const original = dto();

        expect(withCriticalAura(original, null)).toBe(original);
    });
});
