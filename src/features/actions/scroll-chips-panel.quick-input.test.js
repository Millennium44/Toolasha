/** @vitest-environment happy-dom */

/**
 * The chips row next to the real quick-input-buttons sections: a chip press goes through
 * quick-input-buttons' own `_onScrollSelectionChanged` (which removes and redraws its rows and
 * sections and sets the profit section aside), and the row must end up in the same place every time,
 * once, above the profit section and under Level Progress, without the two fighting or duplicating.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, register: () => () => {} },
}));

const game = vi.hoisted(() => ({
    actionDetails: {},
    itemDetails: {},
    panels: new WeakMap(),
    saved: {},
    settings: { scrollPlanner: false },
    personalBuffTypeDetailMap: {
        '/personal_buff_types/efficiency': {
            usableInActionTypeMap: { '/action_types/woodcutting': true },
            buff: { typeHrid: '/buff_types/efficiency', flatBoost: 0.14 },
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => [],
        getCurrentCharacterId: () => 'char1',
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getItemDetails: (hrid) => game.itemDetails[hrid] ?? null,
        getInventory: () => [],
        getInitClientData: () => ({
            itemDetailMap: game.itemDetails,
            personalBuffTypeDetailMap: game.personalBuffTypeDetailMap,
        }),
        getActionDrinkSlots: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        getSkills: () => [{ skillHrid: '/skills/woodcutting', level: 5, experience: 0 }],
        getEquipment: () => new Map(),
        getPersonalBuffFlatBoost: () => 0,
        isTaskAction: () => false,
        isBuffBeingSimulated: () => false,
        getCommunityBuffLevel: () => 0,
        setScrollSimulation: () => {},
        clearScrollSimulation: () => {},
        characterData: {},
        characterItems: [],
        on: () => () => {},
        off: () => {},
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(async () => false),
        set: vi.fn(),
        getJSON: async (key, store, fallback) => game.saved[key] ?? fallback,
        setJSON: async (key, value) => {
            game.saved[key] = value;
        },
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key in game.settings ? game.settings[key] : true),
        getSettingValue: (_key, fallback) => fallback,
        getPricingModeDisplayLabel: (mode) => `label:${mode}`,
        onSettingChange: () => () => {},
        onSettingsLoaded: () => () => {},
        COLOR_ACCENT: '#0ff',
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
vi.mock('../../utils/action-panel-helper.js', () => ({
    onDetailPanel: () => () => {},
    resolveDetailPanel: (panel) => {
        const nameElement = panel.querySelector('[class*="SkillActionDetail_name"]');
        const actionHrid = game.panels.get(panel) ?? null;
        return {
            panel,
            nameElement,
            actionName: nameElement?.textContent ?? '',
            actionHrid,
            actionDetails: actionHrid ? game.actionDetails[actionHrid] : null,
        };
    },
}));

const quickInputButtons = (await import('./quick-input-buttons.js')).default;
const scrollSimulator = (await import('../combat/scroll-simulator.js')).default;
const { default: chipsPanel } = await import('./scroll-chips-panel.js');

const CHOP_LOG = '/actions/woodcutting/log';
const SELECTION_EVENT = 'toolasha:scroll-selection-changed';
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

function buildPanel() {
    const panel = document.createElement('div');
    panel.className = 'SkillActionDetail_skillActionDetail__x';
    panel.innerHTML =
        '<div class="SkillActionDetail_name__x">Log</div>' +
        '<div><div><div class="maxActionCountInput_wrapper"><input></div></div></div>' +
        '<div class="SkillActionDetail_buttonsContainer__x"><button>Start</button></div>';
    document.body.appendChild(panel);
    game.panels.set(panel, CHOP_LOG);
    return panel;
}

/** What profit-display.js does: a collapsible section after the run of collapsible sections */
function addProfitSection(panel) {
    const profit = document.createElement('div');
    profit.className = 'mwi-collapsible-section';
    profit.setAttribute('data-mwi-profit-display', 'true');
    profit.id = 'mwi-foraging-profit';
    let point = panel.querySelector('.mwi-collapsible-section');
    while (
        point.nextElementSibling &&
        (point.nextElementSibling.className === 'mwi-collapsible-section' ||
            point.nextElementSibling.classList.contains('mwi-scroll-chips'))
    ) {
        point = point.nextElementSibling;
    }
    point.insertAdjacentElement('afterend', profit);
    return profit;
}

/** The panel's children, named by what they are */
function layout(panel) {
    return [...panel.children].map((el) => {
        if (el.matches('[data-mwi-profit-display]')) return 'profit';
        if (el.classList.contains('mwi-scroll-chips')) return 'chips';
        if (el.classList.contains('mwi-quick-input-rows')) return 'rows';
        if (el.classList.contains('mwi-collapsible-section')) return 'section';
        if (el.className.includes('buttonsContainer')) return 'buttons';
        if (el.className.includes('SkillActionDetail_name')) return 'name';
        return 'input';
    });
}

/** The block's order, whatever number of sections the speed and level figures draw (zero is a failure) */
const order = (panel) => layout(panel).join(' ');
const WITH_PROFIT = /^name input rows( section)+ chips profit buttons$/;

let onSelection;
beforeEach(() => {
    document.body.innerHTML = '';
    game.saved = {};
    game.itemDetails = { '/items/log': { itemHrid: '/items/log', name: 'Log', itemLevel: 1 } };
    game.actionDetails = {
        [CHOP_LOG]: {
            hrid: CHOP_LOG,
            name: 'Log',
            type: '/action_types/woodcutting',
            coinCost: 0,
            inputItems: [],
            outputItems: [{ itemHrid: '/items/log', count: 1 }],
            experienceGain: { skillHrid: '/skills/woodcutting', value: 10 },
        },
    };
    scrollSimulator.scrollsByLoadout = {};
    scrollSimulator.initialized = false;
    scrollSimulator.switchHandler = null;
    scrollSimulator.owner = null;
    // What startObserving() wires, without its panel scan
    onSelection = () => quickInputButtons._onScrollSelectionChanged();
    document.addEventListener(SELECTION_EVENT, onSelection);
});

afterEach(() => {
    document.removeEventListener(SELECTION_EVENT, onSelection);
    chipsPanel.cleanup();
    quickInputButtons.disable();
    document.body.innerHTML = '';
});

describe('the chips row with the real quick-input sections', () => {
    test('sits under Level Progress and above the profit section, in either order of arrival', async () => {
        await scrollSimulator.initialize();
        const panel = buildPanel();
        quickInputButtons.injectButtons(panel);
        addProfitSection(panel);
        chipsPanel.initialize();

        expect(order(panel)).toMatch(WITH_PROFIT);
    });

    test('the chips first, then the quick-input sections and the profit section, ends up the same', async () => {
        await scrollSimulator.initialize();
        const panel = buildPanel();
        chipsPanel.initialize();
        quickInputButtons.injectButtons(panel);
        addProfitSection(panel);

        await vi.waitFor(() => expect(order(panel)).toMatch(WITH_PROFIT));
    });

    test('a chip press redraws the quick-input rows and sections once each, with the row in place and not doubled', async () => {
        await scrollSimulator.initialize();
        const panel = buildPanel();
        quickInputButtons.injectButtons(panel);
        addProfitSection(panel);
        chipsPanel.initialize();

        panel.querySelector('button[data-buff="/buff_types/efficiency"]').click();
        await vi.waitFor(() =>
            expect(panel.querySelector('button[data-buff="/buff_types/efficiency"]')?.dataset.on).toBe('true')
        );
        await settle();

        expect(order(panel)).toMatch(WITH_PROFIT);
        expect(panel.querySelectorAll('.mwi-scroll-chips')).toHaveLength(1);
        expect(panel.querySelectorAll('.mwi-quick-input-rows')).toHaveLength(1);
        expect(scrollSimulator.getScrollsForLoadout(null)).toEqual(new Set(['/buff_types/efficiency']));

        // And again, off
        panel.querySelector('button[data-buff="/buff_types/efficiency"]').click();
        await vi.waitFor(() =>
            expect(panel.querySelector('button[data-buff="/buff_types/efficiency"]')?.dataset.on).toBe('false')
        );
        await settle();
        expect(order(panel)).toMatch(WITH_PROFIT);
    });

    test('a rows container with no buttons in it is still part of the block the row follows', async () => {
        await scrollSimulator.initialize();
        const panel = buildPanel();
        const empty = document.createElement('div');
        empty.className = 'mwi-quick-input-rows';
        panel
            .querySelector('[class*="maxActionCountInput"]')
            .parentNode.parentNode.insertAdjacentElement('afterend', empty);
        chipsPanel.initialize();

        expect(order(panel)).toBe('name input rows chips buttons');
    });
});
