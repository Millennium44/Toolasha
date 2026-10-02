/**
 * Every opening of an action panel used to register the Speed & Time section's input
 * observer and listeners (and a timeout per click on the panel) into the module-wide cleanup
 * registry, released only when the feature was disabled. Their closures hold the panel, so a
 * session pinned one detached copy of the panel per opening. Each panel's wiring is now
 * released when it is injected again or found detached at the next injection.
 *
 * Same mock set as `quick-input-buttons.decouple.test.js`.
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

const { getCleanupRegistryCensus } = await import('../../utils/cleanup-registry.js');

function held() {
    const census = getCleanupRegistryCensus();
    return census.listeners + census.observers + census.timeouts + census.cleanups;
}

function openPanel(actionName = 'Log') {
    const { panel, nameEl, input } = buildPanel(actionName);
    quickInputButtons.injectButtons(panel, context(panel, nameEl, CHOP_LOG, logDetails()));
    return { panel, nameEl, input };
}

describe('quick input buttons release a panel when it remounts', () => {
    beforeEach(() => {
        settings.actionPanel_totalTime_quickInputs = true;
        settings.actionPanel_showSpeedTime = true;
        settings.actionPanel_showLevelProgress = true;
    });

    test('reopening the panel many times holds one panel worth of registrations', () => {
        const baseline = held();
        openPanel();
        const perPanel = held() - baseline;
        expect(perPanel).toBeGreaterThan(0);

        for (let i = 0; i < 10; i++) {
            document.body.innerHTML = '';
            openPanel();
        }

        expect(held() - baseline).toBe(perPanel);
    });

    test('switching the action on a reused panel releases the previous action wiring', () => {
        const baseline = held();
        const { panel, nameEl } = openPanel('Log');
        const perPanel = held() - baseline;

        for (let i = 0; i < 5; i++) {
            nameEl.textContent = i % 2 ? 'Log' : 'Log again';
            quickInputButtons.injectButtons(panel, context(panel, nameEl, CHOP_LOG, logDetails()));
        }

        expect(held() - baseline).toBe(perPanel);
        expect(panel.querySelectorAll('.mwi-collapsible-section').length).toBeGreaterThan(0);
    });

    test('clicks on the panel do not add a registration each', () => {
        const baseline = held();
        const { panel } = openPanel();
        const perPanel = held() - baseline;

        for (let i = 0; i < 20; i++) panel.click();

        expect(held() - baseline).toBe(perPanel);
    });

    test('the released input listeners no longer update the detached section', () => {
        const { input } = openPanel();
        const oldLine = [...document.querySelectorAll('.mwi-collapsible-section')]
            .map((section) => section.textContent)
            .join('');
        expect(oldLine).toContain('Total time');

        const detached = document.body.firstChild;
        document.body.innerHTML = '';
        openPanel();

        input.value = '5';
        input.dispatchEvent(new Event('input'));
        // The old panel's section was left as it was: its listener is gone
        expect(detached.textContent).not.toContain('Total time: 50');
    });

    test('disable releases everything', () => {
        const baseline = held();
        openPanel();
        quickInputButtons.disable();
        expect(held()).toBe(baseline);
    });
});
