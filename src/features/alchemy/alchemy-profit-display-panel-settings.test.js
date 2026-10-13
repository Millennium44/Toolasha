/** @vitest-environment happy-dom */

/**
 * The Alchemy panel follows the shared action-panel switches for Action Speed & Time and Level
 * Progress, and the Level Progress target level fills the Repeat box (on user edits only).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ initClientData: null, skills: [] }));
const settings = vi.hoisted(() => ({}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key in settings ? settings[key] : true),
        getSettingValue: (key, def) => (key === 'profitCalc_pricingMode' ? 'optimistic' : def),
        getPricingModeDisplayLabel: (mode) => `label:${mode}`,
        onSettingChange: () => () => {},
        onSettingsLoaded: () => () => {},
        COLOR_TEXT_PRIMARY: '#fff',
        COLOR_TEXT_SECONDARY: '#888',
        COLOR_INFO: '#09f',
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, register: () => () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getSkills: () => game.skills,
        getItemDetails: (hrid) => game.initClientData?.itemDetailMap?.[hrid] || null,
        on: () => {},
        off: () => {},
    },
}));
vi.mock('./alchemy-profit.js', () => ({
    default: {
        getCurrentActionHrid: () => null,
        getStateFingerprint: () => 'fp',
        extractDrops: async () => [],
        extractRequirements: async () => [],
    },
}));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: {} }));
vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalMultiplier: 1 }),
}));

const { default: display } = await import('./alchemy-profit-display.js');

const ITEM = '/items/test_item';

const profitData = () => ({
    profitPerHour: 0,
    profitPerDay: 0,
    revenuePerHour: 0,
    materialCostPerHour: 0,
    catalystCostPerHour: 0,
    totalTeaCostPerHour: 0,
    actionsPerHour: 180,
    actionTime: 20,
    efficiency: 0,
    efficiencyBreakdown: {},
    successRate: 1,
    dropRevenues: [],
    requirementCosts: [],
    catalystCost: { itemHrid: null, price: 0, costPerAttempt: 0, costPerHour: 0 },
    consumableCosts: [],
    pricingMode: 'hybrid',
});

/** @returns {{container: HTMLElement, repeat: HTMLInputElement}} */
function mountPanel() {
    const comp = document.createElement('div');
    comp.className = 'SkillActionDetail_alchemyComponent__x';
    const max = document.createElement('div');
    max.className = 'maxActionCountInput__y';
    const repeat = document.createElement('input');
    repeat.value = '';
    max.appendChild(repeat);
    comp.appendChild(max);
    const container = document.createElement('div');
    comp.appendChild(container);
    document.body.appendChild(comp);
    return { container, repeat };
}

beforeEach(() => {
    for (const k of Object.keys(settings)) delete settings[k];
    game.initClientData = {
        itemDetailMap: { [ITEM]: { itemLevel: 10 } },
        levelExperienceTable: { 1: 0, 2: 100, 3: 300, 4: 600, 5: 1000 },
    };
    game.skills = [{ skillHrid: '/skills/alchemy', level: 1, experience: 0 }];
    display._alchemyTargetLevel = undefined;
});

afterEach(() => {
    vi.restoreAllMocks();
    display.sectionExpanded.clear();
    display.removeSpeedTimeInputListeners();
    display.removeProfitSummaryInputListeners();
    display.cachedInputField = null;
    display.displayElement = null;
    document.body.innerHTML = '';
});

describe('Alchemy panel honors the action-panel section settings', () => {
    test('both sections draw by default', () => {
        const { container } = mountPanel();
        display.createDisplay(container, profitData(), 'coinify', ITEM, 0);
        expect(document.getElementById('mwi-alchemy-speed-time')).not.toBeNull();
        expect(document.getElementById('mwi-alchemy-level-progress')).not.toBeNull();
    });

    test('actionPanel_showSpeedTime=false hides only Action Speed & Time', () => {
        settings.actionPanel_showSpeedTime = false;
        const { container } = mountPanel();
        display.createDisplay(container, profitData(), 'coinify', ITEM, 0);
        expect(document.getElementById('mwi-alchemy-speed-time')).toBeNull();
        expect(document.getElementById('mwi-alchemy-level-progress')).not.toBeNull();
        expect(document.getElementById('mwi-alchemy-profit')).not.toBeNull();
    });

    test('actionPanel_showLevelProgress=false hides only Level Progress', () => {
        settings.actionPanel_showLevelProgress = false;
        const { container } = mountPanel();
        display.createDisplay(container, profitData(), 'coinify', ITEM, 0);
        expect(document.getElementById('mwi-alchemy-level-progress')).toBeNull();
        expect(document.getElementById('mwi-alchemy-speed-time')).not.toBeNull();
        expect(document.getElementById('mwi-alchemy-profit')).not.toBeNull();
    });

    test('with both hidden the Profitability section still anchors the display (no rebuild every check)', () => {
        settings.actionPanel_showSpeedTime = false;
        settings.actionPanel_showLevelProgress = false;
        const { container } = mountPanel();
        display.createDisplay(container, profitData(), 'coinify', ITEM, 0);
        expect(display.displayElement?.parentNode).toBe(container);
    });
});
