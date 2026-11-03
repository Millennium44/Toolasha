/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
    answers: new Map(),
    selection: { itemHrid: '/items/holy_cheese', enhancementLevel: 0, actionType: 'coinify' },
    inventory: [],
    charId: 'char-1',
    pricingMode: 'hybrid',
    settingHandlers: new Map(),
    events: new Map(),
    markEnabled: true,
}));

const calculator = vi.hoisted(() => {
    const answer = (action, choice, item) => state.answers.get(`${action}:${choice}:${item}`) ?? null;
    return {
        calculateCoinifyProfit: vi.fn((item, _enh, _live, _a, _b, choice) => answer('coinify', choice, item)),
        calculateDecomposeProfit: vi.fn((item, _enh, _live, _a, _b, choice) => answer('decompose', choice, item)),
        calculateTransmuteProfit: vi.fn((item, _live, _tea, choice) => answer('transmute', choice, item)),
    };
});

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key === 'alchemyCatalystMark' ? state.markEnabled : true),
        getSettingValue: (key, fallback) => (key === 'profitCalc_pricingMode' ? state.pricingMode : fallback),
        onSettingChange: (key, handler) => {
            state.settingHandlers.set(key, handler);
            return () => state.settingHandlers.delete(key);
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (event, handler) => state.events.set(event, handler),
        off: (event) => state.events.delete(event),
        getCurrentCharacterId: () => state.charId,
        getInventory: () => state.inventory,
        getItemDetails: (hrid) => ({ name: hrid.split('/').pop().replace(/_/g, ' ') }),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: calculator }));
vi.mock('./alchemy-profit.js', () => ({ readAlchemyPanelSelection: () => state.selection }));

const { default: mark, rankCatalystOptions } = await import('./alchemy-catalyst-mark.js');

const CAT = '/items/catalyst_of_coinification';
const PRIME = '/items/prime_catalyst';
const CHEESE = '/items/holy_cheese';

function setAnswers(action, item, byChoice) {
    for (const [choice, data] of Object.entries(byChoice)) state.answers.set(`${action}:${choice}:${item}`, data);
}
const profit = (profitPerHour, extra = {}) => ({ profitPerHour, profitPerAction: profitPerHour / 1000, ...extra });

function buildPanel(action = 'Coinify') {
    document.body.innerHTML = '';
    const primary = document.createElement('div');
    primary.className = 'SkillActionDetail_primaryItemSelectorContainer_x';
    document.body.appendChild(primary);
    const tablist = document.createElement('div');
    tablist.setAttribute('role', 'tablist');
    for (const name of ['Coinify', 'Decompose', 'Transmute', 'Unrefine']) {
        const tab = document.createElement('div');
        tab.setAttribute('role', 'tab');
        tab.textContent = name;
        if (name === action) tab.setAttribute('aria-selected', 'true');
        tablist.appendChild(tab);
    }
    document.body.appendChild(tablist);
}

/** The catalyst menu, nested in its input container, tiles drawn with xlink:href only */
function openCatalystMenu(hrids) {
    const container = document.createElement('div');
    container.className = 'SkillActionDetail_catalystItemInputContainer_x';
    const menu = document.createElement('div');
    menu.className = 'ItemSelector_menu_x';
    const grid = document.createElement('div');
    for (const hrid of hrids) {
        const wrap = document.createElement('div');
        const tile = document.createElement('div');
        tile.className = 'Item_itemContainer_x';
        tile.innerHTML = `<svg><use xlink:href="/items_sprite.svg#${hrid.replace('/items/', '')}"></use></svg>`;
        wrap.appendChild(tile);
        grid.appendChild(wrap);
    }
    menu.appendChild(grid);
    container.appendChild(menu);
    document.body.appendChild(container);
    return menu;
}

const banner = () => document.querySelector('.mwi-alchemy-catalyst-mark');
const stars = () => document.querySelectorAll('.mwi-alchemy-catalyst-mark-star');

async function drawn() {
    mark.schedule();
    await vi.advanceTimersByTimeAsync(100);
}

beforeEach(() => {
    vi.useFakeTimers();
    state.answers.clear();
    state.inventory = [];
    state.selection = { itemHrid: CHEESE, enhancementLevel: 0, actionType: 'coinify' };
    state.charId = 'char-1';
    state.pricingMode = 'hybrid';
    state.markEnabled = true;
    buildPanel();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mark.initialize();
});

afterEach(() => {
    const failures = console.error.mock.calls.map((c) => String(c[0]));
    mark.disable();
    vi.useRealTimers();
    document.head.innerHTML = '';
    vi.restoreAllMocks();
    // Nothing may have failed to draw
    expect(failures.filter((m) => m.includes('AlchemyCatalystMark'))).toEqual([]);
});

describe('rankCatalystOptions', () => {
    test('a lone option has nothing to compare', () => {
        expect(rankCatalystOptions([{ key: 'none', hrid: null, profitPerHour: 5 }]).state).toBe('none');
        expect(rankCatalystOptions([]).state).toBe('none');
    });
    test('ties within half a coin an hour', () => {
        const r = rankCatalystOptions([
            { key: 'a', hrid: 'a', profitPerHour: 100 },
            { key: 'b', hrid: 'b', profitPerHour: 100.2 },
            { key: 'c', hrid: 'c', profitPerHour: 50 },
        ]);
        expect(r.state).toBe('tie');
        expect(r.best).toHaveLength(2);
    });
});

describe('catalyst picker mark', () => {
    test('names the best owned catalyst, shows profit per hour and per action, and stars its tile', async () => {
        setAnswers('coinify', CHEESE, {
            none: profit(1_000_000),
            typeSpecific: profit(1_500_000),
            prime: profit(1_200_000),
        });
        state.inventory = [{ itemHrid: CAT, count: 4, itemLocationHrid: '/item_locations/inventory' }];
        openCatalystMenu([CAT, PRIME]);
        await drawn();

        expect(banner().textContent).toContain('Best catalyst: catalyst of coinification, +1.5M/hr, +1.5K/action');
        expect(banner().textContent).not.toContain('You have none');
        expect(stars()).toHaveLength(1);
        expect(stars()[0].closest('[class*="Item_itemContainer"]').innerHTML).toContain('catalyst_of_coinification');
    });

    test('best not owned says so and names the best owned option', async () => {
        setAnswers('coinify', CHEESE, {
            none: profit(1_000_000),
            typeSpecific: profit(1_100_000),
            prime: profit(2_000_000),
        });
        state.inventory = [{ itemHrid: CAT, count: 1 }];
        openCatalystMenu([CAT]);
        await drawn();
        const text = banner().textContent;
        expect(text).toContain('Best catalyst: prime catalyst, +2.0M/hr');
        expect(text).toContain('You have none. Best you own: catalyst of coinification, +1.1M/hr');
        expect(stars()).toHaveLength(0);
    });

    test('no catalysts owned and an empty picker still gets the line', async () => {
        setAnswers('coinify', CHEESE, { none: profit(10), typeSpecific: profit(20), prime: profit(30) });
        openCatalystMenu([]);
        await drawn();
        expect(banner().textContent).toContain('You have none. Best you own: no catalyst, +10/hr');
    });

    test('no benefit from any catalyst: none is best', async () => {
        setAnswers('coinify', CHEESE, { none: profit(500), typeSpecific: profit(-300), prime: profit(-900) });
        openCatalystMenu([CAT, PRIME]);
        await drawn();
        expect(banner().textContent).toContain('Best catalyst: no catalyst, +500/hr');
        expect(banner().textContent).toContain('catalyst of coinification -300/hr');
        expect(stars()).toHaveLength(0);
    });

    test('a tie is called a tie and no tile is starred', async () => {
        setAnswers('coinify', CHEESE, { none: profit(700), typeSpecific: profit(700), prime: profit(100) });
        openCatalystMenu([CAT]);
        await drawn();
        expect(banner().textContent).toContain('no catalyst and catalyst of coinification tie at +700/hr');
        expect(stars()).toHaveLength(0);
    });

    test('every option equal reports no change', async () => {
        setAnswers('coinify', CHEESE, { none: profit(0), typeSpecific: profit(0), prime: profit(0) });
        openCatalystMenu([CAT]);
        await drawn();
        expect(banner().textContent).toContain('none of these changes profit');
    });

    test('an unpriced catalyst is left out and named, not treated as zero', async () => {
        setAnswers('coinify', CHEESE, { none: profit(100), typeSpecific: profit(300) });
        state.inventory = [{ itemHrid: CAT, count: 2 }];
        openCatalystMenu([CAT]);
        await drawn();
        expect(banner().textContent).toContain('Best catalyst: catalyst of coinification, +300/hr');
        expect(banner().textContent).toContain('Not compared (no market price): prime catalyst');
    });

    test('one priced option, or market not loaded, draws nothing', async () => {
        setAnswers('coinify', CHEESE, { none: profit(100) });
        openCatalystMenu([CAT]);
        await drawn();
        expect(banner()).toBeNull();
        expect(stars()).toHaveLength(0);
    });

    test('unpriced drops mark the figure as a floor', async () => {
        const unpriced = { unpricedOutputs: ['/items/x'] };
        setAnswers('coinify', CHEESE, {
            none: profit(100, unpriced),
            typeSpecific: profit(300, unpriced),
            prime: profit(200, unpriced),
        });
        state.inventory = [{ itemHrid: CAT, count: 1 }];
        openCatalystMenu([CAT]);
        await drawn();
        expect(banner().textContent).toContain('a floor: some drops have no price');
    });

    test('no input selected draws nothing', async () => {
        state.selection = null;
        openCatalystMenu([CAT]);
        await drawn();
        expect(banner()).toBeNull();
    });

    test('unrefine has no catalyst and draws nothing', async () => {
        buildPanel('Unrefine');
        openCatalystMenu([CAT]);
        await drawn();
        expect(banner()).toBeNull();
    });

    test('the Alchemize Item menu is never marked', async () => {
        setAnswers('coinify', CHEESE, { none: profit(1), typeSpecific: profit(2), prime: profit(3) });
        const menu = document.createElement('div');
        menu.className = 'ItemSelector_menu_x';
        document.querySelector('[class*="primaryItemSelectorContainer"]').appendChild(menu);
        await drawn();
        expect(banner()).toBeNull();
    });

    test('decompose and transmute use their own calculator call', async () => {
        buildPanel('Decompose');
        setAnswers('decompose', CHEESE, { none: profit(1), typeSpecific: profit(5), prime: profit(3) });
        openCatalystMenu([]);
        await drawn();
        expect(banner().textContent).toContain('Best catalyst: ');
        expect(calculator.calculateDecomposeProfit).toHaveBeenCalled();

        buildPanel('Transmute');
        state.answers.set(`transmute:none:${CHEESE}`, profit(1));
        state.answers.set(`transmute:prime:${CHEESE}`, profit(9));
        openCatalystMenu([]);
        await drawn();
        expect(banner().textContent).toContain('Best catalyst: prime catalyst, +9/hr');
    });

    test('market update or pricing change redraws with the new figures', async () => {
        setAnswers('coinify', CHEESE, { none: profit(1000), typeSpecific: profit(500), prime: profit(0) });
        openCatalystMenu([CAT]);
        await drawn();
        expect(banner().textContent).toContain('Best catalyst: no catalyst');

        setAnswers('coinify', CHEESE, { none: profit(1000), typeSpecific: profit(5000), prime: profit(0) });
        state.events.get('market_item_values_updated')();
        await vi.advanceTimersByTimeAsync(100);
        expect(banner().textContent).toContain('Best catalyst: catalyst of coinification, +5.0K/hr');

        setAnswers('coinify', CHEESE, { none: profit(9000), typeSpecific: profit(5000), prime: profit(0) });
        state.pricingMode = 'bid';
        state.settingHandlers.get('profitCalc_pricingMode')();
        await vi.advanceTimersByTimeAsync(100);
        expect(banner().textContent).toContain('Best catalyst: no catalyst, +9.0K/hr');
    });

    test('a different input redraws for that input', async () => {
        setAnswers('coinify', CHEESE, { none: profit(1), typeSpecific: profit(2), prime: profit(3) });
        setAnswers('coinify', '/items/swiss_cheese', { none: profit(30), typeSpecific: profit(2), prime: profit(3) });
        openCatalystMenu([]);
        await drawn();
        expect(banner().textContent).toContain('prime catalyst, +3/hr');
        state.selection = { itemHrid: '/items/swiss_cheese', enhancementLevel: 0, actionType: 'coinify' };
        await drawn();
        expect(banner().textContent).toContain('Best catalyst: no catalyst, +30/hr');
    });

    test('a different enhancement level is a different input', async () => {
        setAnswers('coinify', CHEESE, { none: profit(1), typeSpecific: profit(2), prime: profit(3) });
        openCatalystMenu([]);
        await drawn();
        const before = calculator.calculateCoinifyProfit.mock.calls.length;
        state.selection = { itemHrid: CHEESE, enhancementLevel: 5, actionType: 'coinify' };
        await drawn();
        expect(calculator.calculateCoinifyProfit.mock.calls.length).toBeGreaterThan(before);
        expect(calculator.calculateCoinifyProfit.mock.calls.at(-1)[1]).toBe(5);
    });

    test('a menu closed before the pass runs leaves nothing behind', async () => {
        setAnswers('coinify', CHEESE, { none: profit(1), typeSpecific: profit(2), prime: profit(3) });
        const menu = openCatalystMenu([CAT]);
        await drawn();
        expect(banner()).not.toBeNull();
        mark.schedule();
        menu.parentElement.remove();
        await vi.advanceTimersByTimeAsync(100);
        expect(banner()).toBeNull();
    });

    test('never clicks or changes anything in the game', async () => {
        setAnswers('coinify', CHEESE, { none: profit(1), typeSpecific: profit(2), prime: profit(3) });
        const menu = openCatalystMenu([CAT, PRIME]);
        const events = [];
        for (const type of ['click', 'mousedown', 'change', 'input']) {
            document.addEventListener(type, () => events.push(type), true);
        }
        await drawn();
        expect(events).toEqual([]);
        expect(menu.querySelectorAll('[class*="Item_itemContainer"]')).toHaveLength(2);
    });

    test('disable removes every node, listener and timer, and re-enable draws again', async () => {
        setAnswers('coinify', CHEESE, { none: profit(1), typeSpecific: profit(5), prime: profit(3) });
        state.inventory = [{ itemHrid: CAT, count: 1 }];
        openCatalystMenu([CAT]);
        await drawn();
        expect(banner()).not.toBeNull();
        expect(stars()).toHaveLength(1);

        mark.schedule();
        mark.disable();
        expect(banner()).toBeNull();
        expect(stars()).toHaveLength(0);
        expect(document.querySelector('.mwi-alchemy-catalyst-mark-tile')).toBeNull();
        expect(document.getElementById('mwi-alchemy-catalyst-mark-style')).toBeNull();
        expect(state.events.has('market_item_values_updated')).toBe(false);
        expect(state.settingHandlers.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);

        mark.initialize();
        await drawn();
        expect(banner()).not.toBeNull();
    });

    test('off by setting does not start', () => {
        mark.disable();
        state.markEnabled = false;
        mark.initialize();
        expect(mark.isInitialized).toBe(false);
        expect(document.getElementById('mwi-alchemy-catalyst-mark-style')).toBeNull();
    });
});
