/**
 * The general action panel's "Base: … → …s" and "Speed: +x%" lines left out the guild shrine's
 * action-speed buff, although the speed breakdown listed it and calculateActionStats applied it.
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
    characterData: {},
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
        get characterData() {
            return game.characterData;
        },
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
    readAlchemyTabType: () => null,
    readAlchemyPanelSelection: () => null,
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

const CHOP_LOG = '/actions/woodcutting/log';

function buildPanel() {
    const panel = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.textContent = 'Log';
    panel.appendChild(nameEl);
    const grandparent = document.createElement('div');
    const parent = document.createElement('div');
    const inputContainer = document.createElement('div');
    inputContainer.className = 'maxActionCountInput_wrapper';
    parent.appendChild(inputContainer);
    grandparent.appendChild(parent);
    panel.appendChild(grandparent);
    const input = document.createElement('input');
    input.value = '10';
    inputContainer.appendChild(input);
    document.body.appendChild(panel);
    return { panel, nameEl };
}

function render() {
    const { panel, nameEl } = buildPanel();
    const details = {
        hrid: CHOP_LOG,
        name: 'Log',
        type: '/action_types/woodcutting',
        baseTimeCost: 10e9,
        coinCost: 0,
        inputItems: [],
        outputItems: [{ itemHrid: '/items/log', count: 1 }],
        experienceGain: { skillHrid: '/skills/woodcutting', value: 10 },
    };
    quickInputButtons.injectButtons(panel, {
        panel,
        nameElement: nameEl,
        actionName: 'Log',
        actionHrid: CHOP_LOG,
        actionDetails: details,
    });
    return panel.textContent;
}

beforeEach(() => {
    document.body.innerHTML = '';
    clearUnlimitedEstimateCache();
    game.itemDetails = { '/items/log': { itemHrid: '/items/log', name: 'Log', itemLevel: 1 } };
    game.actionDetails = {};
    game.inventory = [];
    game.currentActions = [];
    game.equipment = new Map();
    game.skills = [];
    game.characterData = {};
});

afterEach(() => {
    quickInputButtons.disable();
    clearUnlimitedEstimateCache();
});

describe('quick-input speed total includes the guild shrine', () => {
    test('Base time and Speed line reflect a guild shrine action_speed buff', () => {
        game.characterData = {
            guildActionTypeBuffsMap: {
                '/action_types/woodcutting': [
                    { typeHrid: '/buff_types/action_speed', flatBoost: 0.1, ratioBoost: 0 },
                    { typeHrid: '/buff_types/action_speed', flatBoost: 0, ratioBoost: 0.15 },
                    { typeHrid: '/buff_types/wisdom', flatBoost: 0.5 },
                ],
                '/action_types/milking': [{ typeHrid: '/buff_types/action_speed', flatBoost: 0.9 }],
            },
        };

        const text = render();

        // 10s / 1.25 = 8s, 450/hr; the other action type's buff and the non-speed buff are ignored
        expect(text).toContain('Base: 10.00s → 8.00s');
        expect(text).toContain('Speed: +25.0% | 450/hr');
        expect(text).toContain('Guild Shrine: +25.0%');
    });

    test('no guild buff leaves the line unchanged', () => {
        const text = render();
        expect(text).toContain('Base: 10.00s → 10.00s');
        expect(text).not.toContain('Speed: +');
    });
});
