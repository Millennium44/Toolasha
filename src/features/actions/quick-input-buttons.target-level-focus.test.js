/**
 * The Target Level Calculator fills the queue quantity as its level steps, and must do so without
 * moving focus: Chrome stops a held spinner arrow's hold-to-repeat the moment the held input loses
 * focus, so a fill that focused the quantity input limited the arrows to one step per press.
 *
 * Mock set shared with `quick-input-buttons.decouple.test.js`.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, register: () => () => {} },
}));

const LEVEL_XP = vi.hoisted(() => Array.from({ length: 201 }, (_, i) => i * i * 100));

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
        getInitClientData: () => ({ itemDetailMap: game.itemDetails, levelExperienceTable: LEVEL_XP }),
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

const quickInputButtons = (await import('./quick-input-buttons.js')).default;

const LOG = '/items/log';
const CHOP_LOG = '/actions/woodcutting/log';

/** A panel shaped the way the game's action detail panel is: a name and a Repeat input. */
function buildPanel(actionName) {
    const panel = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.textContent = actionName;
    panel.appendChild(nameEl);

    // injectButtons walks up three parents from the input to find the container to insert after
    const grandparent = document.createElement('div');
    const parent = document.createElement('div');
    const inputContainer = document.createElement('div');
    inputContainer.className = 'maxActionCountInput_wrapper';
    parent.appendChild(inputContainer);
    grandparent.appendChild(parent);
    panel.appendChild(grandparent);
    const input = document.createElement('input');
    inputContainer.appendChild(input);

    document.body.appendChild(panel);
    return { panel, nameEl, input };
}

function context(panel, nameEl, actionHrid, actionDetails) {
    return { panel, nameElement: nameEl, actionName: nameEl.textContent, actionHrid, actionDetails };
}

beforeEach(() => {
    document.body.innerHTML = '';
    game.itemDetails = { [LOG]: { itemHrid: LOG, name: 'Log', itemLevel: 1 } };
    game.inventory = [];
    game.equipment = new Map();
    game.skills = [{ skillHrid: '/skills/woodcutting', level: 5, experience: 0 }];
    settings.actionPanel_totalTime_quickInputs = false;
    settings.actionPanel_showSpeedTime = false;
    settings.actionPanel_showLevelProgress = false;
});

afterEach(() => {
    quickInputButtons.disable();
});

function logDetails() {
    return {
        hrid: CHOP_LOG,
        name: 'Log',
        type: '/action_types/woodcutting',
        baseTimeCost: 10e9,
        coinCost: 0,
        inputItems: [],
        outputItems: [{ itemHrid: LOG, count: 1 }],
        experienceGain: { skillHrid: '/skills/woodcutting', value: 10 },
    };
}

describe('target level calculator', () => {
    test('stepping the target level fills the quantity and keeps focus on the target input', () => {
        settings.actionPanel_showLevelProgress = true;
        const { panel, nameEl, input } = buildPanel('Log');

        quickInputButtons.injectButtons(panel, context(panel, nameEl, CHOP_LOG, logDetails()));

        const target = panel.querySelector('#mwi-target-level-input');
        expect(target).not.toBeNull();
        target.focus();
        target.value = '8';
        target.dispatchEvent(new Event('input', { bubbles: true }));

        expect(Number(input.value)).toBeGreaterThan(0);
        expect(document.activeElement).toBe(target);
    });
});
