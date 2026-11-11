/** @vitest-environment happy-dom
 *
 * A trigger row that can never be true is marked: on the ability's trigger button, and on the row inside
 * the trigger editor (which also updates as the value is edited).
 */

import { describe, test, expect, vi, afterEach } from 'vitest';

vi.mock('../../core/data-manager.js', () => ({
    default: {
        characterData: null,
        getCurrentCharacterId: () => 'me',
        getInitClientData: () => ({ itemDetailMap: {}, abilityDetailMap: {} }),
        getItemDetails: () => null,
        getHouseRooms: () => null,
        getPartyMembers: () => ({ members: [], source: 'none', updatedAt: null }),
    },
}));

const { SimEditor } = await import('./sim-editor.js');

const ALLIES = '/combat_trigger_dependencies/all_allies';
const LOWEST = '/combat_trigger_conditions/lowest_hp_percentage';
const GTE = '/combat_trigger_comparators/greater_than_equal';
const LTE = '/combat_trigger_comparators/less_than_equal';
const QUICK_AID = '/abilities/quick_aid';

const gameData = {
    abilityDetailMap: { [QUICK_AID]: { name: 'Quick Aid', defaultCombatTriggers: [] } },
    itemDetailMap: {},
    combatTriggerDependencyDetailMap: { [ALLIES]: { name: "Allies' Total", isSingleTarget: false, sortIndex: 1 } },
    combatTriggerConditionDetailMap: {
        [LOWEST]: { name: 'Lowest HP %', isSingleTarget: false, allowedComparatorHrids: [GTE, LTE], sortIndex: 1 },
    },
    combatTriggerComparatorDetailMap: {
        [GTE]: { name: 'Greater than or equal', sortIndex: 1 },
        [LTE]: { name: 'Less than or equal', sortIndex: 2 },
    },
};

const row = (comparatorHrid, value) => ({
    dependencyHrid: ALLIES,
    conditionHrid: LOWEST,
    comparatorHrid,
    value,
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('trigger button', () => {
    const editor = new SimEditor({ editorEl: document.createElement('div') });
    const button = (triggers) => {
        const host = document.createElement('div');
        host.innerHTML = editor._renderTriggerButton('abilities', 0, { hrid: QUICK_AID, triggers }, gameData);
        return host.querySelector('button');
    };

    test('shows a warning mark and says why when a row can never be true', () => {
        const b = button([row(GTE, 350)]);
        expect(b.dataset.triggerBlocked).toBe('1');
        expect(b.textContent).toBe('⚠');
        expect(b.title).toContain('can never be true');
    });

    test('keeps the ordinary mark for a row that can fire', () => {
        const b = button([row(LTE, 50)]);
        expect(b.dataset.triggerBlocked).toBe('0');
        expect(b.textContent).toBe('⚡');
    });
});

describe('trigger editor rows', () => {
    test('a row that can never be true carries a visible warning that clears when the value is fixed', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });
        const dto = { abilities: [{ hrid: QUICK_AID, triggers: [row(GTE, 350)] }], food: [], drinks: [] };
        editor._openTriggerEditor('abilities', 0, dto, gameData);

        const warn = () => document.querySelector('[data-trig-warn="0"]');
        expect(warn().style.display).not.toBe('none');
        expect(warn().textContent).toContain('never');

        const input = document.querySelector('[data-trig-value="0"]');
        input.value = '100';
        input.dispatchEvent(new Event('change'));
        expect(warn().style.display).toBe('none');

        input.value = '350';
        input.dispatchEvent(new Event('change'));
        expect(warn().style.display).not.toBe('none');
    });

    test('a healthy row has its warning hidden', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });
        const dto = { abilities: [{ hrid: QUICK_AID, triggers: [row(LTE, 50)] }], food: [], drinks: [] };
        editor._openTriggerEditor('abilities', 0, dto, gameData);
        expect(document.querySelector('[data-trig-warn="0"]').style.display).toBe('none');
    });
});
