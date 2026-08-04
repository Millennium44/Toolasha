/** @vitest-environment happy-dom */

/**
 * Tests for the alchemy profit display wrapper.
 *
 * The module is mostly a panel builder, and a panel builder is not worth asserting line by line.
 * What is worth pinning is the part that decides things: which calculator a given tab routes to,
 * the XP-per-action arithmetic, the collapsed/expanded state that has to survive a rebuild, and
 * the total-time arithmetic in the speed section — that last one is the number a player actually
 * plans around, and it is not the one the game shows.
 *
 * The profit calculator and the panel scraper are mocked; both have their own files.
 *
 * Not covered (DOM assembly with no branching): createDisplay's revenue/cost tables,
 * createLevelProgressSection's line layout, setupObserver's MutationObserver plumbing.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    initClientData: null,
    skills: [],
}));

const experience = vi.hoisted(() => ({ totalMultiplier: 1 }));

const panel = vi.hoisted(() => ({
    actionHrid: null,
    drops: [],
    requirements: [],
    fingerprint: 'fp',
}));

const calculator = vi.hoisted(() => ({
    coinify: vi.fn(),
    decompose: vi.fn(),
    transmute: vi.fn(),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
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
        getCurrentActionHrid: () => panel.actionHrid,
        getStateFingerprint: () => panel.fingerprint,
        extractDrops: async () => panel.drops,
        extractRequirements: async () => panel.requirements,
    },
}));

vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        calculateCoinifyProfit: (...args) => calculator.coinify(...args),
        calculateDecomposeProfit: (...args) => calculator.decompose(...args),
        calculateTransmuteProfit: (...args) => calculator.transmute(...args),
    },
}));

vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalMultiplier: experience.totalMultiplier }),
}));

const { default: display } = await import('./alchemy-profit-display.js');

/** Minimal profit-calculator result — updateDisplay only checks it is truthy. */
const someProfit = () => ({ successRate: 1, actionTime: 20, efficiency: 0 });

beforeEach(() => {
    game.initClientData = null;
    game.skills = [];
    experience.totalMultiplier = 1;
    panel.actionHrid = null;
    panel.drops = [];
    panel.requirements = [];
    panel.fingerprint = 'fp';
    calculator.coinify.mockReset().mockReturnValue(someProfit());
    calculator.decompose.mockReset().mockReturnValue(someProfit());
    calculator.transmute.mockReset().mockReturnValue(someProfit());
});

afterEach(() => {
    vi.restoreAllMocks();
    display.sectionExpanded.clear();
    display.removeSpeedTimeInputListeners();
    display.displayElement = null;
    document.body.innerHTML = '';
});

describe('getAlchemyBaseXP', () => {
    test('each action type has its own level scaling', () => {
        // coinify: level + 10 | decompose: 1.4·level + 14 | transmute: 1.6·level + 16
        expect(display.getAlchemyBaseXP('coinify', 65)).toBe(75);
        expect(display.getAlchemyBaseXP('decompose', 65)).toBeCloseTo(105, 9);
        expect(display.getAlchemyBaseXP('transmute', 65)).toBeCloseTo(120, 9);
    });

    test('an unrecognised action type awards nothing', () => {
        expect(display.getAlchemyBaseXP('enchant', 65)).toBe(0);
        expect(display.getAlchemyBaseXP(null, 65)).toBe(0);
    });

    test('it matches the copy in alchemy-best-items, which ranks by it', async () => {
        // The two are hand-copied and there is nothing but this test to keep them together
        const { getAlchemyBaseXP } = await import('./alchemy-best-items.js');

        for (const type of ['coinify', 'decompose', 'transmute', 'nonsense']) {
            for (const level of [0, 1, 37, 100]) {
                expect(display.getAlchemyBaseXP(type, level)).toBe(getAlchemyBaseXP(type, level));
            }
        }
    });
});

describe('calculateAlchemyXPPerAction', () => {
    beforeEach(() => {
        game.initClientData = {
            itemDetailMap: { '/items/cheese': { name: 'Cheese', itemLevel: 65 } },
        };
    });

    test('a guaranteed success awards the full modified XP', () => {
        expect(display.calculateAlchemyXPPerAction('coinify', '/items/cheese', 1)).toBeCloseTo(75, 9);
    });

    test('a failed action still awards a tenth', () => {
        expect(display.calculateAlchemyXPPerAction('coinify', '/items/cheese', 0)).toBeCloseTo(7.5, 9);
    });

    test('a partial success rate is the expected value of the two', () => {
        // 0.8·75 + 0.2·7.5 = 60 + 1.5 = 61.5
        expect(display.calculateAlchemyXPPerAction('coinify', '/items/cheese', 0.8)).toBeCloseTo(61.5, 9);
    });

    test('the wisdom multiplier scales the whole award, failures included', () => {
        experience.totalMultiplier = 1.4;
        // base 75 × 1.4 = 105 on success, 10.5 on failure
        // 0.8·105 + 0.2·10.5 = 84 + 2.1 = 86.1
        expect(display.calculateAlchemyXPPerAction('coinify', '/items/cheese', 0.8)).toBeCloseTo(86.1, 9);
    });

    test('an item with no declared level still earns the flat part', () => {
        game.initClientData.itemDetailMap['/items/cheese'].itemLevel = undefined;
        expect(display.calculateAlchemyXPPerAction('coinify', '/items/cheese', 1)).toBeCloseTo(10, 9);
    });

    test('missing game data, item, or action type returns zero rather than NaN', () => {
        expect(display.calculateAlchemyXPPerAction('coinify', '/items/nope', 1)).toBe(0);
        expect(display.calculateAlchemyXPPerAction('coinify', null, 1)).toBe(0);
        expect(display.calculateAlchemyXPPerAction('enchant', '/items/cheese', 1)).toBe(0);

        game.initClientData = null;
        expect(display.calculateAlchemyXPPerAction('coinify', '/items/cheese', 1)).toBe(0);
    });
});

describe('updateDisplay routes to the right calculator', () => {
    /**
     * Put an alchemy tab bar on screen with one tab selected.
     * @param {string|null} label - selected tab text, or null for no panel
     */
    function selectTab(label) {
        document.body.innerHTML =
            label === null
                ? ''
                : `<div class="AlchemyPanel_tabsComponentContainer__x1">
                       <div role="tab" aria-selected="true">${label}</div>
                   </div>`;
    }

    let created;

    beforeEach(() => {
        created = vi.spyOn(display, 'createDisplay').mockImplementation(() => {});
        vi.spyOn(display, 'removeDisplay').mockImplementation(() => {});
        panel.requirements = [{ itemHrid: '/items/cheese', enhancementLevel: 0 }];
    });

    test('the selected tab wins, and coinify passes the enhancement level through', async () => {
        selectTab('Coinify');
        panel.requirements = [{ itemHrid: '/items/cheese', enhancementLevel: 4 }];

        await display.updateDisplay(document.createElement('div'));

        expect(calculator.coinify).toHaveBeenCalledWith('/items/cheese', 4, true);
        expect(calculator.decompose).not.toHaveBeenCalled();
        expect(created.mock.calls[0][2]).toBe('coinify');
    });

    test('decompose routes to the decompose calculator', async () => {
        selectTab('Decompose');

        await display.updateDisplay(document.createElement('div'));

        expect(calculator.decompose).toHaveBeenCalledWith('/items/cheese', 0, true);
        expect(created.mock.calls[0][2]).toBe('decompose');
    });

    test('transmute takes no enhancement level', async () => {
        selectTab('Transmute');

        await display.updateDisplay(document.createElement('div'));

        expect(calculator.transmute).toHaveBeenCalledWith('/items/cheese', true);
        expect(created.mock.calls[0][2]).toBe('transmute');
    });

    test('a missing enhancement level is treated as +0', async () => {
        selectTab('Coinify');
        panel.requirements = [{ itemHrid: '/items/cheese' }];

        await display.updateDisplay(document.createElement('div'));

        expect(calculator.coinify).toHaveBeenCalledWith('/items/cheese', 0, true);
    });

    test('with no tab bar it falls back to the running action', async () => {
        // getCurrentActionHrid reports any running alchemy action, which is why the tab is
        // preferred — but it is better than nothing when the tab bar has not rendered yet
        selectTab(null);
        panel.actionHrid = '/actions/alchemy/transmute';

        await display.updateDisplay(document.createElement('div'));

        expect(calculator.transmute).toHaveBeenCalledWith('/items/cheese', true);
    });

    test('the tab overrides a running action of a different type', async () => {
        selectTab('Coinify');
        panel.actionHrid = '/actions/alchemy/decompose';

        await display.updateDisplay(document.createElement('div'));

        expect(calculator.coinify).toHaveBeenCalled();
        expect(calculator.decompose).not.toHaveBeenCalled();
    });

    test('with neither tab nor action, a coin drop identifies coinify', async () => {
        selectTab(null);
        panel.drops = [{ itemHrid: '/items/coin' }];

        await display.updateDisplay(document.createElement('div'));

        expect(calculator.coinify).toHaveBeenCalled();
    });

    test('with neither tab nor action, the item’s own alchemy data decides', async () => {
        selectTab(null);
        game.initClientData = {
            itemDetailMap: {
                '/items/cheese': { alchemyDetail: { transmuteDropTable: [{ itemHrid: '/items/x' }] } },
            },
        };

        await display.updateDisplay(document.createElement('div'));

        expect(calculator.transmute).toHaveBeenCalled();
    });

    test('an item that only decomposes falls to decompose', async () => {
        selectTab(null);
        game.initClientData = {
            itemDetailMap: {
                '/items/cheese': { alchemyDetail: { decomposeItems: [{ itemHrid: '/items/x' }] } },
            },
        };

        await display.updateDisplay(document.createElement('div'));

        expect(calculator.decompose).toHaveBeenCalled();
    });

    test('with nothing selected and nothing to go on, the display comes down', async () => {
        selectTab(null);
        panel.requirements = [];

        await display.updateDisplay(document.createElement('div'));

        expect(display.removeDisplay).toHaveBeenCalled();
        expect(created).not.toHaveBeenCalled();
    });

    test('a calculator that returns nothing takes the display down rather than drawing blanks', async () => {
        selectTab('Coinify');
        calculator.coinify.mockReturnValue(null);

        await display.updateDisplay(document.createElement('div'));

        expect(display.removeDisplay).toHaveBeenCalled();
        expect(created).not.toHaveBeenCalled();
    });

    test('a calculator that throws is caught, not left to break the panel', async () => {
        selectTab('Coinify');
        calculator.coinify.mockImplementation(() => {
            throw new Error('no market data');
        });
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(display.updateDisplay(document.createElement('div'))).resolves.toBeUndefined();
        expect(display.removeDisplay).toHaveBeenCalled();
        expect(logged).toHaveBeenCalled();
    });

    test('the item hrid handed to the display is the one that was priced', async () => {
        selectTab('Decompose');
        panel.requirements = [{ itemHrid: '/items/azure_cheese', enhancementLevel: 2 }];

        await display.updateDisplay(document.createElement('div'));

        expect(created.mock.calls[0][3]).toBe('/items/azure_cheese');
    });
});

describe('createTrackedCollapsible remembers what was open', () => {
    const content = () => {
        const div = document.createElement('div');
        div.textContent = 'body';
        return div;
    };

    test('a section starts in its default state the first time it is built', () => {
        const closed = display.createTrackedCollapsible('', 'Costs', null, content(), false);
        const open = display.createTrackedCollapsible('', 'Revenue', null, content(), true);

        expect(closed.querySelector('.mwi-section-content').style.display).toBe('none');
        expect(open.querySelector('.mwi-section-content').style.display).toBe('block');
    });

    test('a click is remembered and applied to the next rebuild', () => {
        const first = display.createTrackedCollapsible('', 'Costs', null, content(), false);
        first.querySelector('.mwi-section-header').click();

        const rebuilt = display.createTrackedCollapsible('', 'Costs', null, content(), false);
        expect(rebuilt.querySelector('.mwi-section-content').style.display).toBe('block');
    });

    test('clicking again closes it again, and that is remembered too', () => {
        const first = display.createTrackedCollapsible('', 'Costs', null, content(), true);
        first.querySelector('.mwi-section-header').click();

        const rebuilt = display.createTrackedCollapsible('', 'Costs', null, content(), true);
        expect(rebuilt.querySelector('.mwi-section-content').style.display).toBe('none');
    });

    test('the key ignores the numbers in the title, which change every rebuild', () => {
        // "Normal Drops: 55.1K/hr (4 items)" and "Normal Drops: 61.9K/hr (4 items)" are the
        // same section; keying on the whole string would reset it whenever a price moved
        const first = display.createTrackedCollapsible('', 'Normal Drops: 55.1K/hr (4 items)', null, content(), false);
        first.querySelector('.mwi-section-header').click();

        const rebuilt = display.createTrackedCollapsible(
            '',
            'Normal Drops: 61.9K/hr (4 items)',
            null,
            content(),
            false
        );
        expect(rebuilt.querySelector('.mwi-section-content').style.display).toBe('block');
    });

    test('the icon is part of the key, so two sections named alike stay separate', () => {
        const withIcon = display.createTrackedCollapsible('📊', 'Breakdown', null, content(), false);
        withIcon.querySelector('.mwi-section-header').click();

        const withoutIcon = display.createTrackedCollapsible('', 'Breakdown', null, content(), false);
        expect(withoutIcon.querySelector('.mwi-section-content').style.display).toBe('none');
    });

    test('sections track independently', () => {
        display.createTrackedCollapsible('', 'A', null, content(), false).querySelector('.mwi-section-header').click();

        const b = display.createTrackedCollapsible('', 'B', null, content(), false);
        const a = display.createTrackedCollapsible('', 'A', null, content(), false);
        expect(b.querySelector('.mwi-section-content').style.display).toBe('none');
        expect(a.querySelector('.mwi-section-content').style.display).toBe('block');
    });
});

describe('createActionSpeedTimeSection', () => {
    /**
     * @param {Object} [overrides] - profitData fields
     * @returns {Object}
     */
    const profitData = (overrides = {}) => ({
        actionTime: 20,
        efficiency: 0,
        efficiencyBreakdown: {},
        ...overrides,
    });

    /**
     * @param {string} value - what the Repeat box says
     * @returns {HTMLInputElement}
     */
    function repeatField(value) {
        const input = document.createElement('input');
        input.value = value;
        return input;
    }

    /** @param {HTMLElement} section @returns {string} */
    const text = (section) => section.querySelector('.mwi-section-content').textContent;

    test('efficiency turns into extra output, not a shorter action', () => {
        // 20s actions → 180/hr base. 50% efficiency → ×1.5 output → 270/hr.
        const section = display.createActionSpeedTimeSection(profitData({ efficiency: 0.5 }), repeatField('0'));

        expect(text(section)).toContain('180/hr');
        expect(text(section)).toContain('×1.50 (270/hr)');
    });

    test('total time counts base actions, so efficiency shortens the run', () => {
        // 100 requested at ×1.25 efficiency → ceil(100/1.25) = 80 base actions × 20s = 1600s
        const section = display.createActionSpeedTimeSection(profitData({ efficiency: 0.25 }), repeatField('100'));

        expect(text(section)).toContain('Total time: 0h 26m 40s');
    });

    test('the base-action count rounds up — you cannot run a fraction of an action', () => {
        // 10 requested at ×1.5 → ceil(10/1.5) = 7 base actions × 20s = 140s, not 133s
        const section = display.createActionSpeedTimeSection(profitData({ efficiency: 0.5 }), repeatField('10'));

        expect(text(section)).toContain('Total time: 0h 02m 20s');
    });

    test('an infinite repeat count reports an infinite time rather than a number', () => {
        const section = display.createActionSpeedTimeSection(profitData(), repeatField('∞'));

        expect(text(section)).toContain('Total time: ∞');
        expect(section.textContent).toContain('Total time: ∞');
    });

    test('an empty or unparseable repeat box reads as zero', () => {
        expect(text(display.createActionSpeedTimeSection(profitData(), repeatField('')))).toContain('Total time: 0s');
        expect(text(display.createActionSpeedTimeSection(profitData(), repeatField('abc')))).toContain(
            'Total time: 0s'
        );
    });

    test('editing the repeat box updates the total without a rebuild', () => {
        const field = repeatField('100');
        const section = display.createActionSpeedTimeSection(profitData(), field);
        expect(text(section)).toContain('Total time: 0h 33m 20s');

        field.value = '10';
        field.dispatchEvent(new Event('input'));
        expect(text(section)).toContain('Total time: 0h 03m 20s');
    });

    test('a rebuild drops the previous section’s listeners so one edit updates one section', () => {
        // The Repeat input is reused across rebuilds; leaving the old listeners on meant every
        // rebuild added another, and a stale closure kept writing into a detached node
        const field = repeatField('100');
        const stale = display.createActionSpeedTimeSection(profitData(), field);
        const fresh = display.createActionSpeedTimeSection(profitData(), field);

        field.value = '10';
        field.dispatchEvent(new Event('input'));

        expect(text(fresh)).toContain('Total time: 0h 03m 20s');
        expect(text(stale)).toContain('Total time: 0h 33m 20s');
    });

    test('removeSpeedTimeInputListeners detaches them and is safe to call twice', () => {
        const field = repeatField('100');
        const section = display.createActionSpeedTimeSection(profitData(), field);

        display.removeSpeedTimeInputListeners();
        display.removeSpeedTimeInputListeners();

        field.value = '10';
        field.dispatchEvent(new Event('input'));
        expect(text(section)).toContain('Total time: 0h 33m 20s');
    });

    test('the collapsed summary carries the rate and the total', () => {
        const section = display.createActionSpeedTimeSection(profitData({ efficiency: 0.5 }), repeatField('10'));

        expect(section.textContent).toContain('270/hr | Total time: 0h 02m 20s');
    });

    test('a malformed profitData is logged and returns null instead of throwing', () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(display.createActionSpeedTimeSection({}, repeatField('1'))).toBeNull();
        expect(logged).toHaveBeenCalled();
    });
});
