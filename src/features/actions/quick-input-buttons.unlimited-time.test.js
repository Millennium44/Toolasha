/**
 * The general action panel's "Action Speed & Time" section used to print `Total time: ∞` for a
 * Repeat of ∞ even though the very same panel's "Profitability" section, right below it, already
 * knew the materials-bounded count (it prints `mat: N`). This drives `injectButtons` — the real
 * function that builds the section — against a real (mocked-data) action, rather than asserting
 * on a helper in isolation, so a regression in the wiring itself would fail here.
 *
 * The mock set mirrors `unlimited-action-estimate.test.js`'s: it drives the same real
 * `action-time-display.js` calculator, so it needs the same dependencies stubbed out.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, register: () => () => {} },
}));

const game = vi.hoisted(() => ({
    currentActions: [],
    actionDetails: {},
    itemDetails: {},
    inventory: [],
    equipment: new Map(),
    skills: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.currentActions,
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getItemDetails: (hrid) => game.itemDetails[hrid] ?? null,
        getInventory: () => game.inventory,
        getInitClientData: () => ({ itemDetailMap: game.itemDetails }),
        getActionDrinkSlots: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
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

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        getPricingModeDisplayLabel: (mode) => `label:${mode}`,
        onSettingChange: () => () => {},
        onSettingsLoaded: () => () => {},
        COLOR_TOOLTIP_INFO: '#abc',
        COLOR_TEXT_PRIMARY: '#fff',
        COLOR_TEXT_SECONDARY: '#888',
        COLOR_INFO: '#09f',
    },
}));

// A flat 10s per action with no efficiency keeps every expected time a round number, the same
// stub `unlimited-action-estimate.test.js` uses for the same reason.
const ACTION_TIME = 10;
vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({
        actionTime: ACTION_TIME,
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

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));
vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        calculate: async () => null,
        calculateCoinifyProfit: () => null,
        calculateDecomposeProfit: () => null,
        calculateTransmuteProfit: () => null,
    },
}));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => null }));
vi.mock('../alchemy/alchemy-profit.js', () => ({
    default: {
        getCurrentActionHrid: () => null,
        getStateFingerprint: () => 'fp',
        extractDrops: async () => [],
        extractRequirements: async () => [],
    },
}));
vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalMultiplier: 1 }),
}));
vi.mock('../combat/scroll-simulator.js', () => ({
    default: { getScrollSetForActionType: () => new Set() },
}));

const { clearUnlimitedEstimateCache } = await import('./unlimited-action-estimate.js');
const quickInputButtons = (await import('./quick-input-buttons.js')).default;

const LOG = '/items/log';
const PLANK = '/items/plank';
const CRAFT_PLANK = '/actions/crafting/plank';
const CHOP_LOG = '/actions/woodcutting/log';

/** Inventory rows in the one location the estimate's inventory lookup counts */
function stack(itemHrid, count) {
    return { itemHrid, count, enhancementLevel: 0, itemLocationHrid: '/item_locations/inventory' };
}

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
    // Not type="number": happy-dom (like the browser) rejects a non-numeric value on one,
    // and the panel's own input accepts '∞' the same way the alchemy Repeat field does.
    const input = document.createElement('input');
    inputContainer.appendChild(input);

    document.body.appendChild(panel);
    return { panel, nameEl, input };
}

function context(panel, nameEl, actionHrid, actionDetails) {
    return { panel, nameElement: nameEl, actionName: nameEl.textContent, actionHrid, actionDetails };
}

function totalTimeLine(panel) {
    return [...panel.querySelectorAll('div')].find((el) => el.textContent.startsWith('Total time:')) ?? null;
}

beforeEach(() => {
    document.body.innerHTML = '';
    clearUnlimitedEstimateCache();
    game.itemDetails = {
        [LOG]: { itemHrid: LOG, name: 'Log', itemLevel: 1 },
        [PLANK]: { itemHrid: PLANK, name: 'Plank', itemLevel: 1 },
    };
    game.actionDetails = {
        [CRAFT_PLANK]: {
            hrid: CRAFT_PLANK,
            name: 'Plank',
            type: '/action_types/crafting',
            coinCost: 0,
            inputItems: [{ itemHrid: LOG, count: 2 }],
            outputItems: [{ itemHrid: PLANK, count: 1 }],
        },
        [CHOP_LOG]: {
            hrid: CHOP_LOG,
            name: 'Log',
            type: '/action_types/woodcutting',
            coinCost: 0,
            inputItems: [],
            outputItems: [{ itemHrid: LOG, count: 1 }],
        },
    };
    game.inventory = [stack(LOG, 80)];
    game.currentActions = [];
    game.equipment = new Map();
    game.skills = [];
});

afterEach(() => {
    quickInputButtons.disable();
    clearUnlimitedEstimateCache();
});

describe('the general action panel draws the bounded time', () => {
    test('Repeat ∞ shows the materials-bounded time instead of ∞', () => {
        const { panel, nameEl, input } = buildPanel('Plank');
        input.value = '∞';
        const details = {
            hrid: CRAFT_PLANK,
            name: 'Plank',
            type: '/action_types/crafting',
            coinCost: 0,
            inputItems: [{ itemHrid: LOG, count: 2 }],
            outputItems: [{ itemHrid: PLANK, count: 1 }],
            experienceGain: { skillHrid: '/skills/crafting', value: 10 },
        };

        quickInputButtons.injectButtons(panel, context(panel, nameEl, CRAFT_PLANK, details));

        // 80 logs at 2 per plank pays for 40 crafts, 10s each — the same bound the queue row
        // and the Profitability line ("mat: 40") would show for this action.
        expect(totalTimeLine(panel).textContent).toBe('Total time: 0h 06m 40s · mat: 40');
    });

    test('a truly unbounded action still reads ∞', () => {
        const { panel, nameEl, input } = buildPanel('Log');
        input.value = '∞';
        const details = {
            hrid: CHOP_LOG,
            name: 'Log',
            type: '/action_types/woodcutting',
            coinCost: 0,
            inputItems: [],
            outputItems: [{ itemHrid: LOG, count: 1 }],
            experienceGain: { skillHrid: '/skills/woodcutting', value: 10 },
        };

        quickInputButtons.injectButtons(panel, context(panel, nameEl, CHOP_LOG, details));

        expect(totalTimeLine(panel).textContent).toBe('Total time: ∞');
    });

    test('a finite Repeat is unchanged', () => {
        const { panel, nameEl, input } = buildPanel('Plank');
        input.value = '100';
        const details = {
            hrid: CRAFT_PLANK,
            name: 'Plank',
            type: '/action_types/crafting',
            coinCost: 0,
            inputItems: [{ itemHrid: LOG, count: 2 }],
            outputItems: [{ itemHrid: PLANK, count: 1 }],
            experienceGain: { skillHrid: '/skills/crafting', value: 10 },
        };

        quickInputButtons.injectButtons(panel, context(panel, nameEl, CRAFT_PLANK, details));

        expect(totalTimeLine(panel).textContent).toBe('Total time: 0h 16m 40s');
        expect(totalTimeLine(panel).textContent).not.toContain('mat:');
    });
});
