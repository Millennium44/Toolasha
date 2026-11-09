import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ skills: [], items: {}, actions: {}, drinks: [], equipment: new Map() }));
vi.mock('../core/data-manager.js', () => ({
    default: {
        getSkills: () => state.skills,
        getInitClientData: () => ({ itemDetailMap: state.items, actionDetailMap: state.actions }),
    },
}));
vi.mock('./action-context.js', () => ({
    resolveActionContext: () => ({ equipment: state.equipment, drinks: state.drinks }),
}));
import { actionStartEligibility, craftPlanEligibility, craftStartContext } from './craft-start-eligibility.js';

const recipe = {
    name: 'Cheese sword',
    type: '/action_types/cheesesmithing',
    levelRequirement: { skillHrid: '/skills/cheesesmithing', level: 60 },
};
beforeEach(() => {
    state.skills = [{ skillHrid: '/skills/cheesesmithing', level: 65 }];
    state.equipment = new Map();
    state.drinks = [{ itemHrid: '/items/artisan_tea' }];
    state.items = {
        '/items/artisan_tea': { consumableDetail: { buffs: [{ typeHrid: '/buff_types/action_level', flatBoost: 6 }] } },
        '/items/ultra_cheesesmithing_tea': {
            name: 'Ultra Cheesesmithing Tea',
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/cheesesmithing_level', flatBoost: 8 }] },
        },
        '/items/pouch': { equipmentDetail: { combatStats: { drinkSlots: 2 } } },
    };
    state.actions = { '/actions/sword': recipe };
});

describe('recipe startability', () => {
    test('separates Artisan action levels from skill levels and accepts the exact boundary', () => {
        expect(actionStartEligibility(recipe)).toMatchObject({
            status: 'blocked',
            skillLevel: 65,
            level: 60,
            actionLevelBonus: 6,
        });
        state.skills[0].level = 66;
        expect(actionStartEligibility(recipe).status).toBe('available');
    });
    test('does not invent skill or tea data', () => {
        state.skills = [];
        expect(actionStartEligibility(recipe).status).toBe('unknown');
        state.skills = [{ skillHrid: '/skills/cheesesmithing', level: 65 }];
        delete state.items['/items/artisan_tea'];
        expect(actionStartEligibility(recipe).status).toBe('unknown');
        state.skills = {};
        expect(actionStartEligibility(recipe).status).toBe('unknown');
    });
    test('models removing Artisan without mutating the selected drinks', () => {
        expect(actionStartEligibility(recipe, 'no-artisan').status).toBe('available');
        expect(state.drinks).toEqual([{ itemHrid: '/items/artisan_tea' }]);
    });
    test('offers Ultra only with slot capacity and replaces the existing skill tea', () => {
        expect(actionStartEligibility(recipe, 'ultra').status).toBe('unknown');
        state.equipment.set('/item_locations/pouch', { itemHrid: '/items/pouch' });
        expect(actionStartEligibility(recipe, 'ultra')).toMatchObject({
            status: 'available',
            requiredTea: '/items/ultra_cheesesmithing_tea',
        });
        state.drinks = [{ itemHrid: '/items/cheesesmithing_tea' }];
        state.equipment.clear();
        expect(craftStartContext(recipe.type, 'ultra').drinks).toEqual([
            { itemHrid: '/items/ultra_cheesesmithing_tea' },
        ]);
    });
    test('does not demand Ultra for an intermediate already available with no free slots', () => {
        state.skills[0].level = 66;
        expect(actionStartEligibility(recipe, 'ultra')).toMatchObject({ status: 'available', requiredTea: null });
    });
    test('checks every chosen craft, but not recipes under purchased intermediates', () => {
        state.actions['/actions/root'] = {
            ...recipe,
            levelRequirement: { skillHrid: '/skills/cheesesmithing', level: 1 },
        };
        const child = { strategy: 'craft', actionHrid: '/actions/sword', children: [] };
        const plan = { strategy: 'craft', actionHrid: '/actions/root', children: [child, child, child] };
        expect(craftPlanEligibility(plan)).toMatchObject({ status: 'blocked', requirements: expect.any(Array) });
        expect(craftPlanEligibility(plan).message.match(/Cheese sword/g)).toHaveLength(1);
        plan.children = [{ strategy: 'buy', children: [child] }];
        expect(craftPlanEligibility(plan).status).toBe('available');
    });
    test('a known blocked intermediate wins over another unknown requirement', () => {
        expect(
            craftPlanEligibility({
                strategy: 'craft',
                actionHrid: '/actions/missing',
                children: [{ strategy: 'craft', actionHrid: '/actions/sword' }],
            }).status
        ).toBe('blocked');
    });
});

test('fractional drink concentration uses the game floor/truncation boundary for both bonuses', () => {
    state.items['/items/pouch'].equipmentDetail.noncombatStats = { drinkConcentration: 0.125 };
    state.equipment.set('/item_locations/pouch', { itemHrid: '/items/pouch', enhancementLevel: 0 });
    state.drinks.push({ itemHrid: '/items/ultra_cheesesmithing_tea' });
    state.skills[0].level = 57;
    expect(actionStartEligibility(recipe)).toMatchObject({
        status: 'available',
        teaSkillLevelBonus: 9,
        actionLevelBonus: 6.75,
    });
    state.skills[0].level = 56;
    expect(actionStartEligibility(recipe).status).toBe('blocked');
});

test('missing equipment metadata cannot silently change drink concentration to zero', () => {
    state.equipment.set('/item_locations/pouch', { itemHrid: '/items/unknown_pouch' });
    expect(actionStartEligibility(recipe).status).toBe('unknown');
});
