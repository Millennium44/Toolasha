/**
 * `actionPanel_totalTime_quickInputs` ("Quick Input Buttons"), `actionPanel_showSpeedTime` and
 * `actionPanel_showLevelProgress` used to share one gate: the registry started this whole module
 * only off `actionPanel_totalTime_quickInputs`, so turning that off silently killed the Speed &
 * Time / Level Progress sections too, even with their own settings still on. The registry now
 * starts the module when any of the three is on, and `injectButtons` builds/inserts the button
 * rows only under their own setting, independently of the other two sections.
 *
 * Mirrors the mock set `quick-input-buttons.unlimited-time.test.js` uses to drive the real
 * `injectButtons` against a real (mocked-data) action.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

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

describe('quick input buttons, speed/time and level progress are gated independently', () => {
    test('quick inputs off + speed on: speed section inserted, button rows not', () => {
        settings.actionPanel_showSpeedTime = true;
        const { panel, nameEl } = buildPanel('Log');

        quickInputButtons.injectButtons(panel, context(panel, nameEl, CHOP_LOG, logDetails()));

        expect(panel.querySelector('.mwi-collapsible-section')).not.toBeNull();
        expect(panel.querySelector('.mwi-quick-input-btn')).toBeNull();
    });

    test('quick inputs on + speed and level progress off: button rows inserted, no speed section', () => {
        settings.actionPanel_totalTime_quickInputs = true;
        const { panel, nameEl } = buildPanel('Log');

        quickInputButtons.injectButtons(panel, context(panel, nameEl, CHOP_LOG, logDetails()));

        expect(panel.querySelector('.mwi-quick-input-btn')).not.toBeNull();
        expect(panel.querySelector('.mwi-collapsible-section')).toBeNull();
    });

    test('all three off: neither buttons nor speed section are inserted', () => {
        const { panel, nameEl } = buildPanel('Log');

        quickInputButtons.injectButtons(panel, context(panel, nameEl, CHOP_LOG, logDetails()));

        expect(panel.querySelector('.mwi-quick-input-btn')).toBeNull();
        expect(panel.querySelector('.mwi-collapsible-section')).toBeNull();
    });
});
