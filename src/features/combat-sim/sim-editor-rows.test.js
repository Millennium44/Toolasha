/** @vitest-environment happy-dom
 *
 * The editor's list rows run the full panel width with a gap in the middle, so
 * alternate rows are striped, and the level boxes have to be wide enough to
 * show the whole number.
 */

import { describe, test, expect, vi } from 'vitest';

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

function render(html) {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
}

describe('editor list rows', () => {
    const editor = new SimEditor({ editorEl: document.createElement('div') });

    test('equipment rows alternate the stripe class and widen the enhancement box', () => {
        const dto = {
            equipment: {
                '/equipment_types/head': { hrid: '/items/a', enhancementLevel: 12 },
                '/equipment_types/body': { hrid: '/items/b', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/c', enhancementLevel: 3 },
            },
        };
        const host = render(editor._renderEquipmentSection(dto, { itemDetailMap: {} }));
        const rows = [...host.querySelectorAll('.mwi-csim-row')].filter((r) => r.querySelector('[data-enhance-slot]'));
        expect(rows.length).toBe(3);
        expect(rows.map((r) => r.classList.contains('mwi-csim-row-alt'))).toEqual([false, true, false]);
        const input = host.querySelector('[data-enhance-slot]');
        expect(parseFloat(input.style.width)).toBeGreaterThanOrEqual(3.5);
        expect(input.style.width.endsWith('em')).toBe(true);
    });

    test('ability and consumable rows are striped and the ability level fits three digits', () => {
        const dto = {
            abilities: [null, { hrid: '/abilities/x', level: 100 }, { hrid: '/abilities/y', level: 78 }],
            food: [null, null, null],
            drinks: [null, null, null],
        };
        const abilities = render(editor._renderAbilitiesSection(dto, { abilityDetailMap: {} }));
        const rows = abilities.querySelectorAll('.mwi-csim-row');
        expect(rows.length).toBe(5);
        expect(rows[1].classList.contains('mwi-csim-row-alt')).toBe(true);
        expect(rows[0].classList.contains('mwi-csim-row-alt')).toBe(false);
        expect(parseFloat(abilities.querySelector('[data-ability-idx]').style.width)).toBeGreaterThanOrEqual(4);

        const consumables = render(editor._renderConsumablesSection(dto, { itemDetailMap: {} }));
        expect(consumables.querySelectorAll('.mwi-csim-row').length).toBe(6);
        expect(consumables.querySelectorAll('.mwi-csim-row-alt').length).toBe(2);
    });
});
