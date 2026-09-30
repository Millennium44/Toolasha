/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const calc = vi.hoisted(() => ({ materials: [] }));

vi.mock('../../core/config.js', () => ({ default: { COLOR_LOSS: 'red', COLOR_PROFIT: 'green' } }));
vi.mock('../../utils/material-calculator.js', () => ({
    calculateMaterialRequirements: () => calc.materials,
    isArtisanTeaOutOfStock: () => false,
}));
vi.mock('../../utils/action-panel-helper.js', () => ({
    findActionInput: vi.fn(),
    attachInputListeners: vi.fn(),
    performInitialUpdate: vi.fn(),
    onActionPanelsRefresh: vi.fn(),
    onDetailPanel: vi.fn(),
    resolveDetailPanel: () => ({ actionHrid: '/actions/crafting/furious_spear' }),
}));

const { default: requiredMaterials } = await import('./required-materials.js');

function buildPanel() {
    document.body.innerHTML = `
        <div class="SkillActionDetail_skillActionDetail__x">
            <div class="SkillActionDetail_itemRequirements__x">
                <span class="SkillActionDetail_inputCount__x">1</span>
                <div class="Item_item__x"></div>
            </div>
            <div class="SkillActionDetail_upgradeItemSelectorInput__x"></div>
        </div>`;
    return document.querySelector('[class*="SkillActionDetail_skillActionDetail"]');
}

describe('required materials line', () => {
    beforeEach(() => {
        calc.materials = [
            { isUpgradeItem: false, required: 25949100, queued: 10200, missing: 24858000 },
            { isUpgradeItem: true, required: 86497, queued: 34, missing: 82860 },
        ];
    });

    test('wraps instead of forcing the panel wider', () => {
        // nowrap makes the line's min-content width the whole string, so the flex/grid item holding it refuses to
        // shrink and the panel scrolls sideways.
        const panel = buildPanel();
        requiredMaterials.updateRequiredMaterials(panel, '10');

        const lines = panel.querySelectorAll('.mwi-required-materials');
        expect(lines).toHaveLength(2);
        for (const line of lines) {
            expect(line.style.whiteSpace).toBe('normal');
            expect(line.style.overflowWrap).toBe('anywhere');
            expect(line.style.minWidth).toBe('0');
            expect(line.textContent).toContain('Missing:');
        }
        expect(panel.querySelector('.Item_item__x').style.minWidth).toBe('0');
    });
});
