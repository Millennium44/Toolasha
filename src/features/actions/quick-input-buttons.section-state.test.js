/**
 * A scroll change redraws an action panel's speed and level sections, which are rebuilt closed.
 * The sections the player had expanded must open again, the way the profit redraw keeps its own.
 *
 * Same mock set as `quick-input-buttons.remount.test.js`.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, register: () => () => {} },
}));

const game = vi.hoisted(() => ({
    itemDetails: {},
    inventory: [],
    equipment: new Map(),
    skills: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: (_hrid) => null,
        getItemDetails: (hrid) => game.itemDetails[hrid] ?? null,
        getInventory: () => game.inventory,
        getInitClientData: () => ({ itemDetailMap: game.itemDetails }),
        getActionDrinkSlots: () => [],
        getSkills: () => game.skills,
        getEquipment: () => game.equipment,
        getPersonalBuffFlatBoost: () => 0,
        isTaskAction: () => false,
        isBuffBeingSimulated: () => false,
        getCommunityBuffLevel: () => 0,
        setScrollSimulation: () => {},
        clearScrollSimulation: () => {},
        characterData: {},
        on: () => () => {},
        off: () => {},
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: { get: vi.fn(async () => false), set: vi.fn() },
}));

/** Which settings this suite exercises; every other key defaults to off. */
const settings = vi.hoisted(() => ({
    actionPanel_totalTime_quickInputs: false,
    actionPanel_showSpeedTime: false,
    actionPanel_showLevelProgress: false,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings[key] ?? false,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => () => {},
        onSettingsLoaded: () => () => {},
        COLOR_TOOLTIP_INFO: '#abc',
        COLOR_TEXT_PRIMARY: '#fff',
        COLOR_TEXT_SECONDARY: '#888',
        COLOR_INFO: '#09f',
    },
}));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({
        actionTime: 10,
        totalEfficiency: 0,
        efficiencyBreakdown: {
            levelEfficiency: 0,
            houseEfficiency: 0,
            equipmentEfficiency: 0,
            teaEfficiency: 0,
            teaBreakdown: [],
            communityEfficiency: 0,
            achievementEfficiency: 0,
            skillLevel: 1,
            baseRequirement: 1,
            actionLevelBonus: 0,
            actionLevelBreakdown: [],
            effectiveRequirement: 1,
        },
    }),
}));

vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalMultiplier: 1 }),
}));
vi.mock('../combat/scroll-simulator.js', () => ({
    default: { getScrollSetForActionType: () => new Set() },
}));

const { openSectionTitles, reopenSections } = await import('./quick-input-buttons.js');
const { createCollapsibleSection } = await import('../../utils/ui-components.js');

/** A panel with the two sections the speed and level injection draws */
function panelWithSections() {
    const panel = document.createElement('div');
    for (const title of ['Action Speed & Time', 'Level Progress']) {
        const content = document.createElement('div');
        content.textContent = title + ' figures';
        panel.appendChild(createCollapsibleSection('', title, null, content, false, 0));
    }
    document.body.appendChild(panel);
    return panel;
}

const header = (panel, title) =>
    [...panel.querySelectorAll('.mwi-section-header')].find((h) => h.textContent.includes(title));

describe('section open state across a scroll redraw', () => {
    test('an expanded section opens again after the panel is rebuilt', () => {
        const before = panelWithSections();
        header(before, 'Level Progress').click();
        const open = openSectionTitles(before);
        before.remove();

        // The rebuild draws fresh, closed sections
        const after = panelWithSections();
        reopenSections(after, open);

        const isOpen = (title) =>
            header(after, title).parentElement.querySelector(':scope > .mwi-section-content').style.display === 'block';
        expect(isOpen('Level Progress')).toBe(true);
        expect(isOpen('Action Speed & Time')).toBe(false);
        after.remove();
    });

    test('with nothing expanded, nothing is opened', () => {
        const panel = panelWithSections();
        reopenSections(panel, openSectionTitles(panel));

        expect([...panel.querySelectorAll('.mwi-section-content')].every((c) => c.style.display !== 'block')).toBe(
            true
        );
        panel.remove();
    });
});
