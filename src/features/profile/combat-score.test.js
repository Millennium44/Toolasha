/**
 * @vitest-environment happy-dom
 *
 * The trigger-condition formatters: turning `{dependencyHrid, conditionHrid,
 * comparatorHrid, value}` into the sentence a player reads on the panel.
 * Pinned here because a renamed HRID or a swapped operand silently reads as
 * a different rule than the one actually configured.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: {
        onSettingChange: () => {},
        getSetting: () => false,
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_ACCENT: '#5b8def',
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: {} }));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => null, setJSON: async () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('./score-calculator.js', () => ({ calculateCombatScore: () => ({}) }));
vi.mock('../combat/combat-sim-export.js', () => ({ constructExportObject: () => ({}) }));
vi.mock('../combat/milkonomy-export.js', () => ({ constructMilkonomyExport: () => ({}) }));
vi.mock('./character-card-button.js', () => ({
    handleViewCardClick: () => {},
    handleViewCardFromSnapshot: () => {},
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, clearAll: () => {} }),
}));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../combat-sim/combat-sim-ui.js', () => ({ default: {} }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({ buildPlayerDTOFromProfile: () => ({}) }));
vi.mock('../../utils/enhancement-worker-manager.js', () => ({ terminateWorkerPool: () => {} }));

const combatScore = (await import('./combat-score.js')).default;

describe('formatDependency', () => {
    test('known dependencies read as short labels', () => {
        expect(combatScore.formatDependency('/combat_trigger_dependencies/self')).toBe('Self');
        expect(combatScore.formatDependency('/combat_trigger_dependencies/targeted_enemy')).toBe('Target');
        expect(combatScore.formatDependency('/combat_trigger_dependencies/all_enemies')).toBe('All Enemies');
        expect(combatScore.formatDependency('/combat_trigger_dependencies/all_allies')).toBe('All Allies');
    });

    test('an unknown dependency falls back to a de-slugged tail', () => {
        expect(combatScore.formatDependency('/combat_trigger_dependencies/random_ally')).toBe('random ally');
    });
});

describe('formatCondition', () => {
    test('known conditions read as short labels', () => {
        expect(combatScore.formatCondition('/combat_trigger_conditions/current_hp')).toBe('HP');
        expect(combatScore.formatCondition('/combat_trigger_conditions/missing_hp')).toBe('Missing HP');
        expect(combatScore.formatCondition('/combat_trigger_conditions/current_mp')).toBe('MP');
    });

    test('an unknown condition is title-cased from its hrid tail', () => {
        expect(combatScore.formatCondition('/combat_trigger_conditions/enemy_count')).toBe('Enemy Count');
    });
});

describe('formatComparator', () => {
    test('known comparators map to their symbol or phrase', () => {
        expect(combatScore.formatComparator('/combat_trigger_comparators/greater_than_equal')).toBe('≥');
        expect(combatScore.formatComparator('/combat_trigger_comparators/less_than_equal')).toBe('≤');
        expect(combatScore.formatComparator('/combat_trigger_comparators/greater_than')).toBe('>');
        expect(combatScore.formatComparator('/combat_trigger_comparators/less_than')).toBe('<');
        expect(combatScore.formatComparator('/combat_trigger_comparators/equal')).toBe('=');
        expect(combatScore.formatComparator('/combat_trigger_comparators/is_active')).toBe('is active');
        expect(combatScore.formatComparator('/combat_trigger_comparators/is_inactive')).toBe('is inactive');
    });

    test('an unknown comparator falls back to its de-slugged tail', () => {
        expect(combatScore.formatComparator('/combat_trigger_comparators/roughly_equal')).toBe('roughly equal');
    });
});

describe('formatTriggerCondition', () => {
    test('a value comparator reads as dependency: condition comparator value', () => {
        const text = combatScore.formatTriggerCondition({
            dependencyHrid: '/combat_trigger_dependencies/self',
            conditionHrid: '/combat_trigger_conditions/current_hp',
            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
            value: 50,
        });

        expect(text).toBe('Self: HP ≤ 50');
    });

    test('is_active/is_inactive never appends a trailing value', () => {
        const text = combatScore.formatTriggerCondition({
            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
            conditionHrid: '/combat_trigger_conditions/current_hp',
            comparatorHrid: '/combat_trigger_comparators/is_active',
            value: 999,
        });

        expect(text).toBe('Target: HP is active');
        expect(text).not.toContain('999');
    });
});

describe('formatTriggers', () => {
    test('no conditions reads as "No trigger", not an empty string', () => {
        expect(combatScore.formatTriggers([])).toBe('No trigger');
        expect(combatScore.formatTriggers(null)).toBe('No trigger');
        expect(combatScore.formatTriggers(undefined)).toBe('No trigger');
    });

    test('multiple conditions are joined with AND, in the given order', () => {
        const text = combatScore.formatTriggers([
            {
                dependencyHrid: '/combat_trigger_dependencies/self',
                conditionHrid: '/combat_trigger_conditions/current_hp',
                comparatorHrid: '/combat_trigger_comparators/less_than',
                value: 30,
            },
            {
                dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                conditionHrid: '/combat_trigger_conditions/current_mp',
                comparatorHrid: '/combat_trigger_comparators/greater_than',
                value: 10,
            },
        ]);

        expect(text).toBe('Self: HP < 30 AND Target: MP > 10');
    });
});

describe('getAbilitiesSpriteUrl / getItemsSpriteUrl', () => {
    test('null when no matching sprite sheet is on the page', () => {
        document.body.innerHTML = '';
        expect(combatScore.getAbilitiesSpriteUrl()).toBeNull();
        expect(combatScore.getItemsSpriteUrl()).toBeNull();
    });

    test('reads the sheet path (without the fragment) from the use element', () => {
        document.body.innerHTML = `
            <svg><use href="/sprites/abilities_sprite.svg?v=3#fireball"></use></svg>
            <svg><use href="/sprites/items_sprite.svg?v=3#bronze_bar"></use></svg>
        `;

        expect(combatScore.getAbilitiesSpriteUrl()).toBe('/sprites/abilities_sprite.svg?v=3');
        expect(combatScore.getItemsSpriteUrl()).toBe('/sprites/items_sprite.svg?v=3');
    });
});

describe('buildAbilitiesTriggersHTML', () => {
    test('empty when the profile has no abilities and no triggers at all', () => {
        document.body.innerHTML = '';
        expect(combatScore.buildAbilitiesTriggersHTML({ profile: {} })).toBe('');
    });

    test('an ability with no configured trigger reads as "No trigger"', () => {
        document.body.innerHTML = `<svg><use href="/sprites/abilities_sprite.svg#fireball"></use></svg>`;

        const html = combatScore.buildAbilitiesTriggersHTML({
            profile: { equippedAbilities: [{ abilityHrid: '/abilities/fireball' }] },
        });

        expect(html).toContain('No trigger');
        expect(html).toContain('#fireball');
    });

    test('an ability with a configured trigger renders the formatted condition', () => {
        document.body.innerHTML = `<svg><use href="/sprites/abilities_sprite.svg#fireball"></use></svg>`;

        const html = combatScore.buildAbilitiesTriggersHTML({
            profile: {
                equippedAbilities: [{ abilityHrid: '/abilities/fireball' }],
                abilityCombatTriggersMap: {
                    '/abilities/fireball': [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
                            value: 50,
                        },
                    ],
                },
            },
        });

        expect(html).toContain('Target: HP ≤ 50');
    });

    test('without the abilities sprite on the page, abilities are skipped even if present', () => {
        document.body.innerHTML = '';

        const html = combatScore.buildAbilitiesTriggersHTML({
            profile: { equippedAbilities: [{ abilityHrid: '/abilities/fireball' }] },
        });

        expect(html).not.toContain('fireball');
    });

    test('a "Food & Drinks" heading only appears when abilities are also present', () => {
        document.body.innerHTML = `
            <svg><use href="/sprites/abilities_sprite.svg#fireball"></use></svg>
            <svg><use href="/sprites/items_sprite.svg#tea"></use></svg>
        `;

        const html = combatScore.buildAbilitiesTriggersHTML({
            profile: {
                equippedAbilities: [{ abilityHrid: '/abilities/fireball' }],
                consumableTriggers: {},
                consumableCombatTriggersMap: { '/items/tea': [] },
            },
        });

        expect(html).toContain('Food & Drinks');

        const withoutAbilities = combatScore.buildAbilitiesTriggersHTML({
            profile: { consumableCombatTriggersMap: { '/items/tea': [] } },
        });

        expect(withoutAbilities).not.toContain('Food & Drinks');
    });
});
