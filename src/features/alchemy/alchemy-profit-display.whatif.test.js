/** @vitest-environment happy-dom */

/**
 * The catalyst what-if in the Alchemy Profitability section: which calculator
 * call it adds, what it publishes for the Missing Mats button, and what the
 * section says. The equipped figure is computed exactly as before; the what-if
 * figure replaces it in Profitability only.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ initClientData: null, skills: [], inventory: [] }));
const settings = vi.hoisted(() => ({}));
const panel = vi.hoisted(() => ({ actionHrid: null, requirements: [], fingerprint: 'fp', tabType: null }));
const calculator = vi.hoisted(() => ({
    coinify: vi.fn(),
    decompose: vi.fn(),
    transmute: vi.fn(),
    unrefine: vi.fn(),
}));

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
    default: { onClass: () => () => {}, register: () => () => {}, onReady: () => () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getSkills: () => game.skills,
        getInventory: () => game.inventory,
        getItemDetails: (hrid) => game.initClientData?.itemDetailMap?.[hrid] || null,
        on: () => {},
        off: () => {},
    },
}));
vi.mock('./alchemy-profit.js', () => ({
    readAlchemyTabType: () => panel.tabType,
    readAlchemyPanelSelection: () => null,
    default: {
        getCurrentActionHrid: () => panel.actionHrid,
        getStateFingerprint: () => panel.fingerprint,
        extractDrops: async () => [],
        extractRequirements: async () => panel.requirements,
    },
}));
vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        calculateCoinifyProfit: (...args) => calculator.coinify(...args),
        calculateDecomposeProfit: (...args) => calculator.decompose(...args),
        calculateTransmuteProfit: (...args) => calculator.transmute(...args),
        calculateUnrefineProfit: (...args) => calculator.unrefine(...args),
    },
}));
vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalMultiplier: 1 }),
}));

const { default: display } = await import('./alchemy-profit-display.js');
const whatIfState = await import('./alchemy-catalyst-whatif.js');

const EGG = '/items/egg';
const PRIME = '/items/prime_catalyst';
const DECOMP = '/items/catalyst_of_decomposition';

/** A full calculator result; `catalyst` is the slotted catalyst's hrid or null. */
const profitData = ({ profit = 1000, successRate = 0.6, catalyst = null } = {}) => ({
    profitPerHour: profit,
    profitPerDay: profit * 24,
    revenuePerHour: 0,
    materialCostPerHour: 0,
    catalystCostPerHour: 0,
    totalTeaCostPerHour: 0,
    actionsPerHour: 180,
    actionTime: 20,
    efficiency: 0,
    efficiencyBreakdown: {},
    successRate,
    dropRevenues: [],
    requirementCosts: [],
    catalystCost: { itemHrid: catalyst, price: 0, costPerAttempt: 0, costPerHour: 0 },
    consumableCosts: [],
    pricingMode: 'hybrid',
});

function selectTab(label) {
    document.body.insertAdjacentHTML(
        'beforeend',
        `<div class="AlchemyPanel_tabsComponentContainer__x1"><div role="tab" aria-selected="true">${label}</div></div>`
    );
}

/** The alchemy component with a Repeat box and an info container to draw into. */
function mountPanel() {
    const comp = document.createElement('div');
    comp.className = 'SkillActionDetail_alchemyComponent__x';
    const max = document.createElement('div');
    max.className = 'maxActionCountInput__y';
    const repeat = document.createElement('input');
    repeat.value = '10';
    max.appendChild(repeat);
    comp.appendChild(max);
    const container = document.createElement('div');
    comp.appendChild(container);
    document.body.appendChild(comp);
    return container;
}

const profitSection = () => document.getElementById('mwi-alchemy-profit');

beforeEach(() => {
    for (const k of Object.keys(settings)) delete settings[k];
    whatIfState.resetCatalystWhatIf();
    game.initClientData = {
        itemDetailMap: {
            [EGG]: { name: 'Egg', itemLevel: 10 },
            [PRIME]: { name: 'Prime Catalyst' },
            [DECOMP]: { name: 'Catalyst Of Decomposition' },
        },
        levelExperienceTable: { 1: 0, 2: 100 },
    };
    game.skills = [{ skillHrid: '/skills/alchemy', level: 1, experience: 0 }];
    game.inventory = [];
    panel.requirements = [{ itemHrid: EGG, enhancementLevel: 0 }];
    panel.fingerprint = 'fp';
    panel.tabType = null;
    for (const fn of Object.values(calculator)) fn.mockReset();
    calculator.decompose.mockImplementation((_item, _enh, _live, _tea, _ctx, choice) =>
        choice === 'prime' ? profitData({ profit: 5000, successRate: 0.75, catalyst: PRIME }) : profitData()
    );
    calculator.coinify.mockReturnValue(profitData());
    calculator.transmute.mockReturnValue(profitData());
    calculator.unrefine.mockReturnValue(profitData());
});

afterEach(() => {
    vi.restoreAllMocks();
    whatIfState.resetCatalystWhatIf();
    display.sectionExpanded.clear();
    display.removeSpeedTimeInputListeners();
    display.removeProfitSummaryInputListeners();
    display.cachedInputField = null;
    display.displayElement = null;
    document.body.innerHTML = '';
});

describe('the equipped catalyst', () => {
    test('is one calculator call with the arguments it always had, and nothing published', async () => {
        selectTab('Decompose');
        const container = mountPanel();
        await display.updateDisplay(container);

        expect(calculator.decompose).toHaveBeenCalledTimes(1);
        expect(calculator.decompose).toHaveBeenCalledWith(EGG, 0, true);
        expect(whatIfState.getCatalystWhatIfResult()).toBeNull();
        expect(profitSection().textContent).not.toContain('⚠ what-if');
        // The picker is there, Equipped pressed
        const equipped = profitSection().querySelector('[data-mwi-catalyst-choice="equipped"]');
        expect(equipped.getAttribute('aria-pressed')).toBe('true');
    });
});

describe('a localized client', () => {
    test('the tab position, not its label or the running action, picks the calculator', async () => {
        selectTab('点金'); // transmute selected on a Chinese strip
        panel.tabType = 'transmute';
        panel.actionHrid = '/actions/alchemy/coinify';
        whatIfState.setCatalystWhatIf('prime');
        const container = mountPanel();
        await display.updateDisplay(container);

        expect(calculator.coinify).not.toHaveBeenCalled();
        expect(calculator.transmute).toHaveBeenCalledWith(EGG, true, null, 'prime', null, 0);
        expect(whatIfState.getCatalystWhatIfResult()?.actionType).toBe('transmute');
    });
});

describe('a picked catalyst', () => {
    test('adds a forced-catalyst call, shows its figure marked what-if, and publishes it', async () => {
        selectTab('Decompose');
        whatIfState.setCatalystWhatIf('prime');
        const container = mountPanel();
        await display.updateDisplay(container);

        expect(calculator.decompose).toHaveBeenCalledWith(EGG, 0, true, null, null, 'prime');
        const header = profitSection().querySelector('.mwi-section-header').parentElement.textContent;
        expect(header).toContain('5.00K/hr');
        expect(header).toContain('⚠ what-if');
        expect(profitSection().querySelector('.mwi-alchemy-catalyst-whatif-note').textContent).toContain(
            'Prime Catalyst slotted'
        );
        // None in the bag: say so
        expect(profitSection().querySelector('.mwi-alchemy-catalyst-whatif-note').textContent).toContain(
            'You have no Prime Catalyst'
        );
        expect(whatIfState.getCatalystWhatIfResult()).toEqual({
            itemHrid: EGG,
            actionType: 'decompose',
            catalystHrid: PRIME,
            successRate: 0.75,
        });
    });

    test('the other sections keep the equipped figure', async () => {
        selectTab('Decompose');
        whatIfState.setCatalystWhatIf('prime');
        const speed = vi.spyOn(display, 'createActionSpeedTimeSection');
        const level = vi.spyOn(display, 'createLevelProgressSection');
        await display.updateDisplay(mountPanel());

        expect(speed.mock.calls[0][0].successRate).toBe(0.6);
        expect(speed.mock.calls[0][2].catalystHrid).toBeNull();
        expect(level.mock.calls[0][2].successRate).toBe(0.6);
    });

    test('Equipped goes back: the display redraws on the equipped figure and withdraws the result', async () => {
        selectTab('Decompose');
        display.isActive = true;
        whatIfState.setCatalystWhatIf('prime');
        const container = mountPanel();
        await display.updateDisplay(container);

        profitSection().querySelector('[data-mwi-catalyst-choice="equipped"]').click();
        expect(whatIfState.getCatalystWhatIf()).toBeNull();
        await display.updateDisplay(container);

        expect(profitSection().textContent).not.toContain('⚠ what-if');
        expect(whatIfState.getCatalystWhatIfResult()).toBeNull();
        display.isActive = false;
    });

    test('the choice is part of the fingerprint, so picking one forces a rebuild', () => {
        const before = display._fingerprint();
        whatIfState.setCatalystWhatIf('none');
        expect(display._fingerprint()).not.toBe(before);
    });

    test('picking the catalyst already slotted is no what-if', async () => {
        selectTab('Decompose');
        calculator.decompose.mockImplementation(() => profitData({ catalyst: PRIME }));
        whatIfState.setCatalystWhatIf('prime');
        await display.updateDisplay(mountPanel());

        expect(calculator.decompose).toHaveBeenCalledTimes(1);
        expect(profitSection().textContent).not.toContain('⚠ what-if');
        expect(whatIfState.getCatalystWhatIfResult()).toBeNull();
    });

    test('None on a slotted catalyst is a what-if with no catalyst, and publishes nothing to buy', async () => {
        selectTab('Decompose');
        calculator.decompose.mockImplementation((_i, _e, _l, _t, _c, choice) =>
            choice === 'none' ? profitData({ profit: 200 }) : profitData({ catalyst: DECOMP })
        );
        whatIfState.setCatalystWhatIf('none');
        await display.updateDisplay(mountPanel());

        expect(profitSection().querySelector('.mwi-alchemy-catalyst-whatif-note').textContent).toContain(
            'assume no catalyst'
        );
        expect(whatIfState.getCatalystWhatIfResult()).toBeNull();
    });

    test('an unpriced pick keeps the equipped figure, says why, and keeps the picker to go back', async () => {
        selectTab('Decompose');
        calculator.decompose.mockImplementation((_i, _e, _l, _t, _c, choice) =>
            choice === 'typeSpecific' ? null : profitData()
        );
        whatIfState.setCatalystWhatIf('typeSpecific');
        await display.updateDisplay(mountPanel());

        expect(profitSection().textContent).not.toContain('⚠ what-if');
        expect(profitSection().querySelector('.mwi-alchemy-catalyst-whatif-note').textContent).toContain(
            'Catalyst Of Decomposition has no market price'
        );
        expect(profitSection().querySelector('[data-mwi-catalyst-choice="equipped"]')).not.toBeNull();
        expect(whatIfState.getCatalystWhatIfResult()).toBeNull();
    });

    test('a catalyst in the bag gets no "you have none"', async () => {
        selectTab('Decompose');
        game.inventory = [{ itemHrid: PRIME, count: 3, itemLocationHrid: '/item_locations/inventory' }];
        whatIfState.setCatalystWhatIf('prime');
        await display.updateDisplay(mountPanel());

        expect(profitSection().querySelector('.mwi-alchemy-catalyst-whatif-note').textContent).not.toContain(
            'You have no'
        );
    });

    test('coinify and transmute route the choice through their own argument positions', async () => {
        whatIfState.setCatalystWhatIf('prime');
        selectTab('Coinify');
        await display.updateDisplay(mountPanel());
        expect(calculator.coinify).toHaveBeenCalledWith(EGG, 0, true, null, null, 'prime');

        document.body.innerHTML = '';
        selectTab('Transmute');
        panel.requirements = [{ itemHrid: EGG, enhancementLevel: 2 }];
        await display.updateDisplay(mountPanel());
        expect(calculator.transmute).toHaveBeenCalledWith(EGG, true, null, 'prime', null, 2);
    });

    test('Unrefine takes no catalyst: no picker, no what-if call', async () => {
        selectTab('Unrefine');
        whatIfState.setCatalystWhatIf('prime');
        await display.updateDisplay(mountPanel());

        expect(calculator.unrefine).toHaveBeenCalledTimes(1);
        expect(profitSection().querySelector('.mwi-alchemy-catalyst-whatif')).toBeNull();
        expect(whatIfState.getCatalystWhatIfResult()).toBeNull();
    });

    test('with the picker switched off a stored choice is ignored', async () => {
        settings.alchemy_catalystWhatIf = false;
        selectTab('Decompose');
        whatIfState.setCatalystWhatIf('prime');
        await display.updateDisplay(mountPanel());

        expect(calculator.decompose).toHaveBeenCalledTimes(1);
        expect(profitSection().querySelector('.mwi-alchemy-catalyst-whatif')).toBeNull();
        expect(whatIfState.getCatalystWhatIfResult()).toBeNull();
    });

    test('no profit figure at all withdraws a published result', async () => {
        selectTab('Decompose');
        whatIfState.setCatalystWhatIf('prime');
        await display.updateDisplay(mountPanel());
        expect(whatIfState.getCatalystWhatIfResult()).not.toBeNull();

        calculator.decompose.mockReturnValue(null);
        await display.updateDisplay(mountPanel());
        expect(whatIfState.getCatalystWhatIfResult()).toBeNull();
    });

    test('disable() resets the choice', () => {
        whatIfState.setCatalystWhatIf('prime');
        display.disable();
        expect(whatIfState.getCatalystWhatIf()).toBeNull();
    });
});
