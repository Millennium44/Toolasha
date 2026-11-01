/** @vitest-environment happy-dom */

import { describe, test, expect } from 'vitest';
import { upgradeLevelForPanel } from './upgrade-slot.js';

const UPGRADE = '/items/crimson_staff';

const panelWith = (inner) => {
    const panel = document.createElement('div');
    panel.innerHTML = inner;
    return panel;
};
const slot = (icon) => `<div class="SkillActionDetail_upgradeItemSelectorInput__q">${icon}</div>`;
const icon = (sprite, badge = '') =>
    `<svg><use href="/static/media/items_sprite.abc.svg#${sprite}"></use></svg>${badge}`;

describe('upgradeLevelForPanel', () => {
    test('a slot showing the upgrade item at +3 answers 3', () => {
        const panel = panelWith(slot(icon('crimson_staff', '<div class="Item_enhancementLevel__x">+3</div>')));
        expect(upgradeLevelForPanel(panel, UPGRADE)).toBe(3);
    });

    test('an unenhanced stack answers 0', () => {
        expect(upgradeLevelForPanel(panelWith(slot(icon('crimson_staff'))), UPGRADE)).toBe(0);
    });

    test('an empty slot answers null, which holds nothing', () => {
        expect(upgradeLevelForPanel(panelWith(slot('<div>Select item</div>')), UPGRADE)).toBeNull();
    });

    test('no slot on the panel, no upgrade item, or another item in the slot answer 0', () => {
        expect(upgradeLevelForPanel(panelWith(''), UPGRADE)).toBe(0);
        expect(upgradeLevelForPanel(panelWith(slot(icon('crimson_staff'))), undefined)).toBe(0);
        expect(upgradeLevelForPanel(panelWith(slot(icon('azure_staff'))), UPGRADE)).toBe(0);
    });
});
